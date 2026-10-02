/**
 * THE IMPORT WORKER: parse, merge, weld, simplify and crease a dropped model OFF the main thread, and
 * send the prepared model (≤ 150k triangles) back with its arrays transferred. Spawned per import by
 * `importSession.ts` and terminated when it answers or the player cancels, so the meshopt heap a
 * 4M-triangle export grows (hundreds of MB) is given back the moment the import is done.
 *
 * Reads GLB, glTF, STL, OBJ and PLY itself (`parse.ts`); a STEP or 3MF file arrives as parts read
 * elsewhere. Every failure comes back as `{ kind: 'error' }` with the `ImportError` code, so the
 * player sees the same sentence the main-thread loader would have given.
 *
 * It also runs the bake's mesh half (`{ kind: 'bake' }`, `bakeMesh.ts`): the GLB export and its
 * refits, so Save does not block on them either.
 */
import { bakeMeshHere } from './bakeMesh';
import { ImportError } from './importError';
import type { ImportRequest, ImportResponse } from './importProtocol';
import { partBuffers } from './importProtocol';
import { assembleLoaded, parseFiles } from './parse';
import { simplifyModel } from './prepare';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ImportRequest>) => void) | null;
  postMessage(msg: ImportResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent<ImportRequest>) => {
  const req = e.data;
  const post = (m: ImportResponse, transfer?: Transferable[]): void => ctx.postMessage(m, transfer);
  try {
    if (req.kind === 'bake') {
      const { glb, parts, refits } = await bakeMeshHere(req.parts);
      post({ kind: 'baked', glb, parts, refits }, [glb, ...partBuffers(parts)]);
      return;
    }
    let loaded;
    if (req.kind === 'files') {
      const file = req.files[req.primary];
      const parsed = await parseFiles(file, req.files, req.format, (stage, frac) => post({ kind: 'progress', stage, frac }), () => import('./meshoptDecoder').then((m) => m.MeshoptDecoder));
      post({ kind: 'progress', stage: 'convert' });
      loaded = assembleLoaded(file.name, req.format, parsed);
    } else {
      post({ kind: 'progress', stage: 'convert' });
      loaded = assembleLoaded(req.name, req.format, req.parsed);
    }
    const tris = loaded.trisIn;
    post({ kind: 'progress', stage: 'simplify', frac: 0, tris });
    let last = 0;
    const model = await simplifyModel(loaded, req.budget, (frac) => {
      if (frac - last < 0.02 && frac < 1) return;
      last = frac;
      post({ kind: 'progress', stage: 'simplify', frac, tris });
    });
    post({ kind: 'done', model }, partBuffers(model.parts));
  } catch (err) {
    post({
      kind: 'error',
      code: err instanceof ImportError ? err.code : null,
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
