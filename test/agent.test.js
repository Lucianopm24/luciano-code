import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPrompt } from '../src/agent.js';
import { normalizeConfig } from '../src/config.js';

function createOutput() {
  let value = '';
  return {
    isTTY: false,
    write(chunk) {
      value += String(chunk);
      return true;
    },
    toString() {
      return value;
    },
  };
}

test('cloud history restores camelCase tool fields before sending to NVIDIA', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'luciano-agent-cloud-history-'));
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Continuing the session' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const config = normalizeConfig({
      apiKey: 'nvapi-test-key',
      nvidiaDataConsent: 'accepted',
      trustedPaths: [process.cwd()],
      preferences: { stream: false, contextMessages: 20 },
    });
    const toolCalls = [{
      id: 'call_1',
      type: 'function',
      function: { name: 'write_file', arguments: '{"path":"README.md"}' },
    }];

    await runPrompt('Continue from Cloud', config, createOutput(), {
      input: { isTTY: false },
      memoryBaseDir: baseDir,
      cloudLlmMessages: [
        { role: 'user', content: 'Previous request' },
        { role: 'assistant', content: null, toolCalls: JSON.stringify(toolCalls) },
        { role: 'tool', content: 'Wrote README.md.', toolCallId: 'call_1' },
      ],
    });

    const messages = requestBody.messages;
    assert.deepEqual(messages[2].tool_calls, toolCalls);
    assert.equal(messages[3].tool_call_id, 'call_1');
    assert.equal('toolCalls' in messages[2], false);
    assert.equal('toolCallId' in messages[3], false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('generic NVIDIA 400 errors do not trigger the native-tool fallback', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'luciano-agent-400-'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'missing field tool_call_id' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const config = normalizeConfig({
      apiKey: 'nvapi-test-key',
      nvidiaDataConsent: 'accepted',
      trustedPaths: [process.cwd()],
      preferences: { stream: false },
    });
    const output = createOutput();
    await runPrompt('Trigger an API validation error', config, output, {
      input: { isTTY: false },
      memoryBaseDir: baseDir,
    });

    assert.equal(calls, 1);
    assert.match(output.toString(), /missing field tool_call_id/);
    assert.doesNotMatch(output.toString(), /using JSON tool mode/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('unsupported-tool errors still activate the JSON tool fallback', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'luciano-agent-tools-fallback-'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (body.tools) {        return new Response(JSON.stringify({ error: { message: 'This model does not support tool calling' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'JSON mode answer' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const config = normalizeConfig({
      apiKey: 'nvapi-test-key',
      nvidiaDataConsent: 'accepted',
      trustedPaths: [process.cwd()],
      preferences: { stream: false },
    });
    const output = createOutput();
    await runPrompt('Use JSON fallback', config, output, {
      input: { isTTY: false },
      memoryBaseDir: baseDir,
    });
    assert.equal(calls, 2);
    assert.match(output.toString(), /using JSON tool mode/);
    assert.match(output.toString(), /JSON mode answer/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('second prompt sends previous local user and assistant messages to NVIDIA', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'luciano-agent-memory-'));
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: requests.length === 1 ? 'First answer' : 'Second answer' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const config = normalizeConfig({
      apiKey: 'nvapi-test-key',
      nvidiaDataConsent: 'accepted',
      trustedPaths: [process.cwd()],
      preferences: { stream: false, contextMessages: 20 },
    });

    await runPrompt('First prompt', config, createOutput(), {
      input: { isTTY: false },
      memoryBaseDir: baseDir,
    });
    await runPrompt('Second prompt', config, createOutput(), {
      input: { isTTY: false },
      memoryBaseDir: baseDir,
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests[1].messages.filter((message) => message.role !== 'system').map((message) => [message.role, message.content]),
      [
        ['user', 'First prompt'],
        ['assistant', 'First answer'],
        ['user', 'Second prompt'],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(baseDir, { recursive: true, force: true });
  }
});
