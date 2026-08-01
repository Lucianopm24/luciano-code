import readline from 'node:readline';
import path from 'node:path';
import { box } from './ui/box.js';
import { colors } from './ui/colors.js';
import { createTerminalRenderer } from './ui/terminal-renderer.js';
import { grantTrust, isTrusted, revokeTrust, saveConfig } from './config.js';

function question(readlineInterface, prompt) {
  return new Promise((resolve) => readlineInterface.question(prompt, resolve));
}

export function currentFolder(targetPath = process.cwd()) {
  const absolutePath = path.resolve(targetPath);
  return {
    name: path.basename(absolutePath) || absolutePath,
    path: absolutePath,
  };
}

export async function runTrustGate({
  input = process.stdin,
  output = process.stdout,
  config = {},
} = {}) {
  output = createTerminalRenderer(output);
  const folder = currentFolder();

  if (isTrusted(config, folder.path)) {
    return { config, trusted: true, skipped: true };
  }

  if (!input.isTTY || !output.isTTY) {
    output.write(`${colors.amber('⚠')} This folder is not trusted in non-interactive mode; tools will remain unavailable.\n`);
    return { config, trusted: false, skipped: true };
  }

  output.write(`\n${box([
    colors.bold('Do you trust the authors of this folder?'),
    '',
    colors.slate('Due to prompt injection risks, we have to make sure you trust the authors of the folder Luciano Code is going to execute in.'),
    '',
    `${colors.dim('Folder name:')} ${colors.white(folder.name)}`,
    `${colors.dim('Folder path:')} ${colors.slate(folder.path)}`,
    '',
    colors.amber('Only trust folders whose files and instructions you understand.'),
  ], { title: 'Folder trust required', width: 76, tone: 'green' })}\n\n`);

  const readlineInterface = readline.createInterface({ input, output, terminal: true });
  try {
    const answer = (await question(
      readlineInterface,
      `${colors.green('Trust this folder?')} ${colors.dim('[y/N]')} `,
    )).trim().toLowerCase();

    if (!['y', 'yes', 's', 'si', 'sí'].includes(answer)) {
      output.write(`\n${colors.red('✗')} Folder not trusted. Luciano Code will exit without starting the agent.\n`);
      process.exitCode = 1;
      return { config, trusted: false, skipped: false };
    }

    const savedConfig = await saveConfig(grantTrust(config, folder.path));
    output.write(`${colors.green('✓')} Trusted folder saved locally for this exact path.\n\n`);
    return { config: savedConfig, trusted: true, skipped: false };
  } finally {
    readlineInterface.close();
  }
}

export function renderTrustStatus(config) {
  const folder = currentFolder();
  const trusted = isTrusted(config, folder.path);
  return trusted
    ? `${colors.green('✓')} Trusted: ${colors.white(folder.name)} ${colors.dim(`(${folder.path})`)}`
    : `${colors.amber('⚠')} Not trusted: ${colors.white(folder.name)} ${colors.dim(`(${folder.path})`)}`;
}

export async function revokeCurrentFolderTrust(config) {
  return saveConfig(revokeTrust(config, process.cwd()));
}
