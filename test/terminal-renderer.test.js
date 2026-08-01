import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalRenderer, getTerminalStream } from '../src/ui/terminal-renderer.js';
import { stripAnsi } from '../src/ui/colors.js';

function createOutput() {
  let value = '';
  return {
    isTTY: false,
    write(chunk) {
      value += chunk;
      return true;
    },
    toString() {
      return value;
    },
  };
}

test('readline receives the underlying stream rather than the renderer wrapper', () => {
  const output = createOutput();
  const renderer = createTerminalRenderer(output);

  assert.notEqual(renderer, output);
  assert.equal(typeof renderer.on, 'undefined');
  assert.equal(getTerminalStream(renderer), output);
});

test('duplicate tool events are rendered once per stable event scope', () => {
  const output = createOutput();
  const renderer = createTerminalRenderer(output);
  const request = { tool: 'list_files', arguments: { path: '.' } };

  renderer.toolCompleted(request, { eventId: 'provider-event-1' });
  renderer.toolCompleted(request, { eventId: 'provider-event-1' });

  const plain = stripAnsi(output.toString());
  assert.equal((plain.match(/list_files completed\./g) || []).length, 1);
});

test('separate tool executions remain visible', () => {
  const output = createOutput();
  const renderer = createTerminalRenderer(output);
  const request = { tool: 'list_files', arguments: { path: '.' } };

  renderer.toolCompleted(request, { eventId: 'provider-event-1' });
  renderer.toolCompleted(request, { eventId: 'provider-event-2' });

  const plain = stripAnsi(output.toString());
  assert.equal((plain.match(/list_files completed\./g) || []).length, 2);
});

test('textual executions without an event id are not globally suppressed', () => {
  const output = createOutput();
  const renderer = createTerminalRenderer(output);
  const request = { tool: 'list_files', arguments: { path: '.' } };

  renderer.toolCompleted(request);
  renderer.toolCompleted(request);

  const plain = stripAnsi(output.toString());
  assert.equal((plain.match(/list_files completed\./g) || []).length, 2);
});
