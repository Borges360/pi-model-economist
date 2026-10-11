// Reproducible paired replay. Input provenance/evidence must be reviewed by the operator.
export function benchmark(records, { seed = 12345, resamples = 1000 } = {}) {
  if (
    !Array.isArray(records) ||
    records.length > 10000 ||
    !Number.isInteger(resamples) ||
    resamples < 100 ||
    resamples > 10000
  )
    throw Error('Invalid benchmark records/budget');
  const paired = records.filter(
    (r) =>
      Number.isFinite(r.observedCost) &&
      r.observedCost >= 0 &&
      Number.isFinite(r.baselineCost) &&
      r.baselineCost >= 0,
  );
  const accepted = paired.filter((r) => r.verifiedAccepted === true),
    baselineAccepted = paired.filter((r) => r.baselineVerifiedAccepted === true);
  if (!paired.length)
    return {
      tasks: records.length,
      pairedAccepted: 0,
      costPerAcceptedTask: null,
      baselineCostPerAcceptedTask: null,
      savingsConfidenceInterval: null,
      measuredCoverage: 0,
    };
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const sum = (xs) => xs.reduce((a, b) => a + b, 0),
    mean = (xs) => sum(xs) / xs.length;
  const deltas = paired.map((r) => r.baselineCost - r.observedCost),
    samples = [];
  for (let i = 0; i < resamples; i++)
    samples.push(
      mean(
        Array.from({ length: paired.length }, () => deltas[Math.floor(random() * paired.length)]),
      ),
    );
  samples.sort((a, b) => a - b);
  return {
    tasks: records.length,
    pairedAccepted: accepted.length,
    pairedMeasured: paired.length,
    costPerAcceptedTask: accepted.length
      ? sum(paired.map((r) => r.observedCost)) / accepted.length
      : null,
    baselineCostPerAcceptedTask: baselineAccepted.length
      ? sum(paired.map((r) => r.baselineCost)) / baselineAccepted.length
      : null,
    baselineAcceptanceCoverage:
      paired.filter((r) => typeof r.baselineVerifiedAccepted === 'boolean').length / paired.length,
    meanSavingsUSD: mean(deltas),
    savingsConfidenceInterval: [
      samples[Math.floor(samples.length * 0.025)],
      samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.975))],
    ],
    measuredCoverage: paired.length / records.length,
    seed,
    resamples,
  };
}
