/**
 * Read a STEP file in a worker (`stepWorker.ts`). Reached only through `load.ts`'s dynamic
 * `import('./stepReader')`, so the worker, its occt glue and the wasm are fetched only when a STEP
 * file is dropped. occt converts to millimetres itself, so a STEP file's unit is KNOWN.
 *
 * occt reports no progress and cannot be interrupted from inside, and a 100 MB export keeps it busy
 * for minutes: `signal` TERMINATES the worker, which is the only way to stop it.
 */
import { abortError } from './importError';
import { STEP_PARAMS, type StepPart, type StepResponse } from './stepConvert';

export type StepProgress = (stage: 'step-wasm' | 'step-parse') => void;

export function readStep(bytes: ArrayBuffer, onProgress?: StepProgress, signal?: AbortSignal): Promise<{ parts: StepPart[]; trisIn: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./stepWorker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const onAbort = (): void => {
      worker.terminate();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const end = (): void => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<StepResponse>) => {
      const m = e.data;
      if (m.kind === 'progress') {
        onProgress?.(m.stage);
        return;
      }
      end();
      if (m.kind === 'done') resolve({ parts: m.parts, trisIn: m.trisIn });
      else reject(new Error(m.message));
    };
    worker.onerror = (e) => {
      end();
      reject(new Error(e.message || 'the STEP reader stopped'));
    };
    worker.postMessage({ bytes, params: STEP_PARAMS }, [bytes]);
  });
}
