/**
 * The `/economist` dashboard.
 *
 * One screen that shows every routing knob with the value it currently has, so
 * configuring the router is "look, press enter, done" instead of reading a command
 * reference. `SettingsList` cycles enum values in place and opens submenus for the
 * things that need a list (candidate pool, last decision, dry run). Each change is
 * applied and persisted the moment it is made, and the screen stays open so the
 * next one is two keystrokes away. `onChange(id, value, update, target)` returns the
 * note shown to the user; `target` carries the pool member a submenu edit applies to.
 *
 * pi-tui and the coding-agent theme helpers are host-provided. They are imported
 * lazily so `node --test`, JSON and print modes never need them.
 */

import { localeName, translate } from './lib/i18n.mjs';

/** `openrouter/qwen/turbo` → `qwen/turbo`: only the provider is dropped. */
export function shortName(id) {
  const parts = String(id ?? '').split('/');
  return parts.length > 2 ? parts.slice(1).join('/') : parts.at(-1) ?? '';
}

/** The main screen, built from live config so the values shown are the truth. */
export function dashboardItems({ conf, pool, scoped, last, notes = {}, locale = 'pt-BR' }) {
  const t = (key, values) => translate(locale, key, values);
  const thinking = conf.thinking ?? {};
  const scope = conf.scope ?? {};
  const modeKey = ['hybrid', 'rules', 'jev', 'small-llm', 'learned', 'manual', 'off'].includes(conf.mode)
    ? `desc.mode.${conf.mode}`
    : 'desc.mode.fallback';
  const policyKey = ['economy', 'balanced', 'quality', 'latency'].includes(conf.policy)
    ? `desc.policy.${conf.policy}`
    : 'desc.policy.fallback';
  return [
    {
      id: 'language',
      label: t('language.row'),
      currentValue: localeName(locale),
      submenu: true,
      description: t('language.description'),
    },
    {
      id: 'enabled',
      label: t('row.enabled'),
      currentValue: conf.enabled ? 'on' : 'off',
      values: ['on', 'off'],
      description: t('desc.enabled'),
    },
    {
      id: 'cadence',
      label: t('row.cadence'),
      currentValue: conf.cadence ?? 'prompt',
      values: ['session', 'prompt', 'subagent'],
      description: t(`desc.cadence.${conf.cadence ?? 'prompt'}`),
    },
    {
      id: 'mode',
      label: t('row.mode'),
      currentValue: conf.mode,
      values: notes.modes ?? [],
      description: t(modeKey),
    },
    {
      id: 'policy',
      label: t('row.policy'),
      currentValue: conf.policy,
      values: notes.policies ?? [],
      description: t(policyKey),
    },
    {
      id: 'thinking',
      label: t('row.thinking'),
      currentValue: thinking.mode ?? 'auto',
      values: ['auto', 'follow', 'fixed'],
      description: t('desc.thinking'),
    },
    {
      id: 'ceiling',
      label: t('row.ceiling'),
      currentValue: thinking.ceiling ?? 'high',
      values: (notes.levels ?? []).filter((l) => l !== 'off'),
      description: t('desc.ceiling'),
    },
    {
      id: 'fixed',
      label: t('row.fixed'),
      currentValue: thinking.fixed ?? 'medium',
      values: notes.levels ?? [],
      description: t('desc.fixed'),
    },
    {
      id: 'scope',
      label: t('row.scope'),
      currentValue: scope.source ?? 'scoped',
      values: ['scoped', 'all'],
      description: t('desc.scope'),
    },
    {
      id: 'pool',
      label: t('row.pool'),
      currentValue: t('value.pool', { count: pool.length }),
      submenu: true,
      description: t('desc.pool', { count: scoped }),
    },
    {
      id: 'explain',
      label: t('row.explain'),
      currentValue: last
        ? `${shortName(last.selectedModelId)}:${last.selectedThinkingLevel ?? 'off'}`
        : t('value.none'),
      submenu: true,
      description: t('desc.explain'),
    },
    {
      id: 'simulate',
      label: t('row.simulate'),
      currentValue: '—',
      submenu: true,
      description: t('desc.simulate'),
    },
    {
      id: 'help',
      label: t('row.help'),
      currentValue: '—',
      submenu: true,
      description: t('desc.help'),
    },
  ];
}

