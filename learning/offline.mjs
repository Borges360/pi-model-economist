import { Worker } from 'node:worker_threads';
import { open } from 'node:fs/promises';
export async function readMatrix(path, { signal, maxBytes = 16000000, maxRows = 10000 } = {}) {
  signal?.throwIfAborted();
  const file = await open(path, 'r'), chunks = []; let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted(); const buffer = Buffer.alloc(65536), { bytesRead } = await file.read(buffer);
      if (!bytesRead) break; size += bytesRead;
      if (size > maxBytes) throw Error('Offline matrix exceeds size limit'); chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally { await file.close(); }
  const text = Buffer.concat(chunks).toString('utf8'), rows = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    signal?.throwIfAborted(); if (!line.trim()) continue;
    if (rows.length >= maxRows) throw Error('Offline matrix exceeds row limit');
    try { rows.push(JSON.parse(line)); } catch { throw Error(`Invalid JSON at matrix line ${index + 1}`); }
  }
  return { rows, text };
}
export async function evaluateOffline(rows, { mode = 'ablations', signal, timeoutMs = 30000, ...options } = {}) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./evaluate-worker.mjs', import.meta.url), { workerData: { rows, mode, options },
    resourceLimits: { maxOldGenerationSizeMb: 192 } });
  let abort, timer;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason ?? Error('Offline evaluation cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(Error('Offline evaluation timed out')), timeoutMs);
      worker.once('message', message => message.error ? reject(Error(message.error)) : resolve(message.report));
      worker.once('error', () => reject(Error('Offline evaluation worker failed')));
      worker.once('exit', code => { if (code) reject(Error('Offline evaluation worker stopped')); });
    });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await worker.terminate(); }
}
