import { chmod, mkdir, readFile, rename, unlink, writeFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const MEMORY_DIR = path.join(os.homedir(), '.config', 'luciano-code');
export const CONVERSATIONS_DIR = path.join(MEMORY_DIR, 'conversations');
export const CURRENT_CONVERSATION_PATH = path.join(CONVERSATIONS_DIR, 'current.json');
export const HISTORY_DIR = path.join(CONVERSATIONS_DIR, 'history');

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);
const API_KEY_PATTERNS = [
  /\bnvapi-[A-Za-z0-9_-]+\b/g,
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi,
  /(\bbearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /((?:api[_-]?key|api[_-]?token|access[_-]?token|secret|password|passwd|token)\s*[:=]\s*)([^\s,;"']+)/gi,
  /(["']?(?:apiKey|apiToken|accessToken|clientSecret|secretKey)["']?\s*[:=]\s*["']?)([^\s,;"'}]+)/gi,
];

function now() {
  return new Date().toISOString();
}

function redactSecrets(value) {
  let text = String(value ?? '');
  text = text.replace(API_KEY_PATTERNS[0], '[REDACTED_SECRET]');
  text = text.replace(API_KEY_PATTERNS[1], '$1[REDACTED_SECRET]');
  text = text.replace(API_KEY_PATTERNS[2], '$1[REDACTED_SECRET]');
  text = text.replace(API_KEY_PATTERNS[3], '$1[REDACTED_SECRET]');
  text = text.replace(API_KEY_PATTERNS[4], '$1[REDACTED_SECRET]');
  return text;
}

export function sanitizeMessage(message) {
  if (!message || !ALLOWED_ROLES.has(message.role)) return null;
  return {
    role: message.role,
    content: redactSecrets(message.content),
    timestamp: typeof message.timestamp === 'string' ? message.timestamp : now(),
  };
}

function sanitizeConversation(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.messages)) {
    throw new Error('Invalid local conversation schema.');
  }
  for (const message of input.messages) {
    if (!message || typeof message !== 'object' || !ALLOWED_ROLES.has(message.role)
      || typeof message.content !== 'string' || typeof message.timestamp !== 'string') {
      throw new Error('Invalid local conversation message schema.');
    }
  }
  if (typeof input.createdAt !== 'string' || typeof input.updatedAt !== 'string') {
    throw new Error('Invalid local conversation metadata schema.');
  }
  const messages = input.messages.map(sanitizeMessage).filter(Boolean);
  const createdAt = input.createdAt;
  const updatedAt = input.updatedAt;
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    createdAt,
    updatedAt,
    messages,
  };
}

export function createConversation() {
  const timestamp = now();
  return {
    id: randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
  };
}

function pathsFor(baseDir = MEMORY_DIR) {
  const conversationsDir = path.join(baseDir, 'conversations');
  return {
    conversationsDir,
    currentPath: path.join(conversationsDir, 'current.json'),
    historyDir: path.join(conversationsDir, 'history'),
  };
}

async function ensureDirectories(baseDir = MEMORY_DIR) {
  const { conversationsDir, historyDir } = pathsFor(baseDir);
  await mkdir(conversationsDir, { recursive: true, mode: 0o700 });
  await mkdir(historyDir, { recursive: true, mode: 0o700 });
  await chmod(conversationsDir, 0o700);
  await chmod(historyDir, 0o700);
  return { conversationsDir, historyDir };
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    const backupPath = `${filePath}.${randomUUID()}.bak`;
    let backedUp = false;
    try {
      await rename(filePath, backupPath);
      backedUp = true;
      await rename(temporaryPath, filePath);
    } catch (replacementError) {
      if (backedUp) {
        await unlink(filePath).catch(() => {});
        await rename(backupPath, filePath).catch(() => {});
      }
      throw replacementError;
    }
    await unlink(backupPath).catch(() => {});
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  await chmod(filePath, 0o600);
}

async function readConversationFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    error.code = 'CONVERSATION_CORRUPT';
    throw error;
  }

  try {
    return sanitizeConversation(parsed);
  } catch (error) {
    error.code = 'CONVERSATION_CORRUPT';
    throw error;
  }
}

async function quarantineCorruptCurrent(currentPath) {
  const quarantinePath = `${currentPath}.corrupt-${Date.now()}-${randomUUID()}.json`;
  try {
    await rename(currentPath, quarantinePath);
    await chmod(quarantinePath, 0o600);
    return quarantinePath;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`No se pudo preservar la conversación corrupta: ${error.message}`);
  }
}

