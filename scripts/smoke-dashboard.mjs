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
  console.log(`host: ${host.entry}`);
  // Prove the shape we rely on before anything else: which export lives where.
  for (const name of ['Container', 'SettingsList', 'SelectList', 'Text', 'Input'])
    console.log(`  pi-tui.${name}: ${typeof host.tui[name]}`);
  for (const name of ['DynamicBorder', 'getSettingsListTheme', 'getSelectListTheme', 'keyHint'])
    console.log(`  pi-coding-agent.${name}: ${typeof host.agent[name]}`);
  if (host.provenance.length)
    throw Error(`host module shape changed: missing ${host.provenance.join(', ')}`);

  // The real pi loader: jiti plus the host module mapping, exactly as at runtime.
  const { loadExtensions, createExtensionRuntime } = await piExtensions();
  const entry = join(process.cwd(), 'index.ts');
  const loaded = await loadExtensions([entry], process.cwd(), undefined, createExtensionRuntime());
  if (loaded.errors?.length)
    throw Error(`extension did not load: ${loaded.errors.map((e) => e.error ?? e).join('; ')}`);
  const command = loaded.extensions
    .flatMap((e) => [...e.commands.values()])
    .find((c) => c.name === 'economist');
  if (!command) throw Error('the real loader did not register /economist');

  host.theme.initTheme?.();
  const theme = host.theme.theme;
  const keybindings = host.tui.getKeybindings();

  const dir = await mkdtemp(join(tmpdir(), 'econ-smoke-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  try {
    await mkdir(join(dir, '.pi'), { recursive: true });
    // A seeded pool: `simulate` must have something to route to, and the pool submenu
    // needs a member to open. Nothing here calls a model.
    await writeFile(
      join(dir, '.pi', 'pi-suite.yaml'),
      'schemaVersion: 1\nmodelEconomist:\n  mode: rules\n  policy: economy\n  candidates:\n    - { id: openrouter/cheap/model, tier: 1, tools: true }\n    - { id: openrouter/strong/model, tier: 3, tools: true }\n',
    );
    const models = [
      { provider: 'openrouter', id: 'cheap/model', name: 'cheap', api: 'openai-completions', input: ['text'], cost: { input: 0.2, output: 0.6 }, contextWindow: 200000, reasoning: true },
      { provider: 'openrouter', id: 'strong/model', name: 'strong', api: 'openai-completions', input: ['text'], cost: { input: 3, output: 12 }, contextWindow: 200000, reasoning: true },
    ];
    const f = fakePi(dir, models);
    f.ctx.scopedModels = [];
    f.ctx.modelRegistry.hasConfiguredAuth = () => true;
    const notes = [];
    const firstLine = (text) => String(text).split('\n')[0];
    f.ctx.ui.notify = (text) => notes.push(String(text));
    f.ctx.ui.setStatus = () => {};
    let screen = null;
    let close;
    const closed = new Promise((resolve) => (close = resolve));
    f.ctx.ui.custom = (factory) => {
      screen = factory({ requestRender: () => {} }, theme, keybindings, (result) => close(result));
      return closed;
    };
    const ctx = f.ctx;
    const show = (label, limit = 26) => {
      console.log(`\n──── ${label}`);
      if (!screen) {
        console.log('   (nenhuma tela: /economist não abriu painel)');
        return;
      }
      for (const line of screen.render(96).slice(0, limit)) console.log(`   ${strip(line)}`);
    };
    const send = (bytes) => screen.handleInput(bytes);
    const saved = () => readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8').catch(() => '(sem arquivo)');
    /**
     * The screen writes through promises the UI never awaits (a real keypress has no
     * promise to hang on). Wait for the observable effect — the file on disk — instead
     * of counting ticks: a deadline on a real side effect is deterministic, a tick
     * budget is not.
     */
    const waitFor = async (predicate, what, ms = 4000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (await predicate()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error(`timeout aguardando: ${what}`);
    };
    const decision = async (label) => {
      await command.handler('simulate "refatorar auth e rodar testes"', ctx);
      console.log(`\n${label}`);
      for (const line of String(notes.at(-1)).split('\n')) console.log('   ' + strip(line));
    };

    await decision('DECISÃO ANTES DO PAINEL (simulate, sem chamar modelo):');
    const before = await saved();

    const running = command.handler('', ctx);
    await new Promise((r) => setImmediate(r));
    if (!screen) {
      await running;
      console.log('\nPAINEL NÃO ABRIU — notas do comando (por quê?):');
      for (const note of notes) console.log('   · ' + firstLine(note));
      throw Error('bare /economist did not take over the screen (no menu at all)');
    }
    show('painel aberto com /economist (vazio)');

    send(DOWN); // Modo
    send(DOWN); // Política
    show('após 2× ↓ (cursor em Política)');
    send(ENTER);
    await waitFor(async () => (await saved()) !== before, 'Enter em Política ter persistido');
    show('após Enter em Política (valor ciclado, aplicado e persistido)');
    const afterPolicy = await saved();
    if (afterPolicy === before)
      throw Error('Enter ciclou um valor mas nada foi persistido em .pi/pi-suite.yaml');
    if (!/policy: (balanced|quality|latency|economy)/.test(afterPolicy))
      throw Error('o arquivo não traz a chave policy');

    // Submenu de 2 níveis com navigateTo: pool → candidato → poolEdit → tier.
    for (let i = 3; i < 12; i++) send(DOWN);
    show('cursor em "Pool de candidatos"');
    send(ENTER);
    show('submenu pool aberto');
    send(ESC);
    await new Promise((r) => setImmediate(r));
    show('após Esc: voltou para a lista principal — o painel continua aberto');

    send(ENTER); // reabre pool
    send(ENTER); // escolhe o primeiro candidato: done(undefined,{navigateTo:'poolEdit'})
    await new Promise((r) => setImmediate(r));
    // `settings-list.js:227-233` — navigateTo re-selects the target row AND activates it,
    // so the second level is already open here; pressing enter again would pick a row.
    show('segundo nível já aberto pelo navigateTo ("Editar candidato")');
    for (let i = 0; i < 4; i++) send(DOWN); // tier 1 → tier 5
    send(ENTER);
    await waitFor(
      async () => /tier: 5/.test(await saved()),
      'edição de tier pelo submenu ter persistido',
    );
    show('após tier 5 no candidato');

    send(ESC); // no topo, agora fecha
    const summary = await closed;
    console.log('\nFECHAMENTO →', JSON.stringify(summary));
    console.log('NOTIFICAÇÕES DO PAINEL →', JSON.stringify(notes.slice(-4).map(firstLine)));

    await decision('DECISÃO DEPOIS DO PAINEL (mesmo pedido, política e tier novos):');
    await command.handler('off', ctx);
    await waitFor(async () => /enabled: false/.test(await saved()), 'escrita de enabled: false');
    console.log('\nARQUIVO FINAL GRAVADO PELO PAINEL:\n' + (await saved()).trimEnd());
    console.log('\nOK: menu abriu, navegou, persistiu e fechou com resumo contra o host real.');
  } finally {
    if (old === undefined) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error('SMOKE FALHOU:', error?.stack ?? error);
  process.exitCode = 1;
});
