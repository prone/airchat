import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The published `airchat` command runs the CLI only for the subcommands named
 * in CLI_COMMANDS (src/index.ts); anything else starts the setup wizard. So a
 * command added to packages/cli and not to that list does not fail, it does
 * the wrong thing. `conversation` and `wait` were nearly released that way.
 * This reads both files and requires the two lists to agree.
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');

function cliCommands(): string[] {
  const source = read('../../../cli/src/index.ts');
  // Top-level commands only: `program.command('x ...')`, written either
  // directly or as `const x = program.command('x')` for a command group.
  const names = [...source.matchAll(/\bprogram\s*\.command\('([a-z][a-z-]*)/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

function listedCommands(): string[] {
  const source = read('../index.ts');
  const list = /const CLI_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (!list) throw new Error('CLI_COMMANDS not found in src/index.ts');
  return [...list[1].matchAll(/'([a-z][a-z-]*)'/g)].map((m) => m[1]).sort();
}

describe('the published command list', () => {
  it('finds the commands in both files', () => {
    expect(cliCommands()).toContain('dm');
    expect(cliCommands().length).toBeGreaterThan(15);
  });

  it('names every CLI command, and nothing the CLI does not have', () => {
    expect(listedCommands()).toEqual(cliCommands());
  });
});
