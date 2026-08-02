import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveRenderer,
  createStreamTextAccumulator,
  supportsInPlaceUpdates,
} from '../src/ui/stream-renderer.js';
import { renderMarkdownLine } from '../src/ui/markdown.js';
import { stripAnsi } from '../src/ui/colors.js';

function createOutput(isTTY) {
  let value = '';
  return {
    isTTY,
    write(chunk) {
      value += chunk;
      return true;
    },
    toString() {
      return value;
    },
  };
}

function createSpinner() {
  return {
    started: false,
    clear() {},
  };
}

test('normal deltas are rendered once in order', () => {
  const accumulator = createStreamTextAccumulator();
  const deltas = ['Hola', ', soy', ' Luciano'].map((chunk) => accumulator.push(chunk));

  assert.deepEqual(deltas, ['Hola', ', soy', ' Luciano']);
  assert.equal(accumulator.text, 'Hola, soy Luciano');
  assert.equal(accumulator.mode, 'delta');
});

test('cumulative snapshots emit only their new suffix', () => {
  const accumulator = createStreamTextAccumulator();
  const deltas = ['Hola', 'Hola, soy', 'Hola, soy Luciano'].map((chunk) => accumulator.push(chunk));

  assert.deepEqual(deltas, ['Hola', '', ', soy Luciano']);
  assert.equal(accumulator.text, 'Hola, soy Luciano');
  assert.equal(accumulator.mode, 'cumulative');
});

test('repeated delta chunks are preserved before a stream format is known', () => {
  const accumulator = createStreamTextAccumulator();
  const deltas = ['A', 'A', 'A'].map((chunk) => accumulator.push(chunk));

  assert.deepEqual(deltas, ['A', 'A', 'A']);
  assert.equal(accumulator.text, 'AAA');
  assert.equal(accumulator.mode, 'delta');
});

test('ambiguous delta growth is not lost when it arrives only once', () => {
  const accumulator = createStreamTextAccumulator();
  const deltas = ['A', 'AB'].map((chunk) => accumulator.push(chunk));
  deltas.push(accumulator.finish());

  assert.deepEqual(deltas, ['A', '', 'B']);
  assert.equal(accumulator.text, 'AB');
});

test('stale cumulative snapshots are ignored', () => {
  const accumulator = createStreamTextAccumulator();
  const deltas = ['Hola', 'Hola, soy', 'Hola', 'Hola, soy Luciano']
    .map((chunk) => accumulator.push(chunk));

  assert.deepEqual(deltas, ['Hola', '', '', ', soy Luciano']);
  assert.equal(accumulator.text, 'Hola, soy Luciano');
});

test('repeated cumulative snapshots do not create repeated assistant output', () => {
  const accumulator = createStreamTextAccumulator();
  const deltas = ['Hola', 'Hola, soy', 'Hola, soy', 'Hola, soy Luciano']
    .map((chunk) => accumulator.push(chunk));

  assert.deepEqual(deltas, ['Hola', '', '', ', soy Luciano']);
  assert.equal(accumulator.text, 'Hola, soy Luciano');
});

test('renderer preserves NVIDIA-style incremental deltas immediately', () => {
  const output = createOutput(false);
  const renderer = createLiveRenderer(output, createSpinner());

  for (const chunk of ['Ho', 'la', ' mun', 'do']) {
    renderer.writeResponse(chunk);
  }

  assert.equal(stripAnsi(output.toString()), 'Assistant › Hola mundo');
  renderer.finish();
  assert.equal(stripAnsi(output.toString()), 'Assistant › Hola mundo\n');
});

test('ANSI in-place updates are conservative across Windows terminals', () => {
  const tty = { isTTY: true };
  assert.equal(supportsInPlaceUpdates(tty, { platform: 'win32', env: { WT_SESSION: '1' } }), true);
  assert.equal(supportsInPlaceUpdates(tty, { platform: 'win32', env: {} }), false);
  assert.equal(supportsInPlaceUpdates(tty, { platform: 'linux', env: {} }), true);
  assert.equal(supportsInPlaceUpdates({ isTTY: false }, { platform: 'linux', env: {} }), false);
});

test('non-TTY renderer preserves each normalized streamed delta once', () => {
  const output = createOutput(false);
  const renderer = createLiveRenderer(output, createSpinner());

  for (const chunk of ['Hola', ', soy', ' Luciano']) renderer.writeResponse(chunk);
  renderer.finish();

  const plain = stripAnsi(output.toString());
  assert.equal(plain, 'Assistant › Hola, soy Luciano\n');
  assert.equal((plain.match(/Assistant ›/g) || []).length, 1);
});

test('TTY renderer streams one response without ANSI repaint duplication', () => {
  const output = createOutput(true);
  const renderer = createLiveRenderer(output, createSpinner());

  for (const chunk of ['Hola', ', soy', ' Luciano']) renderer.writeResponse(chunk);
  renderer.finish();

  const plain = stripAnsi(output.toString());
  assert.equal(plain, 'Assistant › Hola, soy Luciano\n');
  assert.equal((plain.match(/Assistant ›/g) || []).length, 1);
  assert.doesNotMatch(output.toString(), /\r\u001b\[2K/);
});

test('TTY multiline response keeps one Assistant prefix and continuation indentation', () => {
  const output = createOutput(true);
  const renderer = createLiveRenderer(output, createSpinner());

  for (const chunk of ['Hello\n', 'this is ', 'a test\n', 'Goodbye']) renderer.writeResponse(chunk);
  renderer.finish();

  const plain = stripAnsi(output.toString());
  assert.equal((plain.match(/Assistant ›/g) || []).length, 1);
  assert.match(plain, /Assistant › Hello/);
  assert.match(plain, /this is a test/);
  assert.match(plain, /Goodbye/);
  assert.doesNotMatch(output.toString(), /\r\u001b\[2K/);
});

test('streaming Markdown renders complete lines and keeps code-block state', () => {
  const state = { inCode: false, codeLanguage: '' };
  const heading = stripAnsi(renderMarkdownLine('# Title', state));
  const codeStart = stripAnsi(renderMarkdownLine('```js', state));
  const codeLine = stripAnsi(renderMarkdownLine('const answer = 42;', state));
  const codeEnd = stripAnsi(renderMarkdownLine('```', state));

  assert.match(heading, /Title/);
  assert.match(codeStart, /js/);
  assert.equal(codeLine, '│ const answer = 42;');
  assert.match(codeEnd, /╰/);
});
