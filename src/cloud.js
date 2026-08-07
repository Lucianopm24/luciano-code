import { clearAuth, clearSessionApiKey, getConvexSiteUrl, loadAuth } from './auth.js';

export const CLOUD_SESSION_EXPIRED_MESSAGE = 'Session expired, run /login again';
export const CLOUD_THREAD_NOT_FOUND_MESSAGE = 'Thread not found or not accessible';

function cloudSiteUrl(siteUrl = getConvexSiteUrl()) {
  const value = String(siteUrl || '').trim().replace(/\/+$/, '');
  // Cloud's HTTP API is exposed from the production .convex.site host. Never
  // silently send a CLI Cloud request to the Convex deployment host.
  return value.replace(/\.convex\.cloud(?=\/|$)/i, '.convex.site');
}

function endpoint(pathname, siteUrl) {
  return `${cloudSiteUrl(siteUrl)}${pathname}`;
}

function errorWithStatus(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readCloudResponse(response, description) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw errorWithStatus(`${description} returned invalid JSON.`, response.status);
  }

  const bodyError = payload && payload.ok === false ? payload.error : null;
  if (!response.ok || payload?.ok !== true || bodyError) {
    throw errorWithStatus(
      `${description} failed: ${bodyError || `HTTP ${response.status}`}`,
      response.status,
    );
  }
  return payload;
}

export function validateCloudRepo(repo) {
  const value = typeof repo === 'string' ? repo.trim() : '';
  if (value.includes('\\') || !/^[^/\s]+(?:\/[^/\s]+)?$/.test(value)) {
    throw errorWithStatus('Repository name is required and may be `repo` or `owner/repo`.', 400);
  }
  return value;
}

function unwrap(payload, key) {
  if (payload && Array.isArray(payload[key])) return payload[key];
  if (payload?.data && Array.isArray(payload.data[key])) return payload.data[key];
  if (payload?.data && Array.isArray(payload.data)) return payload.data;
  return [];
}

function repoName(value) {
  if (typeof value === 'string') return value;
  if (value?.fullName) return value.fullName;
  if (value?.owner && value?.repo) return `${value.owner}/${value.repo}`;
  return value?.repo || value?.repository || value?.name || '';
}

export function normalizeCloudRepos(payload) {
  return unwrap(payload, 'repos')
    .map((repo) => {
      const fullName = repoName(repo).trim();
      return {
        raw: repo,
        repo: fullName,
        fullName,
      };
    })
    .filter(({ repo }) => repo.length > 0);
}

export function findCloudRepo(repos, requestedRepo) {
  const normalizedRequested = String(requestedRepo ?? '').trim().toLowerCase();
  if (!normalizedRequested) return null;
  const requestedName = normalizedRequested.split('/').pop();
  const candidates = (Array.isArray(repos) ? repos : []).map((item) => {
    const names = [item?.fullName, item?.repo]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase());
    return { item, names };
  });

  // An explicit owner/repo is authoritative. Never let a same-name repo from
  // another owner win through the short-name fallback.
  if (normalizedRequested.includes('/')) {
    return candidates.find(({ names }) => names.includes(normalizedRequested))?.item || null;
  }

  const matches = candidates.filter(({ names }) => names.some((candidate) => (
    candidate === normalizedRequested || candidate.split('/').pop() === requestedName
  )));
  // A short name is only safe when it identifies one connected repository.
  return matches.length === 1 ? matches[0].item : null;
}

function threadId(value) {
  if (typeof value === 'string') return value;
  return value?.threadId ?? value?.id ?? '';
}

export function normalizeCloudThreads(payload) {
  return unwrap(payload, 'threads')
    .map((thread) => ({
      ...((thread && typeof thread === 'object') ? thread : {}),
      threadId: threadId(thread),
      title: typeof thread?.title === 'string' && thread.title.trim() ? thread.title : 'Untitled Cloud session',
      status: typeof thread?.status === 'string' && thread.status.trim() ? thread.status : 'unknown',
      updatedAt: thread?.updatedAt || thread?.updated_at || null,
    }))
    .filter((thread) => typeof thread.threadId === 'string' && thread.threadId.length > 0);
}

function messageList(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeCloudThread(payload) {
  const source = payload?.thread && typeof payload.thread === 'object'
    ? { ...payload, ...payload.thread }
    : payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? { ...payload, ...payload.data }
      : payload || {};
  return {
    ...source,
    uiMessages: messageList(source.uiMessages),
    llmMessages: messageList(source.llmMessages),
  };
}

export class CloudClient {
  constructor({
    fetchImpl = globalThis.fetch,
    siteUrl = getConvexSiteUrl(),
    authPath,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.siteUrl = siteUrl;
    this.authPath = authPath;
  }

  async request(pathname, { method = 'GET', query, body } = {}) {
    const auth = await loadAuth(this.authPath ? { authPath: this.authPath } : {});
    if (!auth?.token) throw errorWithStatus(CLOUD_SESSION_EXPIRED_MESSAGE, 401);

    const url = new URL(endpoint(pathname, this.siteUrl));
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    try {
      return await readCloudResponse(response, `Cloud ${method} ${pathname}`);
    } catch (error) {
      if (error.status === 401) {
        await clearAuth(this.authPath ? { authPath: this.authPath } : {});
        clearSessionApiKey();
        error.sessionExpired = true;
      }
      throw error;
    }
  }

  async listRepos() {
    return normalizeCloudRepos(await this.request('/cli/cloud/repos'));
  }

  async listThreads(repo) {
    return normalizeCloudThreads(await this.request('/cli/cloud/threads', {
      query: { repo: validateCloudRepo(repo) },
    }));
  }

  async getThread(repo, opaqueThreadId) {
    const validRepo = validateCloudRepo(repo);
    if (typeof opaqueThreadId !== 'string' || !opaqueThreadId.trim()) {
      throw errorWithStatus('A threadId is required.', 400);
    }
    // The ID is intentionally only trimmed as input hygiene. It is never
    // parsed, decoded, lowercased, or otherwise interpreted.
    return normalizeCloudThread(await this.request('/cli/cloud/thread', {
      query: { repo: validRepo, threadId: opaqueThreadId.trim() },
    }));
  }

  async appendMessages(repo, opaqueThreadId, messages) {
    const validRepo = validateCloudRepo(repo);
    if (typeof opaqueThreadId !== 'string' || !opaqueThreadId.trim()) {
      throw errorWithStatus('A threadId is required.', 400);
    }
    if (!Array.isArray(messages)) throw errorWithStatus('Messages are required.', 400);
    return this.request('/cli/cloud/thread', {
      method: 'POST',
      body: {
        repo: validRepo,
        threadId: opaqueThreadId.trim(),
        messages: messages.map(({ role, content }) => ({ role, content: String(content ?? '') }))
          .filter(({ role }) => role === 'user' || role === 'assistant'),
      },
    });
  }
}

export function formatCloudUpdatedAt(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
