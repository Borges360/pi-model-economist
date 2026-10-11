/**
 * Probe the real command grammar through pi's loader and print what the user would
 * see in the autocomplete list.
 *
 *   node scripts/probe-complete.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { piExtensions } from './pi-module.mjs';

const { loadExtensions, createExtensionRuntime } = await piExtensions();
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const probes = [
  ['pi-model-economist', ['', 'mo', 'mode ', 'mode hyb', 'candidates ', 'candidates add ', 'candidates remove ', 'policy ', 'budget ', 'budget task 0.5 ', 'simulate hello', 'classifier ']],
  ['pi-loop-guard', ['', 'pol', 'policy ', 'limits ', 'limits tool-repeat ', 'resume ', 'report --', 'change-']],
  ['pi-mcp-control', ['', 'us', 'use ', 'allow ', 'allow mcp__x ', 'allow mcp__x --scope ', 'inspect ', 'revoke ', 'trace --', 'prof']],
  ['pi-cost-profiler', ['', 'ta', 'task ', 'project --', 'project --last ', 'budget ', 'budget task ', 'export --', 'export --format ', 'compare ', 'reconcile ']],
  ['pi-acceptance-gate', ['', 'us', 'use ', 'approve ', 'fail ', 'check ', 'rep']],
];

let bad = 0;
for (const [dir, prefixes] of probes) {
  const extDir = resolve(workspace, dir);
  const result = await loadExtensions(
    [resolve(extDir, 'index.ts')],
    extDir,
    undefined,
    createExtensionRuntime(),
  );
  if (result.errors?.length) {
    bad++;
    console.log(`FAIL ${dir}: ${result.errors.map((e) => e.error).join('; ')}`);
    continue;
  }
  const command = result.extensions.flatMap((e) => [...e.commands.values()])[0];
  console.log(`\n── /${command.name} ── ${command.description}`);
  for (const prefix of prefixes) {
    const items = (await command.getArgumentCompletions(prefix)) ?? [];
    const shown = items
      .slice(0, 4)
      .map((i) => `${i.value}${i.description ? ` ⟨${i.description}⟩` : ''}`)
      .join('  |  ');
    console.log(`  "${prefix}" -> ${String(items.length).padStart(2)}: ${shown || '(none)'}`);
    if (prefix === '' && items.length < 5) {
      console.log('     !! bare command should list its subcommands');
      bad++;
    }
  }
}
process.exit(bad ? 1 : 0);
