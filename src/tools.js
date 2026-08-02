import { exec } from 'node:child_process';
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
import { colors } from './ui/colors.js';

const MAX_FILE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 200;
const TOOL_NAMES = new Set(['list_files', 'read_file', 'write_file', 'edit_file', 'execute_command']);
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const COMMAND_TIMEOUT_MS = 120_000;

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List visible files and directories inside the trusted workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative directory path.' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the trusted workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path.' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a UTF-8 file inside the trusted workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact text snippet in a UTF-8 file inside the trusted workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old: { type: 'string' },
          new: { type: 'string' },
          replaceAll: { type: 'boolean' },
        },
        required: ['path', 'old', 'new'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute a real shell command in the trusted workspace after explicit user authorization.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The exact command to execute.' },
          cwd: { type: 'string', description: 'Optional relative working directory inside the workspace.' },
        },
        required: ['command'],
      },
    },
  },
];

const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules', '.luciano-code']);
const SENSITIVE_FILE = /(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|crt|cer)|id_rsa(?:\..*)?)$/i;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function displayPath(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  return relative || '.';
}

function validateRelativePath(requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    throw new Error('A relative workspace path is required.');
  }
  if (requestedPath.includes('\0')) throw new Error('Invalid null character in path.');
  return requestedPath.trim();
}

function rejectSensitive(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error('Access to protected workspace directories is blocked.');
  }
  if (SENSITIVE_FILE.test(normalized)) {
    throw new Error('Access to secret or private-key files is blocked.');
  }
}

async function resolveExistingPath(root, requestedPath) {
  const relativePath = validateRelativePath(requestedPath);
  const candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate)) throw new Error('Path must stay inside the trusted workspace.');
  rejectSensitive(displayPath(root, candidate));

  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    throw new Error(`Path does not exist: ${relativePath} (${error.code || error.message})`);
  }
  if (!isInside(root, resolved)) throw new Error('Symlink resolves outside the trusted workspace.');
  rejectSensitive(displayPath(root, resolved));
  return { absolutePath: resolved, relativePath: displayPath(root, resolved) };
}

async function resolveWritablePath(root, requestedPath) {
  const relativePath = validateRelativePath(requestedPath);
  const candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate)) throw new Error('Path must stay inside the trusted workspace.');
  rejectSensitive(displayPath(root, candidate));

  const parent = path.dirname(candidate);
  let resolvedParent;
  try {
    resolvedParent = await realpath(parent);
  } catch (error) {
    throw new Error(`Parent directory does not exist: ${path.dirname(relativePath)} (${error.code || error.message})`);
  }
  if (!isInside(root, resolvedParent)) throw new Error('Parent directory resolves outside the trusted workspace.');
  rejectSensitive(displayPath(root, resolvedParent));

  try {
    const existing = await realpath(candidate);
    if (!isInside(root, existing)) throw new Error('Existing path resolves outside the trusted workspace.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { absolutePath: candidate, relativePath: displayPath(root, candidate) };
}

function summarizeContent(content) {
  const text = String(content);
  if (!text) return '(empty file)';
  const preview = text.split('\n').slice(0, 8).join('\n');
  return text.length > preview.length ? `${preview}\n…` : preview;
}

function toolLabel(request) {
  const pathValue = request.arguments?.path || request.arguments?.file || '.';
  const labels = {
    list_files: 'list files',
    read_file: 'read file',
    write_file: 'write file',
    edit_file: 'edit file',
    execute_command: 'execute command',
  };
  if (request.tool === 'execute_command') return `${labels[request.tool]}\n${request.arguments?.command || ''}`;
  return `${labels[request.tool] || request.tool} · ${pathValue}`;
}

function normalizeToolRequest(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.tool && TOOL_NAMES.has(parsed.tool)) {
    const args = typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : parsed.arguments;
    if (!args || typeof args !== 'object') return null;
    return { tool: parsed.tool, arguments: args };
  }
  const functionCall = parsed.function || parsed.function_call;
  if (parsed.type === 'function' && functionCall?.name) {
    const args = typeof functionCall.arguments === 'string'
      ? JSON.parse(functionCall.arguments)
      : functionCall.arguments;
    if (!TOOL_NAMES.has(functionCall.name) || !args || typeof args !== 'object') return null;
    return { tool: functionCall.name, arguments: args, callId: parsed.id };
  }
  return null;
}

