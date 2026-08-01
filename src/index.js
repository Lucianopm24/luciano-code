import { createCli } from './cli.js';
import { loadConfig } from './config.js';
import { runDemo } from './demo.js';
import { runSetup } from './setup.js';
import { runTrustGate } from './trust.js';
import { runConsentGate } from './consent.js';
import { renderBanner, renderHelp } from './ui/banner.js';
import { createTerminalRenderer } from './ui/terminal-renderer.js';

const args = new Set(process.argv.slice(2));

function printUsage(output) {
  output.write(`${renderHelp()}\n`);
}

export async function main() {
  const output = createTerminalRenderer(process.stdout);

  if (args.has('--help') || args.has('-h')) {
    printUsage(output);
    return;
  }

  if (args.has('--version') || args.has('-v')) {
    output.write('Luciano Code AI v0.4.0\n');
    return;
  }

  const { config, exists } = await loadConfig();
  const shouldCheckTrust = !args.has('--help') && !args.has('-h')
    && !args.has('--version') && !args.has('-v');
  const trustResult = shouldCheckTrust
    ? await runTrustGate({ config, output })
    : { config, trusted: false, skipped: true };
  if (!trustResult.trusted && !trustResult.skipped) return;

  const consentResult = await runConsentGate({
    config: trustResult.config,
    output,
  });
  if (!consentResult.decided && !consentResult.config.nvidiaDataConsent) {
    // The CLI can still start so local-only commands remain available.
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (args.has('--setup') && !interactive) {
    output.write('Luciano Code AI setup requires an interactive terminal. Run `npm start` directly.\n');
    return;
  }

  const shouldSetup = args.has('--setup') || (!exists && interactive);
  let activeConfig = consentResult.config;

  if (shouldSetup) {
    activeConfig = await runSetup({ currentConfig: activeConfig, output, isFirstRun: !exists });
  }

  output.write(`${renderBanner(activeConfig, output.columns)}\n`);

  if (args.has('--demo')) {
    await runDemo(output);
    return;
  }

  createCli({ config: activeConfig, output }).start();
}
