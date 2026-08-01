import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendConversationMessage,
  clearCurrentConversation,
  listConversationHistory,
  loadCurrentConversation,
  resumeLatestConversation,
  selectContextMessages,
  startNewConversation,
} from '../src/memory.js';

async function withTempMemory(callback) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'luciano-memory-'));
  try {
    return await callback(baseDir);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

test('conversation messages persist locally with timestamps and safe permissions', async () => {
  await withTempMemory(async (baseDir) => {
    await appendConversationMessage({ role: 'user', content: 'Estoy creando una app' }, { baseDir });
    await appendConversationMessage({ role: 'assistant', content: 'Puedo ayudarte' }, { baseDir });

    const conversation = await loadCurrentConversation({ baseDir });
    assert.deepEqual(conversation.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'Estoy creando una app' },
      { role: 'assistant', content: 'Puedo ayudarte' },
    ]);
    assert.ok(conversation.messages.every((message) => typeof message.timestamp === 'string'));

    const currentPath = path.join(baseDir, 'conversations', 'current.json');
    const fileMode = (await stat(currentPath)).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.match(await readFile(currentPath, 'utf8'), /Estoy creando una app/);
  });
});

test('context selection keeps system messages and limits conversational messages', () => {
  const selected = selectContextMessages([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
  ], 2);

  assert.deepEqual(selected.map((message) => message.content), ['system', 'two', 'three']);
});

test('API keys and common credential formats are redacted and unsupported roles are not persisted', async () => {
  await withTempMemory(async (baseDir) => {
    await appendConversationMessage({
      role: 'user',
      content: 'key=nvapi-secret-value Authorization: Bearer abc.def token: private secret: hidden',
    }, { baseDir });
    await appendConversationMessage({ role: 'tool', content: 'private tool result' }, { baseDir });

    const conversation = await loadCurrentConversation({ baseDir });
    assert.equal(conversation.messages.length, 1);
    assert.equal(
      conversation.messages[0].content,
      'key=[REDACTED_SECRET] Authorization: Bearer [REDACTED_SECRET] token: [REDACTED_SECRET] secret: [REDACTED_SECRET]',
    );
  });
});

test('clear archives the current conversation and resume restores it', async () => {
  await withTempMemory(async (baseDir) => {
    await appendConversationMessage({ role: 'user', content: 'Debugging API' }, { baseDir });
    await clearCurrentConversation({ baseDir });

    assert.equal((await loadCurrentConversation({ baseDir })).messages.length, 0);
    assert.equal((await listConversationHistory({ baseDir })).length, 1);

    const resumed = await resumeLatestConversation({ baseDir });
    assert.equal(resumed.messages[0].content, 'Debugging API');
    assert.equal((await loadCurrentConversation({ baseDir })).messages[0].content, 'Debugging API');
  });
});

test('new conversation archives before creating a fresh current session', async () => {
  await withTempMemory(async (baseDir) => {
    await appendConversationMessage({ role: 'user', content: 'First session' }, { baseDir });
    await startNewConversation({ baseDir });
    await appendConversationMessage({ role: 'user', content: 'Second session' }, { baseDir });

    const history = await listConversationHistory({ baseDir });
    assert.equal(history.length, 2);
    assert.equal(history[0].title, 'Second session');
    assert.equal(history[1].title, 'First session');
  });
});

test('malformed current memory schema is quarantined instead of treated as empty', async () => {
  await withTempMemory(async (baseDir) => {
    const conversationsDir = path.join(baseDir, 'conversations');
    await mkdir(conversationsDir, { recursive: true });
    await writeFile(path.join(conversationsDir, 'current.json'), JSON.stringify({ messages: [{ role: 'user' }] }), 'utf8');

    const recovered = await loadCurrentConversation({ baseDir });
    assert.equal(recovered.messages.length, 0);
    assert.ok((await readdir(conversationsDir)).some((name) => name.startsWith('current.json.corrupt-')));
  });
});

test('corrupt current memory is quarantined instead of silently overwritten', async () => {
  await withTempMemory(async (baseDir) => {
    const conversationsDir = path.join(baseDir, 'conversations');
    await mkdir(conversationsDir, { recursive: true });
    await writeFile(path.join(conversationsDir, 'current.json'), '{not valid json', 'utf8');

    const recovered = await loadCurrentConversation({ baseDir });
    assert.equal(recovered.messages.length, 0);

    const files = await readdir(conversationsDir);
    const quarantined = files.find((name) => name.startsWith('current.json.corrupt-'));
    assert.ok(quarantined);
    assert.equal(await stat(path.join(conversationsDir, quarantined)).then((result) => result.mode & 0o777), 0o600);

    await appendConversationMessage({ role: 'user', content: 'Recovered safely' }, { baseDir });
    assert.match(await readFile(path.join(conversationsDir, 'current.json'), 'utf8'), /Recovered safely/);
    assert.match(await readFile(path.join(conversationsDir, quarantined), 'utf8'), /not valid json/);
  });
});
