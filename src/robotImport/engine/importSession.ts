/**
 * THE EDITOR'S IMPORT: dropped files → a prepared model, with the main thread left free. The heavy
 * work (parse, merge, weld, simplify, crease) runs in a fresh `importWorker.ts` per import; STEP is
 * read in its own worker first and 3MF on this thread (three's loader needs `DOMParser`), and their
 * parts then go to the import worker for the rest. Arrays travel TRANSFERRED both ways.
 *
 * `signal` cancels: every worker this import started is terminated at once (an occt read or a
 * meshopt pass cannot be interrupted from inside), and the promise rejects with an `AbortError`.
 *
 * Where a worker cannot start (no `Worker`, or a script that fails to load), the same steps run
 * here on the main thread through `load.ts`, as they always did.
 */
import type { MeshPart } from '../geometry';
import { bakeMeshHere } from './bakeMesh';
import { ImportError, abortError } from './importError';
import { partBuffers, type ImportProgress, type ImportRequest, type ImportResponse } from './importProtocol';
import { checkFiles, loadModel, readRaw } from './load';
import { WORKER_FORMATS } from './parse';
import { simplifyModel, type PreparedModel } from './prepare';

export interface ImportOptions {
  /** the triangle budget (`ImportSetup.triBudget`) */
  budget: number;
  onProgress?: (p: ImportProgress) => void;
  signal?: AbortSignal;
}

/** null where a module worker cannot be made at all */
function spawn(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./importWorker.ts', import.meta.url), { type: 'module' });
  } catch (e) {
    console.warn('[import] the import worker could not start; reading on the main thread', e);
    return null;
  }
}

/** the same steps on this thread (no worker) */
async function onMainThread(files: File[], opts: ImportOptions): Promise<PreparedModel> {
  const loaded = await loadModel(files, (stage, frac) => opts.onProgress?.({ stage, frac }), { signal: opts.signal });
  if (opts.signal?.aborted) throw abortError();
  opts.onProgress?.({ stage: 'simplify', tris: loaded.trisIn });
  // a frame for the label to paint before the synchronous part of simplification
  await new Promise((r) => setTimeout(r, 30));
  return simplifyModel(loaded, opts.budget);
}

/**
 * The bake's mesh half (`bakeMeshHere`) in a fresh import worker, the result transferred back; on
 * this thread where a worker cannot start or stops. The parts are COPIED there (a few MB, a few
 * milliseconds), so this thread still has them to fall back on.
 */
export async function bakeMeshOff(parts: MeshPart[]): Promise<{ glb: ArrayBuffer; parts: MeshPart[]; refits: number }> {
  const worker = spawn();
  if (!worker) return bakeMeshHere(parts);
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ImportResponse>) => {
      const m = e.data;
      if (m.kind === 'progress') return;
      worker.terminate();
      if (m.kind === 'baked') resolve({ glb: m.glb, parts: m.parts, refits: m.refits });
      else reject(new Error(m.kind === 'error' ? m.message : 'unexpected answer from the import worker'));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      console.warn('[import] the bake worker stopped; baking on the main thread', e.message);
      bakeMeshHere(parts).then(resolve, reject);
    };
    worker.postMessage({ kind: 'bake', parts } satisfies ImportRequest);
  });
}

/** read and prepare `input` (the editor's `readModel`); throws `ImportError` or `AbortError` */
export async function importModel(input: readonly File[] | FileList, opts: ImportOptions): Promise<PreparedModel> {
  const { files, file, format } = checkFiles(input);
  if (opts.signal?.aborted) throw abortError();
  const worker = spawn();
  if (!worker) return onMainThread(files, opts);
  let request: ImportRequest;
  let transfer: Transferable[] = [];
  try {
    if (WORKER_FORMATS.includes(format)) {
      request = { kind: 'files', files, primary: files.indexOf(file), format, budget: opts.budget };
    } else {
      // STEP (its own worker) or 3MF (here), then the merge and simplify in the import worker
      const raw = await readRaw(files, (stage, frac) => opts.onProgress?.({ stage, frac }), { signal: opts.signal });
      request = { kind: 'parts', name: raw.file.name, format: raw.format, parsed: raw.parsed, budget: opts.budget };
      transfer = partBuffers(raw.parsed.parts);
    }
  } catch (e) {
    worker.terminate();
    throw e;
  }
  return new Promise<PreparedModel>((resolve, reject) => {
    let heard = false;
    const done = (): void => {
      opts.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = (): void => {
      done();
      reject(abortError());
    };
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<ImportResponse>) => {
      heard = true;
      const m = e.data;
      if (m.kind === 'progress') {
        opts.onProgress?.({ stage: m.stage, frac: m.frac, tris: m.tris });
        return;
      }
      done();
      if (m.kind === 'done') resolve(m.model);
      else if (m.kind !== 'error') reject(new Error('unexpected answer from the import worker'));
      else if (m.code) reject(new ImportError(m.code, m.message));
      else {
        const err = new Error(m.message);
        err.name = m.name;
        reject(err);
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      done();
      // a worker that never said a word did not load (a blocked module script, an old browser):
      // do it here instead. One that failed part-way ran out of something; say so.
      if (!heard && request.kind === 'files') {
        console.warn('[import] the import worker did not start; reading on the main thread', e.message);
        onMainThread(files, opts).then(resolve, reject);
      } else {
        reject(new ImportError('corrupt', `Couldn’t finish reading ${file.name} (${e.message || 'the reader stopped'}). Export it again, or with fewer parts, and retry.`));
      }
    };
    worker.postMessage(request, transfer);
  });
}
