import {
  createRuntime,
  merge,
  output,
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
    if (!rankedCandidates.length)
      throw Error(
        'Economist: no eligible authenticated/capable model within policy. Configure candidates with explicit tier/tools.',
      );
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
  pi.registerCommand('economist', {
    description:
      'Model routing: explain | simulate | mode | classifier | policy | budget | benchmark | on/off',
    handler: async (args, ctx) => {
      await init(ctx);
      const [action = 'explain', ...rest] = words(args);
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
      }[action];
      if (lockedField && Object.hasOwn(locked, lockedField))
        throw Error('This economist setting is locked by global policy');
      if (action === 'on') {
        if (ctx.model?.api !== 'pi-virtual') manualModel = ctx.model;
        conf.enabled = true;
        const model = ctx.modelRegistry.find('economist', 'auto');
        if (model) await pi.setModel(model);
      } else if (action === 'off') {
        conf.enabled = false;
        if (manualModel) await pi.setModel(manualModel);
        ctx.ui.setStatus('economist', undefined);
      } else if (action === 'mode') {
        if (!['off', 'manual', 'rules', 'jev', 'small-llm', 'hybrid', 'learned'].includes(rest[0]))
          throw Error('Invalid mode');
        conf.mode = rest[0];
      } else if (action === 'classifier') {
        if (!['on', 'off'].includes(rest[0])) throw Error('Expected on/off');
        conf.classifier.enabled = rest[0] === 'on';
      } else if (action === 'classifier-model') {
        conf.classifier.smallLlmCandidates = [rest[0]];
      } else if (action === 'policy') {
        if (!['economy', 'balanced', 'quality', 'latency'].includes(rest[0]))
          throw Error('Invalid policy');
        conf.policy = rest[0];
      } else if (action === 'budget') {
        const value = Number(rest[1]);
        if (rest[0] !== 'task' || !Number.isFinite(value) || value <= 0 || rest[2] !== 'USD')
          throw Error('Usage: budget task N USD');
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
      } else if (action === 'simulate') {
        const r = await decide(rest.join(' '), ctx, { simulate: true });
        return output(ctx, r.decision);
      } else if (action === 'benchmark') {
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
      } else if (action === 'explain')
        return output(ctx, last ?? { message: 'No routing decision yet', mode: conf.mode });
      else throw Error('Unknown /economist command');
      await rt.emit('model.configuration_changed', { action, value: rest[0] ?? null });
      output(ctx, {
        enabled: conf.enabled,
        mode: conf.mode,
        policy: conf.policy,
        classifier: conf.classifier.enabled,
      });
    },
  });
}
