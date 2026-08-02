import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createToolAuthorizer,
  executeTool,
  formatToolRequest,
  parseToolRequest,
  TOOL_DEFINITIONS,
} from '../src/tools.js';
import { appendCommandExecution } from '../src/memory.js';

function fakeTerminal() {
  let output = '';
  return {
    input: { isTTY: true },
    output: {
      isTTY: true,
      write(value) {
        output += String(value);
        return true;
      },
      toString() {
        return output;
      },
    },
    readlineInterface: { closed: false },
  };
}

test('execute_command is exposed as a native tool and parsed from JSON', () => {
  assert.ok(TOOL_DEFINITIONS.some(({ function: definition }) => definition.name === 'execute_command'));
  assert.deepEqual(parseToolRequest('{"tool":"execute_command","arguments":{"command":"node --version"}}'), {
    tool: 'execute_command',
    arguments: { command: 'node --version' },
  });
});

test('execute_command cannot run without explicit authorization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'luciano-command-auth-'));
  try {
    await assert.rejects(
      executeTool(root, { tool: 'execute_command', arguments: { command: 'node --version' } }),
      /explicit user authorization/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('authorizer approves once, rejects by default, and supports session approval', async () => {
  const terminal = fakeTerminal();
  const answers = ['y', 'n', 'a'];
  const prompts = [];
  const authorize = createToolAuthorizer({
    ...terminal,
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
  });
  const request = { tool: 'execute_command', arguments: { command: 'npm install' } };

  assert.deepEqual(await authorize(request), { approved: true });
  assert.deepEqual(await authorize(request), { approved: false, reason: 'The user rejected this tool request.' });
  assert.deepEqual(await authorize(request), { approved: true });
  assert.deepEqual(await authorize({ tool: 'execute_command', arguments: { command: 'npm test' } }), { approved: true });
  assert.match(terminal.output.toString(), /execute command\nnpm install/);
  assert.match(prompts.join(''), /Allow\? \[y\/N\/a\]/);
  assert.match(terminal.output.toString(), /Tools approved for the rest of this session/);
  assert.equal(formatToolRequest(request).includes('npm install'), true);
});

test('execute_command captures stdout, stderr, exit code, and working directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'luciano-command-run-'));
  try {
    const result = await executeTool(root, {
      tool: 'execute_command',
      arguments: {
        command: `node -e "process.stdout.write('out'); process.stderr.write('err'); process.exitCode=3"`,
      },
    }, { authorized: true });

    assert.match(result, /Command failed \(exit code 3\)/);
    assert.match(result, /stdout:\nout/);
    assert.match(result, /stderr:\nerr/);
    assert.match(result, /cwd: \./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('command executions are recorded as redacted JSONL memory', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'luciano-command-memory-'));
  try {
    await appendCommandExecution({
      command: 'echo token=nvapi-secret',
      cwd: '.',
      stdout: 'token=nvapi-output',
      stderr: 'none',
      exitCode: 0,
    }, { baseDir });
    const raw = await readFile(path.join(baseDir, 'commands.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim());
    assert.equal(record.exitCode, 0);
    assert.equal(record.command, 'echo token=[REDACTED_SECRET]');
    assert.equal(record.stdout, 'token=[REDACTED_SECRET]');
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
