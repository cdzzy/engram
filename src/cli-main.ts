/**
 * Bin entry point for the `engram` CLI.
 * Kept separate from cli.ts so the command implementations stay testable
 * without triggering a second main() with the test runner's argv.
 */
import { main } from './cli.js';

main().then(
  code => process.exit(code),
  err => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`engram: ${message}\n`);
    process.exit(1);
  },
);
