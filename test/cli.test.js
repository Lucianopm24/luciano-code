import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandInput } from '../src/cli.js';
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
