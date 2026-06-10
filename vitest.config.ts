import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Unit-test runner for the pure-logic modules. Scoped to `test/unit/**` so it
// never touches the VS Code integration suite under `src/test/**` (run by
// @vscode/test-electron instead). The `vscode` alias lets the host file be
// imported headlessly against a minimal stub; integration tests use the real API.
export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(here, 'test/support/vscode-stub.ts'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Only the modules that contain real logic in this scaffold. The host file
      // (extension.ts), the `ui/` host wiring, and the empty module placeholders
      // are exercised by the integration harness, not vitest.
      include: [
        'src/container.ts',
        'src/commands.ts',
        'src/dev/cli.ts',
        'test/support/fixtures.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
