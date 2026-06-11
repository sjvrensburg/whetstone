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
 * Commands:
 *   interactive   Coach a single passage and print the per-layer guard verdict.
 *   record        Snapshot a live provider response into a replay fixture.
 */

import { createProvider } from '../providers/registry';
import type { CoachingProvider } from '../providers/types';
import type { GuardResult, StructuredCoaching } from '../shared/types';
import { createRefusalGuard } from '../guard';
import { screenInjection } from '../guard/injection';
import { runDeterministicChecks } from '../guard/deterministic';
import { runJudgeLayer } from '../guard/judge';
import * as path from 'node:path';

export const CLI_NAME = 'whetstone-dev';

/** Output sink, injected so `runCli` stays pure and unit-testable. */
export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Provider resolution (headless)
// ---------------------------------------------------------------------------

/**
 * Resolve a provider for the CLI. Reads the API key from the `Z_AI_API_KEY`
 * environment variable (consistent with the registry's fallback path).
 * Returns undefined if no key is available.
 *
 * Uses hardcoded defaults to avoid importing from `config.ts` (which has a
 * runtime `vscode` dependency). This mirrors DEFAULT_SETTINGS.
 */
const CLI_DEFAULT_SETTINGS = {
  activeProvider: 'zai' as const,
  models: {},
  ledgerInWorkspace: false,
  grammarSeverity: 'info' as const,
  telemetryEnabled: true,
  externalInsertThreshold: 50,
};

