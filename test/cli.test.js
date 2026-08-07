import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chooseCloudThread, createCli, parseCommandInput } from '../src/cli.js';
import { normalizeConfig } from '../src/config.js';
import { renderHelp } from '../src/ui/banner.js';
import { analysisToolRequestsFromListing } from '../src/agent.js';

test('only an actual leading slash creates an internal command', () => {
  assert.deepEqual(parseCommandInput('/help'), {
    type: 'command',
    command: 'help',
    args: [],
    text: '/help',
  });
  assert.deepEqual(parseCommandInput('/model set deepseek-ai/test'), {
    type: 'command',
    command: 'model',
    args: ['set', 'deepseek-ai/test'],
    text: '/model set deepseek-ai/test',
  });
});

test('ordinary messages, including leading whitespace, go to the agent path', () => {
  assert.deepEqual(parseCommandInput(' analiza este proyecto'), {
    type: 'prompt',
    text: 'analiza este proyecto',
  });
  assert.deepEqual(parseCommandInput('revisa mis archivos'), {
    type: 'prompt',
    text: 'revisa mis archivos',
  });
});

test('Cloud commands parse and help exposes all Cloud subcommands', async () => {
  assert.deepEqual(parseCommandInput('/cloud repos'), {
    type: 'command', command: 'cloud', args: ['repos'], text: '/cloud repos',
  });
  assert.deepEqual(parseCommandInput('/cloud threads blank'), {
    type: 'command', command: 'cloud', args: ['threads', 'blank'], text: '/cloud threads blank',
  });
  const help = renderHelp();
  assert.ok(help.includes('/cloud repos'));
  assert.ok(help.includes('/cloud threads'));
  assert.ok(help.includes('/cloud continue'));
  assert.ok(help.includes('/cloud use'));
  const output = { value: '', write(value) { this.value += value; } };
  const selected = await chooseCloudThread([
    { title: 'One', status: 'open', updatedAt: '2026-01-01', threadId: 'a' },
    { title: 'Two', status: 'done', updatedAt: '2026-01-02', threadId: 'b' },
  ], async () => '2', output);
  assert.equal(selected.threadId, 'b');
  assert.match(output.value, /Two/);
});

test('Cloud use resolves short repos to the documented fullName, including needs_approval', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const output = { isTTY: false, value: '', write(value) { this.value += String(value); } };
  const readlineInterface = new EventEmitter();
  readlineInterface.closed = false;
  readlineInterface.setPrompt = () => {};
  readlineInterface.prompt = () => {};
  readlineInterface.close = () => { readlineInterface.closed = true; };
  const calls = [];
  const cloudClient = {
    async listRepos() {
      calls.push(['repos']);
      return [{ repo: 'blank', fullName: 'Lucianopm24/blank' }];
    },
    async listThreads(repo) {
      calls.push(['threads', repo]);
      return [{ threadId: 'opaque-thread', title: 'Existing', status: 'needs_approval', updatedAt: '2026-01-01' }];
    },
    async getThread(repo, threadId) {
      calls.push(['thread', repo, threadId]);
      return { threadId, uiMessages: [], llmMessages: [] };
    },
  };
  createCli({ input, output, readlineInterface, cloudClient });
  readlineInterface.emit('line', '/cloud use blank');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [
    ['repos'],
    ['threads', 'Lucianopm24/blank'],
    ['thread', 'Lucianopm24/blank', 'opaque-thread'],
  ]);
  assert.match(output.value, /Cloud session loaded/);
});

