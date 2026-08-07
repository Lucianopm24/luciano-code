import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accountIdentity,
  clearSessionApiKey,
  initializeAccountSession,
  syncAccountSession,
  loadAuth,
  requestAccountKey,
  requestLogin,
  requestLoginStatus,
  runLoginFlow,
  saveAuth,
} from '../src/auth.js';
import { getApiKey, normalizeConfig, runtimeConfig } from '../src/config.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

async function withTempAuth(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'luciano-auth-'));
  try {
    return await callback(path.join(directory, 'auth.json'));
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }
}

test('auth sessions are stored as plain local JSON with restricted permissions', async () => {
  await withTempAuth(async (authPath) => {
    await saveAuth({ token: 'session-token', account: { name: 'Luciano' } }, { authPath });
    const loaded = await loadAuth({ authPath });
    assert.equal(loaded.token, 'session-token');
    assert.equal(loaded.account.name, 'Luciano');
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    assert.match(await readFile(authPath, 'utf8'), /session-token/);
  });
});

test('account endpoints use the Convex backend and preserve verificationUrl from the response', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/cli/login')
      ? { code: 'ABC', verificationUrl: 'https://code.lucianopm.com/cli/login?code=ABC', expiresInSeconds: 600 }
      : { status: 'pending' });
  };

  const login = await requestLogin({ fetchImpl, siteUrl: 'https://backend.test/' });
  const status = await requestLoginStatus(login.code, { fetchImpl, siteUrl: 'https://backend.test/' });
  assert.equal(login.verificationUrl, 'https://code.lucianopm.com/cli/login?code=ABC');
  assert.equal(status.status, 'pending');
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://backend.test/cli/login',
    'https://backend.test/cli/login/status?code=ABC',
  ]);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[1].options.method, 'GET');
});

test('login checks status only once per manual Enter and saves an approved session', async () => {
  await withTempAuth(async (authPath) => {
    const statusResponses = [
      { status: 'pending' },
      { status: 'approved', token: 'approved-token', account: { name: 'Luciano PM' } },
    ];
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/cli/login')) {
        return response({ code: 'ABC', verificationUrl: 'https://code.lucianopm.com/cli/login' });
      }
      return response(statusResponses.shift());
    };
    const enters = [Promise.resolve(), Promise.resolve()];
    const output = { value: '', write(text) { this.value += text; } };

    const result = await runLoginFlow({
      ask: () => enters.shift(),
      output,
      fetchImpl,
      openBrowser: () => {},
      siteUrl: 'https://backend.test',
      authPath,
    });

    assert.equal(result.status, 'approved');
    assert.equal(calls.filter(({ url }) => url.includes('/status?')).length, 2);
    assert.match(output.value, /Press Enter when you're done\./);
    assert.match(output.value, /Still pending/);
    assert.match(output.value, /Signed in as Luciano PM/);
    assert.equal((await loadAuth({ authPath })).token, 'approved-token');
  });
});

test('account key activation takes precedence over environment and local keys', async () => {
  await withTempAuth(async (authPath) => {
    const previous = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = 'environment-key';
    try {
      await saveAuth({ token: 'session-token' }, { authPath });
      const output = { value: '', write(text) { this.value += text; } };
      await initializeAccountSession({
        output,
        authPath,
        fetchImpl: async (url, options) => {
          assert.equal(url, 'https://backend.test/cli/key');
          assert.equal(options.headers.Authorization, 'Bearer session-token');
          return response({ apiKey: 'account-key', model: 'deepseek/account-model' });
        },
        siteUrl: 'https://backend.test',
      });
      assert.equal(getApiKey(normalizeConfig({ apiKey: 'local-key' })), 'account-key');
      assert.equal(runtimeConfig({ apiKey: 'local-key' }).keySource, 'account');
    } finally {
      clearSessionApiKey();
      if (previous === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = previous;
    }
  });
});

test('expired account sessions are deleted and fall back cleanly', async () => {
  await withTempAuth(async (authPath) => {
    await saveAuth({ token: 'expired-token' }, { authPath });
    const output = { value: '', write(text) { this.value += text; } };
    const result = await initializeAccountSession({
      output,
      authPath,
      fetchImpl: async () => response({ error: 'expired' }, 401),
      siteUrl: 'https://backend.test',
    });
    assert.equal(result.expired, true);
    assert.equal(await loadAuth({ authPath }), null);
    assert.match(output.value, /Session expired, run \/login again/);
  });
});

test('sync refreshes the account key and preserves account identity fields', async () => {
  await withTempAuth(async (authPath) => {
    await saveAuth({ token: 'session-token', account: { email: 'old@example.com' } }, { authPath });
    const output = { value: '', write(text) { this.value += text; } };
    const result = await syncAccountSession({
      output,
      authPath,
      siteUrl: 'https://backend.test',
      fetchImpl: async () => response({
        apiKey: 'synced-key',
        model: 'synced-model',
        account: { name: 'Luciano', email: 'new@example.com' },
      }),
    });
    assert.equal(result.active, true);
    assert.equal(result.config.model, 'synced-model');
    assert.equal(result.config.apiKey, 'synced-key');
    assert.equal(accountIdentity(result.auth.account), 'Luciano');
    assert.equal((await loadAuth({ authPath })).account.email, 'new@example.com');
    clearSessionApiKey();
  });
});

test('account identity prefers name, then username, then email', () => {
  assert.equal(accountIdentity({ name: 'Name', username: 'user', email: 'a@b.test' }), 'Name');
  assert.equal(accountIdentity({ username: 'user', email: 'a@b.test' }), 'user');
  assert.equal(accountIdentity({ email: 'a@b.test' }), 'a@b.test');
  assert.equal(accountIdentity(null), null);
});

test('account key request sends only the session bearer token', async () => {
  await requestAccountKey('token', {
    siteUrl: 'https://backend.test',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://backend.test/cli/key');
      assert.deepEqual(options, { method: 'POST', headers: { Authorization: 'Bearer token' } });
      return response({ apiKey: null });
    },
  });
});
