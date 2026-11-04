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

/** `openrouter/qwen/turbo` → `qwen/turbo`: only the provider is dropped. */
export function shortName(id) {
  const parts = String(id ?? '').split('/');
  return parts.length > 2 ? parts.slice(1).join('/') : parts.at(-1) ?? '';
}

/** The main screen, built from live config so the values shown are the truth. */
export function dashboardItems({ conf, pool, scoped, last, notes = {} }) {
  const thinking = conf.thinking ?? {};
  const scope = conf.scope ?? {};
  return [
    {
      id: 'enabled',
      label: 'Roteamento',
      currentValue: conf.enabled ? 'on' : 'off',
      values: ['on', 'off'],
      description: 'on seleciona economist/auto nesta sessão e nas próximas; off mantém seu /model',
    },
    {
      id: 'cadence',
      label: 'Quando escolher o modelo',
      currentValue: conf.cadence ?? 'prompt',
      values: ['session', 'prompt', 'subagent'],
      description: ({ session: 'Escolhe o melhor custo-benefício na primeira pergunta e mantém até você trocar /model. Voltar para economist/auto escolhe de novo.', prompt: 'Reavalia cada pergunta pelo contexto e pelo tipo de trabalho. Continuações ficam no mesmo modelo.', subagent: 'Reavalia cada pergunta. Quem cria subagentes recebe um par novo para cada filho que inicia.' })[conf.cadence ?? 'prompt'],
    },
    {
      id: 'mode',
      label: 'Como avaliar a tarefa',
      currentValue: conf.mode,
      values: notes.modes ?? [],
      description: ({ hybrid: 'Regras primeiro; classificador só em pedidos ambíguos.', rules: 'Regras locais sem chamada de classificação.', jev: 'Classificador Jev para avaliar tarefas.', 'small-llm': 'Modelo pequeno classifica tarefas.', learned: 'Aprende com resultados verificados.', manual: 'Você seleciona o modelo manualmente.', off: 'Roteamento desligado.' })[conf.mode] ?? 'Estratégia para avaliar dificuldade e requisitos.',
    },
    {
      id: 'policy',
      label: 'Política',
      currentValue: conf.policy,
      values: notes.policies ?? [],
      description: 'economy prioriza preço; balanced equilibra; quality prioriza capacidade; latency prioriza rapidez',
    },
    {
      id: 'thinking',
      label: 'Esforço (thinking)',
      currentValue: thinking.mode ?? 'auto',
      values: ['auto', 'follow', 'fixed'],
      description: 'auto escolhe o esforço pela tarefa; follow usa /thinking; fixed usa Esforço fixo',
    },
    {
      id: 'ceiling',
      label: 'Teto de esforço',
      currentValue: thinking.ceiling ?? 'high',
      values: (notes.levels ?? []).filter((l) => l !== 'off'),
      description: 'auto nunca despacha acima disto, mesmo em tarefa crítica',
    },
    {
      id: 'fixed',
      label: 'Esforço fixo',
      currentValue: thinking.fixed ?? 'medium',
      values: notes.levels ?? [],
      description: 'usado quando Esforço (thinking) está em fixed',
    },
    {
      id: 'scope',
      label: 'Fonte do pool',
      currentValue: scope.source ?? 'scoped',
      values: ['scoped', 'all'],
      description: 'scoped usa só os modelos do /scoped-models; all libera o catálogo autenticado',
    },
    {
      id: 'pool',
      label: 'Pool de candidatos',
      currentValue: `${pool.length} modelo(s)`,
      submenu: true,
      description: `abra para escolher um modelo e ajustar tier/tools ou remover · escopo: ${scoped} modelo(s)`,
    },
    {
      id: 'explain',
      label: 'Última decisão',
      currentValue: last
        ? `${shortName(last.selectedModelId)}:${last.selectedThinkingLevel ?? 'off'}`
        : 'nenhuma',
      submenu: true,
      description: 'mostra modelo escolhido, esforço efetivo, estimativa de custo e alternativas rejeitadas',
    },
    {
      id: 'simulate',
      label: 'Simular um pedido',
      currentValue: '—',
      submenu: true,
      description: 'preveja modelo, esforço e custo para um texto, sem chamada paga',
    },
    {
      id: 'help',
      label: 'Modo linha de comando',
      currentValue: '—',
      submenu: true,
      description: 'veja comandos para configurar opções avançadas fora deste painel',
    },
  ];
}

/** Human-readable last decision, used by the explain submenu. */
export function explainLines(last, conf) {
  if (!last)
    return [
      'Nenhuma decisão ainda neste session.',
      'Mande um pedido, ou use "Simular um pedido" — a simulação não chama modelo nem cobra.',
    ];
  const a = last.assessment ?? {};
  return [
    `modelo + esforço: ${last.selectedModelId}:${last.selectedThinkingLevel ?? 'off'}`,
    `motivo: ${(last.reasonCodes ?? []).join(' · ')}`,
    `tarefa: ${a.kind ?? '?'} / ${a.difficulty ?? '?'} · risco: ${(a.risks ?? []).join(', ') || 'nenhum'}`,
    `esforço definido por: ${last.effortSource ?? 'n/d'}`,
    `estimado: ${last.estimatedTotalCostUsd == null ? 'sem preço conhecido' : `$${last.estimatedTotalCostUsd.toFixed(6)}`} · classificador: $${(last.classifierCostUsd ?? 0).toFixed(6)}`,
    `pool ranqueado: ${(last.candidates ?? []).map((c) => `${shortName(c.model)}:${c.thinkingLevel ?? 'off'}`).join(', ') || 'vazio'}`,
    `rejeitados: ${(last.rejected ?? []).map((r) => `${shortName(r.model)} (${r.reasonCodes.join('+')})`).join(', ') || 'nenhum'}`,
    `política: ${conf.policy} · avaliação: ${conf.mode} · cadência: ${conf.cadence ?? 'prompt'} · pool: ${conf.scope?.source ?? 'scoped'}`,
  ];
}