test('Cloud use keeps a normal threadId 404 without an unnecessary fallback lookup', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const output = { isTTY: false, value: '', write(value) { this.value += String(value); } };
  const readlineInterface = new EventEmitter();
  readlineInterface.closed = false;
  readlineInterface.setPrompt = () => {};
  readlineInterface.prompt = () => {};
  readlineInterface.close = () => { readlineInterface.closed = true; };
  const normalThreadId = 'm17ezrjccssv1sfhtdpx53e8';
  const calls = [];
  const cloudClient = {
    async listRepos() {
      return [{ repo: 'blank', fullName: 'Lucianopm24/blank' }];
    },
    async listThreads() {
      calls.push(['threads']);
      return [];
    },
    async getThread() {
      calls.push(['thread']);
      const error = new Error('not found');
      error.status = 404;
      throw error;
    },
  };
  createCli({ input, output, readlineInterface, cloudClient });
  readlineInterface.emit('line', `/cloud use blank t ${normalThreadId}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [['thread']]);
  assert.match(output.value, /Thread not found/);
});

test('Cloud use retries a listed long threadId with its title after a 404', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const output = { isTTY: false, value: '', write(value) { this.value += String(value); } };
  const readlineInterface = new EventEmitter();
  readlineInterface.closed = false;
  readlineInterface.setPrompt = () => {};
  readlineInterface.prompt = () => {};
  readlineInterface.close = () => { readlineInterface.closed = true; };
  const longThreadId = 'm17ezrjccssv1sfhtdpx53e8m58c10qm';
  const calls = [];
  const cloudClient = {
    async listRepos() {
      return [{ repo: 'blank', fullName: 'Lucianopm24/blank' }];
    },
    async listThreads(repo) {
      calls.push(['threads', repo]);
      return [{ threadId: longThreadId, title: 'Fix the login redirect', status: 'done', updatedAt: '2026-01-01' }];
    },
    async getThread(repo, threadId) {
      calls.push(['thread', repo, threadId]);
      if (threadId === longThreadId) {
        const error = new Error('not found');
        error.status = 404;
        throw error;
      }
      return { threadId: longThreadId, title: threadId, uiMessages: [], llmMessages: [] };
    },
  };
  createCli({ input, output, readlineInterface, cloudClient });
  readlineInterface.emit('line', `/cloud use blank t ${longThreadId}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [
    ['thread', 'Lucianopm24/blank', longThreadId],
    ['threads', 'Lucianopm24/blank'],
    ['thread', 'Lucianopm24/blank', 'Fix the login redirect'],
  ]);
  assert.match(output.value, /Cloud session loaded/);
});

