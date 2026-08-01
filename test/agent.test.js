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
