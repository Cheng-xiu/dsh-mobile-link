#!/usr/bin/env node
// dsh-mobile-link standalone CLI.
import { buildProgram } from '../lib/cli-command.js';

const program = buildProgram();
try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error('[dsh-mobile-link][ERROR]', error && error.message ? error.message : String(error));
  process.exitCode = 1;
}
