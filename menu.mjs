/**
 * The `/economist` settings panel and its read-only views.
 *
 * The root command opens one panel that shows every routing knob with the value it
 * currently has. Edits stay in a draft until Ctrl+S; saving keeps the panel open; Esc
 * in a field returns, Esc on a draft warns and a second Esc discards. Pool editing,
 * the dry-run simulation and the read-only screens (session economics, last decision,
 * command reference) are rows of the same panel that hand over to their own screen and
 * come back to the panel afterwards.
 *
 * The panel itself is the vendored Pi adapter in `vendor/inteiro-terminal/` (see
 * `vendor/THIRD_PARTY_NOTICES.md`). It imports `@earendil-works/pi-tui` statically, which
 * is the only import form Pi's extension loader maps to the host modules. This module
 * owns the product side only: fields, choices, actions, texts and draft helpers.
 */

import { localeName, normalizeLocale, translate } from './lib/i18n.mjs';
import { causalExplain } from './lib/v2-ui.mjs';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { resolveMessages } from './vendor/inteiro-terminal/i18n.js';
import { keyAction, standardKeyHints } from './vendor/inteiro-terminal/keyboard.js';
import { openPiSettings, piBindings } from './vendor/inteiro-terminal/pi.js';
import { SettingsSession } from './vendor/inteiro-terminal/settings.js';
import { wrap } from './vendor/inteiro-terminal/text.js';

export { openPiSettings, SettingsSession };

/** `openrouter/qwen/turbo` → `qwen/turbo`: only the provider is dropped. */
export function shortName(id) {
  const parts = String(id ?? '').split('/');
  return parts.length > 2 ? parts.slice(1).join('/') : parts.at(-1) ?? '';
}

