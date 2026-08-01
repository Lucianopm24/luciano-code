import { colors, stripAnsi, visibleLength } from './colors.js';

const CODE_TOKEN = '\u0000CODE_';
const TERMINAL_WIDTH = 88;

function sanitize(value) {
  return stripAnsi(String(value))
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[^\n]*/g, '')
    .replace(/\\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function wrapSourceLine(line, width = TERMINAL_WIDTH) {
  if (line.length <= width) return [line];
  const chunks = [];
  let remaining = line;
  while (remaining.length > width) {
    let cut = remaining.lastIndexOf(' ', width);
    if (cut < Math.floor(width * 0.55)) cut = width;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function inlineMarkdown(value) {
  const codeSpans = [];
  let text = sanitize(value).replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `${CODE_TOKEN}${codeSpans.length}__`;
    codeSpans.push(colors.mint(code));
    return token;
  });

  text = text
    .replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => `${label} ${colors.dim(`(${url})`)}`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_match, content) => colors.bold(content))
    .replace(/__([^_\n]+)__/g, (_match, content) => colors.bold(content))
    .replace(/~~([^~\n]+)~~/g, (_match, content) => colors.dim(content))
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_match, prefix, content) => `${prefix}${colors.mint(content)}`)
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, (_match, prefix, content) => `${prefix}${colors.mint(content)}`);

  return text.replace(/\u0000CODE_(\d+)__/g, (_match, index) => codeSpans[Number(index)] ?? '');
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
}

function isTableRow(line) {
  return line.includes('|') && tableCells(line).length >= 2;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function renderTableLine(line) {
  return `${colors.dim('│')} ${tableCells(line).map((cell) => inlineMarkdown(cell.trim())).join(` ${colors.dim('│')} `)} ${colors.dim('│')}`;
}

export function renderMarkdown(markdown = '') {
  const sourceLines = sanitize(markdown).replace(/\r\n?/g, '\n').split('\n');
  const lines = sourceLines.flatMap((line) => wrapSourceLine(line));
  const output = [];
  let inCode = false;
  let codeLanguage = '';
  let inTable = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fence = line.match(/^\s*```\s*([^\s]*)\s*$/);
    if (fence) {
      if (inCode) {
        output.push(colors.dim('╰' + '─'.repeat(58)));
        inCode = false;
        codeLanguage = '';
      } else {
        inCode = true;
        codeLanguage = fence[1] || 'code';
        output.push(colors.dim(`╭─ ${codeLanguage} ${'─'.repeat(Math.max(1, 54 - codeLanguage.length))}`));
      }
      continue;
    }

    if (inCode) {
      output.push(`${colors.dim('│')} ${colors.mint(line)}`);
      continue;
    }

    if (inTable) {
      if (isTableRow(line)) {
        output.push(renderTableLine(line));
        continue;
      }
      inTable = false;
    }

    if (isTableRow(line) && isTableSeparator(lines[lineIndex + 1] ?? '')) {
      output.push(renderTableLine(line));
      output.push(colors.dim('├' + '─'.repeat(58)));
      inTable = true;
      lineIndex += 1;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      output.push(`${colors.green('◆')} ${colors.brightGreen(colors.bold(inlineMarkdown(heading[2])))}`);
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      output.push(colors.dim('─'.repeat(60)));
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      output.push(`${colors.green('•')} ${inlineMarkdown(unordered[1])}`);
      continue;
    }

    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      output.push(`${colors.green(`${ordered[1]}.`)} ${inlineMarkdown(ordered[2])}`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      output.push(`${colors.dim('│')} ${colors.slate(inlineMarkdown(quote[1]))}`);
      continue;
    }

    output.push(inlineMarkdown(line));
  }

  if (inCode) {
    output.push(colors.dim('╰' + '─'.repeat(58)));
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function markdownVisibleLength(markdown) {
  return visibleLength(renderMarkdown(markdown));
}
