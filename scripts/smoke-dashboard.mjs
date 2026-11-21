/**
 * Real-host smoke for the `/economist` dashboard.
 *
 * The unit tests drive a hand-written double (`test-support/fake-tui.mjs`), and that
 * double defines the module shape from memory. It shipped `DynamicBorder` inside
 * `tuiPkg` while the real host exports it from `@earendil-works/pi-coding-agent`
 * (`dist/index.d.ts:36`; `pi-tui/dist/index.d.ts:32` exports `Container`, not it), so
 * `new DynamicBorder(...)` threw inside `ctx.ui.custom()` and the menu never appeared —
 * with 49 unit tests green. Only the real modules can catch that class of bug.
 *
 * This script uses the INSTALLED pi: its own extension loader (jiti plus the host
 * module mapping), the real `pi-tui` components, the real theme and the real
 * keybindings, and drives the screen with terminal bytes (↓ / Enter / Esc) the way a
 * human does. It never calls a model and never spends money: the decision is a
 * `simulate`, which is dry-run by construction.
 *
 *   node scripts/smoke-dashboard.mjs          # optionally: PI_CODING_AGENT_ENTRY=<pi>/dist/index.js
 *
 * Exit 0 with the rendered screens on stdout; exit 1 on any host/API mismatch.
 */
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piExtensions } from './pi-module.mjs';
import { fakePi } from '../test-support/fakes.mjs';

const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';
const url = (path) => pathToFileURL(path).href;

/** Locate the installed pi-coding-agent's dist/index.js (same search as pi-module.mjs). */
async function agentEntry() {
  const candidates = [
    process.env.PI_CODING_AGENT_ENTRY,
    ...(await readdir(join(homedir(), '.pi', 'agent', 'install', 'releases'))
      .catch(() => [])
      .then((versions) =>
        versions
          .sort()
          .reverse()
          .map((v) =>
            join(
              homedir(),
              '.pi',
              'agent',
              'install',
              'releases',
              v,
              'node_modules',
              '@earendil-works',
              'pi-coding-agent',
              'dist',
              'index.js',
            ),
          ),
      )),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const path = candidate.replace(/[/\\]$/, '').replace(/[\\/]dist[/\\]?$/, '/dist/index.js');
    if (await exists(path)) return path;
  }
  throw Error('installed pi-coding-agent/dist/index.js not found; set PI_CODING_AGENT_ENTRY');
}
async function exists(path) {
  try {
    return (await readFile(path)) && path;
  } catch {
    return undefined;
  }
}

async function realModules() {
  const entry = await agentEntry();
  const dist = dirname(entry);
  const agent = await import(url(entry));
  const theme = await import(url(join(dist, 'modes', 'interactive', 'theme', 'theme.js')));
  let tui;
  for (const candidate of [
    join(dist, '..', '..', 'pi-tui', 'dist', 'index.js'),
    join(dist, '..', '..', '..', 'pi-tui', 'dist', 'index.js'),
  ]) {
    try {
      const mod = await import(url(candidate));
      if (mod.SettingsList && mod.Container && mod.Input && mod.getKeybindings) {
        tui = mod;
        break;
      }
    } catch {
      /* next candidate */
    }
  }
  if (!tui) throw Error('installed pi-tui not importable from the pi release directory');
  const required = [
    ['pi-tui', tui, ['Container', 'SettingsList', 'SelectList', 'Text', 'Input', 'getKeybindings']],
    ['pi-coding-agent', agent, ['DynamicBorder', 'getSettingsListTheme', 'getSelectListTheme']],
  ];
  const provenance = required.flatMap(([name, mod, names]) =>
    names.filter((n) => typeof mod[n] !== 'function').map((n) => `${name}.${n}`),
  );
  return { entry, dist, agent, theme, tui, provenance };
}

/** ANSI stripped so the evidence lines stay readable in a terminal or a commit body. */
const strip = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, '');

