/**
 * Load each suite extension through pi's own loader and verify it registers a
 * command whose argument completion is real and never throws.
 *
 *   node scripts/check-load.mjs <dir> [<dir> ...]
 *
 * Exit 1 on a load failure or a command with missing/invalid completion.
 */
import { piExtensions } from './pi-module.mjs';

const { loadExtensions, createExtensionRuntime } = await piExtensions();
const targets = process.argv.slice(2);
if (!targets.length) throw Error('usage: check-load.mjs <extension-dir> ...');

let bad = 0;
for (const dir of targets) {
  const entry = `${dir.replace(/[\\/]+$/, '')}/index.ts`;
  const result = await loadExtensions([entry], process.cwd(), undefined, createExtensionRuntime());
  const errors = result.errors ?? [];
  if (errors.length) {
    bad++;
    console.log(`FAIL ${dir}`);
    for (const e of errors) console.log(`     ${e.error ?? e}`);
    continue;
  }
  for (const w of result.warnings ?? []) console.log(`WARN ${dir}: ${w.warning ?? w}`);

  const cmds = result.extensions.flatMap((e) => [...e.commands.values()]);
  const tools = result.extensions.flatMap((e) => [...e.tools.values()]);
  const rows = [];
  for (const c of cmds) {
    const problem = await completionProblems(c);
    if (problem) {
      bad++;
      rows.push(`${c.name} [${problem}]`);
    } else rows.push(`${c.name} [+complete]`);
  }
  if (!cmds.length) {
    bad++;
    rows.push('(no command registered)');
  }
  console.log(`OK   ${dir}  cmds: ${rows.join(', ')}  tools: ${tools.length}`);
}
process.exit(bad ? 1 : 0);

/**
 * A completion that throws or returns the wrong shape is worse than none: pi swallows
 * it and the user just sees nothing happen. Exercise the whole grammar, including the
 * inputs a human can actually produce.
 */
async function completionProblems(command) {
  if (typeof command.getArgumentCompletions !== 'function') return 'NO COMPLETION';
  const prefixes = ['', 'x', 'x ', 'x y ', 'x y z ', '--', '--x ', 'é ', '\u0000', 'a'.repeat(2000)];
  for (const prefix of prefixes) {
    try {
      const out = await command.getArgumentCompletions(prefix);
      if (out === null || out === undefined) continue;
      if (!Array.isArray(out)) return 'non-array result';
      for (const item of out)
        if (typeof item?.value !== 'string' || typeof item?.label !== 'string')
          return 'item missing value/label';
    } catch (e) {
      return `threw: ${e.message}`;
    }
  }
  // A bare command must teach the grammar; that is the whole point of discoverability.
  const bare = await command.getArgumentCompletions('');
  if (!bare || bare.length < 4) return 'bare command lists too few subcommands';
  return null;
}
