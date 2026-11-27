---
name: pi-model-economist
description: Maintain Pi Model Economist's scoped model-and-effort routing, policy, budget, and offline evaluation.
---

# Pi Model Economist

Use this specialization for work in the Pi Model Economist repository. Shared
Harness procedures remain in the workspace catalog; this guide records the
product's local behavior and safety boundaries.

## Routing contract

- Rank eligible `(model, effort)` actions from configured capabilities and
  evidence. Pi dispatches the selected model; this extension does not answer
  tasks, call a model to simulate, or guarantee model competence or savings.
- Keep classification mode, re-evaluation cadence, selection policy and
  thinking-effort mode independent. Preserve quality/risk floors, budgets and
  fallback behavior when changing ranking or routing.
- Missing prices and measurements stay unknown. Do not invent cost, latency,
  quality, provider availability or benchmark outcomes.
- `/economist simulate` is a synthetic decision; `/economist benchmark` replays
  an existing measured matrix offline. Neither performs inference or network IO.
- `economist_subagent_model` returns model-and-effort advice to its integrating
  parent; it does not change the parent or dispatch a model.

## Configuration and privacy

- Read and write only the `modelEconomist` section. Respect precedence and
  locked global policy; project language is saved only in a trusted project's
  `.pi/pi-suite.yaml` and is not inherited from global configuration.
- Candidate setup may inspect scoped model metadata and asks before writing.
  Never inspect live provider credentials, API tokens, or persistent Pi
  configuration during routine repository work.
- Use synthetic, offline fixtures. Do not call providers, models, external
  benchmarks or network services in tests.
- The extension's choices do not establish provider quality or isolate other
  tools. Do not describe routing as a sandbox or an externally verified saving.

## Interface and verification

- Version 2.0 context/cache economics lives in `context/`, `economics/`,
  `routing/adaptive.mjs`, `learning/calibration.mjs`, `topology/` and
  `observability/`; read `docs/v2.md` for the integration contract.
- Preserve observed/derived/estimated/unknown provenance. Host price calculations
  are not invoices; absent cache retention or usage is never a universal TTL,
  hit probability or zero. Cache is counted inside input cost exactly once.
- Keep artifacts in private project-scoped operational storage, separate from
  metadata-only audit events. Recovery handles cannot escape the store.
- `economist_delegate` is separate from the advice tool. Its native Pi Agent
  worker requires explicit enabling, bounded budgets/permissions and lead review.
  Native verifiers check JSON, literal content or JavaScript syntax, without
  arbitrary shell execution. An enforcing adapter may replace the native worker.
  Never infer OS isolation or verified success from a worker's self-report.
- Adaptive/bandit activation needs paired measured evidence and family samples.
  Tests and synthetic ablations do not prove real workload savings. Rollback
  persists across session changes until new eligible evidence is evaluated.
- Run `npm test`, `npm run test:host` (installed Pi with synthetic metadata) and
  `npm pack --dry-run` for release changes. Do not publish implicitly.

- `/economist` opens the settings panel (vendored adapter in
  `vendor/inteiro-terminal/`; never edit it by hand). Keep command names and
  native Pi completion aligned with configured values; drafts and saves must
  retain the documented Ctrl+S/Escape behavior.
- Read `README.md` and `docs/fluxo-de-decisao.md` before changing behavior;
  consult `decision.mjs`, `routing.mjs`, `extension.mjs`, and `benchmark.mjs` for
  the corresponding implementation.
- For context-only work, run `test/agent-context.test.mjs` and
  `.harness/project.mjs verify`. Behavior changes require the declared local
  unit suite and relevant additional checks.
- No INTEIRO design-system role is selected for this product. Do not infer
  adoption from shared Harness metadata, and preserve the mark's license notice.
  The vendored panel adapter is code only: it paints with the Pi host theme.
- Live Pi sessions, provider calls, persistent user settings and publication
  require separate authorization.