/** Tier proposal when a model goes straight from the scope into the pool. */
export function tierForPool(index, total) {
  if (total <= 1) return 1;
  return Math.min(5, Math.max(1, 1 + Math.round((index * 4) / (total - 1))));
}

/** Actions offered for one pool member. */
export function candidateActions(current) {
  const tier = Number(current?.tier) || 1;
  return [
    ...[1, 2, 3, 4, 5].map((t) => ({
      value: `tier:${t}`,
      label: `tier ${t}`,
      description:
        t === tier
          ? 'valor atual'
          : t === 1
            ? 'cumprimentos, buscas, resumos'
            : t === 2
              ? 'edits e testes de rotina'
              : t === 3
                ? 'debugging complexo e design'
                : t === 4
                  ? 'produção e segurança'
                  : 'o mais forte disponível',
    })),
    {
      value: 'tools:on',
      label: 'tools on',
      description: current?.tools ? 'valor atual' : 'aceita editar/executar nesta tarefa',
    },
    {
      value: 'tools:off',
      label: 'tools off',
      description: current?.tools === false ? 'valor atual' : 'só respostas; nunca roda trabalho com ferramenta',
    },
    { value: 'remove', label: 'remover do pool', description: 'some este modelo da seleção' },
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
 * Show the dashboard. Returns false when the host cannot run a custom TUI screen,
 * so the caller falls back to the status panel. `host` argument injects the real
 * pi-tui and coding-agent modules in tests; production resolves them lazily.
 */
export async function runDashboard(deps, injection = {}) {
  const { ctx, title, items, onChange, onSave, menus } = deps;
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
      `faltam exports: ${missing.join(', ')} — este pi não expõe a tela customizada esperada`,
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
        ? `  ${keyText('tui.select.up')}/${keyText('tui.select.down')} navegar · digite para filtrar · ${keyText('tui.select.confirm')} escolher · ${keyText('tui.select.cancel')} voltar`
        : '  ↑↓ navegar · digite para filtrar · enter escolher · esc voltar';
    const backHint =
      typeof keyHint === 'function' ? `  ${keyHint('tui.select.cancel', 'voltar')}` : '  esc voltar';
    const box = new Container();
    box.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
    box.addChild(new Text(theme.fg('accent', theme.bold ? theme.bold(title) : title), 1, 0));
    const list = new SettingsList(
      items,
      Math.min(items.length, 12),
      getSettingsListTheme(),
      (id, value) => {
        const note = onChange(id, value, (target, replacement) =>
          list.updateValue(target, replacement),
          null,
        );
        // Return the write so a caller (and the tests) can await persistence.
        return Promise.resolve(note).then((text) => {
          if (text) changed.push(text);
          ctx.ui.notify(text ?? `${id} → ${value}`, 'info');
          list.updateValue('pool', `${menus.pool().length} modelo(s)`);
          tuiRef.requestRender();
          return text;
        });
      },
      () => done({ changed }),
    );
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
      pool: (_current, close) => {
        let active;
        const showPool = () => {
          active = screen('Pool · escolha um modelo para editar', menus.pool(), open, () => close());
          tuiRef.requestRender();
        };
        const open = (id) => {
          active = screen(`Editar ${id}`, menus.candidateRows(id), async (value) => {
            const note = await onChange('poolEdit', value, () => {}, id);
            if (note) changed.push(note);
            ctx.ui.notify(note ?? 'Pool atualizado', 'info');
            list.updateValue('pool', `${menus.pool().length} modelo(s)`);
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
      explain: (_current, close) => textScreen('Última decisão', menus.explain(), () => close()),
      help: (_current, close) => textScreen('Linha de comando', menus.help(), () => close()),
      simulate: (_current, close) => {
        const inner = frame('Simular um pedido · confirmar roda, cancelar volta');
        const input = new Input({ placeholder: 'ex.: refatorar auth e rodar testes' });
        inner.addChild(input);
        const result = new Text(
          theme.fg('dim', '  nada sai daqui: nenhum modelo é chamado, nenhuma cobrança acontece'),
          0,
          0,
        );
        inner.addChild(result);
        let showing = false;
        let pending = null;
        const run = (text) => {
          if (!text || showing) return pending;
          showing = true;
          result.setText(theme.fg('dim', '  calculando…'));
          pending = Promise.resolve(menus.simulate(text))
            .then((lines) => result.setText(lines.map((l) => `  ${l}`).join('\n')))
            .catch((error) => result.setText(theme.fg('error', `  ${error.message}`)))
            .finally(() => tuiRef.requestRender());
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
                showing = false;
                result.setText(theme.fg('dim', '  digite outro pedido'));
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
      item.submenu = (currentValue, close) =>
        panel(currentValue === '—' ? undefined : currentValue, close);
    }
    box.addChild(list);
    box.addChild(new Text(theme.fg('dim', '  Ctrl+S salvar · Esc fechar (mudanças também são salvas ao editar)'), 1, 0));
    box.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
    return {
      render: (width) => box.render(width),
      invalidate: () => box.invalidate(),
      handleInput: (data) => {
        if (data === '\u0013') {
          return Promise.resolve(onSave?.()).then((path) => {
            ctx.ui.notify(`Configuração salva em ${path}`, 'info');
            tuiRef.requestRender();
          }).catch((error) => ctx.ui.notify(`Falha ao salvar: ${error.message}`, 'error'));
        }
        list.handleInput(data);
        tuiRef.requestRender();
      },
    };
  });
  return { changed };
}
