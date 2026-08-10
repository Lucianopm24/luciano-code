import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { clearAuth, clearSessionApiKey, getConvexSiteUrl, loadAuth } from './auth.js';

export const REGISTRY_SESSION_EXPIRED_MESSAGE = 'Session expired, run /login again';
export const REGISTRY_MAX_FILES = 100;
export const REGISTRY_MAX_BYTES = 1_000_000;

function registryUrl(pathname, siteUrl = getConvexSiteUrl()) {
  return `${String(siteUrl).trim().replace(/\/+$/, '')}${pathname}`;
}

function registryError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readRegistryResponse(response, description) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw registryError(`${description} returned invalid JSON.`, response.status);
  }
  if (!response.ok || payload?.ok === false) {
    throw registryError(
      `${description} failed: ${payload?.error || `HTTP ${response.status}`}`,
      response.status,
    );
  }
  return payload;
}

function appendQuery(url, query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function normalizeVisibility(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!['public', 'private'].includes(value)) {
    throw registryError('Visibility must be public or private.', 400);
  }
  return value;
}

function normalizeTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : [tags])
    .filter((tag) => typeof tag === 'string' && tag.trim())
    .map((tag) => tag.trim().toLowerCase()))];
}

function normalizePermissions(permissions) {
  return [...new Set((Array.isArray(permissions) ? permissions : [permissions])
    .filter((permission) => typeof permission === 'string' && permission.trim())
    .map((permission) => permission.trim()))];
}

export class RegistryClient {
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
    if (!auth?.token) throw registryError(REGISTRY_SESSION_EXPIRED_MESSAGE, 401);

    const url = appendQuery(new URL(registryUrl(pathname, this.siteUrl)), query);
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    try {
      return await readRegistryResponse(response, `Registry ${method} ${pathname}`);
    } catch (error) {
      if (error.status === 401) {
        await clearAuth(this.authPath ? { authPath: this.authPath } : {});
        clearSessionApiKey();
        error.sessionExpired = true;
      }
      throw error;
    }
  }

  async listPrompts({ mine = false, visibility, search, tag } = {}) {
    return this.request('/cli/prompts/list', {
      query: { mine: mine ? 'true' : undefined, visibility: normalizeVisibility(visibility), search, tag },
    });
  }

  async searchPrompts({ q, tag } = {}) {
    return this.request('/cli/prompts/search', { query: { q, tag } });
  }

  async getPrompt(slug) {
    return this.request('/cli/prompts/get', { query: { slug } });
  }

  async publishPrompt({ slug, description = '', content, visibility = 'private', tags = [] }) {
    if (!slug || typeof content !== 'string' || !content.trim()) {
      throw registryError('A prompt slug and non-empty content are required.', 400);
    }
    return this.request('/cli/prompts/publish', {
      method: 'POST',
      body: { slug, description, content, visibility: normalizeVisibility(visibility) || 'private', tags: normalizeTags(tags) },
    });
  }

  async deletePrompt(slug) {
    return this.request('/cli/prompts/delete', { method: 'DELETE', query: { slug } });
  }

  async listSkills({ mine = false, visibility, search } = {}) {
    return this.request('/cli/skills/list', {
      query: { mine: mine ? 'true' : undefined, visibility: normalizeVisibility(visibility), search },
    });
  }

  async searchSkills({ q, tag } = {}) {
    return this.request('/cli/skills/search', { query: { q, tag } });
  }

  async getSkill(slug) {
    return this.request('/cli/skills/get', { query: { slug } });
  }

  async publishSkill({ slug, displayName, description = '', entry, permissions = [], visibility = 'private', tags = [], definition, files }) {
    if (!slug || !Array.isArray(files) || !files.length) {
      throw registryError('A skill slug and at least one file are required.', 400);
    }
    return this.request('/cli/skills/publish', {
      method: 'POST',
      body: {
        slug,
        ...(displayName ? { displayName } : {}),
        description,
        ...(entry ? { entry } : {}),
        permissions: normalizePermissions(permissions),
        visibility: normalizeVisibility(visibility) || 'private',
        tags: normalizeTags(tags),
        ...(definition ? { definition } : {}),
        files,
      },
    });
  }

  async publishSkillsBatch({ visibility = 'private', skills }) {
    if (!Array.isArray(skills) || !skills.length) throw registryError('At least one skill is required.', 400);
    return this.request('/cli/skills/publish/batch', {
      method: 'POST',
      body: { visibility: normalizeVisibility(visibility) || 'private', skills },
    });
  }

  async deleteSkill(slug) {
    return this.request('/cli/skills/delete', { method: 'DELETE', query: { slug } });
  }
}

const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules']);
const BLOCKED_FILE = /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key))$/i;

function safeRelativePath(value) {
  const normalized = String(value).split(path.sep).join('/');
  const lower = normalized.toLowerCase();
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
    throw new Error(`Unsafe skill file path: ${value}`);
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('..') || segments.some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()))
    || lower.includes('.env') || /\.(?:pem|key)(?:$|\/)/i.test(normalized)) {
    throw new Error(`Unsafe skill file path: ${value}`);
  }
  return segments.join('/');
}

