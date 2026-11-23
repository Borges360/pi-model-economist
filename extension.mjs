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
  yamlFile,
  now,
  redact,
} from './lib/core.mjs';
import {
  defaults,
  assess,
  modelRoleOf,
  MODEL_ROLES,
  relabel,
  Classifiers,
  failureClass,
  tokenEstimate,
  requiredTier,
  supportedLevels,
  levelRank,
  risks as RISK_CATEGORIES,
  levels as THINKING_LEVELS,
} from './routing.mjs';
import {
  rankActions,
  selectAction,
  fastSet,
  labelAlternatives,
  shouldClassify,
  actionUtility,
  explore,
  constrainRoleExploration,
  prepareOutcomes,
  recordVerifiedOutcome,
  preferencePairs,
  bradleyTerry,
  calibrationReport,
  reasoningProfile,
  scanMessages,
  buildRoutingState,
  checkpoints,
  validateFeasibility,
  fixHint,
  telemetryView,
  tokenProfile,
  requiredWindow,
  predictSafety,
  actionId,
  modelVersion,
  familyOf,
} from './decision.mjs';
import {
  explainLines,
  shortName,
  provideHost,
  runOperation,
  host,
  missingHostExports,
  economistFields,
  poolFields,
  poolValues,
  panelValues,
  PANEL_COMMANDS,
  setDraftValue,
  restoreDraft,
  openTextView,
  openPiSettings,
  SettingsSession,
  simulationScreen,
} from './menu.mjs';
import {
  candidateDescription,
  localeName,
  loadProjectLocale,
  localizedHelpLines,
  normalizeLocale,
  translate,
} from './lib/i18n.mjs';
import { readFile } from 'node:fs/promises';
import { benchmark, benchmarkMatrix } from './benchmark.mjs';
import { ContextEconomics, registerEconomicsTools } from './context/runtime.mjs';
import { PRESETS, CONTROLS, STAGES, presetPatch, migrationPreview } from './lib/v2-config.mjs';
import { switchDecision, contextualBandit, costCascade } from './routing/adaptive.mjs';
import { evaluateOffline, readMatrix } from './learning/offline.mjs';
import { economicsLines, economicsHeader } from './lib/v2-ui.mjs';
import { remainingBudgets } from './economics/operations.mjs';
/** What a parent may tell the router about a child; nothing here is free text that leaves the machine. */
const ENVELOPE_SCHEMA = {
  type: 'object',
  properties: {
    environment: { type: 'string', enum: ['production', 'staging', 'development', 'unknown'] },
    risks: { type: 'array', items: { type: 'string' } },
    capabilities: {
      type: 'object',
      properties: { tools: { type: 'boolean' }, image: { type: 'boolean' }, fileWrite: { type: 'boolean' } },
      additionalProperties: false,
    },
    artifacts: {
      type: 'object',
      properties: { repo: { type: 'boolean' }, filesTouched: { type: 'number' } },
      additionalProperties: false,
    },
    parentPhase: { type: 'string', enum: ['planning', 'implementation', 'repair', 'recovery', 'unknown'] },
    availableTools: { type: 'array', items: { type: 'string' } },
    privacy: { type: 'string', enum: ['deny', 'redact', 'allow'] },
  },
  additionalProperties: false,
};
export function sanitizeEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = ENVELOPE_SCHEMA.properties;
  const pick = (v, list) => (list.includes(v) ? v : undefined);
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 64) : undefined);
  const caps = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  const env = {
    environment: pick(raw.environment, p.environment.enum),
    risks: strings(raw.risks)?.filter((r) => RISK_CATEGORIES.includes(r)),
    capabilities: {
      tools: caps.tools === true,
      image: caps.image === true,
      fileWrite: caps.fileWrite === true,
    },
    artifacts: {
      repo: raw.artifacts?.repo === true,
      filesTouched: Number.isFinite(raw.artifacts?.filesTouched) ? Math.max(0, raw.artifacts.filesTouched) : 0,
    },
    parentPhase: pick(raw.parentPhase, p.parentPhase.enum),
    availableTools: strings(raw.availableTools),
    privacy: pick(raw.privacy, p.privacy.enum),
  };
  return env;
}
export default function economist(pi, injected = {}) {
  // The entry point hands us the host modules it imported statically; without this the
  // dashboard would have to resolve them lazily and silently degrade (see index.ts).
  provideHost(injected.tui, injected.agent);
  const rt = createRuntime(pi, 'economist', defaults),
    classifiers = new Classifiers();
  const economics = new ContextEconomics(pi, rt, injected);
  let last = null,
    manualModel = null,
    footerTui = null;
  const failedTasks = new Set();
  const init = async (ctx) => {
    economics.beforeInit(ctx);
    await rt.init(ctx);
    await economics.init(ctx);
    const env = process.env.PI_ECONOMIST_MODELS;
    if (env && !rt.config.modelEconomist.candidates.length)
      rt.config.modelEconomist.candidates = env
        .split(',')
        .map((id, i) => ({ id, tier: i + 1, tools: true }));
  };
  const modelKey = (m) => `${m.provider}/${m.id}`;
  /** Tool names the host exposes, as plain strings; descriptions never enter the state. */
  const availableToolNames = () => {
    try {
      return (pi.getActiveTools?.() ?? [])
        .map((t) => (typeof t === 'string' ? t : t?.name))
        .filter((t) => typeof t === 'string');
    } catch {
      return [];
    }
  };
  /**
   * What `/scoped-models` resolved for this session. pi exposes it as
   * `ctx.scopedModels` (from `enabledModels` / `--models`) and leaves it empty when
   * nothing is scoped, which means "everything available is usable", so the pool
   * falls back to the authenticated catalogue in that case.
   */
  const poolScope = (ctx, conf = rt.config.modelEconomist) => {
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
      strict: active, // scoped means scoped: do not silently admit out-of-scope candidates
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
    // Prompt and subagent re-read /scoped-models on every decision. Membership is
    // Pi's list; a saved tier or tools flag only annotates a model that is still
    // in that list. Session keeps the saved pool until the user changes /model.
    const specs = membershipSpecs(ctx, scope);
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
  const routableModels = (ctx, modelEconomist = rt.config.modelEconomist) => {
    const scope = poolScope(ctx ?? rt.ctx, modelEconomist);
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
  const economistUnavailable = (conf, ctx, modelEconomist = rt.config.modelEconomist) => {
    const scope = poolScope(ctx ?? rt.ctx, modelEconomist);
    const configured = conf.candidates.map(specId).filter(Boolean);
    const routable = routableModels(ctx, modelEconomist);
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
      imageBlocks = [],
      scan = scanMessages([]),
      routingState = null,
      priorRisks = [],
      previousGateFailure = false,
      checkpoint = [],
      feasibility = null,
      envelope = null,
      qualityFloorOverride = null,
      exclude = new Set(),
      excludeModels = new Set(),
      restrictModels = null,
      forceEffort = null,
      forceCapabilities = {},
      extraReasonCodes = [],
    } = {},
  ) => {
    await init(ctx);
    const conf = rt.config.modelEconomist;
    const objectives = conf.objectives ?? defaults.modelEconomist.objectives;
    const started = Date.now();
    const reasonCodes = [...extraReasonCodes];
    if (
      qualityFloorOverride != null &&
      !(Number.isFinite(qualityFloorOverride) && qualityFloorOverride > 0 && qualityFloorOverride <= 1)
    )
      throw Error('qualityFloorOverride must be a number in (0, 1]');
    const scope = scopeOf(ctx);
    const calls = await rt.store.rows('model-calls');
    const budget = remainingBudgets(conf, calls, economics.operations.rows, scope);
    if (!simulate && budget.remainingUsd === null) throw Error('Economist budget cannot be verified because a previous operation cost is unknown');
    const remaining = budget.remainingUsd ?? Infinity;
    if (!simulate && remaining <= 0)
      throw Error('Economist task budget exceeded before classification');
    const describerMode = conf.classifier.imageDescriber?.mode ?? 'off';
    const effectivePolicy =
      envelope?.privacy === 'deny' ? 'deny' : (conf.classifier.dataPolicy ?? 'redact');
    let caption = null;
    if (images && describerMode !== 'off') {
      const remoteAllowed = conf.classifier.allowRemote === true && effectivePolicy === 'allow';
      if (describerMode === 'authorized-remote' && (!remoteAllowed || simulate)) {
        if (!remoteAllowed) {
          reasonCodes.push('image-describer-blocked');
          if (!simulate) await rt.emit('model.image_describer_blocked', { mode: describerMode });
        }
      } else if (typeof injected.describeImage === 'function' && imageBlocks.length) {
        try {
          const block = imageBlocks[0];
          const described = await injected.describeImage(block?.data ?? block, { mode: describerMode, signal });
          caption = typeof described === 'string' && described.trim() ? redact(described).slice(0, 2000) : null;
        } catch {
          reasonCodes.push('image-describer-failed');
        }
      }
    }
    let a = assess(text, {
      images,
      contextTokens,
      caption,
      observationText: scan.last?.text ?? null,
      previousRisks: priorRisks,
      inheritedRisks: envelope?.risks ?? [],
      toolRounds: scan.toolRounds,
      verifierSeen: scan.verifierSeen,
      recentToolFailure: Boolean(scan.last?.failed),
      previousGateFailure,
      capabilities: envelope?.capabilities ?? {},
    });
    if (!routingState)
      routingState = buildRoutingState({ messages: [] }, null, {
        assessment: a,
        scan,
        availableTools: availableToolNames(),
        workspace: Boolean(ctx.cwd),
        envelope,
      });
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
    if (forceDifficulty) a = relabel(a, { difficulty: forceDifficulty, tools: true });
    if (forceCapabilities.tools) a = relabel(a, { tools: true });
    if (forceCapabilities.image) a = relabel(a, { image: true });
    const outcomes = prepareOutcomes(await rt.store.rows('outcomes'));
    const sessionCalls = calls.filter((c) => c.sessionId === scope.sessionId);
    const previousModel = previous
      ? (pool.find((m) => modelKey(m) === previous) ??
        physicalModels(ctx).find((m) => modelKey(m) === previous) ??
        null)
      : null;
    const pairs = conf.learned?.preference ? preferencePairs(outcomes) : [];
    const preference =
      conf.learned?.preference && pairs.length >= (conf.learned.preferencePairs ?? 20)
        ? bradleyTerry(pairs)
        : null;
    const calibration = conf.stats?.applyCalibration ? await calibrationFor() : null;
    const classifierCalibration = conf.stats?.applyCalibration
      ? await calibrationFor('classifierConfidence')
      : null;
    const tokenizer = ctx.modelRegistry?.countTokens;
    let inputTokensByModel = null;
    if (!contextTokens) {
      inputTokensByModel = new Map();
      if (typeof tokenizer === 'function')
        for (const m of [...pool]
          .sort((x, y) => (tokenEstimate(x) ?? Infinity) - (tokenEstimate(y) ?? Infinity))
          .slice(0, 8)) {
          try {
            const counted = await tokenizer.call(ctx.modelRegistry, m, text);
            if (Number.isFinite(counted) && counted > 0)
              inputTokensByModel.set(modelKey(m), Math.max(counted, 0));
          } catch {
            // A failing tokenizer keeps the /4 estimate and says so in the flags.
          }
        }
    }
    const minRiskTier = Math.max(conf.minRiskTier, forceTier ?? 0);
    const rconf = { ...conf, minRiskTier };
    const env = {
      economics: await economics.active(ctx) ? {
        ledger: economics.ledger, scopeKey: m => economics.scopeFor(m), plan: economics.plan, recoveryCosts: m => economics.recoveryCosts(m),
        cacheEnabled: conf.cache.enabled,
      } : null,
      outcomes,
      calls,
      sessionCalls,
      previousModel,
      selectedLevel,
      exclude,
      excludeModels,
      restrictModels,
      forceEffort,
      remainingBudget: remaining,
      executorPolicy: conf.executor?.dataPolicy ?? 'allow',
      embed: typeof injected.embed === 'function' ? injected.embed : null,
      preference,
      calibration,
      inputTokensByModel,
    };
    const floorOf = (assessment) =>
      qualityFloorOverride ?? objectives.qualityFloor?.[assessment.difficulty] ?? 0.7;
    const selectOptions = (assessment) => ({
      policy: conf.policy,
      floor: floorOf(assessment),
      safetyThreshold: objectives.safetyThreshold ?? 0.9,
      remainingBudget: remaining,
      objectives,
      preferredModel: conf.rolePreferences?.[modelRoleOf(assessment)]?.model ?? null,
      preferredEffort: (conf.thinking?.mode ?? 'auto') === 'auto'
        ? conf.rolePreferences?.[modelRoleOf(assessment)]?.effort ?? null
        : null,
      allowPreferenceFallback: conf.rolePreferences?.[modelRoleOf(assessment)]?.allowFallback === true,
    });
    const evaluate = (assessment, overhead) => {
      const ranked = rankActions(pool, assessment, rconf, { ...env, classifierCost: overhead });
      return { ranked, sel: selectAction(ranked.accepted, selectOptions(assessment)) };
    };
    const ev0 = evaluate(a, 0);
    let ev = ev0,
      cost = 0,
      fallback = null,
      classifier = null;
    const classifierPolicy =
      envelope?.privacy === 'deny' ? 'deny' : (conf.classifier.dataPolicy ?? 'redact');
    if (!simulate && allowClassification && !['rules', 'off', 'manual'].includes(conf.mode)) {
      const engine = ['jev', 'small-llm'].includes(conf.mode) ? conf.mode : conf.classifier.engine;
      const classifierConf = {
        ...conf.classifier,
        maxCostUsdPerDecision: Math.min(conf.classifier.maxCostUsdPerDecision, remaining),
      };
      let call = true,
        voi = null;
      if (['hybrid', 'learned'].includes(conf.mode)) {
        const quote = await classifiers.quote(ctx, classifierConf, {
          engine,
          signal,
          inputChars: Math.min(text.length, conf.classifier.maxInputChars),
        });
        if (quote.fallback) {
          call = false;
          fallback = quote.fallback;
        } else {
          voi = valueOfInformation(a, ev0, quote.estimate, evaluate, conf, objectives);
          call = voi.call;
          if (!call) reasonCodes.push('classifier-skipped-no-voi');
        }
      }
      const without = ev0.sel.selected?.id ?? null;
      if (call) {
        const result = await classifiers.run(text, a, ctx, classifierConf, {
          signal,
          engine,
          state: routingState ? { ...routingState } : null,
          dataPolicy: classifierPolicy,
          calibrate: classifierCalibration ? (c) => classifierCalibration.lookup(c) : null,
          emit: (k, p) => rt.emit(k, p),
        });
        if (!result.fallback) a = result.assessment;
        cost = result.cost;
        fallback = result.fallback;
        ev = evaluate(a, cost);
        const withIt = ev.sel.selected?.id ?? null;
        classifier = {
          classifierConsidered: true,
          classifierCalled: true,
          classifierEngine: result.engine ?? engine,
          classifierConfidence: result.confidence ?? null,
          classifierChangedRoute: without !== withIt,
          classifierCost: cost,
          classifierLatencyMs: result.latencyMs ?? null,
          routeWithoutClassifier: without,
          routeWithClassifier: withIt,
          classifierVoi: voi?.reasons ?? null,
          classifierWasCorrect: null,
          classifierRoiUsd: null,
        };
      } else
        classifier = {
          classifierConsidered: true,
          classifierCalled: false,
          classifierConfidence: null,
          classifierChangedRoute: false,
          classifierCost: 0,
          classifierLatencyMs: null,
          routeWithoutClassifier: without,
          routeWithClassifier: null,
          classifierVoi: voi?.reasons ?? null,
          classifierSkipped: voi?.reason ?? fallback,
          classifierWasCorrect: null,
          classifierRoiUsd: null,
        };
    }
    if (fallback) await rt.emit('model.classifier_fallback', { reason: fallback });
    const floor = floorOf(a);
    let sel = ev.sel;
    let fast = null;
    const fastBlocked =
      a.risks.length > 0 ||
      a.semanticRiskActive ||
      a.contextRisk ||
      a.imageUninspected ||
      a.features.context.recentToolFailure ||
      a.features.context.previousGateFailure ||
      Boolean(selectOptions(a).preferredModel) ||
      checkpoint.length > 0 ||
      Boolean(forceDifficulty);
    if (conf.fastPath.enabled && !fastBlocked) {
      fast = fastSet(ev.ranked.accepted, {
        floor,
        margin: conf.fastPath.successMargin ?? 0.05,
        executionModels: conf.fastPath.executionModels ?? [],
      });
      const fastSel = fast ? selectAction(fast.set, selectOptions(a)) : null;
      if (!fastSel?.selected) fast = null;
      else {
        if (cost > 0) {
          const outside = selectAction(
            ev.ranked.accepted.filter((x) => !fast.set.includes(x)),
            selectOptions(a),
          ).selected;
          const gap = (outside?.policyCostUsd ?? Infinity) - fastSel.selected.policyCostUsd;
          if (cost > gap) {
            fast = null;
            reasonCodes.push('fast-path-not-worth-classifier');
          }
        }
        if (fast) sel = fastSel;
      }
    }
    if (!sel.selected) {
      if (sel.rolePreferenceResult === 'unavailable') {
        const role = modelRoleOf(a);
        const preference = conf.rolePreferences?.[role] ?? {};
        const details = [
          preference.model ? `modelo ${preference.model}` : null,
          preference.effort && (conf.thinking?.mode ?? 'auto') === 'auto' ? `esforço ${preference.effort}` : null,
        ].filter(Boolean).join(' e ');
        throw Error(
          `Economist: a preferência de ${role}${details ? ` (${details})` : ''} não está disponível ou não atende aos limites desta chamada. ` +
            `Ajuste-a ou habilite fallback com /economist role ${role} fallback on.`,
        );
      }
      const rejectedAll = ev.ranked.rejected;
      if (
        !ev.ranked.accepted.length &&
        rejectedAll.length &&
        rejectedAll.every((r) => r.reasonCodes.includes('context'))
      ) {
        const error = Error(
          'Economist: nenhum modelo do pool comporta a janela exigida por este pedido. Compacte o contexto com /compact ou adicione um modelo de janela maior.',
        );
        error.code = 'context-overflow';
        throw error;
      }
      const needed = requiredTier(a, rconf);
      const tiers = [...new Set(pool.map((m) => m.tier))].sort((x, y) => x - y);
      const error = Error(
        `${economistUnavailable(conf, ctx)}\n` +
          `Esta tarefa (${a.kind}/${a.difficulty}${a.risks.length ? `, risco ${a.risks.join('+')}` : ''}) exige tier ≥ ${needed} e pSuccess ≥ ${floor.toFixed(2)} (quality-floor-unmet);` +
          ` o pool tem tiers ${tiers.join(', ') || 'nenhum'}${ev.ranked.guard ? ' e ações sem raciocínio foram recusadas' : ''}.` +
          ` Conserte com /economist candidates add <modelo> ${needed} (ou eleve o tier) e revise /economist scope.`,
      );
      error.code = 'quality-floor-unmet';
      throw error;
    }
    const greedy = sel.selected;
    const exploredKey = `${scope.sessionId}/${greedy.family}`;
    const alreadyExplored = (await rt.store.rows('exploration')).some((r) => r.id === exploredKey);
    const lockRoleModel = sel.rolePreferenceResult === 'preferred';
    const lockRoleEffort = sel.roleEffortResult === 'preferred';
    const explorationActions = constrainRoleExploration(sel.ranked, greedy, {
      modelPreferred: lockRoleModel,
      effortPreferred: lockRoleEffort,
    });
    const bandit = conf.adaptive.bandit === 'off' ? { shadowChoice: null, exploreChoice: null } : explore(explorationActions, greedy, {
      policy: conf.policy,
      objectives,
      kappa: conf.learned?.kappa ?? 0.15,
      hardRisk: a.risks.length > 0,
      remainingBudget: remaining,
      maxPremium: conf.maxExplorationPremium ?? 0.1,
      alreadyExplored,
    });
    let selected = greedy;
    if (
      conf.preset === 'custom' && conf.learned?.deployment === 'active' &&
      bandit.shadowChoice &&
      bandit.shadowChoice.id !== greedy.id
    ) {
      if (
        simulate ||
        (await rt.store.append('exploration', {
          id: exploredKey,
          family: greedy.family,
          modelId: bandit.shadowChoice.id,
          occurredAt: now(),
        }))
      ) {
        selected = bandit.shadowChoice;
        reasonCodes.push('explored');
      }
    }
    const activeEconomics = !simulate && await economics.active(ctx);
    const floorActions = sel.ranked.filter(x => x.pSuccess >= floor && (x.pSafe === null || x.pSafe >= (objectives.safetyThreshold ?? 0.9)));
    let adaptiveBandit = conf.adaptive.bandit !== 'off' && conf.rollout.stage !== 'observe'
      ? contextualBandit(explorationActions, { ...selected, qualityFloor: floor, safetyThreshold: objectives.safetyThreshold }, outcomes,
        { ...conf.adaptive, family: greedy.family, hardRisk: a.risks.length > 0, maxPremium: conf.maxExplorationPremium }) : null;
    let switchPlan = null;
    if (activeEconomics) {
      if (conf.adaptive.algorithm === 'cascade' && !lockRoleModel && !lockRoleEffort)
        selected = costCascade(floorActions, { floor, safetyThreshold: objectives.safetyThreshold }) ?? selected;
      if (conf.adaptive.algorithm === 'bandit' && conf.adaptive.bandit === 'active' && adaptiveBandit?.eligible && (await economics.proof())?.eligible)
        selected = adaptiveBandit.choice;
      switchPlan = switchDecision(floorActions, selected, { currentId: last ? actionId(last.selectedModelId, last.selectedThinkingLevel) : null,
        turnsSinceSwitch: economics.turn - economics.lastSwitchTurn, hardRisk: a.risks.length > 0 || reason === 'retry' || checkpoint.length > 0,
        preferred: lockRoleModel || lockRoleEffort || conf.policy === 'quality', config: conf.routing.switch });
      selected = switchPlan.selected;
      reasonCodes.push(switchPlan.reason);
    }
    const effortSource = forceEffort
      ? 'retry'
      : (conf.thinking?.mode ?? 'auto') === 'follow'
        ? 'follow'
        : conf.thinking?.mode === 'fixed'
          ? 'fixed'
          : selected.model.scopedLevel
            ? 'ace'
            : selectOptions(a).preferredEffort && selected.effort === selectOptions(a).preferredEffort
              ? 'role-preference'
              : 'policy';
    const state = routingState
      ? { ...routingState, contextPressure: selected.contextPressure }
      : null;
    const features = { ...a.features, context: { ...a.features.context, pressure: selected.contextPressure ?? 0 } };
    const serial = (c) => ({
      model: c.modelId,
      thinkingLevel: c.effort,
      tier: c.tier,
      pSuccess: c.pSuccess,
      pSafe: c.pSafe,
      uncertainty: c.uncertainty,
      predictedCostUsd: c.predictedCostUsd,
      policyCostUsd: c.policyCostUsd,
      latencyP50Ms: c.latency.p50Ms,
      latencyP95Ms: c.latency.p95Ms,
      requiredWindow: c.requiredWindow,
      samples: c.samples,
      flags: c.flags,
    });
    const ordered = [...sel.ranked, ...ev.ranked.accepted.filter((c) => !sel.ranked.includes(c))];
    const decision = {
      id: uid(),
      reason,
      assessment: a,
      features,
      routingState: state,
      selectedModelId: selected.modelId,
      selectedThinkingLevel: selected.effort,
      effortSource,
      role: modelRoleOf(a),
      rolePreferenceResult: sel.rolePreferenceResult ?? 'automatic',
      roleEffortResult: sel.roleEffortResult ?? 'automatic',
      phase: fast ? 'fast' : 'normal',
      action: { model: selected.modelId, effort: selected.effort, version: selected.version, family: selected.family },
      pSuccess: selected.pSuccess,
      pSafe: selected.pSafe,
      predictedCostUsd: selected.predictedCostUsd,
      latencyP50Ms: selected.latency.p50Ms,
      latencyP95Ms: selected.latency.p95Ms,
      latencySource: selected.latencySource,
      expectedRetries: selected.expectedRetries,
      expectedRecoveryCostUsd: selected.expectedRecoveryCostUsd,
      recoveryBreakdown: selected.recoveryBreakdown ?? null,
      expectedSuccess: selected.expectedSuccessDistribution,
      expectedCost: selected.expectedCostDistribution,
      expectedLatency: selected.expectedLatencyDistribution,
      recoverySource: selected.recoverySource,
      expectedCacheSavingsUsd: selected.expectedCacheSavingsUsd,
      expectedCacheLossUsd: selected.expectedCacheLossUsd,
      expectedTtftDeltaMs: selected.expectedTtftDeltaMs,
      uncertainty: selected.uncertainty,
      qualityFloor: floor,
      policyResult: sel.policyResult,
      role: modelRoleOf(a),
      classifierCostUsd: cost,
      classifierDataPolicy: classifierPolicy,
      estimatedTotalCostUsd: selected.policyCostUsd,
      checkpoint: checkpoint.length ? checkpoint : null,
      feasibility,
      flags: selected.flags,
      ...(caption ? { caption } : {}),
      finalOutcome: null,
      ...(classifier ?? {
        classifierConsidered: false,
        classifierConfidence: null,
        classifierChangedRoute: false,
        classifierCost: 0,
        classifierLatencyMs: null,
        routeWithoutClassifier: null,
        routeWithClassifier: null,
        classifierWasCorrect: null,
        classifierRoiUsd: null,
      }),
      shadowChoice: bandit.shadowChoice?.id ?? null,
      exploreChoice: bandit.exploreChoice?.id ?? null,
      productionChoice: greedy.id,
      explorationRegret: null,
      reasoningProfile: reasoningProfile(selected.model, calls, outcomes),
      durationMs: Date.now() - started,
      reasonCodes: [
        ...new Set([
          conf.policy,
          conf.mode,
          fast ? 'fast-path' : 'normal-route',
          fallback
            ? 'classifier-fallback'
            : classifier?.classifierCalled
              ? 'classified'
              : 'rules-assessment',
          `effort:${selected.effort}`,
          `role:${modelRoleOf(a)}`,
          ...(sel.rolePreferenceResult && sel.rolePreferenceResult !== 'automatic'
            ? [`role-preference:${sel.rolePreferenceResult}`]
            : []),
          ...(sel.roleEffortResult && sel.roleEffortResult !== 'automatic'
            ? [`role-effort:${sel.roleEffortResult}`]
            : []),
          ...(ev.ranked.guard && selected.pSafe === null ? ['reasoning-required'] : []),
          ...(poolScope(ctx).active ? [`scope:${conf.scope?.source ?? 'scoped'}`] : []),
          ...(sel.policyResult !== 'selected' ? [sel.policyResult] : []),
          ...reasonCodes,
          ...selected.flags,
        ]),
      ],
      candidates: ordered.map(serial),
      rejected: [...ev.ranked.rejected, ...scopeRejections(ctx)],
      simulation: simulate,
      economicsVersion: 2,
      preset: conf.preset,
      contextPlan: economics.plan,
      cacheImpact: selected.cacheForecast ? { ...selected.cacheForecast.prediction, coldFallback: selected.cacheForecast.coldFallback } : null,
      costBreakdown: selected.costBreakdown ?? null,
      switchPlan: switchPlan ? { ...switchPlan, selected: switchPlan.selected.id } : null,
      bandit: adaptiveBandit ? { shadowChoice: adaptiveBandit.shadowChoice, eligible: adaptiveBandit.eligible, samples: adaptiveBandit.samples, propensity: adaptiveBandit.propensity } : null,
    };
    if (!simulate) {
      if (last?.selectedModelId !== selected.modelId) economics.lastSwitchTurn = economics.turn;
      economics.lastPhysical = selected.model;
      economics.route = { id: decision.id, selectedModelId: selected.modelId, pSuccess: selected.pSuccess,
        selectedThinkingLevel: selected.effort, estimatedTotalCostUsd: selected.policyCostUsd,
        recoveryActionCostUsd: selected.pSuccess < 1 && selected.expectedRecoveryCostUsd != null
          ? selected.expectedRecoveryCostUsd / (1 - selected.pSuccess) : selected.baseCostUsd };
      economics.observer.routes.push({ id: decision.id, fallback: Boolean(fallback), qualityViolation: selected.pSuccess < floor,
        safetyViolation: selected.pSafe != null && selected.pSafe < (objectives.safetyThreshold ?? 0.9) });
      await economics.emit('route.considered', { model: selected.modelId, count: ordered.length, routeId: decision.id, taskFamily: selected.family });
      await economics.emit('route.selected', { model: selected.modelId, effort: selected.effort, routeId: decision.id,
        costUsd: null, estimatedCostUsd: selected.policyCostUsd, provenance: 'estimated', propensity: 1 });
      last = decision;
      footerTui?.requestRender();
      if (sel.policyResult.startsWith('relaxed-'))
        await rt.emit('model.policy_relaxed', { decisionId: decision.id, policyResult: sel.policyResult });
      await rt.store.append(
        'model-routes',
        telemetryView(
          { ...scope, id: decision.id, occurredAt: now(), ...decision },
          conf.telemetry?.dataPolicy ?? 'redact',
        ),
      );
      await rt.emit('model.routed', decision, decision.id);
      ctx.ui.setStatus('economist', undefined); // the concise footer shows the active pair
    }
    return { decision, model: selected.model, thinkingLevel: selected.effort, action: selected };
  };
  /**
   * VOI for `hybrid` and `learned`: replay the ranking under every label the
   * classifier could return (all above the floor) and ask `shouldClassify`.
   */
  const valueOfInformation = (a, ev0, price, evaluate, conf, objectives) => {
    const first = ev0.sel.ranked[0] ?? null,
      second = ev0.sel.ranked[1] ?? null;
    const capsOf = (x) => x.features.requiredCapabilities.join(',');
    const base = {
      firstId: first?.id ?? null,
      firstUtility: first ? actionUtility(conf.policy, first, objectives) : null,
      secondUtility: second ? actionUtility(conf.policy, second, objectives) : null,
      firstCost: first?.policyCostUsd ?? null,
      secondCost: second?.policyCostUsd ?? null,
      requiredTier: requiredTier(a, conf),
      requiredCaps: capsOf(a),
    };
    const alternatives = labelAlternatives(a).map(({ label, patch }) => {
      const alt = relabel(a, patch);
      const run = evaluate(alt, price);
      const winner = run.sel.selected;
      const baseline = first ? run.ranked.accepted.find((x) => x.id === first.id) : null;
      const gain = winner
        ? actionUtility(conf.policy, winner, objectives) -
          (baseline ? actionUtility(conf.policy, baseline, objectives) : 0)
        : 0;
      return {
        label,
        winnerId: winner?.id ?? null,
        gain,
        requiredTier: requiredTier(alt, conf),
        requiredCaps: capsOf(alt),
      };
    });
    return shouldClassify({ base, alternatives, price, classifier: conf.classifier, objectives });
  };
  /** Calibration of pSuccess from routed decisions joined to verified outcomes. */
  const calibrationFor = async (field = 'pSuccess') => {
    const routes = await rt.store.rows('model-routes');
    const outcomes = prepareOutcomes(await rt.store.rows('outcomes'));
    const byDecision = new Map(outcomes.filter((o) => o.decisionId).map((o) => [o.decisionId, o.success]));
    return calibrationReport(
      routes
        .filter((r) => byDecision.has(r.id) && Number.isFinite(r[field]))
        .map((r) => ({ p: r[field], success: byDecision.get(r.id) })),
    );
  };
  pi.on('session_start', async (_e, ctx) => {
    await init(ctx);
    last = null;
    footerTui = null;
    // Config enablement alone does not select a virtual model. A fresh session
    // starts on Pi's default physical model unless we explicitly select auto.
    // Never override a model selected in an existing conversation on resume.
    const explicitCliModel = process.argv.some((arg) => arg === '--model' || arg === '-m' || arg.startsWith('--model='));
    if (rt.config.modelEconomist.enabled &&
        !['off', 'manual'].includes(rt.config.modelEconomist.mode) &&
        !explicitCliModel &&
        !ctx.sessionManager.getBranch().some((entry) => entry.type === 'message') &&
        ctx.model?.api !== 'pi-virtual') {
      const auto = ctx.modelRegistry.find('economist', 'auto');
      if (auto) {
        manualModel = ctx.model;
        await pi.setModel(auto);
      }
    }
    if (ctx.mode === 'tui' && typeof ctx.ui.setFooter === 'function' && injected.tui) {
      ctx.ui.setFooter((tui, theme, footerData) => {
        footerTui = tui;
        const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
        return {
          dispose() {
            unsubscribe?.();
            if (footerTui === tui) footerTui = null;
          },
          invalidate() {},
          render(width) {
            const branch = footerData.getGitBranch?.();
            const statuses = footerData.getExtensionStatuses?.() ?? new Map();
            const extra = [...statuses.entries()].filter(([name]) => name !== 'economist')
              .map(([, value]) => value).filter(Boolean).join(' · ');
            const selected = ctx.model?.provider === 'economist' && ctx.model.id === 'auto';
            const pair = selected
              ? `AUTO ${last?.selectedModelId ?? 'aguardando pedido'} · esforço ${last?.selectedThinkingLevel ?? 'automático'}`
              : `${ctx.model?.id ?? 'sem modelo'} · ${ctx.thinkingLevel ?? 'off'}`;
            const stats = ctx.sessionManager.getBranch()
              .filter((e) => e.type === 'message' && e.message?.role === 'assistant')
              .reduce((sum, e) => {
                sum.input += e.message.usage?.input ?? 0;
                sum.output += e.message.usage?.output ?? 0;
                sum.cost += e.message.usage?.cost?.total ?? 0;
                return sum;
              }, { input: 0, output: 0, cost: 0 });
            const fmt = (n) => n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
            const ctxUse = ctx.getContextUsage?.();
            const ctxPart = ctxUse?.percent != null
              ? ` · ctx ${ctxUse.percent.toFixed(0)}%/${fmt(ctxUse.contextWindow ?? 0)}`
              : '';
            const left = theme.fg('dim', `↑${fmt(stats.input)} ↓${fmt(stats.output)} $${stats.cost.toFixed(3)}${ctxPart}${branch ? ` · ${branch}` : ''}`);
            const right = theme.fg('accent', `${pair}${extra ? ` · ${extra}` : ''}`);
            const space = width - injected.tui.visibleWidth(left) - injected.tui.visibleWidth(right);
            if (space < 1) return [
              injected.tui.truncateToWidth(right, width),
              injected.tui.truncateToWidth(left, width),
            ];
            return [left + ' '.repeat(space) + right];
          },
        };
      });
    }
  });
  const hook = (name, fn) => {
    try { pi.on(name, async (event, ctx) => { await init(ctx); return economics.run(ctx, guarded => fn(event, guarded)); }); }
    catch { economics.capabilities?.unavailable(name); }
  };
  hook('context', (e, ctx) => economics.context(e, ctx));
  hook('tool_result', (e, ctx) => economics.observeTool(e, ctx));
  hook('before_provider_request', (e, ctx) => economics.beforeRequest(e, ctx));
  hook('provider_stream_event', e => economics.stream(e));
  hook('message_end', (e, ctx) => economics.message(e.message, ctx, last));
  hook('turn_start', () => { economics.turn++; });
  hook('session_switch', () => { last = null; manualModel = null; });
  hook('session_before_compact', (e, ctx) => economics.beforeCompact(e, ctx));
  hook('session_compact', e => economics.compacted(e));
  hook('session_compact_failed', () => { economics.compacting = false; economics.pendingCompaction = null; });
  hook('agent_before_settle', (e, ctx) => economics.settle(e, ctx));
  hook('cache_warming_decision', async e => {
    economics.capabilities.observed('cache_warming_decision');
    // Respect host warming; never create a background paid request of our own.
    if (await economics.active(rt.ctx) && Number.isFinite(e.warmCost) && Number.isFinite(e.missCost) && Number.isFinite(e.continuationProbability) && e.warmCost > e.missCost * e.continuationProbability) return { action: 'stop' };
  });
  hook('context_with_system', () => { economics.capabilities.observed('context_with_system'); });
  pi.on('message_end', async (e, ctx) => {
    if (e.message.role !== 'assistant' || pi.getCommands?.().some((c) => c.name === 'cost')) return;
    await init(ctx);
    const m = e.message,
      u = m.usage,
      estimate = Number.isFinite(u?.cost?.total) && u.cost.total >= 0 ? u.cost.total : null;
    const modelId = `${m.provider}/${m.model}`;
    const num = (v) => (Number.isFinite(v) ? v : null);
    await rt.store.append('model-calls', {
      id: `${m.provider}/${m.responseId ?? `${m.model}/${m.timestamp}`}`,
      ...scopeOf(ctx),
      taskId: scopeOf(ctx).taskId ?? 'unattributed',
      provider: m.provider,
      modelId,
      effort: last?.selectedModelId === modelId ? last.selectedThinkingLevel : null,
      decisionId: last?.selectedModelId === modelId ? last.id : null,
      estimatedCostUsd: estimate,
      observedCostUsd: Number.isFinite(u?.billedCostUsd) && u.billedCostUsd >= 0 ? u.billedCostUsd : null,
      costProvenance: estimate === null ? 'unknown' : 'derived',
      totalTokens: u?.totalTokens ?? null,
      outputTokens: num(u?.output),
      reasoningTokens: num(u?.reasoning ?? u?.reasoningTokens),
      cacheReadTokens: num(u?.cacheRead),
      cacheWriteTokens: num(u?.cacheWrite),
      inputTokens: num(u?.input),
      ttftMs: num(m.ttftMs ?? u?.ttftMs),
      source: 'economist-budget-fallback',
      occurredAt: now(),
    });
  });
  /**
   * Verified outcomes only. Attributed to the last routed pair unless the event
   * names one. A model's own claim of being done never reaches this function.
   */
  const recordOutcome = async (input) => {
    const conf = rt.config?.modelEconomist;
    if (!conf || !rt.store) return null;
    const pair = input.model
      ? input
      : last
        ? {
            ...input,
            model: last.selectedModelId,
            effort: last.selectedThinkingLevel,
            version: last.action?.version,
            family: last.action?.family,
            intents: last.features?.intents,
            risky: (last.features?.risk?.categories ?? []).length > 0,
            decisionId: last.id,
          }
        : null;
    const row = pair && recordVerifiedOutcome({ taskId: scopeOf(rt.ctx).taskId, ...pair }, conf);
    if (!row) return null;
    if (await rt.store.append('outcomes', row)) await economics.emit('outcome.verified', { routeId: row.decisionId, success: row.success, model: row.model });
    await economics.noteOutcome(row);
    economics.outcomes = prepareOutcomes(await rt.store.rows('outcomes'));
    await economics.checkRollback(economics.outcomes);
    if (last && row.decisionId === last.id) {
      last.finalOutcome = row.success ? 'success' : 'failure';
      if (last.classifierCalled) {
        last.classifierWasCorrect = last.classifierChangedRoute ? row.success : null;
        // Both routes are observed only when the classifier kept the route.
        last.classifierRoiUsd = last.classifierChangedRoute ? null : -(last.classifierCost ?? 0);
      }
      await rt.store.append('route-outcomes', {
        id: `${last.id}/${row.id}`,
        decisionId: last.id,
        finalOutcome: last.finalOutcome,
        classifierWasCorrect: last.classifierWasCorrect ?? null,
        classifierRoiUsd: last.classifierRoiUsd ?? null,
        occurredAt: now(),
      });
    }
    return row;
  };
  const VERIFIER_COMMAND = /\b(test|tests|jest|vitest|pytest|mocha|tsc|typecheck|lint|mvn|gradle|go test|cargo test|dotnet test)\b/i;
  pi.on('tool_result', async (e, ctx) => {
    const exitCode = e.details?.exitCode ?? e.details?.exit_code;
    const command = e.input?.command ?? e.details?.command ?? '';
    if (!Number.isInteger(exitCode) || !VERIFIER_COMMAND.test(String(command))) return;
    await init(ctx);
    await recordOutcome({ source: 'exit_code', verifier: String(command).split(/\s+/).slice(0, 3).join(' '), exitCode });
  });
  pi.events.on?.('economist:outcome', (payload) => {
    recordOutcome(payload ?? {}).catch(() => {});
  });
  const stopContextFeedback = pi.events.on?.('economist:context_feedback', payload => {
    if (rt.ctx && economics.lifetime) economics.run(rt.ctx, ctx => economics.contextFeedback(payload, ctx.signal)).catch(() => {});
  });
  const unsubscribe = rt.listen(async (e) => {
    if (e.kind === 'model.call_completed' && e.source === 'economist' && e.payload.category === 'classifier') {
      const p = e.payload;
      await economics.operation('classifier', { id: `classifier/${p.provider}/${p.callId}`, callId: `${p.provider}/${p.callId}`,
        usd: Number.isFinite(p.observedCost) ? p.observedCost : p.estimatedCost ?? null, provenance: Number.isFinite(p.observedCost) ? 'observed' : 'derived',
        includedInCalls: false, budgetIncludedInCalls: true });
    }
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
    if (
      e.kind === 'gate.evaluated' &&
      e.source === 'gate' &&
      e.payload.verified === true &&
      ['accepted', 'rejected'].includes(e.payload.status)
    )
      await recordOutcome({
        source: 'gate',
        verifier: e.payload.gateId ?? 'gate',
        success: e.payload.status === 'accepted',
        taskId: e.taskId,
      });
    if (e.kind === 'verifier.result' && e.payload && typeof e.payload === 'object')
      await recordOutcome({ taskId: e.taskId, ...e.payload });
  });
  pi.on('session_shutdown', async (_e, ctx) => {
    ctx.ui.setFooter?.(undefined);
    unsubscribe?.();
    stopContextFeedback?.();
    await economics.dispose();
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
      const budget = remainingBudgets(conf, await rt.store.rows('model-calls'), economics.operations.rows, scopeOf(ctx));
      if (budget.remainingUsd === null || budget.remainingUsd <= 0) throw Error('Economist budget exhausted/unknown spend; no continuation dispatched');
      const state = request.state ?? { phase: 'normal', retries: 0, escalations: 0 };
      const sticky = request.failed ?? request.previous;
      const messages = request.messages ?? [];
      const humanMessage = m => m.role === 'user' && m.economistEvidence !== true;
      const lastResponse = messages.findLastIndex(m => m.role === 'assistant');
      if (request.reason === 'user' && !messages.slice(lastResponse + 1).some(humanMessage))
        request = { ...request, reason: 'continuation' };
      const messageText = (message) =>
        typeof message?.content === 'string'
          ? message.content
          : (message?.content ?? [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      const userTexts = messages
        .filter(humanMessage)
        .map(messageText)
        .filter((t) => t.trim());
      const latest = userTexts.at(-1) ?? '';
      // Prompt and subagent re-check the current question against the recent
      // conversation, so a short follow-up still sees the work already in progress.
      const text =
        userTexts.length < 2 ? latest : `${userTexts.slice(-4, -1).join('\n').slice(-800)}\n${latest}`;
      const images = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image'),
      );
      const lastUser = messages.findLastIndex(humanMessage);
      const lastAssistant = messages.findLastIndex((m) => m.role === 'assistant');
      const imageBlocks =
        lastUser >= 0 && Array.isArray(messages[lastUser].content)
          ? messages[lastUser].content.filter((c) => c.type === 'image')
          : [];
      const latestImage = imageBlocks.length > 0 && lastUser > lastAssistant;
      const contextTokens = economics.contextTokenEstimate ?? ctx.getContextUsage()?.tokens ?? Math.ceil(JSON.stringify(messages).length / 4);
      const scan = scanMessages(messages);
      const taskKey = `${scopeOf(ctx).sessionId}/${scopeOf(ctx).taskId}`;
      const failedGate = failedTasks.has(taskKey);
      const priorRisks = state.assessment?.risks ?? [];
      // Rules only: enough to build the state, find checkpoints and check a reused pair.
      const pre = assess(text, {
        images,
        contextTokens,
        observationText: scan.last?.text ?? null,
        previousRisks: priorRisks,
        toolRounds: scan.toolRounds,
        verifierSeen: scan.verifierSeen,
        recentToolFailure: Boolean(scan.last?.failed),
        previousGateFailure: failedGate,
      });
      const routingState = buildRoutingState(request, state, {
        assessment: pre,
        scan,
        availableTools: availableToolNames(),
        workspace: Boolean(ctx.cwd),
        failedGate,
      });
      const cps = checkpoints({ state: routingState, assessment: pre, scan, latestImage });
      const autoMode = conf.enabled && conf.routing.enabled !== false && !['off', 'manual'].includes(conf.mode);
      const need = {
        image: pre.requiresImageInput,
        tools: pre.requiresTools,
        requiredWindow:
          contextTokens +
          (pre.requiresTools ? (conf.window?.toolGrowth ?? 2048) : 0) +
          (conf.window?.safetyMargin ?? 512),
        requireReasoning: autoMode && pre.risks.length > 0,
      };
      const feasEnv = {
        // A pair already routed (or rescued) may sit outside the live scope; it only has to exist.
        available: physicalModels(ctx).map(modelKey),
        executorPolicy: conf.executor?.dataPolicy ?? 'allow',
        strictTools: conf.strictToolCompatibility === true,
      };
      const pairOf = (p) => (p ? { model: p.model, thinkingLevel: p.thinkingLevel ?? request.thinkingLevel } : null);
      const carried = (extra = {}) => ({
        ...state,
        triedPairs: state.triedPairs ?? [],
        qualityFailures: state.qualityFailures ?? {},
        ...extra,
      });
      const stick = async (nextState, { feasibility = null, reasonCodes = [] } = {}) => {
        const thinkingLevel = sticky.thinkingLevel ?? request.thinkingLevel;
        const modelId = `${sticky.model.provider}/${sticky.model.id}`;
        const decision = {
          id: uid(),
          reason: request.reason,
          sticky: true,
          selectedModelId: modelId,
          selectedThinkingLevel: thinkingLevel,
          effortSource: 'sticky',
          assessment: state.assessment ?? null,
          phase: state.phase,
          candidates: [modelId],
          rejected: [],
          feasibility,
          checkpoint: null,
          classifierCostUsd: 0,
          estimatedTotalCostUsd: null,
          finalOutcome: null,
          reasonCodes,
        };
        last = decision;
        footerTui?.requestRender();
        await rt.store.append('model-routes', telemetryView({ ...scopeOf(ctx), ...decision, occurredAt: now() }, conf.telemetry?.dataPolicy ?? 'redact'));
        await rt.emit('model.routed', decision, decision.id);
        return {
          model: sticky.model,
          thinkingLevel,
          state: { ...nextState, lastPair: actionId(modelId, thinkingLevel) },
        };
      };
      if (!autoMode) {
        const physical =
          manualModel ??
          request.previous?.model ??
          candidates(ctx).find((m) => modelKey(m) === conf.fallbackModel);
        if (!physical || physical.api === 'pi-virtual')
          throw Error('Economist disabled/manual: choose a physical model with /model');
        const feas = validateFeasibility({ model: physical, thinkingLevel: request.thinkingLevel }, need, feasEnv);
        if (!feas.ok)
          throw Error(
            `Economist ${conf.enabled ? conf.mode : 'off'}: ${modelKey(physical)} não atende este pedido (${feas.reasons.join(', ')}). ${fixHint(feas.reasons) || 'escolha outro modelo com /model'}.`,
          );
        return { model: physical, thinkingLevel: request.thinkingLevel };
      }
      let options = {};
      let nextExtra = {};
      if (request.reason === 'retry') {
        const retries = (state.retries ?? 0) + 1;
        const errorMessage = request.failed?.message?.errorMessage ?? '';
        const category = failureClass(errorMessage);
        await rt.emit('model.retry', { category, retries, maxRetries: conf.maxRetries });
        if (category === 'policy')
          throw Error(`Economist: falha de política não é repetida (${redact(errorMessage).slice(0, 200)})`);
        if (retries > conf.maxRetries) throw Error(`Economist: ${category} retry limit reached`);
        const failedId = sticky ? modelKey(sticky.model) : null;
        const failedLevel = sticky?.thinkingLevel ?? request.thinkingLevel ?? 'off';
        const failedPair = failedId ? actionId(failedId, failedLevel) : null;
        const triedPairs = [...new Set([...(state.triedPairs ?? []), ...(failedPair ? [failedPair] : [])])];
        const qualityFailures = { ...(state.qualityFailures ?? {}) };
        if (category === 'quality' && failedId) qualityFailures[failedId] = (qualityFailures[failedId] ?? 0) + 1;
        nextExtra = {
          retries,
          triedPairs,
          qualityFailures,
          previousAttempt: { model: failedId, effort: failedLevel, outcome: category },
        };
        const sameFeas = sticky ? validateFeasibility(pairOf(sticky), need, feasEnv) : null;
        if (category === 'network' && sameFeas?.ok)
          return stick(carried(nextExtra), { feasibility: sameFeas, reasonCodes: ['retry-network-same-pair'] });
        if (category === 'server' && (state.retries ?? 0) === 0 && sameFeas?.ok)
          return stick(carried(nextExtra), { feasibility: sameFeas, reasonCodes: ['retry-server-same-pair'] });
        const pool = candidates(ctx);
        const failedModel = pool.find((m) => modelKey(m) === failedId) ?? sticky?.model ?? null;
        if (category === 'server') {
          const provider = failedModel?.provider;
          options = {
            restrictModels: new Set(pool.filter((m) => m.provider !== provider).map(modelKey)),
            forceEffort: failedLevel,
            extraReasonCodes: ['retry-server', 'provider-fallback'],
          };
        } else if (category === 'context') {
          const window = failedModel?.contextWindow;
          options = {
            contextTokens: Math.max(contextTokens, Number.isFinite(window) ? window : 0),
            excludeModels: new Set(failedId ? [failedId] : []),
            extraReasonCodes: ['retry-context'],
          };
        } else if (category === 'capability') {
          options = {
            forceCapabilities: {
              image: /image|vision|imagem/i.test(errorMessage) || pre.requiresImageInput,
              tools: /tool|function/i.test(errorMessage) || pre.requiresTools,
            },
            excludeModels: new Set(failedId ? [failedId] : []),
            extraReasonCodes: ['retry-capability'],
          };
        } else if (category === 'quality') {
          // Ladder: more effort on the same model first, then the next tier up.
          const levels = failedModel ? supportedLevels(failedModel) : [];
          const higher = levels.filter((l) => levelRank(l) > levelRank(failedLevel));
          if (failedModel && higher.length && qualityFailures[failedId] < 2)
            options = {
              restrictModels: new Set([failedId]),
              forceEffort: higher[0],
              extraReasonCodes: ['retry-quality', 'quality-ladder-effort'],
            };
          else
            options = {
              excludeModels: new Set(failedId ? [failedId] : []),
              forceTier: (failedModel?.tier ?? 1) + 1,
              extraReasonCodes: ['retry-quality', 'quality-ladder-tier'],
            };
        } else
          options = {
            excludeModels: new Set(failedId ? [failedId] : []),
            extraReasonCodes: [`retry-${category}`],
          };
        options.exclude = new Set(triedPairs);
      }
      const escalate =
        state.phase === 'fast' &&
        failedGate &&
        (state.escalations ?? 0) < conf.fastPath.maxEscalations;
      let feasibility = null;
      if (request.reason === 'continuation' && sticky && !escalate) {
        if (cps.length === 0) {
          feasibility = validateFeasibility(pairOf(sticky), need, feasEnv);
          if (feasibility.ok) return stick(carried(), { feasibility, reasonCodes: ['sticky'] });
          options.extraReasonCodes = [...(options.extraReasonCodes ?? []), 'sticky-infeasible'];
        } else options.extraReasonCodes = [...(options.extraReasonCodes ?? []), 'checkpoint'];
      }
      // A /model away from economist/auto ends the session pin. Pi records that as a
      // model_change after the virtual-model state that stored the pin. Coming back
      // to auto chooses again. While no such change exists, the first choice holds.
      const sessionPinReleased = (choice) => {
        if (!choice) return false;
        const branch = ctx.sessionManager?.getBranch?.() ?? [];
        let matched = -1;
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry?.type !== 'custom' || entry.customType !== 'pi.virtual-model-state') continue;
          const saved = entry.data?.state?.sessionChoice;
          if (saved?.modelId === choice.modelId && saved?.thinkingLevel === choice.thinkingLevel) {
            matched = i;
            break;
          }
        }
        if (matched < 0) return false;
        return branch.slice(matched + 1).some(
          (entry) =>
            entry?.type === 'model_change' &&
            !(entry.provider === 'economist' && entry.modelId === 'auto'),
        );
      };
      const released = conf.cadence === 'session' && sessionPinReleased(state.sessionChoice);
      if (request.reason === 'user' && conf.cadence === 'session' && state.sessionChoice && !released) {
        const pinned = candidates(ctx).find((m) => modelKey(m) === state.sessionChoice.modelId);
        // A hard risk the pin was not chosen for, or a checkpoint, re-decides.
        const newRisk = pre.risks.some((r) => !priorRisks.includes(r));
        if (pinned && !newRisk && cps.length === 0) {
          feasibility = validateFeasibility(
            { model: pinned, thinkingLevel: state.sessionChoice.thinkingLevel },
            need,
            feasEnv,
          );
          if (feasibility.ok)
            return {
              model: pinned,
              thinkingLevel: state.sessionChoice.thinkingLevel,
              state: request.state,
            };
          options.extraReasonCodes = [...(options.extraReasonCodes ?? []), 'session-pin-infeasible'];
        }
      }
      let result;
      try {
        result = await decide(text, ctx, {
          images,
          imageBlocks,
          contextTokens,
          scan,
          routingState,
          priorRisks,
          previousGateFailure: failedGate,
          checkpoint: cps,
          feasibility,
          previous: sticky ? `${sticky.model.provider}/${sticky.model.id}` : null,
          forceDifficulty: escalate ? 'critical' : null,
          reason: request.reason,
          allowClassification: request.reason !== 'direct',
          // The level the human selected on economist/auto is the input to the effort
          // decision, so /thinking keeps meaning without pinning the router.
          selectedLevel: request.thinkingLevel ?? ctx.thinkingLevel ?? 'off',
          signal: request.signal,
          ...options,
          forceTier: escalate
            ? (candidates(ctx).find((m) => m.id === sticky?.model.id)?.tier ?? 1) + 1
            : (options.forceTier ?? null),
        });
      } catch (error) {
        if (error?.code === 'context-overflow') {
          await rt.emit('model.context_overflow', {
            contextTokens: options.contextTokens ?? contextTokens,
            suggestCompaction: true,
          });
          ctx.ui?.notify?.('Economist: nenhum modelo comporta o contexto. Rode /compact.', 'warning');
        }
        throw error;
      }
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
          sessionChoice: conf.cadence === 'session'
            ? { modelId: result.decision.selectedModelId, thinkingLevel: result.thinkingLevel }
            : undefined,
          retries: request.reason === 'retry' ? nextExtra.retries : 0,
          triedPairs: request.reason === 'retry' ? nextExtra.triedPairs : [],
          qualityFailures: request.reason === 'retry' ? nextExtra.qualityFailures : {},
          previousAttempt: request.reason === 'retry' ? nextExtra.previousAttempt : (state.previousAttempt ?? null),
          lastPair: actionId(result.decision.selectedModelId, result.thinkingLevel),
          escalations: escalate
            ? (state.escalations ?? 0) + 1
            : request.reason === 'user'
              ? 0
              : (state.escalations ?? 0),
        },
      };
    },
  });
  registerEconomicsTools(pi, economics, init, () => last, injected.Type, async (contract, ctx, signal) => {
    const refs = await Promise.all((contract.contextRefs ?? []).map(handle => economics.artifacts.get(handle,
      { budgetTokens: Math.min(2048, contract.budget?.tokens ?? 2048), signal })));
    const contextTokens = Math.ceil(JSON.stringify(contract).length / 4) + refs.reduce((n, ref) => n + ref.tokens, 0);
    const result = await decide(contract.objective, ctx, { simulate: true, interactive: false, signal, contextTokens,
      envelope: sanitizeEnvelope({ environment: 'unknown', privacy: rt.config.modelEconomist.executor?.dataPolicy,
        capabilities: { tools: true, fileWrite: contract.permissions?.includes('write') }, risks: [] }) });
    return { model: result.decision.selectedModelId, thinkingLevel: result.decision.selectedThinkingLevel,
      estimatedCostUsd: result.decision.estimatedTotalCostUsd, latencyP95Ms: result.decision.latencyP95Ms, local: result.model.local === true };
  });
  const CADENCES = [
    { value: 'session', description: 'escolhe o melhor custo-benefício na primeira pergunta e mantém até você mudar /model' },
    { value: 'prompt', description: 'reavalia cada pergunta pelo contexto e pelo tipo de trabalho' },
    { value: 'subagent', description: 'reavalia cada pergunta e avalia o modelo de cada subagente ao iniciar' },
  ];
  pi.registerTool({
    name: 'economist_subagent_model',
    exposure: 'codemode',
    label: 'Modelo para subagente',
    description: 'Avalia modelo e esforço para um subagente que vai começar. Não altera a sessão atual. Quem implementa subagentes chama isto antes de criar cada filho e passa o par retornado a ele.',
    parameters: injected.Type?.Object && injected.Type.Unsafe
      ? injected.Type.Object({
          task: injected.Type.String(),
          envelope: injected.Type.Optional(injected.Type.Unsafe(ENVELOPE_SCHEMA)),
        })
      : { type: 'object', properties: { task: { type: 'string' }, envelope: ENVELOPE_SCHEMA }, required: ['task'], additionalProperties: false },
    async execute(_id, { task, envelope }, _signal, _onUpdate, ctx) {
      if (typeof task !== 'string' || !task.trim()) throw Error('Descreva a tarefa do subagente');
      await init(ctx);
      if (!rt.config.modelEconomist.enabled || rt.config.modelEconomist.cadence !== 'subagent')
        throw Error('Ative /economist cadence subagent antes de pedir uma recomendação');
      const env = sanitizeEnvelope(envelope);
      const { decision } = await decide(task, ctx, {
        simulate: true,
        interactive: false,
        envelope: env,
        priorRisks: env?.risks ?? [],
        forceCapabilities: { tools: env?.capabilities.tools === true, image: env?.capabilities.image === true },
        extraReasonCodes: env ? ['subagent-envelope'] : ['degraded-subagent-context'],
      });
      const pair = {
        model: decision.selectedModelId,
        thinkingLevel: decision.selectedThinkingLevel,
        pSuccess: decision.pSuccess,
        degraded: !env,
        reasonCodes: decision.reasonCodes,
      };
      return {
        content: [{ type: 'text', text: `${pair.model} · esforço ${pair.thinkingLevel}` }],
        details: pair,
        structuredContent: pair,
      };
    },
  });
  const MODES = [
    { value: 'hybrid', description: 'regras grátis; classificador só quando o valor da informação paga o custo' },
    { value: 'rules', description: 'determinístico e grátis, nunca chama classificador' },
    { value: 'jev', description: 'classificador nativo em todo pedido elegível, inclusive saudação e risco' },
    { value: 'small-llm', description: 'modelo pequeno classifica todo pedido elegível em JSON estrito' },
    { value: 'learned', description: 'histórico verificado (Beta) com classificador só quando vale a pena' },
    { value: 'manual', description: 'você escolhe com /model; o economist só valida e registra' },
    { value: 'off', description: 'roteamento desligado' },
  ];
  const POLICIES = [
    { value: 'economy', description: 'menor custo em dinheiro com pSuccess acima do piso' },
    { value: 'balanced', description: 'maior utilidade: valor do sucesso menos custo e espera p95' },
    { value: 'quality', description: 'maior pSuccess; custo só desempata' },
    { value: 'latency', description: 'menor p95 com pSuccess acima do piso' },
  ];
  const MODE_IDS = MODES.map((m) => m.value);
  const CADENCE_IDS = CADENCES.map((m) => m.value);
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
  const configuredCandidates = (ctx, modelEconomist = rt.config.modelEconomist) => {
    const scope = poolScope(ctx ?? rt.ctx, modelEconomist);
    const annotate = (c, i) => {
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
    };
    if (!(refreshesScopeEachPrompt() && scope.active))
      return modelEconomist.candidates.map(annotate);
    const live = membershipSpecs(ctx, scope, modelEconomist).map(annotate);
    const seen = new Set(live.map((c) => c.value));
    const stale = modelEconomist.candidates
      .map(annotate)
      .filter((c) => !seen.has(c.value));
    return [...live, ...stale];
  };
  const economistSpec = {
    name: 'economist',
    description: 'Route each request to the cheapest capable model',
    actions: {
      preset: { hint: 'economy|balanced|quality|adaptive|custom', description: 'choose an optimization preset', args: [{ values: PRESETS }] },
      control: { hint: 'automatic|ask|advisory', description: 'choose automation control', args: [{ values: CONTROLS }] },
      rollout: { hint: 'observe|shadow|canary-5|canary-25|active', description: 'context optimization rollout', args: [{ values: STAGES }] },
      metrics: { hint: '', description: 'context, cache and verified-success economics' },
      capabilities: { hint: '', description: 'observed host capabilities' },
      evaluate: { hint: 'FILE.jsonl', description: 'offline paired context/cache/routing ablations; no provider calls', args: [{ hint: 'file' }] },
      migrate: { hint: '--preview|--write', description: 'preview or explicitly save compatible v2 optimizer aliases', flags: { '--preview': { hint: 'show mapping without writing' }, '--write': { hint: 'save migration' } } },
      'off-policy': { hint: 'FILE.jsonl', description: 'offline IPS/SNIPS from logged action probabilities', args: [{ hint: 'file' }] },
      on: { hint: '', description: 'enable routing and switch to economist/auto' },
      off: { hint: '', description: 'stop routing and restore your manual model' },
      setup: {
        hint: '[--global]',
        description: 'guided setup from your authenticated models',
        flags: { '--global': { hint: 'write the global config instead' } },
      },
      cadence: {
        hint: 'session|prompt|subagent',
        description: 'quando reavaliar modelo e esforço',
        args: [{ values: CADENCES, hint: 'cadência' }],
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
      scope: {
        hint: 'scoped|all',
        description: 'pool source: /scoped-models or the whole catalogue',
        args: [{ values: SCOPE_SOURCES, hint: 'source' }],
      },
      role: {
        hint: 'list|ROLE model PROVIDER/MODEL|clear|ROLE effort LEVEL|auto|ROLE fallback on|off',
        description: 'preferred model and thinking effort for planner, executor, or reviewer calls',
        args: [{ values: MODEL_ROLES, hint: 'role' }, { values: ['model', 'effort', 'fallback'], hint: 'preference' }],
      },
      classifier: {
        hint: 'on|off',
        description: 'usar um classificador adicional para tarefas ambíguas',
        args: [
          {
            values: [
              { value: 'on', description: 'classify ambiguous requests' },
              { value: 'off', description: 'somente regras, sem custo extra de classificação' },
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
        hint: 'task|session|project N USD',
        description: 'per-task spend limit',
        args: [
          { values: ['task', 'session', 'project'], hint: 'scope', advance: true },
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
        hint: 'PROMPT [--floor P]',
        description: 'free dry run, no model called',
        args: [{ hint: 'prompt text' }],
        flags: { '--floor': { hint: 'quality floor override in (0,1]' } },
        free: true,
      },
      benchmark: {
        hint: '--dataset PATH [--holdout-before ISO] [--policy POLICY]',
        description: 'offline replay of a measured matrix, no model called',
        flags: {
          '--dataset': { hint: 'JSONL path (≤ 1000 rows)' },
          '--holdout-before': { hint: 'train on rows before this ISO date' },
          '--policy': { values: ['economy', 'balanced', 'quality', 'latency'], hint: 'policy' },
        },
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
  /** Cadences that choose again on each user prompt also refresh who may be chosen. */
  const refreshesScopeEachPrompt = () => {
    const cadence = rt.config.modelEconomist.cadence ?? 'prompt';
    return cadence === 'prompt' || cadence === 'subagent';
  };
  /**
   * Who can be routed. With a live scope and a per-prompt cadence, that is exactly
   * the models `/scoped-models` lists now. Saved rows keep tier and tools for those
   * ids and do not admit anyone the scope dropped. Other cadences keep the saved
   * pool, or the scoped catalogue when nothing was saved yet.
   */
  const membershipSpecs = (ctx, scope = poolScope(ctx ?? rt.ctx), modelEconomist = rt.config.modelEconomist) => {
    const saved = modelEconomist.candidates;
    if (!(refreshesScopeEachPrompt() && scope.active))
      return saved.length ? saved : proposeTiers(routableModels(ctx, modelEconomist));
    const prior = new Map();
    saved.forEach((c, i) => {
      const spec = typeof c === 'string' ? { id: c, tier: i + 1, tools: false } : c;
      if (spec?.id) prior.set(spec.id, spec);
    });
    return proposeTiers(routableModels(ctx, modelEconomist)).map((proposed) => {
      const known = prior.get(proposed.id);
      if (!known) return proposed;
      return {
        id: proposed.id,
        tier: known.tier ?? proposed.tier,
        tools: known.tools === true,
        health: known.health,
        dataAllowed: known.dataAllowed,
        local: known.local,
        priorFailureRate: known.priorFailureRate,
        latencyMs: known.latencyMs,
      };
    });
  };
  /** Why a model is not selectable right now, said in terms the user can act on. */
  const scopeNotice = (id, ctx) => {
    const scope = poolScope(ctx ?? rt.ctx);
    if (scope.active && !scope.ids.has(id))
      return `${id} is not in /scoped-models (${scope.rows.length} scoped). Add it there, or run /economist scope all to use the whole catalogue.`;
    if (!physicalModels(ctx).some((m) => modelKey(m) === id)) return undefined;
    return undefined;
  };
  /** One table for the v2 text commands and the settings panel. */
  const v2Patch = (id, value, current) => {
    if (id === 'preset') return presetPatch(value, current);
    if (id === 'control' && CONTROLS.includes(value)) return { control: value, configVersion: 2,
      ...(value !== 'advisory' && current.control === 'advisory' && current.preset !== 'adaptive' && current.rollout.stage === 'observe'
        ? { rollout: { stage: 'active' } } : {}) };
    if (id === 'rollout' && STAGES.includes(value)) return { rollout: { stage: value }, configVersion: 2 };
    if (id === 'context-enabled' && ['on', 'off'].includes(value)) return { context: { enabled: value === 'on' } };
    if (id === 'retrieval-budget' && [1024, 2048, 4096, 8192].includes(Number(value))) return { context: { retrieval: { budgetTokens: Number(value) } } };
    if (id === 'algorithm' && ['expected-cost', 'cascade', 'bandit'].includes(value)) return { adaptive: { algorithm: value } };
    if (id === 'bandit' && ['off', 'shadow', 'active'].includes(value)) return { adaptive: { bandit: value } };
    if (['privacy', 'privacy-classifier', 'privacy-telemetry'].includes(id) && ['deny', 'redact', 'allow'].includes(value))
      return { [id === 'privacy' ? 'executor' : id.slice('privacy-'.length)]: { dataPolicy: value } };
    if (id === 'delegation' && ['on', 'off'].includes(value)) return { topology: { enabled: value === 'on' } };
    throw Error(`Invalid economist ${id}: ${value}`);
  };
  const validateActivation = async (next) => {
    const mutatingStage = !['observe', 'shadow'].includes(next.rollout.stage);
    if ((next.preset === 'adaptive' && mutatingStage || next.adaptive.bandit === 'active') && !(await economics.proof())?.eligible)
      throw Error('Adaptive activation requires paired measured evidence: P(CPVS improvement) > 0.95, sufficient samples and preserved quality/safety floors. Run /economist evaluate FILE.jsonl. Deterministic presets remain available.');
    if (mutatingStage && economics.rollback) throw Error(`Economist rolled back: ${economics.rollback.join(', ')}. Review evidence before a new session.`);
  };
  /** One open panel per extension instance: a second `/economist` says so instead of stacking. */
  let panelOpen = false;
  /** The cancel hint of the offline-evaluation overlay, in the project's screen language. */
  const operationHint = (ctx) =>
    translate(loadProjectLocale(rt.root, Boolean(rt.root && ctx.isProjectTrusted?.())).locale, 'panel.cancelHint');
  /**
   * Panel field id → nested patch, in a fixed order: the priority preset first (it
   * rewrites several fields at once), then control, then every other field that differs
   * from the saved values. A field edited in the draft therefore always ends up in the
   * file with the value the panel showed, whatever order the user edited in; the panel
   * itself already shows the preset's consequences (see `onDraftChange` below).
   */
  const PANEL_V2_FIELDS = ['contextEnabled', 'retrievalBudget', 'privacyExecutor', 'privacyClassifier', 'privacyTelemetry', 'rollout', 'algorithm', 'bandit', 'delegation'];
  const PANEL_V1_FIELDS = ['cadence', 'mode', 'policy', 'thinking', 'ceiling', 'fixed', 'scope'];
  const panelPatch = (values, from, conf, FIELDS) => {
    let next = structuredClone(conf);
    const changed = (id) => JSON.stringify(values[id]) !== JSON.stringify(from[id]);
    const asCommand = (value) => (typeof value === 'boolean' ? (value ? 'on' : 'off') : value);
    for (const id of ['preset', 'control'])
      if (changed(id)) next = merge(next, v2Patch(PANEL_COMMANDS[id], values[id], next));
    for (const id of PANEL_V2_FIELDS)
      if (changed(id)) next = merge(next, v2Patch(PANEL_COMMANDS[id], asCommand(values[id]), next));
    for (const id of PANEL_V1_FIELDS) {
      if (!changed(id)) continue;
      const field = FIELDS[id];
      if (!field.values.includes(values[id]))
        throw Error(`Invalid ${id}: ${values[id]}. Allowed values: ${field.values.join(' | ')}`);
      next = merge(next, field.patch(values[id]));
    }
    if (changed('enabled')) next = merge(next, { enabled: values.enabled === true });
    return next;
  };
  /**
   * Bare `/economist` opens the settings panel. Changes stay in a draft until Ctrl+S;
   * the screen language is read and saved only in the trusted current project.
   */
  const openMenu = async (ctx, { conf, locked, FIELDS }) => {
    const copy = (value) => structuredClone(value);
    const projectRoot = rt.root;
    const trusted = Boolean(projectRoot && ctx.isProjectTrusted?.());
    const savedLocale = loadProjectLocale(projectRoot, trusted).locale;
    const scope = poolScope(ctx, conf);
    const textFallback = () => {
      // Clients without a custom Pi TUI get the state first and the commands after.
      const tf = (key, values) => translate(savedLocale, key, values);
      const pool = candidates(ctx);
      return output(ctx, [
        tf('fallback.enabled', { enabled: conf.enabled ? 'ON' : 'off', cadence: conf.cadence ?? 'prompt', mode: conf.mode, policy: conf.policy }),
        tf('fallback.pool', {
          count: pool.length,
          scope: scope.active ? tf('fallback.scope', { count: scope.rows.length }) : tf('fallback.all'),
          mode: conf.thinking?.mode ?? 'auto',
          ceiling: conf.thinking?.ceiling ?? 'high',
        }),
        last
          ? tf('fallback.last', { value: `${last.selectedModelId}:${last.selectedThinkingLevel ?? 'off'}`, reasons: last.reasonCodes?.join(' · ') ?? '' })
          : tf('fallback.noLast'),
        '',
        tf('fallback.noTui'),
        tf('fallback.commands.1'),
        tf('fallback.commands.2'),
        tf('fallback.commands.3'),
      ].join('\n'));
    };
    if (ctx.mode !== 'tui' || typeof ctx.ui.custom !== 'function') return textFallback();
    // Degradation is allowed; silence is not: name the host export that is missing.
    const missing = host.tui ? missingHostExports(host.tui) : [];
    if (missing.length) {
      try {
        ctx.ui.notify(translate(savedLocale, 'notice.dashboardUnavailable', { reason: `missing exports: ${missing.join(', ')}` }), 'warning');
      } catch {
        /* a broken notify must not hide the text panel */
      }
      return textFallback();
    }
    if (panelOpen) {
      ctx.ui.notify(translate(savedLocale, 'panel.alreadyOpen'), 'warning');
      return undefined;
    }
    panelOpen = true;
    try {
      return await runPanels(ctx, { conf, locked, FIELDS, copy, projectRoot, trusted, savedLocale, scope });
    } finally {
      panelOpen = false;
    }
  };
  const runPanels = async (ctx, { conf, locked, FIELDS, copy, projectRoot, trusted, savedLocale, scope }) => {
    let saved = copy(conf);
    let base = panelValues(saved, savedLocale);
    let locale = savedLocale;
    const t = (key, values) => translate(locale, key, values);
    const signals = [ctx.signal, economics.lifetime?.signal].filter(Boolean);
    const signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
    const changes = [];
    let livePanel;
    // openPiSettings only uses `ui.custom`; wrapping it lets a save refresh the scope line.
    const ui = {
      custom: (factory, options) =>
        ctx.ui.custom((tui, theme, keys, done) => {
          const component = factory(tui, theme, keys, done);
          livePanel = component?.controller;
          return component;
        }, options),
    };
    const enums = {
      presets: PRESETS,
      controls: CONTROLS,
      cadences: CADENCE_IDS,
      modes: MODE_IDS,
      policies: POLICY_IDS,
      thinking: THINKING_MODES.map((m) => m.value),
      levels: THINKING_LEVELS,
      scopes: SCOPE_SOURCES.map((s) => s.value),
      stages: STAGES,
    };
    const locksFor = (l) => {
      const global = translate(l, 'panel.source.global');
      const locks = {};
      if (Object.hasOwn(locked, 'enabled')) locks.enabled = global;
      for (const id of PANEL_V1_FIELDS) if (Object.hasOwn(locked, FIELDS[id].lock)) locks[id] = global;
      if (!trusted) locks.language = translate(l, 'panel.source.untrusted');
      return locks;
    };
    const fields = (l) => economistFields(l, { enums, values: base, locks: locksFor(l) });
    const overrides = (l) => ({ saved: translate(l, 'panel.saved', { path: rt.configFile }) });
    const scopeLine = (l) => translate(l, 'panel.scope', {
      enabled: saved.enabled ? 'on' : 'off',
      mode: saved.mode,
      policy: saved.policy,
      pool: candidates(ctx).length,
      scope: scope.active ? scope.rows.length : translate(l, 'panel.scopeAll'),
    });
    const actions = (l) => {
      const tl = (key, values) => translate(l, key, values);
      return [
        { id: 'pool', label: tl('row.pool'), description: tl('desc.pool', { count: scope.active ? scope.rows.length : physicalModels(ctx).length }),
          hint: tl('value.pool', { count: candidates(ctx).length }), closeWith: true },
        { id: 'economics', label: tl('row.economics'), description: tl('desc.economics'), hint: saved.rollout?.stage ?? 'observe',
          closeWith: true, requiresSaved: false },
        { id: 'explain', label: tl('row.explain'), description: tl('desc.explain'),
          hint: last ? `${shortName(last.selectedModelId)}:${last.selectedThinkingLevel ?? 'off'}` : tl('value.none'),
          closeWith: true, requiresSaved: false },
        // The dry run routes with the saved settings, so it asks for a saved draft first.
        { id: 'simulate', label: tl('row.simulate'), description: tl('desc.simulate'), closeWith: true },
        { id: 'help', label: tl('row.help'), description: tl('desc.help'), closeWith: true, requiresSaved: false },
      ];
    };
    const formatError = (error, { phase }) => {
      const message = String(error?.message ?? error ?? '').trim();
      if (!message) return undefined;
      return phase === 'save' ? t('notice.saveFailed', { error: message }) : message;
    };
    const common = (session, extra = {}) => ({
      session,
      signal,
      locale,
      messages: overrides(locale),
      formatError,
      // validateActivation can read paired evidence from disk: allow a slow disk, and
      // give an in-flight write time to acknowledge Esc before calling it unknown.
      saveTimeoutMs: 60_000,
      cancelGraceMs: 1_000,
      ...extra,
    });
    const display = (field, value) => {
      if (field.kind === 'boolean') return value ? 'on' : 'off';
      return field.choices?.find((c) => c.id === value)?.label ?? String(value);
    };
    const record = (fieldList, values, from) => {
      for (const field of fieldList)
        if (JSON.stringify(values[field.id]) !== JSON.stringify(from[field.id]))
          changes.push(translate(locale, 'summary.item', {
            label: field.label,
            before: display(field, from[field.id]),
            after: display(field, values[field.id]),
          }));
    };
    /** Validation, model switch with rollback and the write: the core the old dashboard save had. */
    const commit = async (next, operationSignal, { locale: newLocale } = {}) => {
      const before = copy(saved);
      await validateActivation(next);
      operationSignal.throwIfAborted();
      if (next.enabled && !before.enabled) {
        const available = routableModels(ctx, next);
        const selected = next.candidates.length ? new Set(next.candidates.map(specId)) : null;
        const viable = available.filter((row) => !selected || selected.has(row.value));
        if (!viable.length) throw Error(economistUnavailable(next, ctx, next));
        // Consent was given in the panel: enabling showed what Ctrl+S would add.
        if (!next.candidates.length) next.candidates = proposeTiers(viable);
      }
      const currentModel = ctx.model;
      const manualBefore = manualModel;
      let manualAfter = manualBefore;
      let modelToSet = null;
      if (next.enabled && !before.enabled) {
        if (currentModel?.api !== 'pi-virtual') manualAfter = currentModel;
        modelToSet = ctx.modelRegistry.find('economist', 'auto');
      } else if ((before.enabled && !next.enabled) || (['manual', 'off'].includes(next.mode) && currentModel?.provider === 'economist')) {
        const restore = manualBefore ?? physicalModels(ctx).find((m) => modelKey(m) === last?.selectedModelId);
        if (currentModel?.provider === 'economist' && restore) modelToSet = restore;
      }
      let path;
      try {
        if (modelToSet) await pi.setModel(modelToSet);
        // An Esc that landed while the model switch was pending cancels the save before
        // anything is written; the catch below puts the previous model back.
        operationSignal.throwIfAborted();
        if (newLocale) next.locale = newLocale;
        else delete next.locale;
        path = await rt.save('modelEconomist', next, { signal: operationSignal });
      } catch (error) {
        manualModel = manualBefore;
        if (modelToSet && currentModel) {
          try { await pi.setModel(currentModel); } catch { /* keep the original persistence error visible */ }
        }
        throw error;
      }
      manualModel = manualAfter;
      if (!next.enabled) ctx.ui.setStatus('economist', undefined);
      saved = copy(rt.config.modelEconomist);
      if (next.enabled && !before.enabled && !modelToSet)
        ctx.ui.notify(t('notice.saveNoVirtualModel'), 'warning');
      return path;
    };
    const persistMain = async (values, operationSignal) => {
      operationSignal.throwIfAborted();
      const localeChanged = values.language !== base.language;
      const localeWriteTrusted = Boolean(projectRoot && rt.root === projectRoot && ctx.isProjectTrusted?.());
      if (localeChanged && (!trusted || !localeWriteTrusted)) throw Error(t('language.saveTrusted'));
      const next = panelPatch(values, base, saved, FIELDS);
      if (localeChanged || JSON.stringify(next) !== JSON.stringify(saved))
        await commit(next, operationSignal, { locale: localeChanged ? values.language : undefined });
      record(fields(locale), values, base);
      base = copy(values);
      livePanel?.relabel({ scope: scopeLine(locale) });
    };
    /** Preset/control consequences, the enabling notice and the live language preview. */
    let seen;
    const pick = (draft) => ({ language: draft.language, preset: draft.preset, control: draft.control, enabled: draft.enabled });
    const relocalize = (panel, l) => {
      locale = l;
      panel.setLocale(l, overrides(l));
      panel.relabel({ title: translate(l, 'panel.title'), scope: scopeLine(l), fields: fields(l), actions: actions(l) });
    };
    const derive = (draft, id) => {
      const prior = panelPatch({ ...draft, [id]: seen[id] }, base, saved, FIELDS);
      return panelValues(merge(prior, v2Patch(PANEL_COMMANDS[id], draft[id], prior)), draft.language);
    };
    const cascade = (panel, draft, id) => {
      const derived = derive(draft, id);
      for (const field of panel.session.fields)
        if (!['language', 'enabled', 'preset', 'control'].includes(field.id) && JSON.stringify(derived[field.id]) !== JSON.stringify(draft[field.id]))
          setDraftValue(panel.session, field.id, derived[field.id]);
    };
    const onDraftChange = (draft, { reason }, panel) => {
      if (reason === 'discard') {
        if (locale !== base.language) relocalize(panel, base.language);
        seen = pick(panel.session.draft);
        return;
      }
      if (draft.language !== seen.language) relocalize(panel, draft.language);
      const choice = (id, value) => panel.session.fields.find((f) => f.id === id)?.choices?.find((c) => c.id === value)?.label ?? value;
      if (draft.preset !== seen.preset) {
        cascade(panel, draft, 'preset');
        panel.session.setStatus(t('panel.presetApplied', { preset: choice('preset', draft.preset) }), 'info');
      } else if (draft.control !== seen.control) {
        cascade(panel, draft, 'control');
        panel.session.setStatus(t('panel.controlApplied', { control: choice('control', draft.control) }), 'info');
      }
      if (draft.enabled !== seen.enabled) {
        if (draft.enabled && !base.enabled && !saved.candidates.length) {
          const viable = routableModels(ctx, saved).length;
          panel.session.setStatus(viable ? t('panel.enableProposes', { count: viable }) : economistUnavailable(saved, ctx, saved), 'warning');
        } else if (!draft.enabled && panel.session.statusKind === 'warning') panel.session.setStatus('');
      }
      seen = pick(panel.session.draft);
    };
    const reconcileMain = async () => {
      saved = copy(rt.config.modelEconomist);
      base = panelValues(saved, loadProjectLocale(rt.root, trusted).locale);
      return copy(base);
    };
    const view = (title, lines) => openTextView(ui, { title, lines: lines.filter((line) => String(line).trim()), locale, signal });
    const openPool = async () => {
      const rows = configuredCandidates(ctx, saved);
      if (!rows.length) {
        ctx.ui.notify(t('pool.empty'), 'info');
        return;
      }
      const activeScope = poolScope(ctx, saved);
      const scopeLocked = (id) => refreshesScopeEachPrompt() && activeScope.active && activeScope.ids.has(id) &&
        !saved.candidates.some((c) => specId(c) === id);
      let poolBase = poolValues(rows);
      const poolFieldsFor = (l) => poolFields(l, rows, { scopeLocked });
      const session = new SettingsSession(poolFieldsFor(locale), poolBase, { locale });
      const persist = async (values, operationSignal) => {
        operationSignal.throwIfAborted();
        let list = saved.candidates.map((c, i) => (typeof c === 'string' ? { id: c, tier: i + 1, tools: false } : { ...c }));
        for (const row of rows) {
          const id = row.value;
          if (!values[`member:${id}`]) {
            list = list.filter((c) => c.id !== id);
            continue;
          }
          const patch = {};
          if (values[`tier:${id}`] !== poolBase[`tier:${id}`]) patch.tier = Number(values[`tier:${id}`]);
          if (values[`tools:${id}`] !== poolBase[`tools:${id}`]) patch.tools = values[`tools:${id}`];
          if (!Object.keys(patch).length) continue;
          list = list.some((c) => c.id === id)
            ? list.map((c) => (c.id === id ? { ...c, ...patch } : c))
            : list.concat([{ id, tier: Number(values[`tier:${id}`]), tools: values[`tools:${id}`] }]);
        }
        if (JSON.stringify(list) !== JSON.stringify(saved.candidates))
          await commit({ ...copy(saved), candidates: list }, operationSignal);
        record(poolFieldsFor(locale), values, poolBase);
        poolBase = copy(values);
      };
      const reconcile = async () => {
        const now = configuredCandidates(ctx, rt.config.modelEconomist);
        saved = copy(rt.config.modelEconomist);
        poolBase = Object.fromEntries(rows.flatMap((row) => {
          const current = now.find((c) => c.value === row.value);
          return [
            [`member:${row.value}`, Boolean(current)],
            [`tier:${row.value}`, String(current?.tier ?? poolBase[`tier:${row.value}`])],
            [`tools:${row.value}`, current ? current.tools === true : poolBase[`tools:${row.value}`]],
          ];
        }));
        return copy(poolBase);
      };
      await openPiSettings(ui, common(session, {
        title: t('pool.title'),
        scope: t('pool.scope', { count: rows.length }),
        persist,
        reconcile,
      }));
    };
    const openSimulate = async () => {
      const { session, ...screen } = simulationScreen(locale, {
        run: async (text, operationSignal) => {
          const run = await decide(text, ctx, { simulate: true, signal: operationSignal });
          return explainLines(run.decision, saved, { locale });
        },
      });
      const result = await openPiSettings(ui, common(session, screen));
      if (result.action === 'run' && Array.isArray(result.actionValue) && !signal.aborted)
        await view(t('panel.simulation'), result.actionValue);
    };
    let carry;
    while (!signal.aborted) {
      locale = carry?.language ?? base.language;
      const session = new SettingsSession(fields(locale), base, { locale, messages: overrides(locale) });
      restoreDraft(session, carry);
      seen = pick(session.draft);
      const result = await openPiSettings(ui, common(session, {
        title: t('panel.title'),
        scope: scopeLine(locale),
        actions: actions(locale),
        persist: persistMain,
        reconcile: reconcileMain,
        onDraftChange,
      }));
      livePanel = undefined;
      carry = JSON.stringify(session.draft) !== JSON.stringify(base) ? session.draft : undefined;
      if (result.status !== 'succeeded' || !result.action || signal.aborted) break;
      if (result.action === 'pool') await openPool();
      else if (result.action === 'simulate') await openSimulate();
      else if (result.action === 'economics') {
        const report = economics.observer.report(economics.outcomes);
        await view(t('panel.economics'), [
          ...economicsHeader(report, locale).split('\n'),
          ...economicsLines(report, economics.capabilities.capabilities, locale, { stage: saved.rollout.stage, rollback: economics.rollback }),
        ]);
      } else if (result.action === 'explain') await view(t('panel.explain'), explainLines(last, saved, { locale }));
      else if (result.action === 'help') await view(t('panel.help'), localizedHelpLines(locale, usageText('economist', economistSpec).split('\n')));
      else break;
    }
    // A panel closed by a session switch or shutdown reports nothing into the next session.
    if (signal.aborted) return undefined;
    locale = base.language;
    return output(
      ctx,
      changes.length
        ? `${t('summary.changed', { count: changes.length })}\n${changes.map((c) => `· ${c}`).join('\n')}\n${t('summary.savedAt', { path: rt.configFile })}`
        : t('summary.none'),
    );
  };
  pi.registerCommand('economist', {
    description:
      'Model routing — (vazio abre o menu) | on | off | setup | cadence | mode | policy | thinking | ceiling | scope | role | candidates | budget | simulate | explain | help',
    getArgumentCompletions: buildCompletions(economistSpec),
    handler: async (args, ctx) => {
      await init(ctx);
      const argv = words(args);
      const [action = '', ...rest] = argv;
      const conf = rt.config.modelEconomist;
      const locked = rt.config.locked?.modelEconomist ?? {};
      const useGlobal = rest.includes('--global');
      const persist = (patch) => rt.save('modelEconomist', patch, { global: useGlobal });
      if (action === 'migrate') {
        if (!rest.some(v => ['--preview', '--write'].includes(v)) || rest.includes('--preview') && rest.includes('--write')) throw Error('Usage: /economist migrate --preview|--write');
        const raw = (await yamlFile(useGlobal ? rt.globalConfigFile : rt.configFile, true)).modelEconomist ?? {};
        const preview = migrationPreview(raw);
        if (useGlobal) delete preview.config.locale;
        if (rest.includes('--write')) { await validateActivation(merge(conf, preview.config));
          const written = await persist(preview.config); return output(ctx, { ...preview, preview: false, writes: true, written }); }
        return output(ctx, JSON.stringify(preview, null, 2));
      }
      if (action === 'off-policy') {
        const path = await safePath(rt.root, rest[0] ?? '', { existing: true });
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, economics.lifetime.signal]) : economics.lifetime.signal;
        const report = await runOperation(ctx, 'Offline IPS/SNIPS', async signal => {
          const { rows } = await readMatrix(path, { signal }); return evaluateOffline(rows, { mode: 'off-policy', signal });
        }, signal, { cancelHint: operationHint(ctx) });
        signal.throwIfAborted(); return output(ctx, report);
      }
      if (['preset', 'control', 'rollout', 'context-enabled', 'retrieval-budget', 'algorithm', 'bandit', 'privacy', 'privacy-classifier', 'privacy-telemetry', 'delegation'].includes(action)) {
        const patch = v2Patch(action, rest[0], conf);
        await validateActivation(merge(conf, patch));
        const written = await persist(patch);
        return output(ctx, `${action} → ${rest[0]} · ${written}`);
      }
      if (action === 'capabilities') return output(ctx, economics.capabilities.capabilities);
      if (action === 'metrics') return output(ctx, economicsLines(economics.observer.report(prepareOutcomes(await rt.store.rows('outcomes'))),
        economics.capabilities.capabilities, loadProjectLocale(rt.root, ctx.isProjectTrusted()).locale,
        { stage: conf.rollout.stage, rollback: economics.rollback }).join('\n'));
      if (action === 'evaluate') {
        const path = await safePath(rt.root, rest[0] ?? '', { existing: true });
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, economics.lifetime.signal]) : economics.lifetime.signal;
        const store = rt.store, policyFingerprint = economics.evidenceFingerprint();
        const { report, datasetHash } = await runOperation(ctx, 'Offline paired evaluation', async signal => {
          const { rows, text } = await readMatrix(path, { signal });
          return { report: await evaluateOffline(rows, { signal, minSamples: conf.adaptive.minSamples }), datasetHash: hash(text) };
        }, signal, { cancelHint: operationHint(ctx) });
        signal.throwIfAborted();
        await store.append('economics-evaluations', { id: uid(), report, occurredAt: now(), datasetHash, policyFingerprint });
        signal.throwIfAborted();
        await economics.acceptNewEvidence(report);
        return output(ctx, report);
      }
      /**
       * Every writable field in one table. The text commands and the dashboard both
       * go through it, so a lock or a validation can never be bypassed by one of them.
       */
      const FIELDS = {
        cadence: {
          lock: 'cadence',
          values: CADENCE_IDS,
          patch: (v) => ({ cadence: v }),
          note: (v) => `cadência → ${v}`,
        },
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
        fixed: {
          lock: 'thinking',
          values: THINKING_LEVELS,
          patch: (v) => ({ thinking: { fixed: v } }),
          note: (v) => `esforço fixo → ${v}`,
        },
        scope: {
          lock: 'scope',
          values: SCOPE_SOURCES.map((s) => s.value),
          patch: (v) => ({ scope: { source: v } }),
          note: (v) => `fonte do pool → ${v}`,
        },
      };
      const lockedField = {
        on: 'enabled',
        off: 'enabled',
        budget: 'budgetUsd',
        'classifier-model': 'classifier',
        setup: 'candidates',
        candidates: 'candidates',
        role: 'rolePreferences',
        ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.lock])),
      }[action];
      if (lockedField && Object.hasOwn(locked, lockedField))
        throw Error(
          `economist.${lockedField} is locked by global policy and cannot be changed from a command.`,
        );
      const apply = async (patch, note) => {
        const written = await persist(patch);
        // `rt.save` merges the patch into the live config as it writes, so the change
        // is already in effect: telling the user to `/reload` here taught them to
        // distrust a command that had just worked. `/reload` stays mentioned only where
        // it actually fixes something (a virtual model the runtime has not registered).
        output(ctx, `${note}\nsaved ${JSON.stringify(patch)} → ${written} · já em efeito`);
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
        const restoreManual = async () => {
          if (id === 'mode' && ['manual', 'off'].includes(value) && ctx.model?.provider === 'economist') {
            const previous = manualModel ?? physicalModels(ctx).find((m) => modelKey(m) === last?.selectedModelId);
            if (previous) await pi.setModel(previous);
          }
        };
        if (quiet) return persist(field.patch(value)).then(async () => {
          await restoreManual();
          return field.note(value);
        });
        return apply(field.patch(value), field.note(value)).then(async (note) => {
          await restoreManual();
          return note;
        });
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
        const restore = manualModel ?? physicalModels(ctx).find((m) => modelKey(m) === last?.selectedModelId) ?? physicalModels(ctx)[0];
        if (ctx.model?.provider === 'economist' && restore) await pi.setModel(restore);
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
      if (action === 'role') {
        const roleArgs = rest.filter((token) => token !== '--global');
        const [role, setting, value] = roleArgs;
        if (!role || role === 'list') {
          const prefs = conf.rolePreferences ?? defaults.modelEconomist.rolePreferences;
          return output(
            ctx,
            MODEL_ROLES.map((name) => {
              const preference = prefs[name] ?? {};
              return `${name}: ${preference.model ?? 'automatic'} · effort ${preference.effort ?? 'automatic'} · fallback ${preference.allowFallback === true ? 'on' : 'off'}`;
            }).join('\n'),
          );
        }
        if (!MODEL_ROLES.includes(role)) throw Error('role must be planner, executor, reviewer, or list');
        const rolePreferences = structuredClone(conf.rolePreferences ?? defaults.modelEconomist.rolePreferences);
        const preference = rolePreferences[role] ?? { model: null, effort: null, allowFallback: false };
        if (setting === 'model') {
          if (value === 'clear') preference.model = null;
          else {
            if (!value || !conf.candidates.some((candidate) => specId(candidate) === value))
              throw Error(`${role} preference must use a model already in the approved candidates pool; add it first with /economist candidates add.`);
            const scope = poolScope(ctx);
            if (scope.strict && !scope.ids.has(value))
              throw Error(`${value} is outside the active /scoped-models set; it cannot be preferred for ${role}.`);
            preference.model = value;
          }
        } else if (setting === 'fallback') {
          if (!['on', 'off'].includes(value)) throw Error(`Usage: /economist role ${role} fallback on|off`);
          preference.allowFallback = value === 'on';
        } else if (setting === 'effort') {
          const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
          if (value === 'auto') preference.effort = null;
          else if (levels.includes(value)) preference.effort = value;
          else throw Error(`Usage: /economist role ${role} effort ${levels.join('|')}|auto`);
        } else {
          throw Error(`Usage: /economist role ${role} model PROVIDER/MODEL|clear, effort off|minimal|low|medium|high|xhigh|max|auto, or fallback on|off`);
        }
        rolePreferences[role] = preference;
        return apply(
          { rolePreferences },
          `${role} preference → model ${preference.model ?? 'automatic'}, effort ${preference.effort ?? 'automatic'}, fallback ${preference.allowFallback ? 'on' : 'off'}`,
        );
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
          if (next.length === conf.candidates.length) {
            if (refreshesScopeEachPrompt() && poolScope(ctx).active && poolScope(ctx).ids.has(target))
              throw Error(`${target} vem do /scoped-models. Remova-o lá para tirá-lo do pool.`);
            throw Error(`${target} is not in the pool`);
          }
          const stays =
            refreshesScopeEachPrompt() && poolScope(ctx).active && poolScope(ctx).ids.has(target);
          return apply(
            { candidates: next },
            stays
              ? `ajuste de ${target} removido; ele continua disponível pelo /scoped-models`
              : `removed ${target}`,
          );
        }
        throw Error('candidates list|add|remove');
      }
      if (action === 'budget') {
        const value = Number(rest[1]);
        const budgetScope = rest[0], field = { task: 'budgetUsd', session: 'sessionBudgetUsd', project: 'projectBudgetUsd' }[budgetScope];
        if (!field || !Number.isFinite(value) || value <= 0 || rest[2] !== 'USD') throw Error('Usage: /economist budget task|session|project 0.50 USD');
        if (Object.hasOwn(locked, field)) throw Error(`economist.${field} is locked by global policy`);
        await persist({ [field]: value });
        if (budgetScope === 'task' && !scopeOf(ctx).taskId) setTask(pi, `ADHOC-${uid().slice(0, 8)}`);
        await rt.store.append('budgets', {
          id: uid(),
          scope: budgetScope,
          scopeId: budgetScope === 'task' ? scopeOf(ctx).taskId : budgetScope === 'session' ? scopeOf(ctx).sessionId : rt.projectId,
          hardUsd: value,
          softUsd: value * 0.8,
          source: 'economist-command',
          occurredAt: now(),
        });
        return output(
          ctx,
          `${budgetScope} budget ${value} USD (warn at ${Math.round(value * 0.8)})`,
        );
      }
      if (action === 'simulate') {
        const words = [...rest];
        let qualityFloorOverride = null;
        const fl = words.indexOf('--floor');
        if (fl >= 0) {
          qualityFloorOverride = Number(words[fl + 1]);
          if (!(qualityFloorOverride > 0 && qualityFloorOverride <= 1))
            throw Error('--floor precisa de um número em (0, 1]');
          words.splice(fl, 2);
        }
        if (!words.length)
          throw Error('simulate "text" [--floor 0.8] — for example: /economist simulate "add auth to the api"');
        const r = await decide(words.join(' '), ctx, { simulate: true, qualityFloorOverride });
        return output(ctx, r.decision);
      }
      if (action === 'benchmark') {
        const at = rest.indexOf('--dataset');
        if (at < 0) throw Error('benchmark --dataset PATH [--holdout-before ISO] [--policy POLICY]');
        const data = await readFile(
          await safePath(rt.root, rest[at + 1], { existing: true }),
          'utf8',
        );
        const rows = data
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        if (rows.length > 1000) throw Error('Dataset limit 1000');
        const flag = (name) => {
          const i = rest.indexOf(name);
          return i >= 0 ? rest[i + 1] : null;
        };
        if (rows.length && rows.every((r) => Array.isArray(r.actions ?? r.results))) {
          const only = flag('--policy');
          return output(
            ctx,
            benchmarkMatrix(rows, {
              conf,
              holdoutBefore: flag('--holdout-before'),
              ...(only ? { policies: [only] } : {}),
            }),
          );
        }
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
      if (action === 'explain') {
        if (!last)
          return output(
            ctx,
            `No routing decision yet · ${candidates(ctx).length} usable candidate(s) · mode ${conf.mode}, policy ${conf.policy}\nSend a request, preview free with /economist simulate "text", or configure with /economist setup.`,
          );
        const calibration = await calibrationFor();
        return output(ctx, explainLines(last, conf, { calibration }).join('\n'));
      }
      if (action === 'json') return output(ctx, last ?? { message: 'No routing decision yet' });
      if (action === 'help') return output(ctx, usageText('economist', economistSpec));
      throw Error(`Unknown /economist ${action}\n${usageText('economist', economistSpec)}`);
    },
  });
}
