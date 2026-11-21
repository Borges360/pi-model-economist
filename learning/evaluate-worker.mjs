import { parentPort, workerData } from 'node:worker_threads';
import { evaluateAblations, offPolicy } from './calibration.mjs';
try {
  const report = workerData.mode === 'off-policy' ? offPolicy(workerData.rows, row => row.targetProbability)
    : evaluateAblations(workerData.rows, workerData.options);
  parentPort.postMessage({ report });
} catch (error) {
  const message = /^(?:Invalid ablation matrix|Ablation row missing experimental controls|Duplicate task\/seed\/arm)$/.test(error.message)
    ? error.message : 'Offline evaluation rejected invalid input';
  parentPort.postMessage({ error: message });
}
