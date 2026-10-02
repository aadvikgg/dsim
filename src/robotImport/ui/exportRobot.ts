/**
 * EXPORT: a library robot as one `.glb` that any glTF viewer opens and that carries the DSIM setup
 * (`shareFile.ts`, plan §3.3). No three.js: the stored GLB is re-wrapped at the byte level, so the
 * robot page can export without loading the engine. Both modules are `import()`ed so the main chunk
 * carries neither.
 */
import type { GameId, RobotSpec } from '../../types';
import type { ImportSetup } from '../types';

/** `Ironclad 2` → `ironclad-2.dsim.glb` */
export function shareFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'robot'}.dsim.glb`;
}

/** hand the browser a file to save */
export function downloadBytes(bytes: Uint8Array | Blob, filename: string): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([new Uint8Array(bytes)], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // the download has the URL by the next task; revoking sooner cancels it in some browsers
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** a share file from a stored mesh and the setup that goes with it */
export async function shareBytes(mesh: Blob, payload: { game: GameId; spec: RobotSpec; setup: ImportSetup; name: string }): Promise<Uint8Array> {
  const { writeShareFile } = await import('../shareFile');
  return writeShareFile(new Uint8Array(await mesh.arrayBuffer()), payload);
}

/** export one library robot; resolves to null, or the sentence to show */
export async function exportLibraryRobot(id: string): Promise<string | null> {
  const { getRobot } = await import('../library');
  const got = await getRobot(id);
  if (!got.ok) return got.message;
  const r = got.value;
  try {
    const bytes = await shareBytes(r.mesh, { game: r.game, spec: r.spec, setup: r.setup, name: r.spec.name || 'Robot' });
    downloadBytes(bytes, shareFileName(r.spec.name));
    return null;
  } catch (e) {
    console.warn('[import] export failed', e);
    return `Couldn’t export ${r.spec.name || 'this robot'}. Try again.`;
  }
}
