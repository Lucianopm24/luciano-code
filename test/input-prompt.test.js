import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInputPrompt, renderSubmittedPrompt } from '../src/cli.js';
import { STARTUP_BREATHING_LINES } from '../src/index.js';
import { stripAnsi } from '../src/ui/colors.js';

test('input prompt is a green You box with an editable content row', () => {
  const prompt = stripAnsi(renderInputPrompt({ columns: 80 }));

  assert.match(prompt, /╭─ You/);
  assert.match(prompt, /│/);
  assert.match(prompt, /╰/);
  assert.doesNotMatch(prompt, /\| hello/);
});

test('input box width responds to smaller terminals without becoming an outer app panel', () => {
  const prompt = stripAnsi(renderInputPrompt({ columns: 30 }));
  const frameLines = prompt.replace(/\r/g, '').split('\n');

  assert.match(prompt, /╭─ You/);
  assert.ok(frameLines.filter(Boolean).every((line) => line.replace(/\r/g, '').length <= 34));
});

test('submitted input removes the temporary frame and becomes conversation history', () => {
  const submitted = stripAnsi(renderSubmittedPrompt({ columns: 80 }, 'Ayúdame con auth.js'));

  assert.match(submitted, /\| Ayúdame con auth\.js/);
  assert.doesNotMatch(submitted, /You|╭|╮|╰|╯/);
});

test('startup breathing room is approximately fifty blank lines', () => {
  assert.equal(STARTUP_BREATHING_LINES, 50);
});