export async function loadCurrentConversation({ baseDir = MEMORY_DIR } = {}) {
  const { currentPath } = pathsFor(baseDir);
  try {
    const conversation = await readConversationFile(currentPath);
    return conversation || createConversation();
  } catch (error) {
    if (error.code !== 'CONVERSATION_CORRUPT') throw error;
    // Never overwrite unreadable local memory. Preserve it and recover with a
    // fresh conversation so the CLI can continue without losing the original.
    await quarantineCorruptCurrent(currentPath);
    return createConversation();
  }
}

export async function saveCurrentConversation(conversation, { baseDir = MEMORY_DIR } = {}) {
  await ensureDirectories(baseDir);
  const normalized = sanitizeConversation({
    ...conversation,
    updatedAt: now(),
  });
  await writeJsonAtomic(pathsFor(baseDir).currentPath, normalized);
  return normalized;
}

export async function appendConversationMessage(message, { baseDir = MEMORY_DIR } = {}) {
  const conversation = await loadCurrentConversation({ baseDir });
  const normalizedMessage = sanitizeMessage(message);
  if (!normalizedMessage) return conversation;
  conversation.messages.push(normalizedMessage);
  return saveCurrentConversation(conversation, { baseDir });
}

export function selectContextMessages(messages, maxMessages = 24) {
  const safeMessages = Array.isArray(messages) ? messages.map(sanitizeMessage).filter(Boolean) : [];
  const systemMessages = safeMessages.filter((message) => message.role === 'system');
  const conversationalMessages = safeMessages.filter((message) => message.role !== 'system');
  const limit = Number.isFinite(Number(maxMessages)) ? Math.max(1, Math.floor(Number(maxMessages))) : 24;
  return [...systemMessages, ...conversationalMessages.slice(-limit)];
}

export async function archiveCurrentConversation({ baseDir = MEMORY_DIR } = {}) {
  const conversation = await loadCurrentConversation({ baseDir });
  if (!conversation.messages.length) return null;
  const { historyDir } = await ensureDirectories(baseDir);
  // Never derive a filesystem path from persisted, user-controlled metadata.
  // A fresh local identifier also avoids collisions between repeated archives.
  const historyPath = path.join(historyDir, `${Date.now()}-${randomUUID()}.json`);
  await writeJsonAtomic(historyPath, conversation);
  return conversation;
}

export async function startNewConversation({ baseDir = MEMORY_DIR, archive = true } = {}) {
  if (archive) await archiveCurrentConversation({ baseDir });
  const conversation = createConversation();
  await saveCurrentConversation(conversation, { baseDir });
  return conversation;
}

export async function clearCurrentConversation(options = {}) {
  return startNewConversation({ ...options, archive: true });
}

async function historyFiles(baseDir = MEMORY_DIR) {
  const { historyDir } = await ensureDirectories(baseDir);
  const names = await readdir(historyDir);
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .map((name) => path.join(historyDir, name));
}

export async function listConversationHistory({ baseDir = MEMORY_DIR, limit = 20 } = {}) {
  const current = await loadCurrentConversation({ baseDir });
  const records = [];
  if (current.messages.length) records.push({
    id: current.id,
    current: true,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    messageCount: current.messages.length,
    title: conversationTitle(current),
  });
  for (const filePath of await historyFiles(baseDir)) {
    try {
      const conversation = await readConversationFile(filePath);
      if (!conversation?.messages.length) continue;
      records.push({
        id: conversation.id,
        current: false,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messages.length,
        title: conversationTitle(conversation),
      });
      if (records.length >= limit) break;
    } catch {
      // Ignore corrupt history entries without exposing their contents.
    }
  }
  return records;
}

export function conversationTitle(conversation) {
  const firstUser = conversation?.messages?.find((message) => message.role === 'user');
  if (!firstUser?.content) return 'Untitled conversation';
  const oneLine = firstUser.content.replace(/\s+/g, ' ').trim();
  return oneLine.length > 56 ? `${oneLine.slice(0, 53)}...` : oneLine;
}

export async function resumeLatestConversation({ baseDir = MEMORY_DIR } = {}) {
  const current = await loadCurrentConversation({ baseDir });
  if (current.messages.length) return current;
  for (const filePath of await historyFiles(baseDir)) {
    try {
      const conversation = await readConversationFile(filePath);
      if (conversation?.messages.length) {
        await saveCurrentConversation(conversation, { baseDir });
        return conversation;
      }
    } catch {
      // Ignore corrupt history entries and continue to the next one.
    }
  }
  return current;
}
