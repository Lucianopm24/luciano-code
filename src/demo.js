import { box, divider, tree } from './ui/box.js';
import { colors, symbols } from './ui/colors.js';
import { Spinner } from './ui/spinner.js';
import { createTerminalRenderer } from './ui/terminal-renderer.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function analysisTree() {
  return tree([
    `${colors.dim('├──')} ${colors.white('src/')}`,
    `${colors.dim('│   ├──')} ${colors.white('server.js')} ${colors.green(symbols.success)}`,
    `${colors.dim('│   ├──')} ${colors.white('auth.js')} ${colors.amber(symbols.warning)}`,
    `${colors.dim('│   └──')} ${colors.white('database.js')} ${colors.green(symbols.success)}`,
    `${colors.dim('└──')} ${colors.white('package.json')} ${colors.green(symbols.success)}`,
  ]);
}

export async function runDemo(stream = process.stdout) {
  stream = createTerminalRenderer(stream);
  stream.write(`\n${colors.green('luciano-code')} ${colors.dim('>')} ${colors.white('/demo')}\n`);
  stream.write(`${colors.amber('DEMO')} ${colors.slate('Visual walkthrough only; no real workspace was inspected and no files will be modified.')}\n\n`);

  const spinner = new Spinner(stream);
  spinner.start('Thinking...');
  await wait(620);
  spinner.stop('Thinking complete');

  stream.write(`\n${colors.slate('Scanning project...')}\n\n`);
  await wait(380);
  stream.write(`${analysisTree()}\n\n`);
  stream.write(`${box([
    colors.white('4 archivos inspeccionados'),
    colors.white('2 rutas sin cobertura de tests'),
    '',
    colors.slate('El proyecto está listo para una revisión más profunda.'),
  ], { title: 'Analysis', width: 46, tone: 'green' })}\n`);

  await wait(250);
  stream.write(`\n${divider('Proposed changes', 46)}\n`);
  stream.write(`${box([
    `${colors.green('M')} ${colors.white('src/auth.js')}`,
    `${colors.green('+')} ${colors.slate('Añadir validación de sesión')}`,
    `${colors.red('-')} ${colors.slate('Eliminar fallback inseguro')}`,
    `${colors.green('M')} ${colors.white('test/auth.test.js')}`,
  ], { width: 46, tone: 'green' })}\n`);
  stream.write(`\n${colors.amber('Apply changes?')} ${colors.dim('(y/N)')} ${colors.dim('· demo only, no files will be modified')}\n`);
}