/** Human-readable last decision, used by the explain submenu. */
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
  ];
}

/** Tier proposal when a model goes straight from the scope into the pool. */
export function tierForPool(index, total) {
  if (total <= 1) return 1;
  return Math.min(5, Math.max(1, 1 + Math.round((index * 4) / (total - 1))));
}

/** Actions offered for one pool member. */
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
 * Test seam: pi-tui and the coding-agent theme helpers are host-provided and are
 * resolved lazily so `node --test` never needs them. Tests that drive the dashboard
 * inject fakes here; production leaves them unset and takes the dynamic import.
 */
export const host = { tui: undefined, agent: undefined };

/**
 * Wire the host modules the entry point (`index.ts`) imported statically. Static
 * import at the entry is the only path that resolves under pi's loader: a dynamic
 * `await import('@earendil-works/pi-tui')` from inside an extension falls through to
 * Node's native resolver and fails with ERR_MODULE_NOT_FOUND. Called once at install
 * time; the lazy import in `runDashboard` stays as the fallback for whoever loads
 * `extension.mjs` directly (for example `pi -e ./extension.mjs`).
 */
export function provideHost(tui, agent) {
  if (tui) host.tui = tui;
  if (agent) host.agent = agent;
  return host;
}

/**
 * Which export the screen needs, and from which host package. `Container` is a
 * pi-tui export (`pi-tui/dist/index.d.ts:32`); `DynamicBorder`, the two list themes
 * and the key-hint helpers are pi-coding-agent exports
 * (`pi-coding-agent/dist/index.d.ts:36-37`). Getting this wrong is not a cosmetic
 * mistake: `DynamicBorder` used to be destructured off pi-tui, came back `undefined`,
 * and `new DynamicBorder(...)` threw inside the `ctx.ui.custom()` factory — so
 * `/economist` never showed a menu, while a fake that repeated the same lie kept the
 * unit tests green. The smoke script asserts this table against the installed host.
 */
export const HOST_EXPORTS = {
  '@earendil-works/pi-tui': ['Container', 'SettingsList', 'SelectList', 'Text', 'Input'],
  '@earendil-works/pi-coding-agent': [
    'DynamicBorder',
    'getSettingsListTheme',
    'getSelectListTheme',
  ],
};
/** Optional niceties: used when present, literal fallbacks when not.
 * `keyHint`/`keyText` are pi-coding-agent exports (same index.d.ts line). */
export const OPTIONAL_EXPORTS = {
  '@earendil-works/pi-coding-agent': ['keyHint', 'keyText'],
};

/** Name the exports the host does not actually provide (missing module counts as every export). */
export function missingHostExports(tuiPkg, agentPkg) {
  const mods = {
    '@earendil-works/pi-tui': tuiPkg,
    '@earendil-works/pi-coding-agent': agentPkg,
  };
  return Object.entries(HOST_EXPORTS).flatMap(([name, exports]) =>
    exports.filter((key) => typeof mods[name]?.[key] !== 'function').map((key) => `${name}.${key}`),
  );
}

/** First useful line of a resolution failure, for the degradation notice. */
function why(error) {
  return String(error?.code ?? error?.message ?? error).split('\n')[0];
}

/**
 * Degradation is allowed; silence is not. The caller still prints the text panel,
 * and the user learns which host capability was missing instead of staring at a
 * command that appears to do nothing.
 */
function degrade(ctx, reason) {
  try {
    ctx?.ui?.notify?.(`Economist sem painel interativo: ${reason}`, 'warning');
  } catch {
    // A broken notify must not replace the reason with a second error.
  }
  return false;
}

/**
 * Show the dashboard. Changes stay in a draft until the user explicitly saves;
 * Esc at the root warns before discarding. Returns false when the host cannot run
 * a custom TUI screen, so the caller falls back to the status panel. `host`
 * argument injects the real pi-tui and coding-agent modules in tests; production
 * resolves them lazily.
 */
