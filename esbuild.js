// esbuild bundler for the Whetstone VS Code extension host and the headless dev CLI.
//
//   node esbuild.js              build both targets once
//   node esbuild.js --cli        build only the dev CLI (fast prompt-iteration loop)
//   node esbuild.js --watch      rebuild on change
//   node esbuild.js --production  minified, no sourcemap (used by vscode:prepublish)
//
// The extension bundle marks `vscode` external (provided by the host); the dev
// CLI bundle has no `vscode` import at all so it runs in plain Node.

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const cliOnly = process.argv.includes('--cli');

/** @type {import('esbuild').BuildOptions} */
const base = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const extensionBuild = {
  ...base,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  // `vscode` is provided by the extension host; `harper.js` ships its own
  // WASM binary loaded at runtime via `import.meta.url` which does not
  // survive bundling cleanly — mark it external so the extension loads it
  // from node_modules at runtime.
  external: ['vscode', 'harper.js', 'harper.js/binary'],
};

/** @type {import('esbuild').BuildOptions} */
const cliBuild = {
  ...base,
  entryPoints: ['src/dev/main.ts'],
  outfile: 'dist/dev/cli.js',
  // `vscode` is marked external as a guard: the CLI must never pull the host in.
  external: ['vscode'],
};

async function main() {
  const targets = cliOnly ? [cliBuild] : [extensionBuild, cliBuild];

  if (watch) {
    const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('[watch] build finished; watching for changes...');
    return;
  }

  await Promise.all(targets.map((t) => esbuild.build(t)));
  console.log('[build] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
