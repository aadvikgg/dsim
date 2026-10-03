/**
 * THE LIGHTER MESH for a room's visuals relay (`src/net/importVisuals.ts`): the stored GLB cut down
 * to fit the relay's 1 MiB, colours kept, STAYING IN THE STORED MESH FRAME so every viewer places it
 * with the same `STORED_MESH_TO_ROBOT` it uses for the full one.
 *
 * It does not go back through `normalise`/`bake`: those re-measure the model (units, up axis,
 * origin, wheels) and a re-detection could land the lighter mesh a hair off the footprint the
 * sim was told about. This reads the GLB, simplifies the SAME vertices with the importer's own
 * simplifier, re-creases the normals and writes it back, so nothing about where the robot is moves.
 * The stored mesh is already welded, one part per colour, with no textures.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { triangleCount, type MeshPart } from '../geometry';
import { exportStoredScene, readStoredScene, sceneParts, type StoredScene } from './bakeMesh';
import { creaseParts, disposeTree } from './meshGroup';
import { mergeByColour } from './meshOps';
import { simplifyParts } from './simplify';

/** below this a robot stops looking like itself, so the relay sends the picture alone instead */
const MIN_TRIANGLES = 400;
/** aim a little under the cap: the export's size is only roughly linear in the triangle count */
const AIM = 0.85;

/**
 * `glb` (the stored mesh) as a GLB of at most `maxBytes`, or null when it cannot be brought under
 * that without dropping below `MIN_TRIANGLES`. Up to six passes, each aimed from the last export's
 * measured size, the way `bake` refits to `MAX_MESH_BYTES`. The moving parts stay nodes of their own
 * (`readStoredScene`), each simplified to its share; the body ids are left out (a viewer has no use
 * for them, and they are a tenth of the bytes).
 */
export async function liteMesh(glb: ArrayBuffer, maxBytes: number): Promise<ArrayBuffer | null> {
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  const read = readStoredScene(gltf.scene);
  disposeTree(gltf.scene);
  const tidy = (parts: MeshPart[]): MeshPart[] => mergeByColour(parts).map((p) => ({ ...p, body: null }));
  let scene: StoredScene = { rest: tidy(read.rest), moving: read.moving.map((m) => ({ ...m, parts: tidy(m.parts) })) };
  if (!triangleCount(sceneParts(scene))) return null;
  let bytes = glb.byteLength;
  for (let pass = 0; pass < 6; pass++) {
    const total = triangleCount(sceneParts(scene));
    const budget = Math.max(MIN_TRIANGLES, Math.floor((total * maxBytes * AIM) / bytes));
    const ratio = budget / Math.max(1, total);
    const cut = async (parts: MeshPart[]): Promise<MeshPart[]> =>
      // the simplifier numbers the connected pieces of a part with no ids; the relay has no use for them
      parts.length ? (await simplifyParts(parts.map((p) => ({ ...p, normals: null })), Math.max(12, Math.floor(triangleCount(parts) * ratio)))).parts.map((p) => ({ ...p, body: null })) : parts;
    const rest = await cut(scene.rest);
    const moving: StoredScene['moving'] = [];
    for (const m of scene.moving) moving.push({ ...m, parts: await cut(m.parts) });
    scene = { rest, moving };
    const out = await exportStoredScene({ rest: creaseParts(scene.rest), moving: scene.moving.map((m) => ({ ...m, parts: creaseParts(m.parts) })) });
    if (out.byteLength <= maxBytes) return out;
    if (budget <= MIN_TRIANGLES) return null;
    bytes = out.byteLength;
  }
  return null;
}