function findJsonObjects(value) {
  const candidates = [];
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(value.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

export function parseToolRequest(value) {
  if (value && typeof value === 'object') {
    try { return normalizeToolRequest(value); } catch { return null; }
  }
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [cleaned, ...findJsonObjects(cleaned)];
  for (const candidate of candidates) {
    try {
      const request = normalizeToolRequest(JSON.parse(candidate));
      if (request) return request;
    } catch {
      // Continue searching in case the model wrapped the JSON in prose.
    }
  }
  return null;
}

export function formatToolRequest(request) {
  const args = request.arguments || {};
  const target = args.path || args.file || '.';
  if (request.tool === 'write_file') {
    return `${toolLabel(request)}\n${colors.dim('New content preview:')}\n${colors.slate(summarizeContent(args.content))}`;
  }
  if (request.tool === 'edit_file') {
    return `${toolLabel(request)}\n${colors.dim('Replacement preview:')}\n- ${colors.slate(summarizeContent(args.old))}\n+ ${colors.slate(summarizeContent(args.new))}`;
  }
  return toolLabel({ ...request, arguments: { ...args, path: target } });
}

async function listFiles(root, args) {
  const target = await resolveExistingPath(root, args.path || '.');
  const info = await lstat(target.absolutePath);
  if (!info.isDirectory()) throw new Error(`${target.relativePath} is not a directory.`);
  const entries = await readdir(target.absolutePath, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !BLOCKED_SEGMENTS.has(entry.name.toLowerCase()) && !SENSITIVE_FILE.test(entry.name))
    .slice(0, MAX_LIST_ENTRIES)
    .map((entry) => `${entry.isDirectory() ? 'directory' : 'file'}\t${entry.name}`);
  const suffix = entries.length > MAX_LIST_ENTRIES ? `\n… truncated at ${MAX_LIST_ENTRIES} entries` : '';
  return `Listing for ${target.relativePath}:\n${visible.join('\n') || '(empty)'}${suffix}`;
}

async function readWorkspaceFile(root, args) {
  const target = await resolveExistingPath(root, args.path || args.file);
  const info = await lstat(target.absolutePath);
  if (!info.isFile()) throw new Error(`${target.relativePath} is not a regular file.`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`File is larger than ${MAX_FILE_BYTES} bytes.`);
  const content = await readFile(target.absolutePath, 'utf8');
  return `File: ${target.relativePath}\n\n${content}`;
}

async function writeAtomic(filePath, content) {
  const temporary = `${filePath}.luciano-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    // Windows can reject replacing an existing file with rename. Fall back to a
    // direct write only after the destination was validated by the caller.
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function writeWorkspaceFile(root, args) {
  const target = await resolveWritablePath(root, args.path || args.file);
  if (typeof args.content !== 'string') throw new Error('write_file requires a string content argument.');
  if (Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) throw new Error(`File is larger than ${MAX_FILE_BYTES} bytes.`);
  await writeAtomic(target.absolutePath, args.content);
  return `Wrote ${target.relativePath} (${Buffer.byteLength(args.content, 'utf8')} bytes).`;
}

async function executeCommand(root, args) {
  if (typeof args.command !== 'string' || !args.command.trim()) {
    throw new Error('execute_command requires a non-empty command string.');
  }
  const requestedCwd = args.cwd || '.';
  const target = await resolveExistingPath(root, requestedCwd);
  const info = await lstat(target.absolutePath);
  if (!info.isDirectory()) throw new Error(`${target.relativePath} is not a directory.`);

  const command = args.command.trim();
  const shell = process.platform === 'win32'
    ? process.env.ComSpec || 'cmd.exe'
    : process.env.SHELL || '/bin/sh';
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let signal = null;
  try {
    const result = await execAsync(command, {
      cwd: target.absolutePath,
      shell,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = error.stdout || '';
    stderr = error.stderr || '';
    exitCode = Number.isInteger(error.code) ? error.code : 1;
    signal = error.signal || null;
  }

  return {
    command,
    cwd: target.relativePath,
    stdout: String(stdout),
    stderr: String(stderr),
    exitCode,
    signal,
  };
}

function formatCommandResult(result) {
  const status = result.exitCode === 0
    ? 'Command completed'
    : `Command failed (exit code ${result.exitCode})`;
  const output = result.stdout || '(no stdout)';
  const errors = result.stderr || '(no stderr)';
  return [
    `${status}: ${result.command}`,
    `cwd: ${result.cwd}`,
    `exit code: ${result.exitCode}`,
    '',
    'stdout:',
    output,
    '',
    'stderr:',
    errors,
  ].join('\n');
}

async function editWorkspaceFile(root, args) {
  const target = await resolveExistingPath(root, args.path || args.file);
  const info = await lstat(target.absolutePath);
  if (!info.isFile()) throw new Error(`${target.relativePath} is not a regular file.`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`File is larger than ${MAX_FILE_BYTES} bytes.`);
  if (typeof args.old !== 'string' || typeof args.new !== 'string') {
    throw new Error('edit_file requires string old and new arguments.');
  }
  const original = await readFile(target.absolutePath, 'utf8');
  const occurrences = original.split(args.old).length - 1;
  if (!occurrences) throw new Error('The requested text was not found; no changes made.');
  if (occurrences > 1 && args.replaceAll !== true) {
    throw new Error(`The requested text occurs ${occurrences} times. Set replaceAll to true or provide a more specific snippet.`);
  }
  const updated = args.replaceAll === true ? original.split(args.old).join(args.new) : original.replace(args.old, args.new);
  if (Buffer.byteLength(updated, 'utf8') > MAX_FILE_BYTES) throw new Error(`File is larger than ${MAX_FILE_BYTES} bytes.`);
  await writeAtomic(target.absolutePath, updated);
  return `Edited ${target.relativePath} (${occurrences} replacement${occurrences === 1 ? '' : 's'}).`;
}

export async function executeTool(root, request, { authorized = false, onCommandResult } = {}) {
  if (request?.tool === 'execute_command' && authorized !== true) {
    throw new Error('execute_command requires explicit user authorization.');
  }
  if (!TOOL_NAMES.has(request?.tool)) throw new Error('Unknown tool request.');
  const args = request.arguments || {};
  switch (request.tool) {
    case 'list_files': return listFiles(root, args);
    case 'read_file': return readWorkspaceFile(root, args);
    case 'write_file': return writeWorkspaceFile(root, args);
    case 'edit_file': return editWorkspaceFile(root, args);
    case 'execute_command': {
      const result = await executeCommand(root, args);
      await onCommandResult?.(result);
      return formatCommandResult(result);
    }
    default: throw new Error('Unknown tool request.');
  }
}

export function createToolAuthorizer({ input, output, readlineInterface, ask: askQuestion } = {}) {
  let approveAll = false;
  const ask = askQuestion || ((prompt) => new Promise((resolve) => readlineInterface.question(prompt, resolve)));

  return async (request) => {
    if (!input?.isTTY || !output?.isTTY || !readlineInterface || readlineInterface.closed) {
      return { approved: false, reason: 'Tool authorization requires an interactive terminal.' };
    }
    if (approveAll) return { approved: true };
    output.write(`\n${colors.amber('⚠')} Tool authorization required\n${formatToolRequest(request)}\n`);
    const answer = (await ask(`${colors.green('Allow?')} ${colors.dim('[y/N/a]')} `)).trim().toLowerCase();
    if (answer === 'a' || answer === 'always') {
      approveAll = true;
      output.write(`${colors.green('✓')} Tools approved for the rest of this session.\n`);
      return { approved: true };
    }
    if (['y', 'yes', 's', 'si', 'sí'].includes(answer)) return { approved: true };
    return { approved: false, reason: 'The user rejected this tool request.' };
  };
}

export function toolInstructions() {
  return [
    'Available local tools (the user must authorize every operation unless they choose session approval):',
    '- list_files: list a directory inside the workspace',
    '- read_file: read a text file inside the workspace',
    '- write_file: create or replace a file with complete content',
    '- edit_file: replace an exact snippet in an existing file',
    '- execute_command: run one real shell command in the trusted workspace; it always requires explicit authorization',
    'Models that support native OpenAI tool calls may use them. Otherwise request a tool as JSON, preferably with no surrounding prose:',
    '{"tool":"read_file","arguments":{"path":"src/index.js"}}',
    'After a tool result, continue reasoning. Never invent a tool result. Never request paths outside the workspace.',
  ].join('\n');
}

export function workspaceRoot() {
  return path.resolve(process.cwd());
}

export function toolLimits() {
  return { maxFileBytes: MAX_FILE_BYTES, maxListEntries: MAX_LIST_ENTRIES, platform: os.platform() };
}