export async function runDashboard(deps, injection = {}) {
  const {
    ctx,
    title,
    getTitle,
    items,
    onChange,
    onSave,
    onDiscard,
    isDirty = () => false,
    menus,
    locale = 'pt-BR',
    getLocale,
  } = deps;
  const currentLocale = () => getLocale?.() ?? locale;
  const t = (key, values) => translate(currentLocale(), key, values);
  if (ctx.mode !== 'tui' || typeof ctx.ui.custom !== 'function') return false;
  let tuiPkg = injection.tuiPkg ?? host.tui,
    agentPkg = injection.agentPkg ?? host.agent;
  // Fallback only: production arrives with `host` already wired by index.ts.
  if (!tuiPkg) {
    try {
      tuiPkg = await import('@earendil-works/pi-tui');
    } catch (error) {
      return degrade(ctx, `@earendil-works/pi-tui indisponível (${why(error)})`);
    }
  }
  if (!agentPkg) {
    try {
      agentPkg = await import('@earendil-works/pi-coding-agent');
    } catch (error) {
      return degrade(ctx, `@earendil-works/pi-coding-agent indisponível (${why(error)})`);
    }
  }
  const missing = missingHostExports(tuiPkg, agentPkg);
  if (missing.length)
    return degrade(
      ctx,
      `missing exports: ${missing.join(', ')} — this Pi client does not expose the expected custom screen`,
    );
  const { Container, SettingsList, SelectList, Text, Input } = tuiPkg;
  const {
    DynamicBorder,
    getSettingsListTheme,
    getSelectListTheme,
    keyHint,
    keyText,
  } = agentPkg;
  const changed = [];
  await ctx.ui.custom((tuiRef, theme, keybindings, done) => {
    const cancel = (data) => keybindings?.matches?.(data, 'tui.select.cancel') === true;
    /**
     * Hint lines read the user's OWN keybinding config (`keyHint`/`keyText`) instead
     * of hardcoding "Enter"/"Esc" in prose, and fall back to the literal wording when
     * an older host does not export them. Keys the code *acts on* always go through
     * `keybindings.matches` — never a raw byte.
     */
    const navHint =
      typeof keyText === 'function'
        ? `  ${keyText('tui.select.up')}/${keyText('tui.select.down')} ${t('nav.navigate')} · ${t('nav.filter')} · ${keyText('tui.select.confirm')} ${t('nav.choose')} · ${keyText('tui.select.cancel')} ${t('nav.back')}`
        : `  ↑↓ ${t('nav.navigate')} · ${t('nav.filter')} · enter ${t('nav.choose')} · esc ${t('nav.back')}`;
    const backHint =
      typeof keyHint === 'function' ? `  ${keyHint('tui.select.cancel', t('nav.back'))}` : `  esc ${t('nav.back')}`;
    let disposed = false;
    let submenuOpen = false;
    let discardArmed = false;
    let saving = false;
    let operationController;
    let operationGeneration = 0;
    const pendingNotes = [];
    const box = new Container();
    box.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
    const titleText = new Text('');
    box.addChild(titleText);
    const footer = new Text('');
    const list = new SettingsList(
      items,
      Math.min(items.length, 12),
      getSettingsListTheme(),
      async (id, value) => {
        try {
          const note = await onChange(id, value, (target, replacement) =>
            list.updateValue(target, replacement),
            null,
          );
          discardArmed = false;
          if (note) pendingNotes.push(note);
          refresh();
          ctx.ui.notify(note ? t('notice.draft', { note }) : t('notice.updated'), 'info');
          return note;
        } catch (error) {
          ctx.ui.notify(t('notice.notUpdated', { error: error.message }), 'error');
          refresh();
          throw error;
        }
      },
      () => rootEscape(),
    );
    const dirty = () => Boolean(isDirty());
    const refresh = () => {
      const hasDraft = dirty();
      const heading = `${getTitle?.() ?? title}${hasDraft ? ` · ${t('title.draft')}` : ''}`;
      const prompt = hasDraft ? `  ${t('footer.dirty')}` : `  ${t('footer.clean')}`;
      titleText.setText(theme.fg('accent', theme.bold ? theme.bold(heading) : heading));
      footer.setText(theme.fg('dim', saving ? `${prompt} · ${t('footer.saving')}` : prompt));
      tuiRef.requestRender();
    };
    const finish = () => {
      if (disposed) return;
      disposed = true;
      operationGeneration++;
      operationController?.abort(Error('dashboard closed'));
      operationController = undefined;
      done({ changed });
    };
    const rootEscape = () => {
      if (saving) {
        ctx.ui.notify(t('notice.saving'), 'warning');
        return;
      }
      if (!dirty()) {
        finish();
        return;
      }
      if (!discardArmed) {
        discardArmed = true;
        ctx.ui.notify(t('notice.unsaved'), 'warning');
        tuiRef.requestRender();
        return;
      }
      try {
        onDiscard?.();
        pendingNotes.length = 0;
        discardArmed = false;
        finish();
      } catch (error) {
        discardArmed = false;
        ctx.ui.notify(t('notice.discardFailed', { error: error.message }), 'error');
        refresh();
      }
    };
    const save = async () => {
      if (saving || disposed) return;
      discardArmed = false;
      if (!dirty()) {
        pendingNotes.length = 0;
        try {
          const path = await onSave?.();
          if (!disposed) ctx.ui.notify(path ? t('notice.savedCurrent', { path }) : t('notice.noChanges'), 'info');
        } catch (error) {
          if (!disposed) ctx.ui.notify(t('notice.checkFailed', { error: error.message }), 'error');
        }
        return;
      }
      saving = true;
      tuiRef.requestRender();
      try {
        const path = await onSave?.();
        if (disposed) return;
        if (dirty()) throw Error(t('notice.dirtyAfterSave'));
        if (pendingNotes.length) changed.push(...pendingNotes.splice(0));
        ctx.ui.notify(path ? t('notice.savedAt', { path }) : t('notice.saved'), 'info');
      } catch (error) {
        if (!disposed) ctx.ui.notify(t('notice.saveFailed', { error: error.message }), 'error');
      } finally {
        saving = false;
        if (!disposed) refresh();
      }
    };
    refresh();
    const frame = (heading) => {
      const inner = new Container();
      inner.addChild(new Text(theme.fg('accent', heading), 1, 0));
      return inner;
    };
    /** A searchable list inside a submenu; esc returns to the main screen. */
    const screen = (heading, rows, onPick, onClose) => {
      const inner = frame(heading);
      const select = new SelectList(rows, Math.min(rows.length || 1, 8), getSelectListTheme());
      select.onSelect = (item) => onPick(item.value);
      select.onCancel = () => onClose();
      inner.addChild(select);
      inner.addChild(
        new Text(theme.fg('dim', navHint.trim()), 1, 0),
      );
      return {
        render: (width) => inner.render(width),
        invalidate: () => inner.invalidate(),
        handleInput: (data) => {
          select.handleInput(data);
          tuiRef.requestRender();
        },
      };
    };
    const textScreen = (heading, lines, onClose) => {
      const inner = frame(heading);
      for (const line of lines) inner.addChild(new Text(theme.fg('muted', `  ${line}`), 0, 0));
      inner.addChild(new Text(theme.fg('dim', backHint.trim()), 1, 0));
      return {
        render: (width) => inner.render(width),
        invalidate: () => inner.invalidate(),
        handleInput: (data) => {
          if (cancel(data)) onClose();
        },
      };
    };
    const panels = {
      language: (_current, close) => screen(
        t('panel.language'),
        menus.language(),
        async (value) => {
          try {
            const note = await onChange('language', value, (target, replacement) =>
              list.updateValue(target, replacement),
            );
            discardArmed = false;
            if (note) pendingNotes.push(note);
            ctx.ui.notify(note ? t('notice.draft', { note }) : t('notice.updated'), 'info');
            close();
          } catch (error) {
            ctx.ui.notify(t('notice.notUpdated', { error: error.message }), 'error');
          }
          refresh();
        },
        () => close(),
      ),
      pool: (_current, close) => {
        let active;
        const showPool = () => {
          active = screen(t('panel.pool'), menus.pool(), open, () => close());
          tuiRef.requestRender();
        };
        const open = (id) => {
          active = screen(t('panel.edit', { id }), menus.candidateRows(id), async (value) => {
            const note = await onChange('poolEdit', value, () => {}, id);
            discardArmed = false;
            if (note) pendingNotes.push(note);
            ctx.ui.notify(note ? t('notice.draft', { note }) : t('notice.updated'), 'info');
            list.updateValue('pool', t('value.pool', { count: menus.pool().length }));
            refresh();
            showPool();
          }, showPool);
          tuiRef.requestRender();
        };
        showPool();
        return {
          render: (width) => active.render(width),
          invalidate: () => active.invalidate(),
          handleInput: (data) => active.handleInput(data),
        };
      },
      explain: (_current, close) => textScreen(t('panel.explain'), menus.explain(), () => close()),
      help: (_current, close) => textScreen(t('panel.help'), menus.help(), () => close()),
      simulate: (_current, close) => {
        const inner = frame(t('panel.simulate'));
        const input = new Input({ placeholder: t('panel.simulatePlaceholder') });
        inner.addChild(input);
        const result = new Text(
          theme.fg('dim', `  ${t('panel.simulateDisclaimer')}`),
          0,
          0,
        );
        inner.addChild(result);
        let showing = false;
        let pending = null;
        let generation = 0;
        const run = (text) => {
          if (!text || showing) return pending;
          showing = true;
          discardArmed = false;
          const controller = new AbortController();
          operationController = controller;
          const current = ++operationGeneration;
          generation = current;
          result.setText(theme.fg('dim', `  ${t('panel.calculating')}`));
          pending = Promise.resolve(menus.simulate(text, { signal: controller.signal }))
            .then((lines) => {
              if (!disposed && generation === operationGeneration && !controller.signal.aborted)
                result.setText(lines.map((l) => `  ${l}`).join('\n'));
            })
            .catch((error) => {
              if (!disposed && generation === operationGeneration && !controller.signal.aborted)
                result.setText(theme.fg('error', `  ${t('panel.simulationError', { error: error.message })}`));
            })
            .finally(() => {
              if (generation === operationGeneration) {
                showing = false;
                operationController = undefined;
                if (!disposed) tuiRef.requestRender();
              }
            });
          return pending;
        };
        // The host's own Input decides what "submit" means (`tui.input.submit`), so the
        // screen never compares raw bytes: `input.d.ts` documents this callback.
        input.onSubmit = run;
        return {
          render: (width) => inner.render(width),
          invalidate: () => inner.invalidate(),
          handleInput: (data) => {
            if (cancel(data)) {
              if (showing) {
                operationGeneration++;
                generation = -1;
                operationController?.abort(Error('simulation cancelled'));
                operationController = undefined;
                showing = false;
                result.setText(theme.fg('dim', `  ${t('panel.simulationCancelled')}`));
                tuiRef.requestRender();
                return;
              }
              close();
              return;
            }
            if (showing) return pending;
            // Returning the child's promise lets a caller (and the tests) await the
            // dry run instead of counting ticks.
            return input.handleInput(data);
          },
        };
      },
    };
    for (const item of items) {
      if (item.submenu !== true) continue;
      const panel = panels[item.id];
      item.submenu = (currentValue, close) => {
        submenuOpen = true;
        discardArmed = false;
        return panel(currentValue === '—' ? undefined : currentValue, (...args) => {
          submenuOpen = false;
          discardArmed = false;
          const result = close(...args);
          refresh();
          return result;
        });
      };
    }
    box.addChild(list);
    box.addChild(footer);
    box.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
    return {
      render: (width) => box.render(width),
      invalidate: () => box.invalidate(),
      handleInput: (data) => {
        if (data === '\u0013' || String(data).toLowerCase() === 'ctrl+s') {
          return save().finally(() => refresh());
        }
        if (cancel(data)) {
          if (submenuOpen) list.handleInput(data);
          else rootEscape();
          refresh();
          return;
        }
        if (submenuOpen) list.handleInput(data);
        else list.handleInput(data);
        discardArmed = false;
        refresh();
        tuiRef.requestRender();
      },
    };
  });
  return { changed };
}
