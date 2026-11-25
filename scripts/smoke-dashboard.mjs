/**
 * Real-host smoke for the `/economist` settings panel.
 *
 * Unit tests drive the vendored adapter with the pinned pi-tui devDependency. Only the
 * INSTALLED Pi can show that the extension loader (jiti plus the host module mapping)
 * resolves the adapter's static `@earendil-works/pi-tui` import to the host's own copy,
 * and that the host theme and keybindings drive the panel. A module-shape mistake of
 * that kind once kept the menu from opening while every unit test stayed green.
 *
 * This script loads `index.ts` through the installed Pi's own loader, mounts every screen
 * the command opens with the real theme and real keybindings, and drives it with terminal
 * bytes (↑ ↓ Enter Ctrl+S Esc) the way a human does. Every frame is rendered at 40, 80 and
 * 120 columns and checked with the host's `visibleWidth`. It never calls a model and never
 * spends money: the decision is a `simulate`, which is a dry run by construction.
 *
 *   node scripts/smoke-dashboard.mjs          # optionally: PI_CODING_AGENT_ENTRY=<pi>/dist/index.js
 *
 * Exit 0 with a PASS line on stdout; exit 1 on any host/API mismatch.
 */
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piExtensions } from './pi-module.mjs';
import { fakePi } from '../test-support/fakes.mjs';

// The extension installs its themes into the agent dir; a smoke never writes to the real ~/.pi.
process.env.PI_DESIGN_THEMES ??= 'off';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';
const CTRL_S = '\x13';
const url = (path) => pathToFileURL(path).href;
const settle = () => new Promise((r) => setTimeout(r, 15));
/** ANSI stripped so the checks read the text the user reads. */
const strip = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, '');
const plain = (component) => component.render(120).map(strip).join('\n');

