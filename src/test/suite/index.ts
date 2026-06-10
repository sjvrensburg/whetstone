import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

/**
 * Mocha glue invoked inside the Extension Host by `@vscode/test-electron`.
 * Discovers every compiled `*.test.js` under this directory and runs it.
 */
export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 60_000 });
  const testsRoot = __dirname;

  const files = await glob('**/*.test.js', { cwd: testsRoot });
  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} integration test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
