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
import { triangleCount } from '../geometry';
import { exportGlbStored } from './bake';
import { partsFromObject } from './load';
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
 * measured size, the way `bake` refits to `MAX_MESH_BYTES`.
 */
export async function liteMesh(glb: ArrayBuffer, maxBytes: number): Promise<ArrayBuffer | null> {
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  let parts = mergeByColour(partsFromObject(gltf.scene, false).filter((p) => p.positions.length >= 9));
  disposeTree(gltf.scene);
  if (!triangleCount(parts)) return null;
  let bytes = glb.byteLength;
  for (let pass = 0; pass < 6; pass++) {
    const budget = Math.max(MIN_TRIANGLES, Math.floor((triangleCount(parts) * maxBytes * AIM) / bytes));
    const s = await simplifyParts(parts.map((p) => ({ ...p, normals: null })), budget);
    parts = s.parts;
    const out = await exportGlbStored(creaseParts(parts));
    if (out.byteLength <= maxBytes) return out;
    if (budget <= MIN_TRIANGLES) return null;
    bytes = out.byteLength;
  }
  return null;
}
