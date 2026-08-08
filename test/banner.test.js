import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renderBanner } from '../src/ui/banner.js';
import { stripAnsi } from '../src/ui/colors.js';

const CODER_ART = [
  '████████████',
  '██        ██',
  '██  ██  ██ ██',
  '██  ██  ██ ██',
  '██        ██',
  '██  ██████ ██',
  '██        ██',
  '████████████',
  '    ██  ██',
  '    ██  ██',
  '    ██  ██',
].join('\n');

test('startup renders the exact fixed Coder art centered without a container', () => {
  const width = 80;
  const rendered = stripAnsi(renderBanner({}, width));
  const lines = rendered.split('\n').slice(1, -1);
  const expectedLeftPadding = ' '.repeat(Math.floor((width - 13) / 2));

  assert.equal(lines.length, 11);
  assert.equal(lines.join('\n'), CODER_ART.split('\n').map((line) => `${expectedLeftPadding}${line}`).join('\n'));
  assert.doesNotMatch(rendered, /LUCIANO CODE|terminal workspace|Your AI coding partner|╭|╮|╰|╯/);
});

test('startup keeps Coder green when terminal color is enabled', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', [
    "import { renderBanner } from './src/ui/banner.js';",
    "process.stdout.write(renderBanner({}, 80));",
  ].join(' ')], {
    env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: undefined },
    encoding: 'utf8',
  });

  assert.match(output, /\u001b\[38;5;114m████████████\u001b\[0m/);
});

test('startup hides Coder completely when the fixed art does not fit', () => {
  assert.equal(renderBanner({}, 12), '');
  assert.equal(renderBanner({}, 1), '');
});

test('startup keeps Coder unmodified at its minimum fitting width', () => {
  const rendered = stripAnsi(renderBanner({}, 14));
  assert.equal(rendered.startsWith('\n'), true);
  assert.equal(rendered.slice(1, -1), CODER_ART);
});
