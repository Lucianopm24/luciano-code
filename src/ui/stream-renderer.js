import { colors, stripAnsi } from './colors.js';
import { renderMarkdownLine } from './markdown.js';
import { createTerminalRenderer } from './terminal-renderer.js';

const RESPONSE_PREFIX = `${colors.brightGreen('Assistant')} ${colors.dim('›')} `;
const CONTINUATION_PREFIX = ' '.repeat(stripAnsi(RESPONSE_PREFIX).length);

export function supportsInPlaceUpdates(stream, {
  platform = process.platform,
  env = process.env,
} = {}) {
  if (!stream?.isTTY || env.TERM === 'dumb' || env.NO_COLOR !== undefined) return false;
  if (platform !== 'win32') return true;

  return Boolean(
    env.WT_SESSION
      || env.ANSICON
      || env.ConEmuANSI === 'ON'
      || env.TERM_PROGRAM === 'vscode'
      || env.TERM_PROGRAM === 'Windows_Terminal'
      || env.TERM === 'xterm-256color',
  );
}

export function safeStreamToken(token) {
  return stripAnsi(String(token))
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[^\n]*/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/**
 * Accepts both normal deltas and providers that send cumulative snapshots.
 * A possible snapshot is held for one frame so a one-off delta such as `A` ->
 * `AB` is not lost, while repeated/stale snapshots never duplicate output.
 */
export function createStreamTextAccumulator() {
  let fullText = '';
  let pendingSnapshot = '';
  let mode = 'delta';

  return {
    push(value) {
      const chunk = safeStreamToken(value);
      if (!chunk) return '';

      if (!fullText) {
        fullText = chunk;
        return chunk;
      }

      if (pendingSnapshot) {
        if (chunk === pendingSnapshot || chunk === fullText || chunk.length < fullText.length) return '';
        if (chunk.startsWith(fullText) && chunk.length > fullText.length) {
          const delta = chunk.slice(fullText.length);
          fullText = chunk;
          pendingSnapshot = '';
          mode = 'cumulative';
          return delta;
        }
        pendingSnapshot = '';
        mode = 'delta';
        fullText += chunk;
        return chunk;
      }

      if (chunk === fullText) {
        if (mode === 'cumulative') return '';
        mode = 'delta';
        fullText += chunk;
        return chunk;
      }
      if (mode === 'cumulative' && chunk.length < fullText.length && fullText.startsWith(chunk)) return '';
      if (chunk.startsWith(fullText) && chunk.length > fullText.length) {
        pendingSnapshot = chunk;
        mode = 'cumulative';
        return '';
      }

      mode = 'delta';
      fullText += chunk;
      return chunk;
    },
    finish() {
      if (!pendingSnapshot) return '';
      const delta = pendingSnapshot.startsWith(fullText) ? pendingSnapshot.slice(fullText.length) : pendingSnapshot;
      fullText = pendingSnapshot.startsWith(fullText) ? pendingSnapshot : `${fullText}${pendingSnapshot}`;
      pendingSnapshot = '';
      return delta;
    },
    get text() {
      return fullText;
    },
    get mode() {
      return mode;
    },
  };
}

export function createLiveRenderer(stream, spinner) {
  stream = createTerminalRenderer(stream);
  let reasoningStarted = false;
  let responseStarted = false;
  let responseHadTokens = false;
  let lineCommitted = false;
  let pendingLine = '';
  let markdownState = { inCode: false, codeLanguage: '' };
  let responseText = '';
  // Stream deltas directly instead of repainting the same line with ANSI.
  // Repainting is not reliable in every terminal and can appear as duplicated
  // Assistant lines; the response should be written exactly once in order.
  const terminal = false;

  const clearProgress = () => {
    if (spinner.started) spinner.clear();
  };

  const beginResponse = () => {
    if (responseStarted) return;
    if (reasoningStarted) stream.write('\n');
    if (!terminal) stream.write(RESPONSE_PREFIX);
    responseStarted = true;
  };

  const commitMarkdownLine = () => {
    const rendered = renderMarkdownLine(pendingLine, markdownState);
    if (rendered) stream.write(rendered);
    stream.write('\n');
    pendingLine = '';
    lineCommitted = true;
  };

  const isMarkdownLine = (line) => markdownState.inCode
    || /^\s*(?:#{1,6}\s|[-*+]\s+|\d+[.)]\s+|>\s?|```|\|)/.test(line)
    || /(?:\*\*|__|~~|`|\[[^\]]+\]\()/.test(line);

  const writeResponseDelta = (value) => {
    const delta = safeStreamToken(value);
    if (!delta) return;
    responseText += delta;
    clearProgress();
    beginResponse();
    responseHadTokens = true;

    const parts = delta.split('\n');
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      pendingLine += part;
      if (index < parts.length - 1) {
        commitMarkdownLine();
      } else if (pendingLine && !isMarkdownLine(pendingLine)) {
        stream.write(part);
        pendingLine = '';
      }
    }
  };

  return {
    writeReasoning(token) {
      const safeToken = safeStreamToken(token);
      if (!safeToken) return;
      clearProgress();
      if (!reasoningStarted) {
        stream.write(`${colors.dim('Thinking')} ${colors.slate('›')} `);
        reasoningStarted = true;
      }
      stream.write(colors.slate(safeToken));
    },
    writeResponse(token) {
      writeResponseDelta(token);
    },
    finish() {
      if (pendingLine.length > 0) commitMarkdownLine();
      else if ((reasoningStarted || responseStarted) && !lineCommitted) stream.write('\n');
    },
    get responseHadTokens() {
      return responseHadTokens;
    },
    get outputStarted() {
      return reasoningStarted || responseStarted;
    },
    get text() {
      return responseText;
    },
  };
}