/** Human-readable last decision, used by the "Last decision" view and `/economist explain`. */
export function explainLines(last, conf, { calibration = null, locale = 'pt-BR' } = {}) {
  const t = (key, values) => translate(locale, key, values);
  if (!last)
    return [
      t('explain.empty.1'),
      t('explain.empty.2'),
    ];
  const a = last.assessment ?? {};
  const pct = (p) => (Number.isFinite(p) ? `${(p * 100).toFixed(1)}%` : t('value.na'));
  const usd = (n) => (Number.isFinite(n) ? `$${n.toFixed(6)}` : t('value.noKnownPrice'));
  const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)} ms` : t('value.na'));
  const cache =
    Number.isFinite(last.expectedCacheSavingsUsd) || Number.isFinite(last.expectedCacheLossUsd)
      ? t('explain.cache', { savings: usd(last.expectedCacheSavingsUsd ?? 0), loss: usd(last.expectedCacheLossUsd ?? 0) })
      : t('explain.noCacheTerm');
  const roi =
    last.classifierRoiUsd == null ? t('value.na') : `${last.classifierRoiUsd >= 0 ? '+' : ''}${last.classifierRoiUsd.toFixed(6)} USD`;
  const calib = calibration?.n
    ? t('explain.calibration', {
        ece: calibration.ece.toFixed(3),
        count: calibration.n,
        mode: t(conf.stats?.applyCalibration ? 'explain.calibrationApplied' : 'explain.calibrationReported'),
      })
    : t('explain.noCalibrationLine');
  const risks = (a.risks ?? []).join(', ') || t('value.noneRisk');
  const unknown = t('value.unknown');
  return [
    t('explain.modelEffort', { value: `${last.selectedModelId}:${last.selectedThinkingLevel ?? 'off'}` }),
    t('explain.reason', { value: (last.reasonCodes ?? []).join(' · ') || t('value.empty') }),
    t('explain.taskRisk', { kind: a.kind ?? '?', difficulty: a.difficulty ?? '?', risks }),
    t('explain.effortSource', { value: last.effortSource ?? t('value.na') }),
    t('explain.pSuccess', {
      success: pct(last.pSuccess),
      floor: pct(last.qualityFloor),
      safe: last.pSafe == null ? t('explain.noSafeSamples') : pct(last.pSafe),
      result: last.policyResult ?? t('value.na'),
    }),
    t('explain.latency', { p50: ms(last.latencyP50Ms), p95: ms(last.latencyP95Ms) }),
    t('explain.cost', {
      predicted: usd(last.predictedCostUsd ?? last.estimatedTotalCostUsd),
      classifier: usd(last.classifierCostUsd ?? 0),
      roi,
    }),
    cache,
    t('explain.finalOutcome', { value: last.finalOutcome ?? t('explain.awaitingVerification') }),
    calib,
    t('explain.rankedPool', {
      value: (last.candidates ?? []).map((c) => `${shortName(c.model)}:${c.thinkingLevel ?? 'off'}`).join(', ') || t('value.empty'),
    }),
    t('explain.rejected', {
      value: (last.rejected ?? []).map((r) => `${shortName(r.model)} (${r.reasonCodes.join('+')})`).join(', ') || t('value.noneRisk'),
    }),
    t('explain.policy', {
      policy: conf.policy,
      mode: conf.mode,
      cadence: conf.cadence ?? 'prompt',
      scope: conf.scope?.source ?? 'scoped',
    }),
    ...(last.economicsVersion === 2 ? [...causalExplain(last, locale),
      t('explain.contextPlan', {
        artifacts: last.contextPlan?.externalize?.length ?? 0,
        topology: last.contextPlan?.topology?.topology ?? 'single-agent',
      }),
      t('explain.cacheImpact', {
        reason: last.cacheImpact?.reason ?? unknown,
        probability: last.cacheImpact?.probability ?? unknown,
      }),
      t('explain.switch', {
        reason: last.switchPlan?.reason ?? t('explain.deterministicBaseline'),
        gain: usd(last.switchPlan?.deltaUsd),
      }),
      t('explain.costDecomposition', {
        value: last.costBreakdown
          ? Object.entries(last.costBreakdown).map(([key, value]) => `${key}=${typeof value === 'number' ? usd(value) : value}`).join(' · ')
          : unknown,
      }),
      t('explain.bandit', { choice: last.bandit?.shadowChoice ?? 'off', propensity: last.bandit?.propensity ?? 1 }),
    ] : []),
  ];
}

/** Tier proposal when a model goes straight from the scope into the pool. */
export function tierForPool(index, total) {
  if (total <= 1) return 1;
  return Math.min(5, Math.max(1, 1 + Math.round((index * 4) / (total - 1))));
}

/** What each tier is for, with the current one marked. */
export function candidateActions(current, locale = 'pt-BR') {
  const t = (key, values) => translate(locale, key, values);
  const tier = Number(current?.tier) || 1;
  return [
    ...[1, 2, 3, 4, 5].map((tierValue) => ({
      value: `tier:${tierValue}`,
      label: t('candidate.tier', { tier: tierValue }),
      description:
        tierValue === tier
          ? t('action.current')
          : t(`action.tier${tierValue}`),
    })),
    {
      value: 'tools:on',
      label: t('action.toolsOn'),
      description: current?.tools ? t('action.current') : t('action.toolsEnableHelp'),
    },
    {
      value: 'tools:off',
      label: t('action.toolsOff'),
      description: current?.tools === false ? t('action.current') : t('action.toolsDisableHelp'),
    },
    { value: 'remove', label: t('action.remove'), description: t('action.removeHelp') },
  ];
}

/**
 * Test seam: the host modules index.ts imported statically. The panel no longer draws
 * with them (the vendored adapter imports pi-tui itself), but `runOperation` still uses
 * the host `Text`, and the provenance check below runs against what the host handed us.
 */
export const host = { tui: undefined, agent: undefined };

/** Own a cancellable operation without replacing the editor/footer or logging input data. */
export async function runOperation(ctx, title, fn, signal, { cancelHint = 'Esc · cancel' } = {}) {
  if (!host.tui?.Text || ctx.mode !== 'tui' || !ctx.ui.custom) return fn(signal);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const result = await ctx.ui.custom((tui, theme, keys, done) => {
    let disposed = false;
    const text = new host.tui.Text(theme.fg('accent', `${title}\n${cancelHint}`));
    Promise.resolve().then(() => fn(combined)).then(value => { if (!disposed) { disposed = true; done({ value }); } },
      error => { if (!disposed) { disposed = true; done({ error }); } });
    return { render: width => text.render(width), invalidate: () => text.invalidate?.(),
      handleInput(data) { if (keys?.matches(data, 'tui.select.cancel')) controller.abort(Error('Offline evaluation cancelled')); },
      dispose() { disposed = true; controller.abort(); } };
  });
  controller.abort(); if (result.error) throw result.error; return result.value;
}

/**
 * Wire the host modules the entry point (`index.ts`) imported statically. Static
 * import at the entry is the only path that resolves under pi's loader: a dynamic
 * `await import('@earendil-works/pi-tui')` from inside an extension falls through to
 * Node's native resolver and fails with ERR_MODULE_NOT_FOUND. Called once at install time.
 */
export function provideHost(tui, agent) {
  if (tui) host.tui = tui;
  if (agent) host.agent = agent;
  return host;
}

/**
 * The host surface the panel depends on. The vendored adapter imports `Input`,
 * `matchesKey`, `truncateToWidth` and `visibleWidth` from pi-tui
 * (`vendor/inteiro-terminal/pi.js:2`), the read-only view below uses the last three, and
 * `runOperation` draws with pi-tui `Text`. Nothing
 * from pi-coding-agent is needed any more: the panel paints with the theme that
 * `ctx.ui.custom` hands over. The smoke script asserts this table against the installed host.
 */
export const HOST_EXPORTS = {
  '@earendil-works/pi-tui': ['Input', 'matchesKey', 'truncateToWidth', 'visibleWidth', 'Text'],
};

/** Name the exports the host does not actually provide (missing module counts as every export). */
export function missingHostExports(tuiPkg) {
  const mods = { '@earendil-works/pi-tui': tuiPkg };
  return Object.entries(HOST_EXPORTS).flatMap(([name, exports]) =>
    exports.filter((key) => typeof mods[name]?.[key] !== 'function').map((key) => `${name}.${key}`),
  );
}

/** Flat panel values from the nested `modelEconomist` section. */
export function panelValues(conf, locale) {
  return {
    language: normalizeLocale(locale),
    enabled: conf.enabled === true,
    preset: conf.preset ?? 'custom',
    control: conf.control ?? 'advisory',
    contextEnabled: conf.context?.enabled !== false,
    retrievalBudget: String(conf.context?.retrieval?.budgetTokens ?? 2048),
    privacyExecutor: conf.executor?.dataPolicy ?? 'allow',
    privacyClassifier: conf.classifier?.dataPolicy ?? 'redact',
    privacyTelemetry: conf.telemetry?.dataPolicy ?? 'redact',
    cadence: conf.cadence ?? 'prompt',
    mode: conf.mode ?? 'hybrid',
    policy: conf.policy ?? 'balanced',
    thinking: conf.thinking?.mode ?? 'auto',
    ceiling: conf.thinking?.ceiling ?? 'high',
    fixed: conf.thinking?.fixed ?? 'medium',
    scope: conf.scope?.source ?? 'scoped',
    rollout: conf.rollout?.stage ?? 'observe',
    algorithm: conf.adaptive?.algorithm ?? 'expected-cost',
    bandit: conf.adaptive?.bandit ?? 'shadow',
    delegation: conf.topology?.enabled !== false,
  };
}

/** Panel field id → the text-command field it writes (`v2Patch` / `FIELDS` in extension.mjs). */
export const PANEL_COMMANDS = Object.freeze({
  preset: 'preset',
  control: 'control',
  contextEnabled: 'context-enabled',
  retrievalBudget: 'retrieval-budget',
  privacyExecutor: 'privacy',
  privacyClassifier: 'privacy-classifier',
  privacyTelemetry: 'privacy-telemetry',
  rollout: 'rollout',
  algorithm: 'algorithm',
  bandit: 'bandit',
  delegation: 'delegation',
  cadence: 'cadence',
  mode: 'mode',
  policy: 'policy',
  thinking: 'thinking',
  ceiling: 'ceiling',
  fixed: 'fixed',
  scope: 'scope',
});

/**
 * Every field of the root panel, ordered by how often it matters: language, routing,
 * the v2 priority and its consequences, then the individual routing knobs.
 *
 * `options.enums` carries the allowed ids from the extension (one table for commands and
 * panel); `options.values` adds a stored value that is outside the list, so an untouched
 * legacy value never blocks a save; `options.locks` maps field id → lock source.
 */
export function economistFields(locale, { enums, values = {}, locks = {} }) {
  const t = (key, vars) => translate(locale, key, vars);
  const ids = (id, list, label = (v) => v) => {
    const all = [...list];
    if (typeof values[id] === 'string' && !all.includes(values[id])) all.push(values[id]);
    return all.map((v) => ({ id: v, label: label(v) }));
  };
  const lock = (id) => (locks[id] ? { locked: { source: locks[id] } } : {});
  const select = (id, list, label, description, labeller) => ({
    id,
    kind: 'select',
    label,
    description,
    choices: ids(id, list, labeller),
    ...lock(id),
  });
  const boolean = (id, label, description) => ({ id, kind: 'boolean', label, description, ...lock(id) });
  const known = (prefix) => (v) => {
    try {
      return t(`${prefix}.${v}`);
    } catch {
      return v;
    }
  };
  return [
    select('language', ['en', 'pt-BR'], t('language.row'), t('language.description'), (v) => localeName(v)),
    boolean('enabled', t('row.enabled'), t('desc.enabled')),
    select('preset', enums.presets, t('row.preset'), t('desc.preset'), known('choice.preset')),
    select('control', enums.controls, t('row.control'), t('desc.control'), known('choice.control')),
    boolean('contextEnabled', t('row.contextEnabled'), t('desc.contextEnabled')),
    select('retrievalBudget', ['1024', '2048', '4096', '8192'], t('row.retrievalBudget'), t('desc.retrievalBudget'),
      (v) => t('value.tokens', { count: v })),
    select('privacyExecutor', ['deny', 'redact', 'allow'], t('row.privacyExecutor'), t('desc.privacyExecutor'), known('choice.privacy')),
    select('privacyClassifier', ['deny', 'redact', 'allow'], t('row.privacyClassifier'), t('desc.privacyClassifier'), known('choice.privacy')),
    select('privacyTelemetry', ['deny', 'redact', 'allow'], t('row.privacyTelemetry'), t('desc.privacyTelemetry'), known('choice.privacy')),
    select('cadence', enums.cadences, t('row.cadence'), t('desc.cadence')),
    select('mode', enums.modes, t('row.mode'), t('desc.mode.fallback')),
    select('policy', enums.policies, t('row.policy'), t('desc.policy.fallback')),
    select('thinking', enums.thinking, t('row.thinking'), t('desc.thinking')),
    select('ceiling', enums.levels.filter((l) => l !== 'off'), t('row.ceiling'), t('desc.ceiling')),
    select('fixed', enums.levels, t('row.fixed'), t('desc.fixed')),
    select('scope', enums.scopes, t('row.scope'), t('desc.scope'), known('choice.scope')),
    select('rollout', enums.stages, t('row.rollout'), t('desc.rollout')),
    select('algorithm', ['expected-cost', 'cascade', 'bandit'], t('row.algorithm'), t('desc.algorithm')),
    select('bandit', ['off', 'shadow', 'active'], t('row.bandit'), t('desc.bandit')),
    boolean('delegation', t('row.delegation'), t('desc.delegation')),
  ];
}

/** Fields of the pool screen: membership, tier and tools for each candidate. */
export function poolFields(locale, rows, { scopeLocked = () => false } = {}) {
  const t = (key, vars) => translate(locale, key, vars);
  return rows.flatMap((row) => {
    const name = shortName(row.value);
    return [
      {
        id: `member:${row.value}`,
        kind: 'boolean',
        label: t('pool.member', { model: name }),
        description: t('desc.pool.member', { model: row.value }),
        ...(scopeLocked(row.value) ? { locked: { source: t('panel.source.scope') } } : {}),
      },
      {
        id: `tier:${row.value}`,
        kind: 'select',
        label: t('pool.tier', { model: name }),
        description: t('desc.pool.tier'),
        choices: [1, 2, 3, 4, 5].map((tier) => ({
          id: String(tier),
          label: `${t('candidate.tier', { tier })} · ${t(`action.tier${tier}`)}`,
        })),
        format: (value) => t('candidate.tier', { tier: value }),
      },
      {
        id: `tools:${row.value}`,
        kind: 'boolean',
        label: t('pool.tools', { model: name }),
        description: t('desc.pool.tools'),
      },
    ];
  });
}

/** Initial pool values: everyone listed is a member, with the tier/tools it has now. */
export function poolValues(rows) {
  return Object.fromEntries(
    rows.flatMap((row) => [
      [`member:${row.value}`, true],
      [`tier:${row.value}`, String(Math.min(5, Math.max(1, Number(row.tier) || 1)))],
      [`tools:${row.value}`, row.tools === true],
    ]),
  );
}

/**
 * Apply a value to a field of an open session through its public editing API, as a
 * keyboard edit would (validated, and leaving the focus where the user is). Used for
 * preset/control consequences and for carrying a draft across read-only screens.
 */
export function setDraftValue(session, id, value) {
  const field = session.fields.find((f) => f.id === id);
  if (!field || field.locked || field.override || session.saving) return false;
  if (JSON.stringify(session.draft[id]) === JSON.stringify(value)) return true;
  const focus = session.focusedId;
  session.begin(id);
  if (session.editing?.id !== id) {
    session.focusedId = focus;
    return false;
  }
  session.edit(value);
  const ok = session.confirmEdit();
  if (!ok) session.abandonEdit();
  session.focusedId = focus;
  return ok;
}

/** Re-apply a draft (from a previous panel instance) on top of a fresh session. */
export function restoreDraft(session, draft) {
  if (!draft) return;
  for (const field of session.fields)
    if (field.id in draft && JSON.stringify(draft[field.id]) !== JSON.stringify(session.persisted[field.id]))
      setDraftValue(session, field.id, draft[field.id]);
}

/**
 * The dry-run screen: one request field and a cancellable "Run simulation" action. `run`
 * receives the request text and an AbortSignal and returns the explanation lines; the
 * screen closes with them as `actionValue`. A result that arrives after Esc is dropped by
 * the adapter (the action reports that it finished too late and the screen stays open).
 *
 * The request is input for an operation, not a setting: nothing here is ever stored. So
 * the typed request is never an unsaved draft (no "*" marker, no "unsaved changes", Esc
 * closes at once), and Ctrl+S or the bar's Save say that there is nothing to save instead
 * of doing nothing.
 */
export function simulationScreen(locale, { run }) {
  const t = (key, vars) => translate(locale, key, vars);
  const missing = (value) => (String(value ?? '').trim() ? undefined : t('panel.simulationNoText'));
  const session = new SettingsSession([{
    id: 'request',
    kind: 'text',
    label: t('simulate.request'),
    description: t('desc.simulate.request'),
  }], { request: '' }, { locale });
  return {
    session,
    title: t('simulate.title'),
    scope: t('panel.simulateDisclaimer'),
    // Ctrl+S and the bar's Save explain where to go instead of pretending to write something.
    ctrlS: true,
    formatError: (error) => String(error?.message ?? error ?? '').trim() || undefined,
    persist: async () => {
      throw Error(t('simulate.nothingToSave'));
    },
    // The adapter compares the draft with what is stored. Nothing is stored here, so the
    // confirmed request becomes the "stored" value at once (the adapter's own storage read
    // hook; an empty request is still refused by the disabled Run action, not by the field).
    onDraftChange: (draft, _info, panel) => {
      if (JSON.stringify(draft) === JSON.stringify(panel.session.persisted)) return;
      panel.session.reconcilePersistence(draft);
      panel.session.setStatus('');
    },
    actions: [{
      id: 'run',
      label: t('simulate.run'),
      description: t('desc.simulate.run'),
      effect: 'local',
      timeoutMs: 30_000,
      disabled: (draft) => missing(draft.request),
      run: async (draft, signal) => {
        const lines = await run(String(draft.request).trim(), signal);
        signal.throwIfAborted();
        return { message: lines[0], value: lines, close: true };
      },
    }],
  };
}

/**
 * Greedy wrap that breaks at spaces and after `|` (so `economy|balanced|quality` breaks
 * between choices, not inside one); only a piece wider than its line is split by grapheme.
 * The first line holds `first` cells, every later line `rest`.
 */
function wrapWords(text, first, rest) {
  const lines = [];
  const room = () => (lines.length ? rest : first);
  let line = '';
  let gap = '';
  for (const token of text.match(/ +|[^ |]*\|+|[^ |]+/g) ?? []) {
    if (token.startsWith(' ')) {
      if (line) gap = token;
      continue;
    }
    if (visibleWidth(line + gap + token) <= room()) line += gap + token;
    else {
      if (line) lines.push(line);
      line = token;
      while (visibleWidth(line) > room()) {
        const [piece] = wrap(line, room());
        if (!piece || piece === '?') {
          // A single grapheme wider than the line: drop it rather than loop.
          line = [...line].slice(1).join('');
          continue;
        }
        lines.push(piece);
        line = line.slice(piece.length);
      }
    }
    gap = '';
  }
  return [...lines, line];
}

/**
 * Wrap one line of a read-only view to `width` cells. Continuation lines keep the line's
 * own indentation plus two cells, so a wrapped description never restarts at column 0.
 */
export function wrapLine(line, width) {
  const text = String(line);
  const limit = Math.max(0, Math.floor(width / 2) - 2);
  const indent = Math.min(text.length - text.trimStart().length, limit);
  const hang = Math.min(indent + 2, limit);
  return wrapWords(text.trimStart(), Math.max(1, width - indent), Math.max(1, width - hang))
    .map((piece, i) => ' '.repeat(i ? hang : indent) + piece);
}

const MIN_COLUMNS = 40;
const MIN_ROWS = 12;

/**
 * Read-only lines (economics, last decision, simulation result, command reference) in a
 * temporary overlay. The text is word-wrapped to the width Pi asks for and scrolls with
 * the host's ↑/↓ and PgUp/PgDn bindings; Esc returns to whoever opened it. There is
 * nothing to select, sort or save here, so the view offers no actions besides closing.
 * It paints only with the host theme.
 */
export async function openTextView(ui, { title, lines, locale, signal }) {
  if (signal?.aborted) return;
  const t = (key, vars) => translate(locale, key, vars);
  const m = resolveMessages(locale);
  const source = lines.length ? lines.map(String) : [t('value.empty')];
  let dispose;
  try {
    await ui.custom((tui, theme, keys, done) => {
      let closed = false;
      let top = 0;
      let page = 1;
      let total = 0;
      const bindings = piBindings(keys, ['ctrl+c'], false, { locale });
      const hints = standardKeyHints(bindings, [['navigate', m.hintScroll], ['back', m.hintClose]]);
      const close = () => {
        if (closed) return;
        closed = true;
        signal?.removeEventListener('abort', close);
        done();
      };
      signal?.addEventListener('abort', close, { once: true });
      dispose = close;
      const fit = (line, width) => (visibleWidth(line) > width ? truncateToWidth(line, width, '') : line);
      const bold = (line) => (theme.bold ? theme.bold(line) : line);
      const muted = (line) => theme.fg('muted', line);
      return {
        focused: true,
        invalidate() {},
        dispose: close,
        render(columns) {
          const width = Math.max(1, Math.floor(columns));
          const rows = Math.max(1, Math.floor(tui.terminal?.rows ?? 24));
          const wrapped = (text) => wrap(text, width, 'word');
          if (width < MIN_COLUMNS || rows < MIN_ROWS)
            return [
              ...wrapped(title).map(bold),
              ...wrapped(m.terminalTooSmall(width, rows, MIN_COLUMNS, MIN_ROWS)).map((l) => theme.fg('warning', l)),
              ...wrapped(m.enlargeOrGoBack).map(muted),
            ].slice(0, rows).map((l) => fit(l, width));
          const body = source.flatMap((line) => wrapLine(line, width));
          const header = [bold(truncateToWidth(title, width, '…')), muted(truncateToWidth(t('view.scope'), width, '…'))];
          const footer = [...wrapped(t('view.help')), ...wrapped(hints)].map(muted);
          page = Math.max(1, rows - header.length - footer.length - 2);
          total = body.length;
          top = Math.max(0, Math.min(top, total - page));
          const shown = body.slice(top, top + page);
          const position = muted(m.linesRange(Math.min(top + 1, total), Math.min(top + page, total), total));
          return [...header, '', ...shown, position, ...footer].slice(0, rows).map((l) => fit(l, width));
        },
        handleInput(data) {
          if (closed || matchesKey(data, 'ctrl+c')) return;
          const binding = bindings.find((b) => matchesKey(data, b.key));
          const action = binding && keyAction(binding.key, bindings, 'navigation');
          if (action === 'back') return close();
          const last = Math.max(0, total - page);
          if (action === 'navigate.up') top -= 1;
          else if (action === 'navigate.down') top += 1;
          else if (action === 'navigate.pageUp') top -= page;
          else if (action === 'navigate.pageDown') top += page;
          else if (action === 'navigate.first') top = 0;
          else if (action === 'navigate.last') top = last;
          top = Math.max(0, Math.min(top, last));
          tui.requestRender?.();
        },
      };
    }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'center' } });
  } finally {
    dispose?.();
  }
}