test('Cloud use synchronizes with the title when a long ID required the title fallback', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'luciano-cli-cloud-sync-'));
  const originalFetch = globalThis.fetch;
  const input = new EventEmitter();
  input.isTTY = false;
  const output = { isTTY: false, value: '', write(value) { this.value += String(value); } };
  const readlineInterface = new EventEmitter();
  readlineInterface.closed = false;
  readlineInterface.setPrompt = () => {};
  readlineInterface.prompt = () => {};
  readlineInterface.close = () => { readlineInterface.closed = true; };
  const longThreadId = 'm17ezrjccssv1sfhtdpx53e8m58c10qm';
  const calls = [];
  const cloudClient = {
    async listRepos() {
      return [{ repo: 'blank', fullName: 'Lucianopm24/blank' }];
    },
    async listThreads(repo) {
      calls.push(['threads', repo]);
      return [{ threadId: longThreadId, title: 'Hola!', status: 'done', updatedAt: '2026-01-01' }];
    },
    async getThread(repo, threadId) {
      calls.push(['thread', repo, threadId]);
      if (threadId === longThreadId) {
        const error = new Error('not found');
        error.status = 404;
        throw error;
      }
      return { threadId: longThreadId, title: threadId, uiMessages: [], llmMessages: [{ role: 'user', content: 'Previous' }] };
    },
    async appendMessages(repo, threadId, messages) {
      calls.push(['append', repo, threadId, messages]);
    },
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'Respuesta' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const config = normalizeConfig({
      apiKey: 'nvapi-test-key',
      nvidiaDataConsent: 'accepted',
      trustedPaths: [process.cwd()],
      preferences: { stream: false },
    });
    createCli({ input, output, readlineInterface, cloudClient, config, memoryBaseDir: baseDir });
    readlineInterface.emit('line', `/cloud use blank t ${longThreadId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    readlineInterface.emit('line', 'continúa');
    for (let attempt = 0; attempt < 20 && !calls.some((call) => call[0] === 'append'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(calls.slice(0, 4).map((call) => call.slice(0, 3)), [
      ['thread', 'Lucianopm24/blank', longThreadId],
      ['threads', 'Lucianopm24/blank'],
      ['thread', 'Lucianopm24/blank', 'Hola!'],
      ['append', 'Lucianopm24/blank', 'Hola!'],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('Cloud continue resolves the same canonical repo as threads and use', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const output = { isTTY: false, value: '', write(value) { this.value += String(value); } };
  const readlineInterface = new EventEmitter();
  readlineInterface.closed = false;
  readlineInterface.setPrompt = () => {};
  readlineInterface.prompt = () => {};
  readlineInterface.close = () => { readlineInterface.closed = true; };
  const calls = [];
  const cloudClient = {
    async listRepos() {
      calls.push(['repos']);
      return [{ repo: 'blank', fullName: 'Lucianopm24/blank' }];
    },
    async listThreads(repo) {
      calls.push(['threads', repo]);
      return [{ threadId: 'opaque-thread', title: 'Existing', status: 'done', updatedAt: '2026-01-01' }];
    },
    async getThread(repo, threadId) {
      calls.push(['thread', repo, threadId]);
      return { threadId, uiMessages: [], llmMessages: [] };
    },
  };
  createCli({ input, output, readlineInterface, cloudClient });
  readlineInterface.emit('line', '/cloud continue blank');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [
    ['repos'],
    ['threads', 'Lucianopm24/blank'],
    ['thread', 'Lucianopm24/blank', 'opaque-thread'],
  ]);
  assert.match(output.value, /Cloud session loaded/);
});

test('Cloud threads displays the real threadId for every session', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const output = { isTTY: false, value: '', write(value) { this.value += String(value); } };
  const readlineInterface = new EventEmitter();
  readlineInterface.closed = false;
  readlineInterface.setPrompt = () => {};
  readlineInterface.prompt = () => {};
  readlineInterface.close = () => { readlineInterface.closed = true; };
  const cloudClient = {
    async listRepos() {
      return [{ repo: 'blank', fullName: 'Lucianopm24/blank' }];
    },
    async listThreads(repo) {
      assert.equal(repo, 'Lucianopm24/blank');
      return [{ threadId: 'opaque-thread/with-symbols', title: 'Needs review', status: 'needs_approval', updatedAt: '2026-01-01' }];
    },
  };
  createCli({ input, output, readlineInterface, cloudClient });
  readlineInterface.emit('line', '/cloud threads blank');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(output.value, /Needs review/);
  assert.match(output.value, /ID: opaque-thread\/with-symbols/);
});

test('Cloud repos displays each repository fullName', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const output = { isTTY: false, value: '', write(value) { this.value += String(value); } };
  const readlineInterface = new EventEmitter();
  readlineInterface.closed = false;
  readlineInterface.setPrompt = () => {};
  readlineInterface.prompt = () => {};
  readlineInterface.close = () => { readlineInterface.closed = true; };
  const cloudClient = {
    async listRepos() {
      return [{ repo: 'blank', fullName: 'Lucianopm24/blank' }];
    },
  };
  createCli({ input, output, readlineInterface, cloudClient });
  readlineInterface.emit('line', '/cloud repos');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(output.value, /Lucianopm24\/blank/);
  assert.doesNotMatch(output.value, /Connected Cloud repositories\n· blank/);
});

test('analysis plans only real file reads and directory listings', () => {
  assert.deepEqual(analysisToolRequestsFromListing('Listing for .:\n(empty)'), []);
  assert.deepEqual(analysisToolRequestsFromListing('Listing for .:\nfile\tpackage.json\ndirectory\tsrc'), [
    { tool: 'read_file', arguments: { path: 'package.json' } },
    { tool: 'list_files', arguments: { path: 'src' } },
  ]);
  assert.deepEqual(analysisToolRequestsFromListing('Listing for src:\nfile\tindex.js', 'src'), [
    { tool: 'read_file', arguments: { path: 'src/index.js' } },
  ]);
});
