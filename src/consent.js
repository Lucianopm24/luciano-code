import readline from 'node:readline';
import { colors } from './ui/colors.js';
import { saveConfig, setNvidiaDataConsent } from './config.js';
import { getTerminalStream } from './ui/terminal-renderer.js';

const ACCEPTED = new Set(['y', 'yes', 's', 'si', 'sí']);

export function renderConsentStatus(config) {
  if (config?.nvidiaDataConsent === 'accepted') {
    return `${colors.green('✓')} NVIDIA data sharing consent: accepted`;
  }
  if (config?.nvidiaDataConsent === 'declined') {
    return `${colors.amber('⚠')} NVIDIA data sharing consent: declined; remote requests are blocked`;
  }
  return `${colors.amber('⚠')} NVIDIA data sharing consent: not decided; remote requests are blocked`;
}

function question(readlineInterface, prompt) {
  return new Promise((resolve) => readlineInterface.question(prompt, resolve));
}

export async function runConsentGate({
  input = process.stdin,
  output = process.stdout,
  config,
  force = false,
  readlineInterface: existingInterface,
} = {}) {
  if (!force && ['accepted', 'declined'].includes(config?.nvidiaDataConsent)) {
    return { config, decided: true, changed: false };
  }

  if (!input?.isTTY || !output?.isTTY) {
    output.write(`${colors.amber('⚠')} NVIDIA data consent has not been accepted; remote requests are blocked. Use ${colors.green('/consent accept')} in an interactive terminal.\n`);
    return { config, decided: false, changed: false };
  }

  const promptOutput = getTerminalStream(output);
  output.write(`\n${colors.bold('NVIDIA data-sharing consent')}\n`);
  output.write(`${colors.slate('To answer your request, Luciano Code may send your prompts, selected file contents, tool results, and generated responses to NVIDIA NIM. NVIDIA may process or use submitted data to train models according to its current policies.')}\n`);
  output.write(`${colors.amber('This is separate from local folder trust. Declining blocks remote AI requests; your local commands and local conversation files remain available.')}\n`);

  let readlineInterface = existingInterface;
  let ownsInterface = false;
  if (!readlineInterface || readlineInterface.closed) {
    readlineInterface = readline.createInterface({
      input,
      output: promptOutput,
      terminal: true,
    });
    ownsInterface = true;
  }
  try {
    const answer = (await question(
      readlineInterface,
      `${colors.green('Allow sending data to NVIDIA NIM under its policies?')} ${colors.dim('[y/N]')} `,
    )).trim().toLowerCase();
    const accepted = ACCEPTED.has(answer);
    const savedConfig = await saveConfig(setNvidiaDataConsent(config, accepted ? 'accepted' : 'declined'));
    output.write(accepted
      ? `${colors.green('✓')} NVIDIA data consent saved. Remote requests are enabled.\n\n`
      : `${colors.amber('⚠')} Consent declined. Remote requests are blocked until you run ${colors.green('/consent accept')}.\n\n`);
    return { config: savedConfig, decided: true, changed: true };
  } finally {
    if (ownsInterface && !readlineInterface.closed) readlineInterface.close();
  }
}
