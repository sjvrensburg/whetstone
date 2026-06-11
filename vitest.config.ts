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
        'src/shared/config.ts',
        'src/shared/constants.ts',
        'src/shared/crypto.ts',
        'src/shared/json.ts',
        'src/shared/secrets.ts',
        'src/coaching/schema.ts',
        'src/grammar/engine.ts',
        'src/grammar/latexMask.ts',
        'src/grammar/diagnostics.ts',
        'src/grammar/worker.ts',
        'src/grammar/dismissals.ts',
        'src/grammar/hover.ts',
        'src/grammar/codeActions.ts',
        'src/ledger/chain.ts',
        'src/ledger/checkpoints.ts',
        'src/ledger/store.ts',
        'src/ledger/index.ts',
        'src/ledger/detector.ts',
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