function isBlockedName(name) {
  return name.toLowerCase() === '.git' || name.toLowerCase() === 'node_modules' || name.toLowerCase().includes('.env')
    || /\.(?:pem|key)$/i.test(name);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function readPromptFile(inputPath, { maxBytes = 10_240, workspaceRoot = process.cwd() } = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error('A prompt file path is required.');
  const workspace = await realpath(path.resolve(workspaceRoot));
  const root = path.resolve(workspace, inputPath.trim());
  if (!isInside(workspace, root)) throw new Error('Prompt path must stay inside the workspace.');
  const resolved = await realpath(root);
  if (!isInside(workspace, resolved)) throw new Error('Prompt path resolves outside the workspace.');
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error('The prompt path must be a regular file.');
  const relative = safeRelativePath(path.relative(workspace, resolved));
  if (BLOCKED_FILE.test(relative)) throw new Error('Prompt files cannot be secrets or private keys.');
  const content = await readFile(resolved, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new Error(`Prompt content exceeds the ${maxBytes} byte limit.`);
  return content;
}

export async function collectSkillFiles(inputPath, {
  maxFiles = REGISTRY_MAX_FILES,
  maxBytes = REGISTRY_MAX_BYTES,
  workspaceRoot = process.cwd(),
} = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error('A skill file or directory path is required.');
  const workspace = await realpath(path.resolve(workspaceRoot));
  const root = path.resolve(workspace, inputPath.trim());
  if (!isInside(workspace, root)) throw new Error('Skill path must stay inside the workspace.');
  const resolvedRoot = await realpath(root);
  if (!isInside(workspace, resolvedRoot)) throw new Error('Skill path resolves outside the workspace.');
  if (resolvedRoot !== workspace) safeRelativePath(path.relative(workspace, resolvedRoot));
  const rootInfo = await lstat(resolvedRoot);
  const files = [];
  let totalBytes = 0;

  async function visit(absolutePath, relativeBase = '') {
    const info = await lstat(absolutePath);
    if (info.isDirectory()) {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries) {
        if (isBlockedName(entry.name)) {
          throw new Error(`Skill contains a blocked path segment: ${entry.name}`);
        }
        await visit(path.join(absolutePath, entry.name), relativeBase ? `${relativeBase}/${entry.name}` : entry.name);
      }
      return;
    }
    if (!info.isFile()) return;
    const relativePath = safeRelativePath(relativeBase || path.basename(absolutePath));
    if (files.length >= maxFiles) throw new Error(`A skill can contain at most ${maxFiles} files.`);
    const content = await readFile(absolutePath, 'utf8');
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > maxBytes) throw new Error(`Skill files exceed the ${maxBytes} byte limit.`);
    files.push({ path: relativePath, content });
  }

  await visit(resolvedRoot, rootInfo.isDirectory() ? '' : path.basename(resolvedRoot));
  if (!files.length) throw new Error('The skill path contains no publishable files.');
  return files;
}

export async function collectSkillBatch(inputPath, { owner, workspaceRoot = process.cwd() } = {}) {
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('An owner handle is required for batch publishing.');
  const cleanOwner = owner.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(cleanOwner)) throw new Error('Owner handle contains invalid characters.');
  const workspace = await realpath(path.resolve(workspaceRoot));
  const root = path.resolve(workspace, String(inputPath || '').trim());
  if (!isInside(workspace, root)) throw new Error('Batch path must stay inside the workspace.');
  const resolvedRoot = await realpath(root);
  const rootInfo = await lstat(resolvedRoot);
  if (!rootInfo.isDirectory()) throw new Error('Batch path must be a directory.');
  const entries = await readdir(resolvedRoot, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isBlockedName(entry.name)) continue;
    const skillPath = path.join(resolvedRoot, entry.name);
    const files = await collectSkillFiles(skillPath, { workspaceRoot: workspace });
    const manifestFile = files.find((file) => file.path === 'skill.json');
    let manifest = {};
    if (manifestFile) {
      try {
        manifest = JSON.parse(manifestFile.content);
      } catch (error) {
        throw new Error(`Invalid skill.json in ${entry.name}: ${error.message}`);
      }
      if (!manifest.name) throw new Error(`skill.json in ${entry.name} requires name.`);
    }
    const entryFile = manifest.entry || (files.some((file) => file.path === 'index.js') ? 'index.js' : files.length === 1 ? files[0].path : undefined);
    if (!entryFile) throw new Error(`Batch skill ${entry.name} needs an entry or index.js.`);
    skills.push({
      slug: `@${cleanOwner}/${manifest.name || entry.name}`,
      displayName: manifest.displayName || manifest.name || entry.name,
      description: manifest.description || '',
      entry: entryFile,
      permissions: manifest.permissions || [],
      definition: {
        description: manifest.description || `Run the ${manifest.name || entry.name} skill.`,
        parameters: manifest.parameters || { type: 'object', properties: {} },
      },
      files,
    });
  }
  if (!skills.length) throw new Error('The batch directory contains no skill folders.');
  return skills;
}

export function registryItemSummary(item) {
  return {
    slug: item?.slug || '',
    name: item?.name || '',
    displayName: item?.displayName || '',
    description: item?.description || '',
    version: item?.version,
    status: item?.status,
    visibility: item?.visibility,
    downloads: item?.downloads ?? 0,
    tags: Array.isArray(item?.tags) ? item.tags : [],
    fileCount: item?.fileCount ?? (Array.isArray(item?.files) ? item.files.length : undefined),
  };
}
