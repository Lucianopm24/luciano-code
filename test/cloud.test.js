import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveAuth } from '../src/auth.js';
import {
  CloudClient,
  findCloudRepo,
  normalizeCloudRepos,
  normalizeCloudThreads,
  validateCloudRepo,
} from '../src/cloud.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

async function withAuth(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'luciano-cloud-'));
  const authPath = path.join(dir, 'auth.json');
  try {
    await saveAuth({ token: 'cloud-token' }, { authPath });
    return await callback(authPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Cloud accepts simple repo names and matches connected repos case-insensitively', async () => {
  assert.equal(validateCloudRepo('Owner/Repo'), 'Owner/Repo');
  assert.equal(validateCloudRepo('  Blank '), 'Blank');
  assert.equal(validateCloudRepo('blank'), 'blank');
  const repos = normalizeCloudRepos({ repos: [{ repo: 'blank', fullName: 'Lucianopm24/Blank' }] });
  assert.equal(repos[0].repo, 'Lucianopm24/Blank');
  assert.equal(repos[0].fullName, 'Lucianopm24/Blank');
  assert.equal(normalizeCloudRepos({ repos: [{ owner: 'Lucianopm24', repo: 'Blank' }] })[0].fullName, 'Lucianopm24/Blank');
  assert.equal(findCloudRepo(repos, '  lucianopm24/blank ')?.fullName, 'Lucianopm24/Blank');
  assert.equal(findCloudRepo([
    { fullName: 'owner-a/blank' },
    { fullName: 'owner-b/blank' },
  ], 'owner-b/blank')?.fullName, 'owner-b/blank');
  assert.equal(findCloudRepo([
    { fullName: 'owner-a/blank' },
    { fullName: 'owner-b/blank' },
  ], 'blank'), null);
  assert.throws(() => validateCloudRepo('Owner Repo'), /repo|repository/i);
  assert.throws(() => validateCloudRepo('Owner\\Repo'), /repo|repository/i);
  assert.deepEqual(normalizeCloudThreads({ threads: [{ threadId: 'opaque/with?symbols', title: 'Work', status: 'open', updatedAt: '2026-01-01' }] }), [
    { threadId: 'opaque/with?symbols', title: 'Work', status: 'open', updatedAt: '2026-01-01' },
  ]);
});

test('Cloud uses convex.site, login Bearer, query parameters, and filters POST roles', async () => {
  await withAuth(async (authPath) => {
    const calls = [];
    const client = new CloudClient({
      authPath,
      siteUrl: 'https://production.convex.cloud/',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (options.method === 'POST') return response({ ok: true });
        if (url.includes('/threads')) return response({ ok: true, threads: [{ threadId: 'opaque-id', title: 'T', status: 'open', updatedAt: '2026-01-01' }] });
        return response({ ok: true, uiMessages: [], llmMessages: [] });
      },
    });

    await client.listThreads('Owner/Repo');
    await client.getThread('Owner/Repo', 'opaque-id');
    await client.appendMessages('Owner/Repo', 'opaque-id', [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
      { role: 'tool', content: 'secret internal context' },
    ]);

    assert.ok(calls.every(({ url }) => url.startsWith('https://production.convex.site/')));
    assert.match(calls[0].url, /repo=Owner%2FRepo/);
    assert.match(calls[1].url, /threadId=opaque-id/);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer cloud-token');
    const body = JSON.parse(calls[2].options.body);
    assert.deepEqual(body.messages, [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ]);
  });
});

test('Cloud treats ok:false and HTTP errors as errors with status', async () => {
  await withAuth(async (authPath) => {
    const client = new CloudClient({
      authPath,
      siteUrl: 'https://production.convex.site',
      fetchImpl: async () => response({ ok: false, error: 'not accessible' }, 404),
    });
    await assert.rejects(() => client.getThread('Owner/Repo', 'opaque'), (error) => error.status === 404);
  });
});
