// Bootstrap for the dev CLI. esbuild bundles this to `dist/dev/cli.js`; `npm run
// dev` runs it under plain Node (no VS Code host). All logic lives in `runCli`.
import { runCli, type CliIO } from './cli';

const io: CliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

runCli(process.argv.slice(2), io)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
