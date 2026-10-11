import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { benchmark } from '../benchmark.mjs';
test('paired measured replay bootstrap reproducible; missing prices/acceptance do not invent savings', () => {
  const records = [
    { verifiedAccepted: true, observedCost: 0.2, baselineCost: 0.5 },
    { verifiedAccepted: true, observedCost: 0.3, baselineCost: 0.6 },
    { verifiedAccepted: false, observedCost: 0.1, baselineCost: 0.9 },
  ];
  const a = benchmark(records),
    b = benchmark(records);
  assert.deepEqual(a, b);
  assert.equal(a.pairedAccepted, 2);
  assert.ok(Math.abs(a.costPerAcceptedTask - 0.3) < 1e-12); // Failed attempts remain in the numerator.
  assert.equal(a.baselineCostPerAcceptedTask, null); // No invented baseline acceptance.
  assert.equal(benchmark([{ verifiedAccepted: false }]).costPerAcceptedTask, null);
});
