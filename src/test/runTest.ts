import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Entry point for the VS Code integration harness. Downloads a VS Code build (on
 * first run) and launches it headless with this extension loaded, then runs the
 * Mocha suite in `./suite`. Compiled by `tsconfig.test.json` to
 * `out/test/runTest.js` and invoked by `npm run test:integration`.
 */
async function main(): Promise<void> {
  try {
    // out/test -> repo root holds package.json (the extension under development).
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Clean host: don't load the developer's other installed extensions.
      launchArgs: ['--disable-extensions'],
    });
  } catch (err) {
    console.error('Failed to run integration tests');
    console.error(err);
    process.exit(1);
  }
}

void main();
