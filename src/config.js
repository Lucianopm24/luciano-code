import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { getSessionApiKey } from './auth.js';

export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_MODEL = 'deepseek-ai/deepseek-v4-flash';
export const DEFAULT_SEARXNG_URL = 'https://search.lucianopm.com/search';
export const DEFAULT_MAX_TOKENS = 16384;
export const MAX_TOKENS_MIN = 256;
export const MAX_TOKENS_MAX = 65536;
export const CONFIG_DIR = path.join(os.homedir(), '.config', 'luciano-code');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  version: 2,
  provider: 'nvidia-nim',
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  apiKey: '',
  preferences: {
    language: 'es',
    temperature: 0.2,
    stream: true,
    noThink: false,
    contextMessages: 24,
    maxTokens: DEFAULT_MAX_TOKENS,
    searxngUrl: DEFAULT_SEARXNG_URL,
  },
  trustedPaths: [],
  nvidiaDataConsent: null,
};

function cleanString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function normalizeMaxTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_TOKENS_MAX, Math.max(MAX_TOKENS_MIN, Math.floor(parsed)));
}

function normalizeSearxngUrl(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return DEFAULT_SEARXNG_URL;
  try {
    const parsed = new URL(trimmed);
    if (['http:', 'https:'].includes(parsed.protocol)) return trimmed.replace(/\/+$/, '');
  } catch {
    // Invalid or unsupported URLs fall back to the default endpoint.
  }
  return DEFAULT_SEARXNG_URL;
}

export function normalizeConfig(input = {}) {
  const preferences = input.preferences ?? {};
  const temperature = Number(preferences.temperature);

  return {
    ...DEFAULT_CONFIG,
    ...input,
    version: 2,
    provider: 'nvidia-nim',
    baseUrl: cleanString(input.baseUrl, DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: cleanString(input.model, DEFAULT_MODEL),
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
    preferences: {
      ...DEFAULT_CONFIG.preferences,
      ...preferences,
      language: cleanString(preferences.language, 'es'),
      temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : 0.2,
      stream: preferences.stream !== false,
      noThink: preferences.noThink === true || preferences.nothink === true,
      contextMessages: Number.isFinite(Number(preferences.contextMessages))
        ? Math.max(1, Math.min(200, Math.floor(Number(preferences.contextMessages))))
        : 24,
      maxTokens: normalizeMaxTokens(preferences.maxTokens),
      searxngUrl: normalizeSearxngUrl(preferences.searxngUrl),
    },
    nvidiaDataConsent: ['accepted', 'declined'].includes(input.nvidiaDataConsent)
      ? input.nvidiaDataConsent
      : null,
    trustedPaths: Array.isArray(input.trustedPaths)
      ? [...new Set(input.trustedPaths.filter((value) => typeof value === 'string').map((value) => path.resolve(value)))]
      : [],
  };
}

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return { config: normalizeConfig(JSON.parse(raw)), exists: true };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`No se pudo leer ${CONFIG_PATH}: ${error.message}`);
    }
    return { config: normalizeConfig(), exists: false };
  }
}

export function isTrusted(config, targetPath = process.cwd()) {
  const trustedPaths = Array.isArray(config?.trustedPaths) ? config.trustedPaths : [];
  return trustedPaths.includes(path.resolve(targetPath));
}

export function grantTrust(config, targetPath = process.cwd()) {
  const resolvedPath = path.resolve(targetPath);
  const trustedPaths = Array.isArray(config?.trustedPaths) ? config.trustedPaths : [];
  return normalizeConfig({
    ...config,
    trustedPaths: [...new Set([...trustedPaths, resolvedPath])],
  });
}

export function revokeTrust(config, targetPath = process.cwd()) {
  const resolvedPath = path.resolve(targetPath);
  const trustedPaths = Array.isArray(config?.trustedPaths) ? config.trustedPaths : [];
  return normalizeConfig({
    ...config,
    trustedPaths: trustedPaths.filter((value) => path.resolve(value) !== resolvedPath),
  });
}

export function getApiKey(config) {
  const accountKey = getSessionApiKey();
  const environmentKey = process.env.NVIDIA_API_KEY?.trim();
  return accountKey || environmentKey || config.apiKey || '';
}

export function isConfigured(config) {
  return Boolean(getApiKey(config));
}

export function hasNvidiaDataConsent(config) {
  return config?.nvidiaDataConsent === 'accepted';
}

export function setNvidiaDataConsent(config, value) {
  if (!['accepted', 'declined'].includes(value)) throw new Error('Invalid NVIDIA data consent value.');
  return normalizeConfig({ ...config, nvidiaDataConsent: value });
}

export function maskApiKey(apiKey) {
  if (!apiKey) return 'not configured';
  if (apiKey.length < 12) return '••••••••';
  return `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}`;
}

export async function saveConfig(input) {
  const config = normalizeConfig(input);
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await chmod(CONFIG_DIR, 0o700);

  const temporaryPath = `${CONFIG_PATH}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(temporaryPath, 0o600);
    try {
      await rename(temporaryPath, CONFIG_PATH);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;

      const backupPath = `${CONFIG_PATH}.${randomUUID()}.bak`;
      let backedUp = false;
      try {
        await rename(CONFIG_PATH, backupPath);
        backedUp = true;
        await rename(temporaryPath, CONFIG_PATH);
      } catch (replacementError) {
        if (backedUp) {
          await unlink(CONFIG_PATH).catch(() => {});
          await rename(backupPath, CONFIG_PATH).catch(() => {});
        }
        throw replacementError;
      }
      await unlink(backupPath).catch(() => {});
    }
    await chmod(CONFIG_PATH, 0o600);
    return config;
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export function runtimeConfig(config) {
  return {
    ...normalizeConfig(config),
    apiKey: getApiKey(config),
    keySource: getSessionApiKey()
      ? 'account'
      : process.env.NVIDIA_API_KEY?.trim()
        ? 'environment'
        : config.apiKey
          ? 'local'
          : 'none',
  };
}
