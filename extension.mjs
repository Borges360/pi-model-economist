import {
  createRuntime,
  merge,
  output,
  usageText,
  buildCompletions,
  words,
  scopeOf,
  setTask,
  uid,
  hash,
  safePath,
  now,
} from './lib/core.mjs';
import { defaults, assess, rank, Classifiers, failureClass, tokenEstimate, decideEffort, clampLevel, requiredTier, levels as THINKING_LEVELS } from './routing.mjs';
import { dashboardItems, explainLines, runDashboard, tierForPool, candidateActions, shortName } from './menu.mjs';
import { readFile } from 'node:fs/promises';
import { benchmark } from './benchmark.mjs';
export default function economist(pi) {
  const rt = createRuntime(pi, 'economist', defaults),
    classifiers = new Classifiers();
  let last = null,
    manualModel = null;
  const failedTasks = new Set();
  const init = async (ctx) => {
    await rt.init(ctx);
    const env = process.env.PI_ECONOMIST_MODELS;
    if (env && !rt.config.modelEconomist.candidates.length)
      rt.config.modelEconomist.candidates = env
        .split(',')
        .map((id, i) => ({ id, tier: i + 1, tools: true }));
  };
  const modelKey = (m) => `${m.provider}/${m.id}`;
  /**
   * What `/scoped-models` resolved for this session. pi exposes it as
   * `ctx.scopedModels` (from `enabledModels` / `--models`) and leaves it empty when
   * nothing is scoped, which means "everything available is usable", so the pool
   * falls back to the authenticated catalogue in that case.
   */
  const poolScope = (ctx) => {
    const conf = rt.config.modelEconomist;
    const rows = (ctx.scopedModels ?? [])
      .map((s) => ({ id: modelKey(s.model), level: s.thinkingLevel }))
      .filter((s) => !(s.id === 'economist/auto' || s.model?.api === 'pi-virtual'));
    const active = conf.scope?.source !== 'all' && rows.length > 0;
    return {
      active,
      rows,
      ids: new Set(rows.map((s) => s.id)),
      // `model:high` in the scope is an ace: that pair is what the user asked for.
      levels: Object.fromEntries(rows.filter((s) => s.level).map((s) => [s.id, s.level])),
      strict: active && conf.scope?.strict !== false,
    };
  };
  /** Real models this session can dispatch right now, before scoping. */
  const physicalModels = (ctx) => {
    const reg = ctx?.modelRegistry ?? rt.ctx?.modelRegistry;
    if (!reg) return [];
    try {
      return reg
        .getAvailable()
        .filter((m) => m.api !== 'pi-virtual' && reg.hasConfiguredAuth?.(m) !== false);
    } catch {
      return [];
    }
  };
  const candidates = (ctx) => {
    const scope = poolScope(ctx ?? rt.ctx);
    // No explicit pool: the scope is the promise, so the scoped models become the
    // pool with tiers proposed by price. Never silently route to an unscoped model.
    const specs = rt.config.modelEconomist.candidates.length
      ? rt.config.modelEconomist.candidates
      : proposeTiers(routableModels(ctx));
    return specs
      .map((c, i) => {
        const spec = typeof c === 'string' ? { id: c, tier: i + 1, tools: false } : c;
        const model = physicalModels(ctx).find((m) => modelKey(m) === spec.id);
        if (!model || (scope.strict && !scope.ids.has(spec.id))) return null;
        return {
          ...model,
          tier: spec.tier ?? i + 1,
          tools: spec.tools === true,
          health: spec.health ?? true,
          dataAllowed: spec.dataAllowed !== false,
          local: spec.local === true,
          priorFailureRate: spec.priorFailureRate ?? 0.25,
          latencyMs: spec.latencyMs ?? 1000,
          auth: true,
          scopedLevel: scope.levels[spec.id],
        };
      })
      .filter(Boolean);
  };
  /** Pool members excluded only because they are not in /scoped-models. */
  const scopeRejections = (ctx) => {
    const scope = poolScope(ctx ?? rt.ctx);
    if (!scope.strict) return [];
    return rt.config.modelEconomist.candidates
      .map(specId)
      .filter(Boolean)
      .filter((id) => !scope.ids.has(id))
      .map((model) => ({ model, reasonCodes: ['out-of-scope'] }));
  };
  let visionDeclined = false;
  /**
   * A strict scoped pool can be honest but blind: none of the scoped models may
   * accept images. Rather than failing the turn, offer the vision-capable models
   * the registry does have, ordered by what this request would cost on each, and
   * let the human keep the one they want in the pool or use it once.
   */
  const visionRescue = async (ctx, a, pool, interactive) => {
    const withVision = physicalModels(ctx).filter((m) => m.input?.includes('image'));
    if (!withVision.length)
      throw Error(
        'This task needs image input and no authenticated model accepts images. Authenticate a vision provider with /login, or run /model on a vision model and /economist off.',
      );
    const priced = withVision
      .map((m) => ({
        model: m,
        cost: tokenEstimate(m, a.estimatedInputTokens, a.estimatedOutputTokens),
      }))
      .sort((x, y) => (x.cost ?? Infinity) - (y.cost ?? Infinity));
    const label = (row, i) =>
      `${i === 0 ? '▸ recomendado ' : ''}${modelKey(row.model)} · ${row.cost == null ? 'price unknown' : `$${row.cost.toFixed(4)} desta task`} · ${Math.round((row.model.contextWindow ?? 0) / 1000)}k ctx${row.model.reasoning ? ' · thinking' : ''}`;
    const guidance = `/economist candidates add ${modelKey(priced[0].model)} <tier>`;
    if (!interactive || typeof ctx.ui?.select !== 'function' || !ctx.hasUI) {
      if (poolScope(ctx).strict)
        throw Error(
          `Nenhum modelo do seu /scoped-models aceita imagem. ${guidance} salva um (recomendado: ${modelKey(priced[0].model)}), ou rode /economist scope all para abrir mãos.`,
        );
      return null;
    }
    if (visionDeclined)
      throw Error(`Vision request needs a model outside your scope and you declined it earlier. ${guidance}`);
    const agreed = await ctx.ui.confirm(
      'Nenhum modelo do seu escopo aceita imagem',
      `Este pedido tem ${a.requiresImageInput ? 'imagens' : 'entrada de imagem'} e o pool (${pool.length} modelo(s) de /scoped-models) não cobre isso. Escolher um entre ${priced.length} modelo(s) com vision disponíveis?`,
    );
    if (!agreed) {
      visionDeclined = true;
      throw Error(
        `Sem vision no escopo e você preferiu não adicionar. Escopie um modelo com vision em /scoped-models, ou ${guidance}.`,
      );
    }
    const chosen = await ctx.ui.select(
      'Modelos com vision, do mais barato para esta task',
      priced.slice(0, 8).map((row, i) => label(row, i)),
    );
    if (!chosen) {
      visionDeclined = true;
      throw Error(`Nenhum modelo com vision escolhido. ${guidance}`);
    }
    const pickedIndex = priced.slice(0, 8).findIndex((row, i) => label(row, i) === chosen);
    const picked = priced[pickedIndex < 0 ? 0 : pickedIndex].model;
    const tier = Math.min(5, Math.max(1, Math.round((pool.length % 4) + 1)));
    const save = await ctx.ui.confirm(
      'Manter este modelo no pool?',
      `Salvar adiciona ${modelKey(picked)} como tier ${tier} em ${rt.configFile}. "Não" usa só nesta requisição e o pool continua intacto.`,
    );
    const candidate = {
      ...picked,
      tier,
      tools: true,
      health: true,
      dataAllowed: true,
      local: false,
      priorFailureRate: 0.25,
      latencyMs: 1000,
      auth: true,
      scopedLevel: undefined,
    };
    return {
      candidate,
      persist: save
        ? [...rt.config.modelEconomist.candidates.map((c) => (typeof c === 'string' ? { id: c, tier: 1, tools: false } : c)), { id: modelKey(picked), tier, tools: true }]
        : undefined,
    };
  };
  /**
   * Models the user can actually route to right now, limited to the session scope
   * when one is set. Used by completions, the setup wizard, the dashboard and
   * diagnostics so the human never has to guess an ID.
   */
  const routableModels = (ctx) => {
    const scope = poolScope(ctx ?? rt.ctx);
    const list = physicalModels(ctx);
    return (scope.active ? list.filter((m) => scope.ids.has(modelKey(m))) : list)
      .map((m) => ({
        value: modelKey(m),
        label: modelKey(m),
        model: m,
        cost: m.cost?.input != null ? Number(m.cost.input) + Number(m.cost.output ?? 0) : null,
        vision: !!m.input?.includes('image'),
        reasoning: m.reasoning === true,
        window: m.contextWindow ?? null,
        scopedLevel: scope.levels[modelKey(m)],
        description: [
          m.cost?.input != null ? `$${m.cost.input}/M in` : 'price unknown',
          m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : null,
          m.input?.includes('image') ? 'vision' : null,
          m.reasoning === true ? 'thinking' : null,
          scope.levels[modelKey(m)] ? `:${scope.levels[modelKey(m)]}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }));
  };
  const specId = (c) => (typeof c === 'string' ? c : c?.id);
  const economistUnavailable = (conf, ctx) => {
    const scope = poolScope(ctx ?? rt.ctx);
    const configured = conf.candidates.map(specId).filter(Boolean);
    const routable = routableModels(ctx);
    const missing = configured.filter((id) => !routable.some((m) => m.value === id));
    const reason = !configured.length
      ? `no candidates are configured${scope.active ? `, and your ${scope.rows.length} scoped model(s) are not in a pool yet` : ''}, so there is nothing to route to`
      : missing.length
        ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not authenticated/available${scope.strict ? ' or outside /scoped-models' : ''} in this registry`
        : 'every candidate in scope failed a tier, capability, price, or policy filter';
    return (
      `Economist could not select a model: ${reason}. ` +
      (routable.length
        ? `Add one with /economist candidates add (autocomplete lists ${routable.length} scoped model${routable.length === 1 ? '' : 's'}), run /economist setup, or widen /economist scope all.`
        : 'Authenticate a provider with /login first, or pick a physical model with /model and run /economist off.')
    );
  };
  const decide = async (
    text,
    ctx,
    {
      simulate = false,
      images = false,
      contextTokens = 0,
      previous = null,
      forceDifficulty = null,
      forceTier = null,
      reason = 'user',
      allowClassification = true,
      interactive = !simulate,
      selectedLevel = ctx.thinkingLevel ?? 'off',
      signal = ctx.signal,
    } = {},
  ) => {
    await init(ctx);
    const conf = rt.config.modelEconomist;
    const started = Date.now();
    let a = assess(text, { images, contextTokens });
    let cost = 0,
      fallback = null;
    const initialScope = scopeOf(ctx),
      initialCalls = await rt.store.rows('model-calls');
    const spentBefore = initialCalls
      .filter((c) =>
        initialScope.taskId
          ? c.taskId === initialScope.taskId
          : c.sessionId === initialScope.sessionId,
      )
      .reduce((n, c) => n + (c.observedCostUsd ?? c.estimatedCostUsd ?? 0), 0);
    const remaining = Number.isFinite(conf.budgetUsd) ? conf.budgetUsd - spentBefore : Infinity;
    if (!simulate && remaining <= 0)
      throw Error('Economist task budget exceeded before classification');
    if (
      !simulate &&
      allowClassification &&
      conf.mode !== 'rules' &&
      conf.mode !== 'off' &&
      conf.mode !== 'manual' &&
      !(
        a.simple &&
        text.length <= conf.fastPath.maxPromptCharsForFreeRules &&
        conf.fastPath.skipPaidClassifierForObviousTasks
      ) &&
      !a.risks.length
    ) {
      const result = await classifiers.run(
        text,
        a,
        ctx,
        {
          ...conf.classifier,
          maxCostUsdPerDecision: Math.min(conf.classifier.maxCostUsdPerDecision, remaining),
        },
        {
          signal,
          engine: ['jev', 'small-llm'].includes(conf.mode) ? conf.mode : conf.classifier.engine,
          emit: (k, p) => rt.emit(k, p),
        },
      );
      a = result.assessment;
      cost = result.cost;
      fallback = result.fallback;
    }
    if (forceDifficulty) {
      a.difficulty = forceDifficulty;
      a.requiresTools = true;
    }
    if (fallback) await rt.emit('model.classifier_fallback', { reason: fallback });
    let fast =
      conf.fastPath.enabled &&
      conf.fastPath.eligibleDifficulties.includes(a.difficulty) &&
      !a.risks.some((r) => conf.fastPath.prohibitOnRisks.includes(r));
    let pool = candidates(ctx);
    if (
      a.requiresImageInput &&
      conf.scope?.helpVision !== false &&
      !pool.some((m) => m.input?.includes('image'))
    ) {
      // A scoped pool with no vision model would fail an image task. Ask, help
      // choose by the cost of this very request, and offer to save or use once.
      // Only a prompt the human typed is worth interrupting them for: compaction
      // and extension calls must never raise a dialog.
      const rescue = await visionRescue(ctx, a, pool, interactive && reason === 'user');
      if (rescue?.persist) await rt.save('modelEconomist', { candidates: rescue.persist });
      pool = rescue ? [...pool, rescue.candidate] : pool;
    }
    const thinking = conf.thinking ?? {};
    const effortRequest = decideEffort(a, thinking, selectedLevel);
    const effortAware = thinking.mode !== 'follow';
    const effort = effortAware
      ? {
          requested: effortRequest.level,
          thinking,
          // `model:high` inside /scoped-models is an ace the router does not touch.
          levels: Object.fromEntries(
            pool
              .filter((m) => m.scopedLevel)
              .map((m) => [modelKey(m), clampLevel(m.scopedLevel, m)]),
          ),
          requireReasoning:
            thinking.requireReasoningOnRisk !== false &&
            (a.risks.length > 0 || a.difficulty === 'critical'),
        }
      : null;
    if (fast && cost > 0) {
      const estimates = (group) =>
        group
          .map((m) => tokenEstimate(m, a.estimatedInputTokens, a.estimatedOutputTokens))
          .filter((v) => v !== null);
      const low = estimates(pool.filter((m) => m.tier === 1));
      const normal = estimates(pool.filter((m) => m.tier >= 2));
      if (!low.length || !normal.length || Math.min(...normal) - Math.min(...low) <= cost)
        fast = false;
    }
    if (fast && conf.fastPath.executionModels.length) {
      const fastPool = pool.filter((m) =>
        conf.fastPath.executionModels.includes(`${m.provider}/${m.id}`),
      );
      if (fastPool.length) pool = fastPool;
    }
    const history = (await rt.store.rows('outcomes')).map((r) => r.payload ?? r);
    const ranked = rank(
      pool,
      !fast && ['simple', 'trivial'].includes(a.difficulty) && cost > 0
        ? { ...a, difficulty: 'moderate' }
        : a,
      { ...conf, minRiskTier: Math.max(conf.minRiskTier, forceTier ?? 0) },
      history,
      previous,
      cost ?? 0,
      effort,
    );
    let rankedCandidates = ranked.accepted;
    const scope = scopeOf(ctx);
    const calls = await rt.store.rows('model-calls');
    const spent = calls
      .filter((c) => (scope.taskId ? c.taskId === scope.taskId : c.sessionId === scope.sessionId))
      .reduce((n, c) => n + (c.observedCostUsd ?? c.estimatedCostUsd ?? 0), 0);
    const limit = conf.budgetUsd;
    if (Number.isFinite(limit)) {
      rankedCandidates = rankedCandidates.filter((c) => {
        if (c.expectedTotalCost === null || spent + c.expectedTotalCost > limit) {
          ranked.rejected.push({
            model: `${c.model.provider}/${c.model.id}`,
            reasonCodes: ['budget'],
          });
          return false;
        }
        return true;
      });
    }
    if (!rankedCandidates.length) {
      const needed = requiredTier(a, { ...conf, minRiskTier: Math.max(conf.minRiskTier, forceTier ?? 0) });
      const tiers = [...new Set(pool.map((m) => m.tier))].sort((x, y) => x - y);
      throw Error(
        `${economistUnavailable(conf, ctx)}\n` +
          `Esta tarefa (${a.kind}/${a.difficulty}${a.risks.length ? `, risco ${a.risks.join('+')}` : ''}) exige tier ≥ ${needed};` +
          ` o pool tem tiers ${tiers.join(', ') || 'nenhum'}${effort?.requireReasoning ? ' e modelos sem raciocínio foram recusados' : ''}.` +
          ` Conserte com /economist candidates add <modelo> ${needed} (ou elevate o tier) e revise /economist scope.`,
      );
    }
    let selected = rankedCandidates[0];
    // The dispatched pair is (physical model, physical level): take the level that
    // model can actually run, so the estimate above and the turn match.
    const thinkingLevel = effort
      ? (selected.thinkingLevel ?? clampLevel(effort.requested, selected.model))
      : selectedLevel;
    if (
      conf.mode === 'learned' &&
      history.length > 0 &&
      history.length % conf.explorationEvery === 0 &&
      !a.risks.length
    ) {
      const second = rankedCandidates.find(
        (c) =>
          c.samples < conf.minHistorySamples &&
          c.expectedTotalCost !== null &&
          selected.expectedTotalCost !== null &&
          c.expectedTotalCost <= selected.expectedTotalCost * (1 + conf.maxExplorationPremium),
      );
      if (second) {
        const milestone = `${a.kind}/${Math.floor(history.length / conf.explorationEvery)}`;
        if (!(await rt.store.rows('exploration')).some((r) => r.id === milestone)) {
          if (
            simulate ||
            (await rt.store.append('exploration', {
              id: milestone,
              kind: a.kind,
              modelId: `${second.model.provider}/${second.model.id}`,
              occurredAt: now(),
            }))
          )
            selected = second;
        }
      }
    }
    const decision = {
      id: uid(),
      reason,
      assessment: a,
      selectedModelId: `${selected.model.provider}/${selected.model.id}`,
      selectedThinkingLevel: thinkingLevel,
      effortSource: effort ? effortRequest.source : 'follow',
      phase: fast ? 'fast' : 'normal',
      classifierCostUsd: cost,
      estimatedTotalCostUsd: selected.expectedTotalCost,
      durationMs: Date.now() - started,
      reasonCodes: [
        conf.policy,
        conf.mode,
        fast ? 'fast-path' : 'normal-route',
        fallback ? 'classifier-fallback' : 'classified',
        `effort:${thinkingLevel}`,
        ...(effort?.requireReasoning ? ['reasoning-required'] : []),
        ...(poolScope(ctx).active ? [`scope:${conf.scope?.source ?? 'scoped'}`] : []),
      ],
      candidates: rankedCandidates.map((c) => ({
        ...c,
        model: `${c.model.provider}/${c.model.id}`,
      })),
      rejected: [...ranked.rejected, ...scopeRejections(ctx)],
      simulation: simulate,
    };
    if (!simulate) {
      last = decision;
      await rt.store.append('model-routes', {
        ...scope,
        id: decision.id,
        occurredAt: now(),
        ...decision,
      });
      await rt.emit('model.routed', decision, decision.id);
      ctx.ui.setStatus(
        'economist',
        `${selected.model.id}:${thinkingLevel} · ${decision.phase}`,
      );
    }
    return { decision, model: selected.model, thinkingLevel };
  };
  pi.on('session_start', async (_e, ctx) => {
    await init(ctx);
    last = null;
  });
  pi.on('message_end', async (e, ctx) => {
    if (e.message.role !== 'assistant' || pi.getCommands?.().some((c) => c.name === 'cost')) return;
    await init(ctx);
    const m = e.message,
      u = m.usage,
      estimate = Number.isFinite(u?.cost?.total) && u.cost.total > 0 ? u.cost.total : null;
    await rt.store.append('model-calls', {
      id: `${m.provider}/${m.responseId ?? `${m.model}/${m.timestamp}`}`,
      ...scopeOf(ctx),
      taskId: scopeOf(ctx).taskId ?? 'unattributed',
      provider: m.provider,
      modelId: `${m.provider}/${m.model}`,
      estimatedCostUsd: estimate,
      observedCostUsd: null,
      totalTokens: u?.totalTokens ?? null,
      source: 'economist-budget-fallback',
      occurredAt: now(),
    });
  });
  const unsubscribe = rt.listen(async (e) => {
    if (
      e.kind === 'model.call_completed' &&
      e.source === 'economist' &&
      e.payload.category === 'classifier' &&
      !pi.getCommands?.().some((c) => c.name === 'cost')
    ) {
      const p = e.payload;
      await rt.store.append('model-calls', {
        id: `${p.provider}/${p.callId}`,
        ...scopeOf(rt.ctx),
        taskId: e.taskId ?? 'unattributed',
        provider: p.provider,
        modelId: `${p.provider}/${p.model}`,
        estimatedCostUsd: p.estimatedCost ?? null,
        observedCostUsd: null,
        totalTokens: p.usage?.totalTokens ?? null,
        category: 'classifier',
        source: 'economist-budget-fallback',
        occurredAt: now(),
      });
    }
    if (
      e.kind === 'gate.evaluated' &&
      e.source === 'gate' &&
      e.payload.verified === true &&
      e.payload.status === 'rejected' &&
      e.taskId
    )
      failedTasks.add(`${e.sessionId}/${e.taskId}`);
  });
  pi.on('session_shutdown', async () => {
    unsubscribe?.();
    await rt.dispose();
  });
  pi.registerVirtualModel({
    provider: 'economist',
    id: 'auto',
    name: 'Economist',
    // The router dispatches a level of its own, so every level pi can name must be
    // offerable; pi clamps what the physical model cannot run.
    thinkingLevels: [...THINKING_LEVELS],
    async route(request, ctx) {
      await init(ctx);
      const conf = rt.config.modelEconomist;
      if (Number.isFinite(conf.budgetUsd)) {
        const scope = scopeOf(ctx);
        const calls = (await rt.store.rows('model-calls')).filter((c) =>
          scope.taskId ? c.taskId === scope.taskId : c.sessionId === scope.sessionId,
        );
        if (
          calls.some((c) => c.observedCostUsd == null && c.estimatedCostUsd == null) ||
          calls.reduce((n, c) => n + (c.observedCostUsd ?? c.estimatedCostUsd ?? 0), 0) >=
            conf.budgetUsd
        )
          throw Error('Economist task budget exhausted/unknown spend; no continuation dispatched');
      }
      const state = request.state ?? { phase: 'normal', retries: 0, escalations: 0 };
      const sticky = request.failed ?? request.previous;
      const stick = async (nextState) => {
        const decision = {
          id: uid(),
          reason: request.reason,
          sticky: true,
          selectedModelId: `${sticky.model.provider}/${sticky.model.id}`,
          selectedThinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel,
          assessment: state.assessment ?? null,
          phase: state.phase,
          candidates: [`${sticky.model.provider}/${sticky.model.id}`],
          rejected: [],
          classifierCostUsd: 0,
          estimatedTotalCostUsd: null,
        };
        last = decision;
        await rt.store.append('model-routes', { ...scopeOf(ctx), ...decision, occurredAt: now() });
        await rt.emit('model.routed', decision, decision.id);
        return {
          model: sticky.model,
          thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel,
          state: nextState,
        };
      };
      if (request.reason === 'retry') {
        const retries = (state.retries ?? 0) + 1,
          category = failureClass(request.failed?.message?.errorMessage ?? '');
        await rt.emit('model.retry', { category, retries, maxRetries: conf.maxRetries });
        if (category === 'policy' || retries > conf.maxRetries)
          throw Error(`Economist: ${category} retry limit reached`);
        if (sticky && ['network', 'quality'].includes(category))
          return stick({ ...state, retries });
      }
      if (!conf.enabled || ['off', 'manual'].includes(conf.mode)) {
        const physical =
          manualModel ??
          request.previous?.model ??
          candidates(ctx).find((m) => modelKey(m) === conf.fallbackModel);
        if (!physical || physical.api === 'pi-virtual')
          throw Error('Economist disabled/manual: choose a physical model with /model');
        return { model: physical, thinkingLevel: request.thinkingLevel };
      }
      const taskKey = `${scopeOf(ctx).sessionId}/${scopeOf(ctx).taskId}`;
      const escalate =
        state.phase === 'fast' &&
        failedTasks.has(taskKey) &&
        (state.escalations ?? 0) < conf.fastPath.maxEscalations;
      if (request.reason === 'continuation' && sticky && !escalate) return stick(request.state);
      const user = [...request.messages].reverse().find((m) => m.role === 'user');
      const text =
        typeof user?.content === 'string'
          ? user.content
          : (user?.content ?? [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      const images = request.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image'),
      );
      const contextTokens =
        ctx.getContextUsage()?.tokens ?? Math.ceil(JSON.stringify(request.messages).length / 4);
      const result = await decide(text, ctx, {
        images,
        contextTokens,
        previous: sticky ? `${sticky.model.provider}/${sticky.model.id}` : null,
        forceDifficulty: escalate ? 'critical' : null,
        forceTier: escalate
          ? (candidates(ctx).find((m) => m.id === sticky?.model.id)?.tier ?? 1) + 1
          : null,
        reason: request.reason,
        allowClassification: request.reason !== 'direct',
        // The level the human selected on economist/auto is the input to the effort
        // decision, so /thinking keeps meaning without pinning the router.
        selectedLevel: request.thinkingLevel ?? ctx.thinkingLevel ?? 'off',
        signal: request.signal,
      });
      if (escalate) {
        failedTasks.delete(taskKey);
        await rt.emit('model.escalated', { decisionId: result.decision.id });
      }
      return {
        model: result.model,
        // Effort is routed with the model. `follow` returns the user's own level
        // because decide() only passes it through in that mode.
        thinkingLevel: result.thinkingLevel,
        state: {
          phase: result.decision.phase,
          assessment: result.decision.assessment,
          decisionId: result.decision.id,
          retries: request.reason === 'retry' ? (state.retries ?? 0) + 1 : 0,
          escalations: escalate
            ? (state.escalations ?? 0) + 1
            : request.reason === 'user'
              ? 0
              : (state.escalations ?? 0),
        },
      };
    },
  });
  const MODES = [
    { value: 'hybrid', description: 'free rules first, paid classifier only when ambiguous' },
    { value: 'rules', description: 'deterministic and free, never calls a classifier' },
    { value: 'jev', description: 'native classifier decides every request' },
    { value: 'small-llm', description: 'a small model classifies with strict JSON' },
    { value: 'learned', description: 'use verified history once there are enough samples' },
    { value: 'manual', description: 'you pick with /model; the economist only records routes' },
    { value: 'off', description: 'routing disabled' },
  ];
  const POLICIES = [
    { value: 'economy', description: 'cheapest model that can do the job' },
    { value: 'balanced', description: 'default trade-off between cost and capability' },
    { value: 'quality', description: 'prefer the strongest capable model' },
    { value: 'latency', description: 'prefer the fastest capable model' },
  ];
  const MODE_IDS = MODES.map((m) => m.value);
  const POLICY_IDS = POLICIES.map((p) => p.value);
  const THINKING_MODES = [
    { value: 'auto', description: 'effort routed with the model, from task difficulty and risk' },
    { value: 'follow', description: 'never touch effort; your /thinking wins' },
    { value: 'fixed', description: 'always the same level' },
  ];
  const SCOPE_SOURCES = [
    { value: 'scoped', description: 'only the models in /scoped-models' },
    { value: 'all', description: 'every authenticated model in the registry' },
  ];
  const EFFORT_LEVELS = THINKING_LEVELS.map((l) => ({
    value: l,
    description:
      l === 'off'
        ? 'no reasoning tokens'
        : l === 'max' || l === 'xhigh'
          ? 'the model thinks as long as it wants'
          : `reasoning budget: ${l}`,
  }));
  /** RPC and print clients may expose fewer dialogs than the TUI; never assume. */
  const selectable = (ctx) => ctx.hasUI && typeof ctx.ui.select === 'function';
  /** Configured pool, annotated with what the registry can actually route to. */
  const configuredCandidates = (ctx) => {
    const scope = poolScope(ctx ?? rt.ctx);
    return rt.config.modelEconomist.candidates.map((c, i) => {
      const id = specId(c) ?? String(c);
      const tier = typeof c === 'object' && c ? (c.tier ?? i + 1) : i + 1;
      const tools = typeof c === 'object' && c ? c.tools === true : false;
      const live = physicalModels(ctx).some((m) => modelKey(m) === id);
      const inScope = !scope.strict || scope.ids.has(id);
      return {
        value: id,
        label: id,
        tier,
        tools,
        description: [
          `tier ${tier}`,
          tools ? 'tools' : 'no tools',
          live ? null : 'not authenticated',
          inScope ? null : 'outside /scoped-models',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    });
  };
  const economistSpec = {
    name: 'economist',
    description: 'Route each request to the cheapest capable model',
    actions: {
      on: { hint: '', description: 'enable routing and switch to economist/auto' },
      off: { hint: '', description: 'stop routing and restore your manual model' },
      setup: {
        hint: '[--global]',
        description: 'guided setup from your authenticated models',
        flags: { '--global': { hint: 'write the global config instead' } },
      },
      mode: {
        hint: 'MODE',
        description: 'routing strategy',
        args: [{ values: MODES, hint: 'mode' }],
      },
      policy: {
        hint: 'POLICY',
        description: 'cost/quality trade-off',
        args: [{ values: POLICIES, hint: 'policy' }],
      },
      thinking: {
        hint: 'auto|follow|fixed',
        description: 'whether effort is routed with the model',
        args: [{ values: THINKING_MODES, hint: 'mode' }],
      },
      ceiling: {
        hint: 'LEVEL',
        description: 'highest effort auto may dispatch',
        args: [{ values: EFFORT_LEVELS, hint: 'level' }],
      },
      'risk-floor': {
        hint: 'LEVEL',
        description: 'effort a risky task must get (off disables the lift)',
        args: [{ values: [{ value: 'off', description: 'risk never raises effort' }, ...EFFORT_LEVELS], hint: 'level' }],
      },
      scope: {
        hint: 'scoped|all',
        description: 'pool source: /scoped-models or the whole catalogue',
        args: [{ values: SCOPE_SOURCES, hint: 'source' }],
      },
      'scope-strict': {
        hint: 'on|off',
        description: 'reject candidates outside the scope',
        args: [
          {
            values: [
              { value: 'on', description: 'out-of-scope candidates are rejected' },
              { value: 'off', description: 'out-of-scope models stay eligible as last resort' },
            ],
            hint: 'on|off',
          },
        ],
      },
      classifier: {
        hint: 'on|off',
        description: 'paid or LLM classifier',
        args: [
          {
            values: [
              { value: 'on', description: 'classify ambiguous requests' },
              { value: 'off', description: 'rules only, always free' },
            ],
            hint: 'on|off',
          },
        ],
      },
      'classifier-model': {
        hint: 'PROVIDER/MODEL',
        description: 'model used to classify',
        args: [{ provide: async () => routableModels(rt.ctx), hint: 'provider/model' }],
      },
      candidates: {
        hint: 'list|add|remove',
        description: 'inspect or edit the routing pool',
        args: [
          {
            values: [
              { value: 'list', description: 'show the pool and what is usable' },
              { value: 'add', description: 'add a model with an explicit tier' },
              { value: 'remove', description: 'drop a model from the pool' },
            ],
            hint: 'operation',
            advance: true,
          },
          {
            provide: async ({ positional }) =>
              positional[0] === 'add' || !positional.length
                ? routableModels(rt.ctx)
                : configuredCandidates(rt.ctx),
            hint: 'provider/model',
            advance: true,
          },
          {
            values: [
              { value: '1', description: 'cheapest: greetings, lookups, summaries' },
              { value: '2', description: 'routine edits and tests' },
              { value: '3', description: 'complex debugging and design' },
              { value: '4', description: 'risky work: production, security' },
              { value: '5', description: 'strongest available' },
            ],
            hint: 'tier',
          },
        ],
        flags: { '--tools': { values: ['on', 'off'], hint: 'tool capable' } },
      },
      budget: {
        hint: 'task N USD',
        description: 'per-task spend limit',
        args: [
          { values: ['task'], hint: 'task', advance: true },
          {
            values: ['0.25', '0.50', '1.00', '5.00'].map((v) => ({
              value: v,
              description: 'hard cap per task, warns at 50/80%',
            })),
            hint: 'amount',
            advance: true,
          },
          { values: ['USD'], hint: 'USD' },
        ],
      },
      simulate: {
        hint: 'PROMPT',
        description: 'free dry run, no model called',
        args: [{ hint: 'prompt text' }],
        free: true,
      },
      benchmark: {
        hint: '--dataset PATH',
        description: 'offline paired replay',
        flags: { '--dataset': { hint: 'dataset path' } },
        free: true,
      },
      explain: { hint: '', description: 'last routing decision' },
      json: { hint: '', description: 'last decision with rejected alternatives' },
      help: { hint: '', description: 'show this list' },
    },
  };
  /**
   * Tier proposal from price, so a plain "olá" never reaches an expensive model.
   * The registry does not publish tool capability, so it is assumed and reported
   * for correction instead of being silently guessed.
   */
  const proposeTiers = (pool) => {
    const priced = pool.filter((m) => Number.isFinite(m.cost));
    const unpriced = pool.filter((m) => !Number.isFinite(m.cost));
    const sorted = [...priced].sort((a, b) => a.cost - b.cost);
    // One rung per model (capped at 5, never below 2), so a three-model scope is a
    // real ladder [1,2,3] instead of [1,1,2] that cannot serve routine work.
    const tiers = Math.min(5, Math.max(2, sorted.length));
    const step = Math.max(1, sorted.length);
    return sorted
      .map((m, i) => ({
        id: m.value,
        // A lone model cannot be ranked against anything, so it gets the second rung:
        // routine work routes, and risky work names the missing capability instead of
        // failing silently.
        tier:
          sorted.length === 1
            ? 2
            : Math.min(tiers, 1 + Math.floor((i * tiers) / step)),
        tools: true,
      }))
      .concat(unpriced.map((m) => ({ id: m.value, tier: Math.min(5, tiers + 1), tools: true })));
  };
  /** Why a model is not selectable right now, said in terms the user can act on. */
  const scopeNotice = (id, ctx) => {
    const scope = poolScope(ctx ?? rt.ctx);
    if (scope.active && !scope.ids.has(id))
      return `${id} is not in /scoped-models (${scope.rows.length} scoped). Add it there, or run /economist scope all to use the whole catalogue.`;
    if (!physicalModels(ctx).some((m) => modelKey(m) === id)) return undefined;
    return undefined;
  };
  /**
   * Bare `/economist` opens the dashboard: every knob with its live value, changes
   * applied as they are made. Clients without a custom TUI screen get a status
   * panel first and the command lines second, never a bare command dump.
   */
  const openMenu = async (ctx, { conf, locked, setField, turnOn, turnOff, FIELDS }) => {
    const scope = poolScope(ctx);
    const specs = () =>
      rt.config.modelEconomist.candidates.map((c) =>
        typeof c === 'string' ? { id: c, tier: 1, tools: false } : { ...c },
      );
    const items = dashboardItems({
      conf,
      pool: candidates(ctx),
      scoped: scope.active ? scope.rows.length : physicalModels(ctx).length,
      last,
      notes: { modes: MODE_IDS, policies: POLICY_IDS, levels: THINKING_LEVELS },
    }).filter((item) => {
      const lock = item.id === 'enabled' ? 'enabled' : FIELDS[item.id]?.lock;
      return !lock || !Object.hasOwn(locked, lock);
    });
    const savePool = (rows, note) =>
      rt.save('modelEconomist', { candidates: rows }).then(() => note);
    const menus = {
      pool: () =>
        configuredCandidates(ctx).map((c) => ({
          value: c.value,
          label: shortName(c.value),
          description: c.description,
        })),
      scopeCandidates: () => {
        const inPool = new Set(rt.config.modelEconomist.candidates.map(specId));
        return routableModels(ctx)
          .filter((r) => !inPool.has(r.value))
          .map((r) => ({
            value: r.value,
            label: shortName(r.value),
            description: r.description || 'sem anotações',
          }));
      },
      candidateRows: (id) =>
        candidateActions(configuredCandidates(ctx).find((c) => c.value === id)),
      explain: () => explainLines(last, conf),
      help: () => usageText('economist', economistSpec).split('\n'),
      simulate: async (text) => {
        const run = await decide(text, ctx, { simulate: true });
        return explainLines(run.decision, conf);
      },
    };
    const onChange = (id, value, update, target) => {
      if (id === 'enabled') return (value === 'on' ? turnOn : turnOff)({ quiet: true });
      if (id === 'pool') return undefined;
      if (id === 'poolAdd') {
        const rows = menus.scopeCandidates();
        const tier = tierForPool(
          Math.max(0, rows.findIndex((r) => r.value === value)),
          Math.max(1, rows.length),
        );
        return savePool(
          [...specs(), { id: value, tier, tools: true }],
          `adicionado ${value} · tier ${tier}`,
        );
      }
      if (id === 'poolEdit') {
        // The submenu row's own value is the action, so the model comes from the
        // menu's remembered target, never from the row.
        if (!target) return Promise.resolve('nenhum candidato selecionado');
        if (value === 'remove') {
          update('poolEdit', '—');
          return savePool(
            specs().filter((c) => c.id !== target),
            `removido ${target}`,
          );
        }
        const [kind, arg] = String(value).split(':');
        const rows = specs().map((c) =>
          c.id === target
            ? { ...c, ...(kind === 'tier' ? { tier: Number(arg) } : { tools: arg === 'on' }) }
            : c,
        );
        return savePool(rows, `${shortName(target)} · ${kind} ${arg}`);
      }
      return setField(id, value, { quiet: true });
    };
    const title = `Economist · ${conf.enabled ? 'on' : 'off'} · ${conf.mode} · ${conf.policy} · pool ${candidates(ctx).length}/${scope.active ? scope.rows.length : 'all'}`;
    const opened = await runDashboard({ ctx, title, items, onChange, menus });
    if (opened === false) {
      const pool = candidates(ctx);
      return output(ctx, [
        `Economist · ${conf.enabled ? 'ON' : 'off'} · modo ${conf.mode} · política ${conf.policy}`,
        `pool ${pool.length} modelo(s)${scope.active ? ` · escopo /scoped-models com ${scope.rows.length}` : ' · catálogo inteiro'} · esforço ${conf.thinking?.mode ?? 'auto'} (teto ${conf.thinking?.ceiling ?? 'high'}, risco ${conf.thinking?.riskFloor ?? 'high'})`,
        last
          ? `última decisão: ${last.selectedModelId}:${last.selectedThinkingLevel ?? 'off'} · ${last.reasonCodes?.join(' · ') ?? ''}`
          : 'última decisão: nenhuma · mande um pedido ou simule abaixo',
        '',
        'Este cliente não tem tela customizada; os comandos diretos funcionam:',
        '/economist on | off | setup | mode rules | policy economy | thinking follow',
        '/economist candidates list | candidates add <modelo> <tier> | scope all',
        '/economist simulate "refatorar auth" | explain | json',
      ].join('\n'));
    }
    const changed = opened?.changed ?? [];
    return output(
      ctx,
      changed.length
        ? `Economist · ${changed.length} mudança(s)\n${changed.map((c) => `· ${c}`).join('\n')}\nsalvo em ${rt.configFile}`
        : 'Economist · nada foi alterado no menu.',
    );
  };
  pi.registerCommand('economist', {
    description:
      'Model routing — (vazio abre o menu) | on | off | setup | mode | policy | thinking | ceiling | risk-floor | scope | classifier | candidates | budget | simulate | explain | help',
    getArgumentCompletions: buildCompletions(economistSpec),
    handler: async (args, ctx) => {
      await init(ctx);
      const argv = words(args);
      const [action = '', ...rest] = argv;
      const conf = rt.config.modelEconomist;
      const locked = rt.config.locked?.modelEconomist ?? {};
      const useGlobal = rest.includes('--global');
      const persist = (patch) => rt.save('modelEconomist', patch, { global: useGlobal });
      /**
       * Every writable field in one table. The text commands and the dashboard both
       * go through it, so a lock or a validation can never be bypassed by one of them.
       */
      const FIELDS = {
        mode: {
          lock: 'mode',
          values: MODE_IDS,
          patch: (v) => ({ mode: v }),
          note: (v) => `mode → ${v}`,
        },
        policy: {
          lock: 'policy',
          values: POLICY_IDS,
          patch: (v) => ({ policy: v }),
          note: (v) => `policy → ${v}`,
        },
        classifier: {
          lock: 'classifier',
          values: ['on', 'off'],
          patch: (v) => ({ classifier: { enabled: v === 'on' } }),
          note: (v) => `classifier → ${v}`,
        },
        thinking: {
          lock: 'thinking',
          values: THINKING_MODES.map((m) => m.value),
          patch: (v) => ({ thinking: { mode: v } }),
          note: (v) => `esforço → ${v}`,
        },
        ceiling: {
          lock: 'thinking',
          values: THINKING_LEVELS.filter((l) => l !== 'off'),
          patch: (v) => ({ thinking: { ceiling: v } }),
          note: (v) => `teto de esforço → ${v}`,
        },
        'risk-floor': {
          lock: 'thinking',
          values: ['off', ...THINKING_LEVELS.filter((l) => l !== 'off')],
          patch: (v) => ({ thinking: { riskFloor: v } }),
          note: (v) => `esforço sob risco → ${v}`,
        },
        fixed: {
          lock: 'thinking',
          values: THINKING_LEVELS,
          patch: (v) => ({ thinking: { fixed: v } }),
          note: (v) => `esforço fixo → ${v}`,
        },
        'selected-as': {
          lock: 'thinking',
          values: ['ceiling', 'ignore'],
          patch: (v) => ({ thinking: { useSelectedAs: v } }),
          note: (v) => `seu /thinking vale como ${v}`,
        },
        scope: {
          lock: 'scope',
          values: SCOPE_SOURCES.map((s) => s.value),
          patch: (v) => ({ scope: { source: v } }),
          note: (v) => `fonte do pool → ${v}`,
        },
        'scope-strict': {
          lock: 'scope',
          values: ['on', 'off'],
          patch: (v) => ({ scope: { strict: v === 'on' } }),
          note: (v) => `escopo estrito → ${v}`,
        },
      };
      const lockedField = {
        on: 'enabled',
        off: 'enabled',
        budget: 'budgetUsd',
        'classifier-model': 'classifier',
        setup: 'candidates',
        candidates: 'candidates',
        ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.lock])),
      }[action];
      if (lockedField && Object.hasOwn(locked, lockedField))
        throw Error(
          `economist.${lockedField} is locked by global policy and cannot be changed from a command.`,
        );
      const apply = async (patch, note) => {
        const written = await persist(patch);
        output(
          ctx,
          `${note}\nsaved ${JSON.stringify(patch)} → ${written}\nRun /reload if a change does not take effect.`,
        );
        return note;
      };
      const setField = (id, value, { quiet = false } = {}) => {
        const field = FIELDS[id];
        if (!field) throw Error(`Unknown economist field: ${id}`);
        if (Object.hasOwn(locked, field.lock))
          throw Error(`economist.${field.lock} is locked by global policy.`);
        if (!field.values.includes(value))
          throw Error(
            `Invalid ${id}: ${value}\nUse: ${field.values.join(' | ')}`,
          );
        if (quiet) {
          const written = persist(field.patch(value)).then(() => field.note(value));
          return written;
        }
        return apply(field.patch(value), field.note(value));
      };
      const turnOn = async ({ quiet = false } = {}) => {
        const live = candidates(ctx);
        if (!live.length) {
          const routable = routableModels(ctx);
          // Never overwrite an explicit pool the user wrote; only bootstrap an empty one.
          const approved =
            !conf.candidates.length && ctx.hasUI && routable.length
              ? typeof ctx.ui.confirm === 'function'
                ? await ctx.ui.confirm(
                    'No routing candidates configured',
                    `Economist has nothing to route to, but ${routable.length} model${routable.length === 1 ? '' : 's'} in your scope ${routable.length === 1 ? 'is' : 'are'} available. Configure them now?`,
                  )
                : false
              : false;
          if (!approved) throw Error(economistUnavailable(conf, ctx));
          const proposed = proposeTiers(routable);
          const written = await persist({ enabled: true, candidates: proposed });
          if (ctx.model?.api !== 'pi-virtual') manualModel = ctx.model;
          const model = ctx.modelRegistry.find('economist', 'auto');
          if (model) await pi.setModel(model);
          if (quiet) return `on · ${proposed.length} candidates → ${written}`;
          return output(
            ctx,
            `Economist on · ${proposed.length} candidates ordered by price → ${written}\nRefine in /economist (menu), or with /economist candidates, policy, thinking.`,
          );
        }
        if (!rt.config.modelEconomist.candidates.length) {
          // A pool derived from the scope gets saved, so what routing will use is
          // reviewable in the config file and survives a later `/economist scope all`.
          const derived = proposeTiers(routableModels(ctx));
          if (ctx.model?.api !== 'pi-virtual') manualModel = ctx.model;
          const written = await persist({ enabled: true, candidates: derived });
          const auto = ctx.modelRegistry.find('economist', 'auto');
          if (auto) await pi.setModel(auto);
          const note = `on · pool derivado do escopo salvo: ${derived.length} candidatos (tiers ${derived.map((d) => d.tier).join(', ')})`;
          return quiet ? note : output(ctx, `Economist ${note} → ${written}`);
        }
        if (ctx.model?.api !== 'pi-virtual') manualModel = ctx.model;
        conf.enabled = true;
        const model = ctx.modelRegistry.find('economist', 'auto');
        if (model) await pi.setModel(model);
        await persist({ enabled: true });
        const note = `on · ${live.length} usable candidate${live.length === 1 ? '' : 's'} (tiers ${live.map((c) => c.tier).join(', ')})`;
        if (quiet) return note;
        return output(
          ctx,
          `Economist ${note}` +
            (model ? '' : '\nWarning: the economist/auto virtual model is not registered; run /reload.'),
        );
      };
      const turnOff = async ({ quiet = false } = {}) => {
        conf.enabled = false;
        if (manualModel) await pi.setModel(manualModel);
        ctx.ui.setStatus('economist', undefined);
        await persist({ enabled: false });
        const note = 'off · seu modelo manual está restaurado';
        return quiet ? note : output(ctx, `Economist ${note} · enabled: false salvo.`);
      };
      if (!argv.length) return openMenu(ctx, { conf, locked, setField, turnOn, turnOff, FIELDS });
      if (action === 'on') return turnOn();
      if (action === 'off') return turnOff();
      if (FIELDS[action]) return setField(action, rest[0]);
      if (action === 'setup') {
        const routable = routableModels(ctx);
        if (!routable.length)
          throw Error(
            'Economist setup: no model available in your scope. Authenticate one with /login (or add it in /scoped-models), then run /economist setup again.',
          );
        const proposed = proposeTiers(routable);
        let mode = conf.mode,
          policy = conf.policy;
        if (selectable(ctx)) {
          const chosenMode = await ctx.ui.select(
            `Routing strategy · current: ${conf.mode}`,
            MODE_IDS.filter((m) => m !== 'off'),
          );
          if (!chosenMode) throw Error('Setup cancelled · nothing was written');
          mode = chosenMode;
          const chosenPolicy = await ctx.ui.select(
            `Cost/quality policy · current: ${conf.policy}`,
            POLICY_IDS,
          );
          policy = chosenPolicy ?? conf.policy;
        } else if (ctx.hasUI) {
          output(
            ctx,
            'This client has no selector dialog; keeping the current mode and policy and only writing the candidate pool.',
            'warning',
          );
        }
        if (ctx.hasUI) {
          output(
            ctx,
            [
              `Proposed pool from ${routable.length} scoped model(s), tier 1 = cheapest:`,
              ...proposed.map((c) => `  tier ${c.tier}  ${c.id}`),
              'Tool capability is not published by the registry, so it is assumed on. Correct it with /economist candidates add <model> <tier> --tools off.',
            ].join('\n'),
          );
          if (
            typeof ctx.ui.confirm === 'function' &&
            !(await ctx.ui.confirm(
              'Enable routing with this configuration?',
              `${proposed.length} candidates · mode ${mode} · policy ${policy}`,
            ))
          )
            throw Error('Setup cancelled · nothing was written');
        }
        const written = await persist({ enabled: true, mode, policy, candidates: proposed });
        const model = ctx.modelRegistry.find('economist', 'auto');
        if (model) await pi.setModel(model);
        return output(
          ctx,
          `Economist configured · mode ${mode} · policy ${policy} · ${proposed.length} candidates · routing enabled\n${written}`,
        );
      }
      if (action === 'classifier-model') {
        if (!rest[0]) throw Error('classifier-model PROVIDER/MODEL (autocomplete lists them)');
        return apply({ classifier: { smallLlmCandidates: [rest[0]] } }, `classifier model → ${rest[0]}`);
      }
      if (action === 'candidates') {
        const bare = rest.filter((t) => t !== '--global' && t !== '--tools');
        const [op = 'list', target, tierArg] = bare;
        if (op === 'list') {
          const rows = configuredCandidates(ctx);
          return output(
            ctx,
            rows.length
              ? rows.map((c) => `${c.value.padEnd(46)} ${c.description}`).join('\n')
              : 'No candidates configured.\n/economist setup  (guided)\n/economist candidates add <model> <tier>',
          );
        }
        if (op === 'add') {
          if (!target) throw Error('candidates add PROVIDER/MODEL [tier] [--tools on|off]');
          const toolsAt = rest.indexOf('--tools');
          const tools = toolsAt < 0 ? true : rest[toolsAt + 1] !== 'off';
          const tier = Math.min(5, Math.max(1, Number(tierArg) || 1));
          const next = conf.candidates
            .filter((c) => specId(c) !== target)
            .map((c) => (typeof c === 'string' ? { id: c, tier: 1, tools: false } : { ...c }))
            .concat([{ id: target, tier, tools }]);
          await apply({ candidates: next }, `added ${target} · tier ${tier} · tools ${tools}`);
          if (!routableModels(ctx).some((m) => m.value === target))
            output(
              ctx,
              scopeNotice(target, ctx) ||
                `Note: ${target} is not usable in this registry right now, so it stays unselectable until it is.`,
              'warning',
            );
          return;
        }
        if (op === 'remove') {
          if (!target) throw Error('candidates remove PROVIDER/MODEL');
          const next = conf.candidates.filter((c) => specId(c) !== target);
          if (next.length === conf.candidates.length) throw Error(`${target} is not in the pool`);
          return apply({ candidates: next }, `removed ${target}`);
        }
        throw Error('candidates list|add|remove');
      }
      if (action === 'budget') {
        const value = Number(rest[1]);
        if (rest[0] !== 'task' || !Number.isFinite(value) || value <= 0 || rest[2] !== 'USD')
          throw Error('Usage: /economist budget task 0.50 USD');
        conf.budgetUsd = value;
        if (!scopeOf(ctx).taskId) setTask(pi, `ADHOC-${uid().slice(0, 8)}`);
        await rt.store.append('budgets', {
          id: uid(),
          scope: 'task',
          scopeId: scopeOf(ctx).taskId,
          hardUsd: value,
          softUsd: value * 0.8,
          source: 'economist-command',
          occurredAt: now(),
        });
        return output(
          ctx,
          `task budget ${value} USD (warn at ${Math.round(value * 0.8)}) · task ${scopeOf(ctx).taskId}`,
        );
      }
      if (action === 'simulate') {
        if (!rest.length)
          throw Error('simulate "text" — for example: /economist simulate "add auth to the api"');
        const r = await decide(rest.join(' '), ctx, { simulate: true });
        return output(ctx, r.decision);
      }
      if (action === 'benchmark') {
        const at = rest.indexOf('--dataset');
        if (at < 0) throw Error('benchmark --dataset PATH');
        const data = await readFile(
          await safePath(rt.root, rest[at + 1], { existing: true }),
          'utf8',
        );
        const rows = data
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        if (rows.length > 1000) throw Error('Dataset limit 1000');
        const routes = [];
        for (const row of rows) {
          const r = await decide(row.prompt ?? row.description ?? '', ctx, { simulate: true });
          routes.push({
            taskId: row.taskId ?? row.id,
            model: r.decision.selectedModelId,
            estimated: r.decision.estimatedTotalCostUsd,
            verifiedAccepted: row.verifiedAccepted === true,
            observedCost: row.observedCost ?? null,
            baselineCost: row.baselineCost ?? null,
            baselineVerifiedAccepted: row.baselineVerifiedAccepted ?? null,
          });
        }
        return output(ctx, {
          simulation: true,
          rows: routes,
          measured: benchmark(routes),
          note: 'Offline paired replay of supplied measured records; dataset provenance and acceptance evidence must be reviewed. No new executor billing.',
        });
      }
      if (action === 'explain')
        return output(
          ctx,
          last ??
            `No routing decision yet · ${candidates(ctx).length} usable candidate(s) · mode ${conf.mode}, policy ${conf.policy}\nSend a request, preview free with /economist simulate "text", or configure with /economist setup.`,
        );
      if (action === 'json') return output(ctx, last ?? { message: 'No routing decision yet' });
      if (action === 'help') return output(ctx, usageText('economist', economistSpec));
      throw Error(`Unknown /economist ${action}\n${usageText('economist', economistSpec)}`);
    },
  });
}
