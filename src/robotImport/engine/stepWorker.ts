/**
 * STEP → triangles, off the main thread. occt-import-js (LGPL-2.1, OpenCascade compiled to wasm)
 * tessellates the B-rep; this worker turns its JSON into transferable typed arrays, one part per
 * colour. Spawned by `stepReader.ts` only when a STEP file is dropped, so neither the 97 KB glue
 * nor the 7.6 MB wasm is fetched by anyone else.
 */
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { stepToParts, type StepRequest, type StepResponse } from './stepConvert';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<StepRequest>) => void) | null;
  postMessage(msg: StepResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent<StepRequest>) => {
  try {
    ctx.postMessage({ kind: 'progress', stage: 'step-wasm' });
    const occt = await occtimportjs({ locateFile: () => wasmUrl });
    ctx.postMessage({ kind: 'progress', stage: 'step-parse' });
    const res = occt.ReadStepFile(new Uint8Array(e.data.bytes), e.data.params);
    const out = stepToParts(res);
    const transfer: Transferable[] = [];
    if (out.kind === 'done') for (const p of out.parts) transfer.push(p.positions.buffer, p.indices.buffer);
    ctx.postMessage(out, transfer);
  } catch (err) {
    ctx.postMessage({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
