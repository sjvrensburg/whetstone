/**
 * Plain-Node dev-CLI scaffold (no VS Code host).
 *
 * This is the entry point for the headless prompt-iteration loop: domain
 * services (guard, coaching, providers, prompt assets) have no `vscode`
 * dependency, so they can be exercised here in a sub-second loop without
 * launching the editor. Task 19 wires the real provider + full guard into an
 * interactive `live`/`record` mode (single passage in -> structured coaching +
 * per-layer guard verdict out) on top of this scaffold and the record/replay
 * fixtures in `test/support/fixtures.ts`.
 *
 * For now it is an inert scaffold: it parses args, prints usage, and exits
 * cleanly. The logic lives in `runCli` (pure, injectable IO) so it is unit
 * testable; `main.ts` is the thin bootstrap that esbuild bundles to
 * `dist/dev/cli.js`.
 */

export const CLI_NAME = 'whetstone-dev';

/** Output sink, injected so `runCli` stays pure and unit-testable. */
export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

function printHelp(io: CliIO): void {
  io.out(`${CLI_NAME} — headless prompt-iteration loop for Whetstone domain services.`);
  io.out('');
  io.out('Usage: whetstone-dev [command] [options]');
  io.out('');
  io.out('Options:');
  io.out('  -h, --help    Show this help and exit.');
  io.out('');
  io.out('Planned commands (wired in task 19):');
  io.out('  interactive   Coach a single passage and print the per-layer guard verdict.');
  io.out('  record        Snapshot a live provider response into a replay fixture.');
}

/**
 * Run the dev CLI. Returns a process exit code; never calls `process.exit`
 * itself so it can be invoked from tests without tearing down the runner.
 */
export function runCli(args: readonly string[], io: CliIO): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    printHelp(io);
    return Promise.resolve(0);
  }

  if (args.length === 0) {
    io.out(`${CLI_NAME}: scaffold ready — no commands wired yet.`);
    io.out("Run with '--help' to see the planned interface.");
    return Promise.resolve(0);
  }

  io.err(`${CLI_NAME}: unknown command '${args.join(' ')}'. Run with '--help'.`);
  return Promise.resolve(2);
}
