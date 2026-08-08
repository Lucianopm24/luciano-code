import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt } from '../src/agent.js';
import { createCli } from '../src/cli.js';
import {
  fetchAccountSettings,
  saveAuth,
  updateAccountConfig,
  updateAccountKey,
  updateAccountModel,
  updateAccountSystemPrompt,
} from '../src/auth.js';
import { normalizeConfig } from '../src/config.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function fakeReadline() {
  const readlineInterface = new EventEmitter();
  readlineInterface.closed = false;
  readlineInterface.setPrompt = () => {};
  readlineInterface.prompt = () => {};
  readlineInterface.close = () => { readlineInterface.closed = true; };
  return readlineInterface;
}

async function withTempAuth(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'luciano-config-sync-'));
  try {
    return await callback(path.join(directory, 'auth.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('custom system prompt is appended after the untouched base prompt', () => {
  const base = buildSystemPrompt(normalizeConfig());
  const custom = buildSystemPrompt(normalizeConfig({ systemPrompt: 'Always answer with a checklist.' }));
  assert.equal(custom.startsWith(base), true);
  assert.match(custom, /Always format the final response as Markdown/);
  assert.match(custom, /\n---\nEl usuario te ha dado unas instrucciones personalizadas, que son:\nAlways answer with a checklist\./);
  assert.ok(custom.indexOf('\n---\n') > custom.indexOf('Web search endpoint'));
});

test('account settings requests use the production CLI endpoints and bearer token', async () => {
  await withTempAuth(async (authPath) => {
    await saveAuth({ token: 'session-token' }, { authPath });
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/cli/key')) return response({ ok: true, apiKey: 'nvapi-account', model: 'account-model' });
      if (url.endsWith('/cli/config')) return response({ ok: true, blob: '{"preferences":{"maxTokens":1234}}' });
      return response({ ok: true, prompt: 'Account instructions' });
    };
    const settings = await fetchAccountSettings('session-token', {
      fetchImpl,
      siteUrl: 'https://backend.test/',
    });
    assert.equal(settings.key.apiKey, 'nvapi-account');
    assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
      ['https://backend.test/cli/key', 'POST'],
      ['https://backend.test/cli/config', 'GET'],
      ['https://backend.test/cli/systemprompt', 'GET'],
    ]);
    for (const call of calls) assert.equal(call.options.headers.Authorization, 'Bearer session-token');
    assert.equal(calls[0].options.headers['Content-Type'], undefined);
  });
});

test('account setting writes send the exact endpoint bodies', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ ok: true });
  };
  const options = { fetchImpl, siteUrl: 'https://backend.test' };
  await updateAccountKey('token', 'nvapi-local', options);
  await updateAccountModel('token', 'local-model', options);
  await updateAccountConfig('token', '{"preferences":{"maxTokens":999}}', options);
  await updateAccountSystemPrompt('token', '', options);
  assert.deepEqual(calls.map(({ url, options: request }) => [url, JSON.parse(request.body)]), [
    ['https://backend.test/cli/key', { apiKey: 'nvapi-local' }],
    ['https://backend.test/cli/model', { model: 'local-model' }],
    ['https://backend.test/cli/config', { blob: '{"preferences":{"maxTokens":999}}' }],
    ['https://backend.test/cli/systemprompt', { prompt: '' }],
  ]);
});

test('config prompt commands stay local and update the current session system message', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const output = { isTTY: false, value: '', write(value) { this.value += String(value); } };
  const readlineInterface = fakeReadline();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'luciano-config-memory-'));
  const config = normalizeConfig({ trustedPaths: [process.cwd()] });
  const cli = createCli({ input, output, config, memoryBaseDir: baseDir, readlineInterface });
  try {
    readlineInterface.emit('line', '/config prompt Follow these rules');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cli.getConfig().systemPrompt, 'Follow these rules');
    assert.match(output.value, /saved and active/);
    readlineInterface.emit('line', '/config prompt');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(output.value, /Follow these rules/);
    readlineInterface.emit('line', '/config prompt clear');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cli.getConfig().systemPrompt, null);
    assert.match(output.value, /cleared/);
  } finally {
    cli.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});