/** Locate the installed pi-coding-agent's dist/index.js (same search as pi-module.mjs). */
async function agentEntry() {
  const root = join(homedir(), '.pi', 'agent', 'install', 'releases');
  const versions = await readdir(root).catch(() => []);
  const candidates = [
    process.env.PI_CODING_AGENT_ENTRY,
    ...versions.sort().reverse().map((v) => join(root, v, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const path = candidate.replace(/[/\\]$/, '').replace(/[\\/]dist[/\\]?$/, '/dist/index.js');
    if (await readFile(path).then(() => true, () => false)) return path;
  }
  throw Error('installed pi-coding-agent/dist/index.js not found; set PI_CODING_AGENT_ENTRY');
}

async function realModules() {
  const entry = await agentEntry();
  const dist = dirname(entry);
  const theme = await import(url(join(dist, 'modes', 'interactive', 'theme', 'theme.js')));
  let tui;
  for (const candidate of [
    join(dist, '..', '..', 'pi-tui', 'dist', 'index.js'),
    join(dist, '..', '..', '..', 'pi-tui', 'dist', 'index.js'),
  ]) {
    try {
      const mod = await import(url(candidate));
      if (mod.Input && mod.getKeybindings && mod.visibleWidth) {
        tui = mod;
        break;
      }
    } catch {
      /* next candidate */
    }
  }
  if (!tui) throw Error('installed pi-tui not importable from the pi release directory');
  const { HOST_EXPORTS } = await import('../menu.mjs');
  const provenance = HOST_EXPORTS['@earendil-works/pi-tui'].filter((n) => typeof tui[n] !== 'function').map((n) => `pi-tui.${n}`);
  const version = /releases[\\/]([^\\/]+)[\\/]/.exec(entry)?.[1] ?? entry;
  return { entry, version, theme, tui, provenance };
}

const run = async () => {
  const host = await realModules();
  if (host.provenance.length) throw Error(`missing host exports: ${host.provenance.join(', ')}`);
  const dir = await mkdtemp(join(tmpdir(), 'econ-v2-host-'));
  const oldHome = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  try {
    const { loadExtensions, createExtensionRuntime } = await piExtensions();
    const loaded = await loadExtensions([join(process.cwd(), 'index.ts')], process.cwd(), undefined, createExtensionRuntime());
    if (loaded.errors?.length) throw Error(loaded.errors.map((e) => e.error).join('; '));
    const command = loaded.extensions.flatMap((e) => [...e.commands.values()]).find((c) => c.name === 'economist');
    if (!command) throw Error('economist command not loaded');
    const toolCount = loaded.extensions.flatMap((e) => [...e.tools.values()]).length;
    if (toolCount !== 3) throw Error(`expected 3 tools, received ${toolCount}`);
    host.theme.initTheme?.();
    const config = join(dir, '.pi', 'pi-suite.yaml');
    await mkdir(join(dir, '.pi'), { recursive: true });
    await writeFile(config, 'modelEconomist:\n  configVersion: 2\n  preset: balanced\n  control: advisory\n  mode: rules\n  candidates:\n    - { id: p/model, tier: 3, tools: true }\n    - { id: p/模型-ü, tier: 1, tools: true }\n');
    const f = fakePi(dir, [
      { provider: 'p', id: 'model', name: 'fixture', api: 'openai-completions', input: ['text'], cost: { input: 1, output: 2 }, contextWindow: 200000, reasoning: true },
      { provider: 'p', id: '模型-ü', name: 'wide', api: 'openai-completions', input: ['text'], cost: { input: 0.1, output: 0.2 }, contextWindow: 200000, reasoning: true },
    ]);
    const screens = [];
    f.ctx.ui.custom = (factory, options) => new Promise((resolve) => {
      if (options?.overlay !== true) throw Error('the panel must be a temporary overlay');
      const screen = { closed: false };
      screen.component = factory({ requestRender() {}, terminal: { rows: 40 } }, host.theme.theme, host.tui.getKeybindings(), (value) => {
        screen.closed = true;
        resolve(value);
      });
      screens.push(screen);
    });
    const waitScreen = async (n) => {
      const deadline = Date.now() + 4000;
      while (screens.length < n && Date.now() < deadline) await settle();
      if (screens.length < n) throw Error(`screen #${n} did not open`);
      return screens[n - 1].component;
    };
    const frames = [];
    const render = (component, label) => {
      for (const width of [40, 80, 120]) {
        const lines = component.render(width);
        if (!lines.length) throw Error(`${label}: empty render at ${width}`);
        const wide = lines.find((line) => host.tui.visibleWidth(line) > width);
        if (wide !== undefined) throw Error(`${label}: render exceeds ${width} columns: ${JSON.stringify(wide)}`);
      }
      frames.push(label);
      return plain(component);
    };
    const press = async (component, ...keys) => {
      for (const key of keys) {
        component.handleInput(key);
        await settle();
        await component.drain?.();
      }
    };

    const pending = command.handler('', f.ctx);
    let panel = await waitScreen(1);
    let text = render(panel, 'panel');
    if (!/Priority/.test(text) || !/Balanced/.test(text)) throw Error(`panel did not show the current preset:\n${text}`);
    const before = await readFile(config, 'utf8');
    // Language, Routing, Priority: ↓ ↓ Enter opens the choice list; ↑ moves to Economy.
    await press(panel, DOWN, DOWN, ENTER);
    render(panel, 'priority list');
    await press(panel, UP, ENTER);
    text = render(panel, 'draft');
    if ((await readFile(config, 'utf8')) !== before) throw Error('preset navigation wrote before Ctrl+S');
    if (!/Economy/.test(text) || !/\*/.test(text.split('\n')[0])) throw Error(`the draft did not show Economy:\n${text}`);
    await press(panel, CTRL_S);
    const after = await readFile(config, 'utf8');
    if (!/preset: economy/.test(after) || screens[0].closed) throw Error(`Ctrl+S did not save Economy and keep the panel open: ${render(panel, 'saved')}`);
    render(panel, 'saved');

    // Language preview (↑ ↑ to Language, Enter, ↓ Enter), then Esc warns and Esc discards.
    await press(panel, UP, UP, ENTER, DOWN, ENTER);
    text = render(panel, 'pt-BR preview');
    if (!/Idioma/.test(text) || !/Salvar/.test(text)) throw Error(`no Portuguese preview:\n${text}`);
    await press(panel, ESC);
    if (screens[0].closed) throw Error('the first Esc on a draft must warn, not close');
    render(panel, 'discard warning');
    await press(panel, ESC);
    if (!screens[0].closed) throw Error('the second Esc did not discard and close');
    if (/locale/.test(await readFile(config, 'utf8'))) throw Error('the discarded preview was written');
    await pending;

    // Pool screen and the dry-run simulation, reached from the panel rows.
    const second = command.handler('', f.ctx);
    panel = await waitScreen(2);
    const rowsDown = async (component, label) => {
      const focused = () => new RegExp(`^> ${label}`, 'm').test(plain(component));
      for (let i = 0; i < 40 && !focused(); i++) await press(component, DOWN);
      if (!focused()) throw Error(`row ${label} not reachable:\n${plain(component)}`);
    };
    await rowsDown(panel, 'Candidate pool');
    await press(panel, ENTER);
    const pool = await waitScreen(3);
    text = render(pool, 'pool');
    if (!/模型-ü · in pool/.test(text)) throw Error(`the pool screen did not list the candidates:\n${text}`);
    await press(pool, ESC);
    panel = await waitScreen(4);
    await rowsDown(panel, 'Simulate a request');
    await press(panel, ENTER);
    const simulate = await waitScreen(5);
    await press(simulate, ENTER);
    if (simulate.input?.constructor?.name !== 'Input') throw Error('the request field is not a pi-tui Input');
    for (const ch of 'refatorar autenticação') await press(simulate, ch);
    if (!/refatorar autenticação/.test(render(simulate, 'request typed'))) throw Error('typed text is not visible in the field');
    await press(simulate, ENTER, DOWN, ENTER);
    const result = await waitScreen(6);
    text = render(result, 'simulation result');
    if (!/model \+ effort: p\//.test(text)) throw Error(`the simulation did not name a model:\n${text}`);
    await press(result, ESC);
    panel = await waitScreen(7);
    render(panel, 'back to panel');
    await press(panel, ESC);
    await second;

    // An installed copy has no devDependencies: load the shipped files alone (plus the
    // `yaml` runtime dependency) so the vendored adapter can only reach pi-tui through
    // Pi's host module mapping, and open its panel once.
    const isolated = join(dir, 'isolated');
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const { cp } = await import('node:fs/promises');
    for (const entry of ['package.json', ...pkg.files]) await cp(entry, join(isolated, entry), { recursive: true });
    await cp(join('node_modules', 'yaml'), join(isolated, 'node_modules', 'yaml'), { recursive: true });
    const copy = await loadExtensions([join(isolated, 'index.ts')], isolated, undefined, createExtensionRuntime());
    if (copy.errors?.length) throw Error(`isolated copy failed to load: ${copy.errors.map((e) => e.error).join('; ')}`);
    const copied = copy.extensions.flatMap((e) => [...e.commands.values()]).find((c) => c.name === 'economist');
    const third = copied.handler('', f.ctx);
    const isolatedPanel = await waitScreen(8);
    if (!/Priority/.test(render(isolatedPanel, 'isolated copy'))) throw Error('the isolated copy did not render its panel');
    await press(isolatedPanel, ESC);
    await third;

    await command.handler('metrics', f.ctx);
    if (!f.notifications.at(-1).includes('unknown')) throw Error('missing unknown provenance in metrics');
    // Worker URL resolution must also work through Pi's real jiti extension loader.
    await writeFile(join(dir, 'empty.jsonl'), '');
    f.ctx.mode = 'print';
    await command.handler('evaluate empty.jsonl', f.ctx);
    const journal = await readdir(join(dir, 'state', 'projects'), { recursive: true });
    const evidence = journal.find((file) => /economics-evaluations\.jsonl$/.test(file));
    if (!evidence) throw Error(`offline evaluation did not persist through real loader: ${f.notifications.at(-1)}`);
    const saved = JSON.parse((await readFile(join(dir, 'state', 'projects', evidence), 'utf8')).trim());
    if (saved.report.arms['full-adaptive'].eligible !== false) throw Error('empty evidence enabled Adaptive');
    console.log(`PASS Pi ${host.version}: real loader, ${toolCount} tools, isolated copy without node_modules/pi-tui, preset ↓↓Enter↑Enter, Ctrl+S keeps it open, pt-BR preview, Esc warns then discards, pool, simulation, ${frames.length} frames at 40/80/120 columns, offline evaluation thread, no provider calls.`);
  } finally {
    if (oldHome === undefined) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = oldHome;
    const target = await import('node:fs/promises').then((fs) => fs.realpath(dir));
    const tempRoot = await import('node:fs/promises').then((fs) => fs.realpath(tmpdir()));
    if (!target.startsWith(tempRoot) || !target.includes('econ-v2-host-')) throw Error('invalid smoke cleanup target');
    await rm(target, { recursive: true, force: true });
  }
};
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
