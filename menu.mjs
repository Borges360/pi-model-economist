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
      description: 'on roteia cada pedido; off devolve o modelo que você escolheu em /model',
    },
    {
      id: 'mode',
      label: 'Modo',
      currentValue: conf.mode,
      values: notes.modes ?? [],
      description: 'como a dificuldade é descoberta · rules é grátis, hybrid paga só no ambíguo',
    },
    {
      id: 'policy',
      label: 'Política',
      currentValue: conf.policy,
      values: notes.policies ?? [],
      description: 'desempate do ranking · economy, balanced, quality, latency',
    },
    {
      id: 'thinking',
      label: 'Esforço (thinking)',
      currentValue: thinking.mode ?? 'auto',
      values: ['auto', 'follow', 'fixed'],
      description:
        'auto roteia o par (modelo, esforço) · follow respeita seu /thinking · fixed pin um nível',
    },
    {
      id: 'ceiling',
      label: 'Teto de esforço',
      currentValue: thinking.ceiling ?? 'high',
      values: (notes.levels ?? []).filter((l) => l !== 'off'),
      description: 'auto nunca despacha acima disto, mesmo em tarefa crítica',
    },
    {
      id: 'risk-floor',
      label: 'Esforço sob risco',
      currentValue: thinking.riskFloor ?? 'high',
      values: ['off', ...(notes.levels ?? []).filter((l) => l !== 'off')],
      description:
        'risco (produção, segurança, dados) eleva o esforço até aqui, passando o seu /thinking',
    },
    {
      id: 'selected-as',
      label: 'Seu /thinking vale como',
      currentValue: thinking.useSelectedAs ?? 'ceiling-if-set',
      values: ['ceiling-if-set', 'ceiling', 'ignore'],
      description:
        'ceiling-if-set: um nível que você escolheu é teto (off é o default do pi, não opinião); ceiling: até off limita; ignore: o router decide',
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
      id: 'scope-strict',
      label: 'Escopo estrito',
      currentValue: scope.strict === false ? 'off' : 'on',
      values: ['on', 'off'],
      description: 'on rejeita candidato fora do escopo com reason out-of-scope no explain',
    },
    {
      id: 'classifier',
      label: 'Classificador pago',
      currentValue: conf.classifier?.enabled ? 'on' : 'off',
      values: ['on', 'off'],
      description: 'on classifica o ambíguo; off é sempre grátis (regras determinísticas)',
    },
    {
      id: 'pool',
      label: 'Pool de candidatos',
      currentValue: `${pool.length} modelo(s)`,
      submenu: true,
      description: `editar tier/tools/remover · escopo atual: ${scoped} modelo(s)`,
    },
    {
      id: 'poolAdd',
      label: 'Adicionar do escopo',
      currentValue: '—',
      submenu: true,
      description: 'modelos do /scoped-models fora do pool, com preço, janela, vision e thinking',
    },
    {
      id: 'poolEdit',
      label: 'Editar candidato',
      currentValue: notes.pendingId ?? '—',
      submenu: true,
      description: 'tier, tools ou remover do modelo escolhido no pool',
    },
    {
      id: 'explain',
      label: 'Última decisão',
      currentValue: last
        ? `${shortName(last.selectedModelId)}:${last.selectedThinkingLevel ?? 'off'}`
        : 'nenhuma',
      submenu: true,
      description: 'assessment, esforço, custo estimado, candidatos e rejeitados',
    },
    {
      id: 'simulate',
      label: 'Simular um pedido',
      currentValue: '—',
      submenu: true,
      description: 'dry run sem chamar modelo: para onde o pedido iria e quanto custaria',
    },
    {
      id: 'help',
      label: 'Modo linha de comando',
      currentValue: '—',
      submenu: true,
      description: 'os comandos diretos continuam válidos e têm autocomplete',
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
    `política: ${conf.policy} · modo: ${conf.mode} · escopo: ${conf.scope?.source ?? 'scoped'}${conf.scope?.strict === false ? '' : ' (estrito)'}`,
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
 * Show the dashboard. Returns false when the host cannot run a custom TUI screen,
 * so the caller falls back to the status panel. `host` argument injects the real
 * pi-tui and coding-agent modules in tests; production resolves them lazily.
 */
export async function runDashboard(deps, injection = {}) {
  const { ctx, title, items, onChange, menus } = deps;
  if (ctx.mode !== 'tui' || typeof ctx.ui.custom !== 'function') return false;
  let tuiPkg = injection.tuiPkg ?? host.tui,
    agentPkg = injection.agentPkg ?? host.agent;
  if (!tuiPkg || !agentPkg) {
    try {
      tuiPkg ??= await import('@earendil-works/pi-tui');
      agentPkg ??= await import('@earendil-works/pi-coding-agent');
    } catch {
      return false;
    }
  }
  const { Container, SettingsList, SelectList, Text, Input, DynamicBorder } = tuiPkg;
  const { getSettingsListTheme, getSelectListTheme } = agentPkg;
  const changed = [];
  let pendingId = null;
  await ctx.ui.custom((tuiRef, theme, keybindings, done) => {
    const cancel = (data) => keybindings?.matches?.(data, 'tui.select.cancel') === true;
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
          pendingId,
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
        new Text(theme.fg('dim', '  ↑↓ navegar · digite para filtrar · enter escolher · esc voltar'), 1, 0),
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
      inner.addChild(new Text(theme.fg('dim', '  esc voltar'), 1, 0));
      return {
        render: (width) => inner.render(width),
        invalidate: () => inner.invalidate(),
        handleInput: (data) => {
          if (cancel(data)) onClose();
        },
      };
    };
    const panels = {
      pool: (_current, close) =>
        screen(
          'Pool · escolha um candidato para editar tier, tools ou remover',
          menus.pool(),
          (value) => {
            // pi overwrites the row's currentValue with whatever the submenu closes
            // with, so the model being edited is remembered here, not on the row.
            pendingId = value;
            list.updateValue('poolEdit', value);
            close(undefined, { navigateTo: 'poolEdit' });
          },
          () => close(),
        ),
      poolAdd: (_current, close) =>
        screen(
          'Modelos do /scoped-models fora do pool',
          menus.scopeCandidates(),
          (value) => close(value),
          () => close(),
        ),
      poolEdit: (current, close) =>
        current
          ? screen(`Editar ${current}`, menus.candidateRows(current), (value) => close(value), () =>
              close(),
            )
          : textScreen(
              'Editar candidato',
              ['Abra "Pool de candidatos" e escolha um modelo primeiro.'],
              () => close(),
            ),
      explain: (_current, close) => textScreen('Última decisão', menus.explain(), () => close()),
      help: (_current, close) => textScreen('Linha de comando', menus.help(), () => close()),
      simulate: (_current, close) => {
        const inner = frame('Simular um pedido · enter roda, esc volta');
        const input = new Input({ placeholder: 'ex.: refatorar auth e rodar testes' });
        inner.addChild(input);
        const result = new Text(
          theme.fg('dim', '  nada sai daqui: nenhum modelo é chamado, nenhuma cobrança acontece'),
          0,
          0,
        );
        inner.addChild(result);
        let showing = false;
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
            if (showing) return;
            input.handleInput(data);
            if (data === '\r' || data === '\n') {
              const text = input.getValue();
              if (!text) return;
              showing = true;
              result.setText(theme.fg('dim', '  calculando…'));
              Promise.resolve(menus.simulate(text))
                .then((lines) => result.setText(lines.map((l) => `  ${l}`).join('\n')))
                .catch((error) => result.setText(theme.fg('error', `  ${error.message}`)))
                .finally(() => tuiRef.requestRender());
            }
            tuiRef.requestRender();
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
    box.addChild(
      new Text(theme.fg('dim', '  Enter/Espaço muda o valor · Esc volta · no topo, Esc fecha'), 1, 0),
    );
    box.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
    return {
      render: (width) => box.render(width),
      invalidate: () => box.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tuiRef.requestRender();
      },
    };
  });
  return { changed };
}