const run = async () => {
  const host = await realModules();
  if (host.provenance.length) throw Error(`missing host exports: ${host.provenance.join(', ')}`);
  const dir = await mkdtemp(join(tmpdir(), 'econ-v2-host-'));
  const oldHome = process.env.PI_SUITE_HOME; process.env.PI_SUITE_HOME = join(dir, 'state');
  try {
  const { loadExtensions, createExtensionRuntime } = await piExtensions();
  const loaded = await loadExtensions([join(process.cwd(), 'index.ts')], process.cwd(), undefined, createExtensionRuntime());
  if (loaded.errors?.length) throw Error(loaded.errors.map(e => e.error).join('; '));
  const command = loaded.extensions.flatMap(e => [...e.commands.values()]).find(c => c.name === 'economist');
  if (!command) throw Error('economist command not loaded');
  const toolCount = loaded.extensions.flatMap(e => [...e.tools.values()]).length;
  if (toolCount !== 3) throw Error(`expected 3 tools, received ${toolCount}`);
  host.theme.initTheme?.();
  const config = join(dir, '.pi', 'pi-suite.yaml');
    await mkdir(join(dir, '.pi'), { recursive: true });
    await writeFile(config, 'modelEconomist:\n  configVersion: 2\n  preset: balanced\n  control: advisory\n  mode: rules\n  candidates:\n    - { id: p/model, tier: 3, tools: true }\n');
    const f = fakePi(dir, [{ provider: 'p', id: 'model', name: 'fixture', api: 'openai-completions', input: ['text'], cost: { input: 1, output: 2 }, contextWindow: 200000, reasoning: true }]);
    let screen, closed = false;
    f.ctx.ui.custom = factory => new Promise(resolve => {
      screen = factory({ requestRender() {} }, host.theme.theme, host.tui.getKeybindings(), result => { closed = true; resolve(result); });
    });
    const pending = command.handler('', f.ctx);
    const deadline = Date.now() + 4000;
    while (!screen && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    if (!screen) throw Error('dashboard did not open');
    const render = () => {
      for (const width of [40, 80, 120]) {
        const lines = screen.render(width);
        if (!lines.length || lines.some(line => host.tui.visibleWidth(line) > width)) throw Error(`render exceeds ${width} columns`);
      }
    };
    render();
    const before = await readFile(config, 'utf8');
    screen.handleInput(DOWN); screen.handleInput(DOWN); screen.handleInput(ENTER); render();
    screen.handleInput(ENTER); // Economy, first preset in the native SelectList.
    await new Promise(r => setImmediate(r));
    if ((await readFile(config, 'utf8')) !== before) throw Error('preset navigation wrote before Ctrl+S');
    render();
    await screen.handleInput('\u0013');
    const after = await readFile(config, 'utf8');
    if (!/preset: economy/.test(after) || closed) throw Error(`Ctrl+S did not save Economy and keep the panel open: ${f.notifications.join('; ')}`);
    render();
    screen.handleInput(ESC); await pending;
    await command.handler('metrics', f.ctx);
    if (!f.notifications.at(-1).includes('unknown')) throw Error('missing unknown provenance in metrics');
    // Worker URL resolution must also work through Pi's real jiti extension loader.
    await writeFile(join(dir, 'empty.jsonl'), '');
    f.ctx.mode = 'print';
    await command.handler('evaluate empty.jsonl', f.ctx);
    const journal = await readdir(join(dir, 'state', 'projects'), { recursive: true });
    const evidence = journal.find(file => /economics-evaluations\.jsonl$/.test(file));
    if (!evidence) throw Error(`offline evaluation did not persist through real loader: ${f.notifications.at(-1)}`);
    const saved = JSON.parse((await readFile(join(dir, 'state', 'projects', evidence), 'utf8')).trim());
    if (saved.report.arms['full-adaptive'].eligible !== false) throw Error('empty evidence enabled Adaptive');
    console.log(`PASS Pi ${host.entry.includes('1.5.2') ? '1.5.2' : host.entry}: real loader, ${toolCount} tools, preset Enter, Ctrl+S, Esc, 40/80/120 columns, offline evaluation thread, no provider calls.`);
  } finally {
    if (oldHome === undefined) delete process.env.PI_SUITE_HOME; else process.env.PI_SUITE_HOME = oldHome;
    const target = await import('node:fs/promises').then(fs => fs.realpath(dir));
    const tempRoot = await import('node:fs/promises').then(fs => fs.realpath(tmpdir()));
    if (!target.startsWith(tempRoot) || !target.includes('econ-v2-host-')) throw Error('invalid smoke cleanup target');
    await rm(target, { recursive: true, force: true });
  }
};
run().catch(error => { console.error(error); process.exitCode = 1; });
