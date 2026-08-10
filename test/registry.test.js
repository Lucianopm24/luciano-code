import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCli } from '../src/cli.js';
import { RegistryClient, collectSkillFiles } from '../src/registry.js';
import { saveAuth } from '../src/auth.js';
import { renderHelp } from '../src/ui/banner.js';

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

function fakeReadline() {
  const value = new EventEmitter();
  value.closed = false;
  value.setPrompt = () => {};
  value.prompt = () => {};
  value.close = () => { value.closed = true; };
  return value;
}

async function withAuth(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'luciano-registry-'));
  const authPath = path.join(dir, 'auth.json');
  try {
    await saveAuth({ token: 'registry-token' }, { authPath });
    return await callback(authPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('registry client uses bearer auth and user-facing endpoints only', async () => {
  await withAuth(async (authPath) => {
    const calls = [];
    const client = new RegistryClient({ authPath, siteUrl: 'https://backend.test/', fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/prompts/search')) return response({ ok: true, prompts: [{ slug: '@me/test', description: 'A prompt' }] });
      return response({ ok: true, slug: '@me/test', version: 1, status: 'approved' });
    } });
    const found = await client.searchPrompts({ q: 'code', tag: 'review' });
    await client.publishPrompt({ slug: '@me/test', content: 'Be concise', visibility: 'private', tags: ['Review'] });
    assert.equal(found.prompts[0].slug, '@me/test');
    assert.match(calls[0].url, /\/cli\/prompts\/search\?q=code&tag=review/);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer registry-token');
    assert.equal(calls[1].url, 'https://backend.test/cli/prompts/publish');
    assert.equal(JSON.parse(calls[1].options.body).tags[0], 'review');
    assert.ok(calls.every(({ url }) => !url.includes('/review')));
  });
});

test('collectSkillFiles recursively skips secrets and enforces safe paths', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'luciano-skill-'));
  try {
    await mkdir(path.join(dir, 'lib'));
    await mkdir(path.join(dir, 'node_modules'));
    await writeFile(path.join(dir, 'index.js'), 'module.exports = {};');
    await writeFile(path.join(dir, 'lib', 'helper.js'), 'export const ok = true;');
    await writeFile(path.join(dir, '.env'), 'SECRET=bad');
    await writeFile(path.join(dir, 'node_modules', 'ignored.js'), 'ignored');
    await assert.rejects(() => collectSkillFiles(dir, { workspaceRoot: dir }), /blocked path segment/i);
    await rm(path.join(dir, 'node_modules'), { recursive: true, force: true });
    await rm(path.join(dir, '.env'));
    await assert.rejects(() => collectSkillFiles('.git', { workspaceRoot: process.cwd() }), /unsafe skill file path/i);
    const files = await collectSkillFiles(dir, { workspaceRoot: dir });
    assert.deepEqual(files.map((file) => file.path), ['index.js', 'lib/helper.js']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normal CLI exposes prompts and skills but no admin review surface', () => {
  const help = renderHelp();
  assert.match(help, /\/prompts/);
  assert.match(help, /\/skills/);
  assert.doesNotMatch(help, /review|admin|REGISTRY_ADMIN_EMAILS/i);
});

test('CLI routes /prompts search and /skills list without exposing admin commands', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const output = { isTTY: false, value: '', write(value) { this.value += String(value); } };
  const readlineInterface = fakeReadline();
  const calls = [];
  const registryClient = {
    async searchPrompts(query) { calls.push(['searchPrompts', query]); return { prompts: [{ slug: '@me/reviewer', description: 'Review code', status: 'approved' }] }; },
    async listSkills(query) { calls.push(['listSkills', query]); return { skills: [{ slug: '@me/git', description: 'Git helper', status: 'approved' }] }; },
  };
  const cli = createCli({ input, output, readlineInterface, registryClient });
  try {
    readlineInterface.emit('line', '/prompts search code --tag review');
    readlineInterface.emit('line', '/skills list --mine');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(calls, [
      ['searchPrompts', { q: 'code', tag: 'review' }],
      ['listSkills', { mine: true, visibility: undefined, search: undefined }],
    ]);
    assert.match(output.value, /@me\/reviewer/);
    assert.match(output.value, /@me\/git/);
    assert.doesNotMatch(output.value, /Admin review|REGISTRY_ADMIN_EMAILS/);
  } finally {
    cli.close();
  }
});
