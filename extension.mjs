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
import { defaults, assess, rank, Classifiers, failureClass, tokenEstimate } from './routing.mjs';
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
  const candidates = (ctx) =>
    rt.config.modelEconomist.candidates
      .map((c, i) => {
        const spec = typeof c === 'string' ? { id: c, tier: i + 1, tools: false } : c;
        const model = ctx.modelRegistry
          .getAvailable()
          .find((m) => `${m.provider}/${m.id}` === spec.id);
        return model
          ? {
              ...model,
              tier: spec.tier ?? i + 1,
              tools: spec.tools === true,
              health: spec.health ?? true,
              dataAllowed: spec.dataAllowed !== false,
              local: spec.local === true,
              priorFailureRate: spec.priorFailureRate ?? 0.25,
              latencyMs: spec.latencyMs ?? 1000,
              auth: true,
            }
          : null;
      })
      .filter(Boolean);
  /**
   * Models the user can actually route to right now: real (non-virtual) models in
   * the native registry with authentication configured. Used by completions, the
   * setup wizard, and diagnostics so the human never has to guess an ID.
   */
  const routableModels = () => {
    const reg = rt.ctx?.modelRegistry;
    if (!reg) return [];
    try {
      return reg
        .getAvailable()
        .filter((m) => m.api !== 'pi-virtual' && reg.hasConfiguredAuth?.(m) !== false)
        .map((m) => ({
          value: `${m.provider}/${m.id}`,
          label: `${m.provider}/${m.id}`,
          cost: m.cost?.input != null ? Number(m.cost.input) + Number(m.cost.output ?? 0) : null,
          vision: !!m.input?.includes('image'),
          window: m.contextWindow ?? null,
          description: [
            m.cost?.input != null ? `$${m.cost.input}/M in` : 'price unknown',
            m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : null,
            m.input?.includes('image') ? 'vision' : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }));
    } catch {
      return [];
    }
  };
  const specId = (c) => (typeof c === 'string' ? c : c?.id);
  const economistUnavailable = (conf, ctx) => {
    const configured = conf.candidates.map(specId).filter(Boolean);
    const routable = routableModels();
    const missing = configured.filter((id) => !routable.some((m) => m.value === id));
    const reason = !configured.length
      ? 'no candidates are configured, so there is nothing to route to'
      : missing.length
        ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not authenticated/available in this registry`
        : 'every configured candidate failed a capability, price, or policy filter';
    return (
      `Economist could not select a model: ${reason}. ` +
      (routable.length
        ? `Configure one with /economist candidates add (autocomplete lists ${routable.length} authenticated model${routable.length === 1 ? '' : 's'}), or run /economist setup.`
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
    if (!rankedCandidates.length) throw Error(economistUnavailable(conf, ctx));
    let selected = rankedCandidates[0];
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
      selectedThinkingLevel: ctx.thinkingLevel ?? 'off',
      phase: fast ? 'fast' : 'normal',
      classifierCostUsd: cost,
      estimatedTotalCostUsd: selected.expectedTotalCost,
      durationMs: Date.now() - started,
      reasonCodes: [
        conf.policy,
        conf.mode,
        fast ? 'fast-path' : 'normal-route',
        fallback ? 'classifier-fallback' : 'classified',
      ],
      candidates: rankedCandidates.map((c) => ({
        ...c,
        model: `${c.model.provider}/${c.model.id}`,
      })),
      rejected: ranked.rejected,
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
      ctx.ui.setStatus('economist', `${selected.model.id} · ${decision.phase}`);
    }
    return { decision, model: selected.model };
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
    thinkingLevels: ['off', 'low', 'medium', 'high'],
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
          candidates(ctx).find((m) => `${m.provider}/${m.id}` === conf.fallbackModel);
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
        signal: request.signal,
      });
      if (escalate) {
        failedTasks.delete(taskKey);
        await rt.emit('model.escalated', { decisionId: result.decision.id });
      }
      return {
        model: result.model,
        thinkingLevel: request.thinkingLevel,
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
  /** RPC and print clients may expose fewer dialogs than the TUI; never assume. */
  const selectable = (ctx) => ctx.hasUI && typeof ctx.ui.select === 'function';
  /** Configured pool, annotated with what the registry can actually route to. */
  const configuredCandidates = () =>
    rt.config.modelEconomist.candidates.map((c, i) => {
      const id = specId(c) ?? String(c);
      const tier = typeof c === 'object' && c ? (c.tier ?? i + 1) : i + 1;
      const tools = typeof c === 'object' && c ? c.tools === true : false;
      const live = routableModels().some((m) => m.value === id);
      return {
        value: id,
        label: id,
        description:
          `tier ${tier}${tools ? ' · tools' : ' · no tools'}${live ? '' : ' · not authenticated'}`,
      };
    });
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
        args: [{ provide: async () => routableModels(), hint: 'provider/model' }],
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
                ? routableModels()
                : configuredCandidates(),
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
    const tiers = Math.min(4, Math.max(1, Math.ceil(sorted.length / 2)));
    const step = Math.max(1, sorted.length);
    return sorted
      .map((m, i) => ({
        id: m.value,
        tier: Math.min(tiers, 1 + Math.floor((i * tiers) / step)),
        tools: true,
      }))
      .concat(unpriced.map((m) => ({ id: m.value, tier: Math.min(5, tiers + 1), tools: true })));
  };
  pi.registerCommand('economist', {
    description:
      'Model routing — on | off | setup | mode | policy | classifier | candidates | budget | simulate | explain | help',
    getArgumentCompletions: buildCompletions(economistSpec),
    handler: async (args, ctx) => {
      await init(ctx);
      const [action = 'help', ...rest] = words(args);
      const conf = rt.config.modelEconomist;
      const locked = rt.config.locked?.modelEconomist ?? {};
      const lockedField = {
        on: 'enabled',
        off: 'enabled',
        mode: 'mode',
        classifier: 'classifier',
        policy: 'policy',
        budget: 'budgetUsd',
        'classifier-model': 'classifier',
        setup: 'candidates',
      }[action];
      if (lockedField && Object.hasOwn(locked, lockedField))
        throw Error(
          `economist.${lockedField} is locked by global policy and cannot be changed from a command.`,
        );
      const useGlobal = rest.includes('--global');
      const persist = (patch) => rt.save('modelEconomist', patch, { global: useGlobal });
      const apply = async (patch, note) => {
        const written = await persist(patch);
        output(
          ctx,
          `${note}\nsaved ${JSON.stringify(patch)} → ${written}\nRun /reload if a change does not take effect.`,
        );
      };
      if (action === 'on') {
        const live = candidates(ctx);
        if (!live.length) {
          const routable = routableModels();
          // Never overwrite an explicit pool the user wrote; only bootstrap an empty one.
          const approved =
            !conf.candidates.length && ctx.hasUI && routable.length
              ? typeof ctx.ui.confirm === 'function'
                ? await ctx.ui.confirm(
                    'No routing candidates configured',
                    `Economist has nothing to route to, but ${routable.length} authenticated model${routable.length === 1 ? '' : 's'} ${routable.length === 1 ? 'is' : 'are'} available. Configure them now?`,
                  )
                : false
              : false;
          if (!approved) throw Error(economistUnavailable(conf, ctx));
          const proposed = proposeTiers(routable);
          const written = await persist({ enabled: true, candidates: proposed });
          if (ctx.model?.api !== 'pi-virtual') manualModel = ctx.model;
          const model = ctx.modelRegistry.find('economist', 'auto');
          if (model) await pi.setModel(model);
          return output(
            ctx,
            `Economist on · ${proposed.length} candidates ordered by price → ${written}\nRefine with /economist candidates, /economist policy, /economist mode.`,
          );
        }
        if (ctx.model?.api !== 'pi-virtual') manualModel = ctx.model;
        conf.enabled = true;
        const model = ctx.modelRegistry.find('economist', 'auto');
        if (model) await pi.setModel(model);
        await persist({ enabled: true });
        return output(
          ctx,
          `Economist on · ${live.length} usable candidate${live.length === 1 ? '' : 's'} (tiers ${live.map((c) => c.tier).join(', ')})` +
            (model ? '' : '\nWarning: the economist/auto virtual model is not registered; run /reload.'),
        );
      }
      if (action === 'off') {
        conf.enabled = false;
        if (manualModel) await pi.setModel(manualModel);
        ctx.ui.setStatus('economist', undefined);
        await persist({ enabled: false });
        return output(ctx, 'Economist off · your manual model is restored · enabled: false saved.');
      }
      if (action === 'setup') {
        const routable = routableModels();
        if (!routable.length)
          throw Error(
            'Economist setup: no authenticated model available. Authenticate one with /login, then run /economist setup again.',
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
              `Proposed pool from ${routable.length} authenticated model(s), tier 1 = cheapest:`,
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
      if (action === 'mode') {
        if (!MODE_IDS.includes(rest[0]))
          throw Error(`Invalid mode. Use: ${MODE_IDS.join(' | ')}`);
        return apply({ mode: rest[0] }, `mode → ${rest[0]}`);
      }
      if (action === 'policy') {
        if (!POLICY_IDS.includes(rest[0]))
          throw Error(`Invalid policy. Use: ${POLICY_IDS.join(' | ')}`);
        return apply({ policy: rest[0] }, `policy → ${rest[0]}`);
      }
      if (action === 'classifier') {
        if (!['on', 'off'].includes(rest[0])) throw Error('classifier on|off');
        return apply({ classifier: { enabled: rest[0] === 'on' } }, `classifier → ${rest[0]}`);
      }
      if (action === 'classifier-model') {
        if (!rest[0]) throw Error('classifier-model PROVIDER/MODEL (autocomplete lists them)');
        return apply({ classifier: { smallLlmCandidates: [rest[0]] } }, `classifier model → ${rest[0]}`);
      }
      if (action === 'candidates') {
        const bare = rest.filter((t) => t !== '--global' && t !== '--tools');
        const [op = 'list', target, tierArg] = bare;
        if (op === 'list') {
          const rows = configuredCandidates();
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
          if (!routableModels().some((m) => m.value === target))
            output(
              ctx,
              `Note: ${target} is not authenticated/available in the registry right now, so it stays unselectable until it is.`,
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