async function resolveProvider(io: CliIO): Promise<CoachingProvider | undefined> {
  const apiKey = process.env.Z_AI_API_KEY;
  if (!apiKey) {
    io.err('Error: Z_AI_API_KEY environment variable is not set.');
    io.err('Set it to your API key to use live provider commands.');
    return undefined;
  }

  try {
    return createProvider(CLI_DEFAULT_SETTINGS, apiKey);
  } catch (e) {
    io.err(`Error creating provider: ${(e as Error).message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Interactive result formatting
// ---------------------------------------------------------------------------

/** Per-layer breakdown of a guard screening. */
export interface LayerBreakdown {
  injection: { passed: boolean; reason?: string };
  deterministic: { passed: boolean; reason?: string };
  judge?: { passed: boolean; reason?: string };
}

/** The result of a single interactive coaching run. */
export interface InteractiveResult {
  /** The coaching output from the provider. */
  coaching: StructuredCoaching | undefined;
  /** The coaching provider result (may be an error). */
  coachResult: { ok: boolean; error?: string };
  /** The guard result. */
  guardResult: GuardResult;
  /** Per-layer breakdown. */
  layers: LayerBreakdown;
}

/**
 * Run a single passage through the full pipeline (provider → guard) and
 * return the structured coaching plus a per-layer guard verdict.
 *
 * This is the interactive dev-CLI mode (sub-second prompt iteration).
 * Exported for testability.
 */
export async function runInteractive(
  passage: string,
  documentLanguage: 'markdown' | 'latex',
  provider: CoachingProvider,
): Promise<InteractiveResult> {
  // 1. Get coaching from the provider
  const coachReq = {
    selectionText: passage,
    anchorBase: 0,
    documentLanguage,
  };
  const coachResult = await provider.coach(coachReq);

  if (!coachResult.ok) {
    // Provider failed — no coaching to guard
    const guard = createRefusalGuard({ provider });
    const emptyCoaching: StructuredCoaching = { observations: [] };
    const guardResult = await guard.screen(emptyCoaching, {
      selectionText: passage,
      documentLanguage,
    });

    return {
      coaching: undefined,
      coachResult: { ok: false, error: coachResult.error.message },
      guardResult,
      layers: {
        injection: { passed: true },
        deterministic: { passed: true },
      },
    };
  }

  // 2. Run the full guard against the coaching output
  const coaching = coachResult.value;
  const doc = { selectionText: passage, documentLanguage };

  // Run each layer separately for the breakdown
  const layers: LayerBreakdown = {
    injection: { passed: true },
    deterministic: { passed: true },
    judge: undefined,
  };

  // Layer 1: injection screening
  const injectionResult = screenInjection(passage);
  if (!injectionResult.ok) {
    layers.injection = { passed: false, reason: injectionResult.reason };
    return {
      coaching,
      coachResult: { ok: true },
      guardResult: { ok: false, reason: injectionResult.reason, layer: 'deterministic' },
      layers,
    };
  }

  // Layer 2: deterministic checks
  const detResult = runDeterministicChecks(coaching, doc);
  if (!detResult.ok) {
    layers.deterministic = { passed: false, reason: detResult.reason };
    return {
      coaching,
      coachResult: { ok: true },
      guardResult: { ok: false, reason: detResult.reason, layer: 'deterministic' },
      layers,
    };
  }

  // Layer 3: judge
  const judgeResult = await runJudgeLayer(provider, coaching);
  if (!judgeResult.ok) {
    layers.judge = { passed: false, reason: judgeResult.reason };
    return {
      coaching,
      coachResult: { ok: true },
      guardResult: judgeResult,
      layers,
    };
  }

  layers.judge = { passed: true };
  return {
    coaching,
    coachResult: { ok: true },
    guardResult: { ok: true, coaching },
    layers,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format an interactive result as human-readable output. */
export function formatInteractiveResult(result: InteractiveResult): string {
  const lines: string[] = [];
  lines.push('=== Interactive Coaching Result ===');
  lines.push('');

  if (!result.coachResult.ok) {
    lines.push(`Provider error: ${result.coachResult.error}`);
    return lines.join('\n');
  }

  if (result.coaching) {
    lines.push('Coaching observations:');
    for (const o of result.coaching.observations) {
      lines.push(`  [${o.kind}] (${o.anchor.start}–${o.anchor.end})`);
      lines.push(`    Reflection: ${o.reflection}`);
      lines.push(`    Question: ${o.question}`);
    }
  }

  lines.push('');
  lines.push('Guard verdict:');
  lines.push(`  Injection:     ${result.layers.injection.passed ? 'PASS' : 'FAIL'}${result.layers.injection.reason ? ` — ${result.layers.injection.reason}` : ''}`);
  lines.push(`  Deterministic: ${result.layers.deterministic.passed ? 'PASS' : 'FAIL'}${result.layers.deterministic.reason ? ` — ${result.layers.deterministic.reason}` : ''}`);
  lines.push(`  Judge:         ${result.layers.judge ? (result.layers.judge.passed ? 'PASS' : 'FAIL') : 'N/A'}${result.layers.judge?.reason ? ` — ${result.layers.judge.reason}` : ''}`);
  lines.push('');
  lines.push(`Overall: ${result.guardResult.ok ? 'PASS (coaching allowed)' : 'REJECTED'}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Usage help. */
function printHelp(io: CliIO): void {
  io.out(`${CLI_NAME} — headless prompt-iteration loop for Whetstone domain services.`);
  io.out('');
  io.out('Usage: whetstone-dev [command] [options]');
  io.out('');
  io.out('Commands:');
  io.out('  interactive [passage]   Coach a single passage and print the per-layer guard verdict.');
  io.out('                          If no passage is given, reads from stdin.');
  io.out('  record <fixture-path>   Snapshot a live provider response into a replay fixture.');
  io.out('');
  io.out('Options:');
  io.out('  -h, --help              Show this help and exit.');
  io.out('  --lang <lang>           Document language (markdown or latex). Default: markdown.');
}

/**
 * `interactive` command: coach a single passage and print structured coaching
 * plus the per-layer guard verdict.
 */
async function cmdInteractive(
  args: readonly string[],
  io: CliIO,
): Promise<number> {
  // Parse --lang flag
  let lang: 'markdown' | 'latex' = 'markdown';
  const langIdx = args.indexOf('--lang');
  if (langIdx !== -1 && langIdx + 1 < args.length) {
    const val = args[langIdx + 1];
    if (val === 'markdown' || val === 'latex') {
      lang = val;
    } else {
      io.err(`Unknown language: ${val}. Use 'markdown' or 'latex'.`);
      return 2;
    }
  }

  // Get passage from args or stdin
  const positionalArgs = args.filter((a) => !a.startsWith('--') && a !== lang);
  let passage: string;

  if (positionalArgs.length > 0) {
    passage = positionalArgs.join(' ');
  } else {
    // Read from stdin
    passage = await readStdin();
    if (!passage.trim()) {
      io.err('No passage provided. Pass text as arguments or pipe to stdin.');
      return 2;
    }
  }

  // Resolve provider
  const provider = await resolveProvider(io);
  if (!provider) return 1;

  io.out(`Provider: ${provider.id}`);
  io.out(`Language: ${lang}`);
  io.out(`Passage: ${passage.slice(0, 80)}${passage.length > 80 ? '...' : ''}`);
  io.out('');
  io.out('Running coaching + guard...');
  io.out('');

  try {
    const result = await runInteractive(passage, lang, provider);
    io.out(formatInteractiveResult(result));
    return result.guardResult.ok ? 0 : 1;
  } catch (e) {
    io.err(`Error: ${(e as Error).message}`);
    return 1;
  }
}

/**
 * `record` command: snapshot a live provider response into a replay fixture.
 *
 * Usage: whetstone-dev record <fixture-path> [--passage "text"]
 *
 * If no passage is given, reads from stdin. The fixture is saved to the
 * specified path as JSON (ProviderFixture format).
 */
async function cmdRecord(
  args: readonly string[],
  io: CliIO,
): Promise<number> {
  // Parse args: first positional is the fixture path
  const positionalArgs = args.filter((a) => !a.startsWith('--'));
  if (positionalArgs.length === 0) {
    io.err('Usage: whetstone-dev record <fixture-path> [--passage "text"]');
    return 2;
  }

  const fixturePath = positionalArgs[0];

  // Get passage from --passage flag or stdin
  let passage: string;
  const passageIdx = args.indexOf('--passage');
  if (passageIdx !== -1 && passageIdx + 1 < args.length) {
    passage = args[passageIdx + 1];
  } else {
    passage = await readStdin();
    if (!passage.trim()) {
      io.err('No passage provided. Use --passage "text" or pipe to stdin.');
      return 2;
    }
  }

  // Resolve provider
  const provider = await resolveProvider(io);
  if (!provider) return 1;

  io.out(`Recording provider response to: ${fixturePath}`);
  io.out(`Passage: ${passage.slice(0, 80)}${passage.length > 80 ? '...' : ''}`);
  io.out('');

  // We record using a simple fixture format inline (the FixtureRecorder is in
  // test/support and can't be imported from shipped code). The fixture is
  // compatible with FixtureReplayer.
  const calls: Array<{
    method: string;
    request: unknown;
    response: unknown;
    recordedAt: string;
  }> = [];

  try {
    // Record a coach call
    const coachReq = {
      selectionText: passage,
      anchorBase: 0,
      documentLanguage: 'markdown' as const,
    };

    io.out('Recording coach call...');
    const coachResponse = await provider.coach(coachReq);
    calls.push({
      method: 'coach',
      request: coachReq,
      response: coachResponse,
      recordedAt: new Date().toISOString(),
    });

    // Record a judge call with the coaching result
    if (coachResponse.ok) {
      io.out('Recording judge call...');
      const judgeResponse = await provider.judge(coachResponse.value);
      calls.push({
        method: 'judge',
        request: coachResponse.value,
        response: judgeResponse,
        recordedAt: new Date().toISOString(),
      });
    }

    // Save the fixture
    const fixture = { version: 1, provider: provider.id, calls };
    const fs = await import('node:fs');
    const dir = path.dirname(path.resolve(fixturePath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.resolve(fixturePath),
      `${JSON.stringify(fixture, null, 2)}\n`,
      'utf8',
    );

    io.out(`Recorded ${calls.length} calls to ${path.resolve(fixturePath)}`);
    return 0;
  } catch (e) {
    io.err(`Error: ${(e as Error).message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read all of stdin as a string. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // If stdin is a TTY (no pipe), resolve with empty string
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the dev CLI. Returns a process exit code; never calls `process.exit`
 * itself so it can be invoked from tests without tearing down the runner.
 */
export async function runCli(args: readonly string[], io: CliIO): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    printHelp(io);
    return 0;
  }

  if (args.length === 0) {
    io.out(`${CLI_NAME}: scaffold ready.`);
    io.out("Run with '--help' to see available commands.");
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case 'interactive':
      return cmdInteractive(rest, io);
    case 'record':
      return cmdRecord(rest, io);
    default:
      io.err(`${CLI_NAME}: unknown command '${command}'. Run with '--help'.`);
      return 2;
  }
}
