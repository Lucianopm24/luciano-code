import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_CONVEX_SITE_URL = 'https://wry-deer-1.convex.site';
export const APP_URL = 'https://code.lucianopm.com';
export function getConvexSiteUrl() {
  return process.env.CONVEX_SITE_URL?.trim() || DEFAULT_CONVEX_SITE_URL;
}
export const AUTH_DIR = path.join(os.homedir(), '.config', 'luciano-code');
export const AUTH_PATH = path.join(AUTH_DIR, 'auth.json');

let sessionApiKey = '';

function authFilePath(authPath = AUTH_PATH) {
  return authPath;
}

function backendUrl(pathname, siteUrl = getConvexSiteUrl()) {
  return `${siteUrl.replace(/\/+$/, '')}${pathname}`;
}

async function responseJson(response, description) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${description} returned invalid JSON.`);
  }
  if (!response.ok || payload?.ok === false) {
    const detail = payload?.error || payload?.message || `HTTP ${response.status}`;
    const error = new Error(`${description} failed: ${detail}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function getSessionApiKey() {
  return sessionApiKey;
}

export function setSessionApiKey(apiKey) {
  sessionApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  return sessionApiKey;
}

export function clearSessionApiKey() {
  sessionApiKey = '';
}

export async function loadAuth({ authPath = AUTH_PATH } = {}) {
  try {
    const raw = await readFile(authFilePath(authPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== 'string' || !parsed.token.trim()) return null;
    return {
      ...parsed,
      token: parsed.token.trim(),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw new Error(`No se pudo leer ${authFilePath(authPath)}: ${error.message}`);
  }
}

export async function saveAuth(auth, { authPath = AUTH_PATH } = {}) {
  if (!auth || typeof auth.token !== 'string' || !auth.token.trim()) {
    throw new Error('A valid account session token is required.');
  }

  const destination = authFilePath(authPath);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(destination), 0o700);
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  const storedAuth = {
    token: auth.token.trim(),
    ...(auth.account && typeof auth.account === 'object' ? { account: auth.account } : {}),
    savedAt: auth.savedAt || new Date().toISOString(),
  };

  try {
    await writeFile(temporaryPath, `${JSON.stringify(storedAuth, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, destination);
    await chmod(destination, 0o600);
    return storedAuth;
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export async function clearAuth({ authPath = AUTH_PATH } = {}) {
  try {
    await unlink(authFilePath(authPath));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function openVerificationUrl(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

export async function requestLogin({ fetchImpl = globalThis.fetch, siteUrl = getConvexSiteUrl() } = {}) {
  const response = await fetchImpl(backendUrl('/cli/login', siteUrl), { method: 'POST' });
  const payload = await responseJson(response, 'Login request');
  if (!payload.code || !payload.verificationUrl) {
    throw new Error('Login request returned an incomplete device authorization.');
  }
  return payload;
}

export async function requestLoginStatus(code, {
  fetchImpl = globalThis.fetch,
  siteUrl = getConvexSiteUrl(),
} = {}) {
  const url = new URL(backendUrl('/cli/login/status', siteUrl));
  url.searchParams.set('code', code);
  const response = await fetchImpl(url.toString(), { method: 'GET' });
  return responseJson(response, 'Login status request');
}

function cliHeaders(token, hasBody = false) {
  return {
    Authorization: `Bearer ${token}`,
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function cliRequest(pathname, token, {
  method = 'GET',
  body,
  fetchImpl = globalThis.fetch,
  siteUrl = getConvexSiteUrl(),
  description = `Account ${method} ${pathname}`,
} = {}) {
  const response = await fetchImpl(backendUrl(pathname, siteUrl), {
    method,
    headers: cliHeaders(token, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return responseJson(response, description);
}

export async function requestAccountKey(token, options = {}) {
  return cliRequest('/cli/key', token, {
    ...options,
    method: 'POST',
    description: 'Account key request',
  });
}

export async function updateAccountKey(token, apiKey, options = {}) {
  return cliRequest('/cli/key', token, {
    ...options,
    method: 'POST',
    body: { apiKey },
    description: 'Account key update',
  });
}

export async function requestAccountConfig(token, options = {}) {
  return cliRequest('/cli/config', token, {
    ...options,
    method: 'GET',
    description: 'Account config request',
  });
}

export async function updateAccountConfig(token, blob, options = {}) {
  return cliRequest('/cli/config', token, {
    ...options,
    method: 'POST',
    body: { blob },
    description: 'Account config update',
  });
}

export async function updateAccountModel(token, model, options = {}) {
  return cliRequest('/cli/model', token, {
    ...options,
    method: 'POST',
    body: { model },
    description: 'Account model update',
  });
}

export async function requestAccountSystemPrompt(token, options = {}) {
  return cliRequest('/cli/systemprompt', token, {
    ...options,
    method: 'GET',
    description: 'Account system prompt request',
  });
}

export async function updateAccountSystemPrompt(token, prompt, options = {}) {
  return cliRequest('/cli/systemprompt', token, {
    ...options,
    method: 'POST',
    body: { prompt },
    description: 'Account system prompt update',
  });
}

export async function fetchAccountSettings(token, {
  fetchImpl = globalThis.fetch,
  siteUrl = getConvexSiteUrl(),
} = {}) {
  const key = await requestAccountKey(token, { fetchImpl, siteUrl });
  const config = await requestAccountConfig(token, { fetchImpl, siteUrl });
  const systemPrompt = await requestAccountSystemPrompt(token, { fetchImpl, siteUrl });
  return { key, config, systemPrompt };
}

export function accountIdentity(account) {
  if (!account || typeof account !== 'object') return null;
  return account.name || account.username || account.email || account.handle || null;
}

export async function syncAccountSession({
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  siteUrl = getConvexSiteUrl(),
  authPath = AUTH_PATH,
  clearBeforeSync = true,
} = {}) {
  if (clearBeforeSync) clearSessionApiKey();
  const auth = await loadAuth({ authPath });
  if (!auth) return { authenticated: false, active: false, config: null, auth: null };

  try {
    const accountKey = await requestAccountKey(auth.token, { fetchImpl, siteUrl });
    const account = accountKey.account || auth.account || null;
    if (account && JSON.stringify(account) !== JSON.stringify(auth.account)) {
      await saveAuth({ ...auth, account }, { authPath });
    }
    const apiKey = typeof accountKey.apiKey === 'string' ? accountKey.apiKey.trim() : '';
    if (!apiKey) {
      output.write(`⚠ Your account does not have an NVIDIA API key saved. Configure one at ${APP_URL} or use the manual key setup.\n`);
      return { authenticated: true, active: false, config: null, auth: { ...auth, account }, accountKey };
    }

    setSessionApiKey(apiKey);
    return {
      authenticated: true,
      active: true,
      config: {
        apiKey,
        ...(typeof accountKey.model === 'string' && accountKey.model.trim() ? { model: accountKey.model.trim() } : {}),
      },
      auth: { ...auth, account },
      accountKey,
    };
  } catch (error) {
    if (error.status === 401) {
      await clearAuth({ authPath });
      clearSessionApiKey();
      output.write('Session expired, run /login again.\n');
      return { authenticated: false, active: false, expired: true, config: null, auth: null };
    }
    output.write(`⚠ Could not sync your account session: ${error.message}\n`);
    return { authenticated: true, active: false, unavailable: true, config: null, auth };
  }
}

export async function syncAccountSettings({
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  siteUrl = getConvexSiteUrl(),
  authPath = AUTH_PATH,
} = {}) {
  clearSessionApiKey();
  const auth = await loadAuth({ authPath });
  if (!auth) return { authenticated: false, active: false, settings: null, auth: null };

  try {
    const settings = await fetchAccountSettings(auth.token, { fetchImpl, siteUrl });
    const account = settings.key.account || auth.account || null;
    const updatedAuth = { ...auth, ...(account ? { account } : {}) };
    if (account && JSON.stringify(account) !== JSON.stringify(auth.account)) {
      await saveAuth(updatedAuth, { authPath });
    }
    const apiKey = typeof settings.key.apiKey === 'string' ? settings.key.apiKey.trim() : '';
    if (apiKey) setSessionApiKey(apiKey);
    return {
      authenticated: true,
      active: Boolean(apiKey),
      settings,
      auth: updatedAuth,
    };
  } catch (error) {
    if (error.status === 401) {
      await clearAuth({ authPath });
      clearSessionApiKey();
      output.write('Session expired, run /login again.\n');
      return { authenticated: false, active: false, expired: true, settings: null, auth: null };
    }
    output.write(`⚠ Could not sync your account settings: ${error.message}\n`);
    return { authenticated: true, active: false, unavailable: true, settings: null, auth };
  }
}

export async function initializeAccountSession(options = {}) {
  return syncAccountSession({ ...options, clearBeforeSync: true });
}

export async function runLoginFlow({
  ask,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  openBrowser = openVerificationUrl,
  siteUrl = getConvexSiteUrl(),
  authPath = AUTH_PATH,
} = {}) {
  if (typeof ask !== 'function') throw new Error('Login requires an interactive prompt.');

  const device = await requestLogin({ fetchImpl, siteUrl });
  output.write(`\n${device.verificationUrl}\n`);
  output.write('Press Enter when you\'re done.\n');
  try {
    await Promise.resolve(openBrowser(device.verificationUrl));
  } catch (error) {
    output.write(`⚠ Could not open the verification page automatically: ${error.message}\n`);
  }

  while (true) {
    await ask('');
    const result = await requestLoginStatus(device.code, { fetchImpl, siteUrl });
    const status = result.status || result.state;

    if (status === 'pending') {
      output.write('Still pending — press Enter again once you\'ve confirmed in the browser.\n');
      continue;
    }
    if (status === 'denied') {
      output.write('✗ Login denied.\n');
      return { status };
    }
    if (status === 'expired') {
      output.write('✗ Login expired. Run /login again.\n');
      return { status };
    }
    if (status === 'approved') {
      const token = result.token || result.sessionToken || result.authToken;
      if (!token) throw new Error('Approved login did not return a session token.');
      await saveAuth({ token, account: result.account }, { authPath });
      const accountName = result.account?.name || 'your account';
      output.write(`Signed in as ${accountName}\n`);
      return { ...result, status, token };
    }

    output.write(`✗ Login returned an unknown status: ${status || 'missing'}.\n`);
    return { status: status || 'unknown' };
  }
}
