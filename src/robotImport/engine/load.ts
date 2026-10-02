/**
 * Files → parts. One loader per format, all ending in the same place: `MeshPart`s in the SOURCE
 * frame (world transforms applied, the file's own units and axes), merged by colour. Textures are
 * stripped before parsing — the importer keeps colours only, and decoding a 4K texture to throw
 * it away is the slowest part of loading many glTF files.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { triangleCount, type MeshPart } from '../geometry';
import type { LengthUnit, ModelFormat } from '../types';
import { mergeByColour, splitByVertexColour } from './meshOps';

export type ImportErrorCode = 'no-file' | 'unsupported' | 'too-large' | 'corrupt' | 'empty' | 'missing-file' | 'draco' | 'step-failed';

/** a load failure with a sentence the UI can show as is (copy: docs/area/ui.md) */
export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export type LoadStage = 'read' | 'parse' | 'step-wasm' | 'step-parse' | 'convert';
export type LoadProgress = (stage: LoadStage) => void;

export interface LoadedModel {
  /** the primary file's name */
  name: string;
  format: ModelFormat;
  /** bytes of every file that was used */
  bytes: number;
  /** the unit the file declares (STEP: occt converts to mm; 3MF: its `unit`), else null */
  fileUnit: LengthUnit | null;
  /** SOURCE frame, merged by colour */
  parts: MeshPart[];
  trisIn: number;
  /** plain notes about what was dropped or assumed */
  notes: string[];
}

/** the largest file the importer reads (a full-robot STEP export is typically 20–150 MB) */
export const MAX_FILE_BYTES = 400 * 1024 * 1024;

const EXT_FORMAT: Record<string, ModelFormat> = {
  glb: 'glb',
  gltf: 'gltf',
  stl: 'stl',
  obj: 'obj',
  '3mf': '3mf',
  ply: 'ply',
  step: 'step',
  stp: 'step',
};
/** which file is the model when several are dropped together */
const PRIORITY: ModelFormat[] = ['glb', 'gltf', 'step', '3mf', 'obj', 'stl', 'ply'];

const extOf = (name: string): string => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
const baseName = (path: string): string => decodeURIComponent(path.split(/[\\/]/).pop() ?? path).toLowerCase();

/** sRGB-ish neutral grey for formats with no colour at all, as linear */
const DEFAULT_LINEAR: [number, number, number] = [0.42, 0.43, 0.45];

/** which of these files would be read, and as what (null when none is a supported model) */
export function pickModelFile(files: readonly File[]): { file: File; format: ModelFormat } | null {
  let best: { file: File; format: ModelFormat } | null = null;
  for (const f of files) {
    const fmt = EXT_FORMAT[extOf(f.name)];
    if (!fmt) continue;
    if (!best || PRIORITY.indexOf(fmt) < PRIORITY.indexOf(best.format)) best = { file: f, format: fmt };
  }
  return best;
}

/**
 * Read dropped files into parts. Several files may be dropped together: a `.gltf` with its
 * `.bin`, an `.obj` with its `.mtl`. Throws `ImportError` with a sentence for the player.
 */
export async function loadModel(input: readonly File[] | FileList, onProgress?: LoadProgress): Promise<LoadedModel> {
  const files = Array.from(input as ArrayLike<File>);
  if (!files.length) throw new ImportError('no-file', 'Choose a robot file to import.');
  const pick = pickModelFile(files);
  if (!pick) {
    const names = files.map((f) => f.name).join(', ');
    throw new ImportError('unsupported', `Couldn’t read ${names}: DSIM imports GLB, glTF, STEP, STL, OBJ, 3MF and PLY. Export the robot in one of those and try again.`);
  }
  const { file, format } = pick;
  if (file.size > MAX_FILE_BYTES) {
    throw new ImportError('too-large', `${file.name} is ${Math.round(file.size / 1048576)} MB; the importer reads files up to ${MAX_FILE_BYTES / 1048576} MB. Export without hidden parts or fasteners and try again.`);
  }
  if (file.size === 0) throw new ImportError('empty', `${file.name} is empty. Export it again and retry.`);
  onProgress?.('read');
  const notes: string[] = [];
  let bytes = file.size;
  let parts: MeshPart[];
  let fileUnit: LengthUnit | null = null;
  let trisIn = 0;
  try {
    switch (format) {
      case 'glb':
      case 'gltf': {
        const r = await loadGltf(file, files, format, onProgress);
        parts = r.parts;
        bytes = r.bytes;
        notes.push(...r.notes);
        break;
      }
      case 'step': {
        const buf = await file.arrayBuffer();
        const { readStep } = await import('./stepReader');
        let res: Awaited<ReturnType<typeof readStep>>;
        try {
          res = await readStep(buf, (s) => onProgress?.(s));
        } catch (e) {
          throw new ImportError('step-failed', `Couldn’t read ${file.name} as STEP (${e instanceof Error ? e.message : 'unknown error'}). Export it again as STEP AP214 or AP242, or try GLB.`);
        }
        parts = res.parts.map((p) => ({ positions: p.positions, indices: p.indices, color: p.color, name: p.name }));
        trisIn = res.trisIn;
        fileUnit = 'mm';
        break;
      }
      case 'stl': {
        onProgress?.('parse');
        const geo = new STLLoader().parse(await file.arrayBuffer());
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...DEFAULT_LINEAR) }));
        parts = partsFromObject(mesh, true);
        break;
      }
      case 'obj': {
        onProgress?.('parse');
        const objText = await file.text();
        const loader = new OBJLoader();
        const mtls = files.filter((f) => extOf(f.name) === 'mtl');
        if (mtls.length) {
          // texture maps are dropped before parsing so MTLLoader never fetches them
          const text = (await Promise.all(mtls.map((f) => f.text()))).join('\n').replace(/^\s*(map_|bump|disp|decal|refl)\S*.*$/gim, '');
          const mats = new MTLLoader().parse(text, '');
          mats.preload();
          loader.setMaterials(mats);
          bytes += mtls.reduce((s, f) => s + f.size, 0);
        } else if (/^\s*mtllib\s+/m.test(objText)) {
          notes.push('The .obj names a material file that wasn’t dropped with it, so it is one colour. Drop the .mtl together with the .obj to keep its colours.');
        }
        parts = partsFromObject(loader.parse(objText), false);
        break;
      }
      case '3mf': {
        onProgress?.('parse');
        const buf = await file.arrayBuffer();
        fileUnit = threeMfUnit(new Uint8Array(buf));
        const group = new ThreeMFLoader().parse(buf);
        parts = partsFromObject(group, true);
        break;
      }
      case 'ply': {
        onProgress?.('parse');
        const geo = new PLYLoader().parse(await file.arrayBuffer());
        if (!geo.getIndex() && (geo.getAttribute('position')?.count ?? 0) % 3 !== 0) {
          throw new ImportError('empty', `${file.name} has points but no faces. Export it as a mesh and try again.`);
        }
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...DEFAULT_LINEAR) }));
        parts = partsFromObject(mesh, true);
        break;
      }
    }
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError('corrupt', `Couldn’t read ${file.name}: it looks damaged or isn’t really ${format.toUpperCase()} (${e instanceof Error ? e.message : 'unknown error'}). Export it again and retry.`);
  }
  onProgress?.('convert');
  if (!trisIn) trisIn = triangleCount(parts);
  parts = mergeByColour(parts.filter((p) => p.positions.length >= 9));
  if (triangleCount(parts) === 0) {
    throw new ImportError('empty', `Couldn’t find any triangles in ${file.name}. Export the robot as a solid or a mesh and try again.`);
  }
  return { name: file.name, format, bytes, fileUnit, parts, trisIn, notes };
}

// ---- glTF -------------------------------------------------------------------------------

const MAGIC = 0x46546c67;

/** split a GLB into its JSON and the bytes after the JSON chunk */
function splitGlb(buf: ArrayBuffer): { json: Record<string, unknown>; rest: Uint8Array } {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a binary glTF');
  if (dv.getUint32(4, true) !== 2) throw new Error('only glTF 2.0 is supported');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen))) as Record<string, unknown>;
  return { json, rest: new Uint8Array(buf, 20 + jsonLen) };
}

function joinGlb(json: Record<string, unknown>, rest: Uint8Array): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jl = (text.length + 3) & ~3;
  const total = 20 + jl + rest.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jl);
  out.set(rest, 20 + jl);
  return out.buffer;
}

const TEXTURE_EXTENSIONS = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif', 'KHR_texture_transform', 'MSFT_texture_dds'];

/** remove images, textures and every material's texture slots (colours stay) */
function stripTextures(json: Record<string, unknown>): void {
  delete json.images;
  delete json.textures;
  delete json.samplers;
  const mats = json.materials as Record<string, unknown>[] | undefined;
  for (const m of mats ?? []) {
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    const pbr = m.pbrMetallicRoughness as Record<string, unknown> | undefined;
    if (pbr) {
      delete pbr.baseColorTexture;
      delete pbr.metallicRoughnessTexture;
    }
    // extension material slots (clearcoat, sheen …) may name textures too; the importer keeps none
    delete m.extensions;
  }
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    const list = json[key] as string[] | undefined;
    if (list) json[key] = list.filter((e) => !TEXTURE_EXTENSIONS.includes(e) && !e.startsWith('KHR_materials_'));
  }
}

async function loadGltf(
  file: File,
  files: readonly File[],
  format: 'glb' | 'gltf',
  onProgress?: LoadProgress,
): Promise<{ parts: MeshPart[]; bytes: number; notes: string[] }> {
  const notes: string[] = [];
  let bytes = file.size;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let glb: ArrayBuffer;
  if (format === 'glb') {
    const { json, rest } = splitGlb(await file.arrayBuffer());
    checkDraco(json);
    stripTextures(json);
    glb = joinGlb(json, rest);
  } else {
    const json = JSON.parse(await file.text()) as Record<string, unknown>;
    checkDraco(json);
    stripTextures(json);
    const r = await packGltf(json, files, file.name);
    bytes += r.bytes;
    glb = r.glb;
  }
  onProgress?.('parse');
  const gltf = await loader.parseAsync(glb, '');
  return { parts: partsFromObject(gltf.scene, false), bytes, notes };
}

/**
 * A `.gltf` and the `.bin` files dropped with it → one GLB in memory, so nothing is fetched by
 * URL (no object URLs to manage, and a missing file is named before parsing starts). Every
 * external buffer is appended to the GLB's BIN chunk on an 8-byte boundary — keeping every
 * accessor's alignment — and its buffer views re-pointed; data-URI buffers stay as they are.
 */
async function packGltf(json: Record<string, unknown>, files: readonly File[], gltfName: string): Promise<{ glb: ArrayBuffer; bytes: number }> {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const buffers = (json.buffers as { uri?: string; byteLength: number }[] | undefined) ?? [];
  const chunks: Uint8Array[] = [];
  const offsetOf = new Map<number, number>();
  let binLen = 0;
  let bytes = 0;
  for (let i = 0; i < buffers.length; i++) {
    const uri = buffers[i].uri;
    if (!uri || uri.startsWith('data:')) continue;
    const f = byName.get(baseName(uri));
    if (!f) throw new ImportError('missing-file', `Couldn’t find ${baseName(uri)}, which ${gltfName} needs. Drop it together with the .gltf.`);
    const data = new Uint8Array(await f.arrayBuffer());
    const at = (binLen + 7) & ~7;
    if (at > binLen) chunks.push(new Uint8Array(at - binLen));
    chunks.push(data);
    offsetOf.set(i, at);
    binLen = at + data.length;
    bytes += f.size;
  }
  if (!offsetOf.size) return { glb: joinGlb(json, new Uint8Array(0)), bytes };
  // the merged BIN becomes buffer 0; the remaining (data-URI) buffers follow it
  const keep = buffers.map((_, i) => i).filter((i) => !offsetOf.has(i));
  const newIndex = new Map<number, number>(keep.map((i, k) => [i, k + 1]));
  json.buffers = [{ byteLength: binLen }, ...keep.map((i) => buffers[i])];
  for (const v of (json.bufferViews as { buffer: number; byteOffset?: number }[] | undefined) ?? []) {
    const off = offsetOf.get(v.buffer);
    if (off !== undefined) {
      v.byteOffset = (v.byteOffset ?? 0) + off;
      v.buffer = 0;
    } else {
      v.buffer = newIndex.get(v.buffer) ?? v.buffer;
    }
  }
  const padded = (binLen + 3) & ~3;
  const bin = new Uint8Array(8 + padded);
  const dv = new DataView(bin.buffer);
  dv.setUint32(0, padded, true);
  dv.setUint32(4, 0x004e4942, true);
  let at = 8;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.length;
  }
  return { glb: joinGlb(json, bin), bytes };
}

function checkDraco(json: Record<string, unknown>): void {
  const req = (json.extensionsRequired as string[] | undefined) ?? [];
  if (req.includes('KHR_draco_mesh_compression')) {
    throw new ImportError('draco', 'This glTF uses Draco compression, which the importer doesn’t read. Export it again without Draco (meshopt compression is fine).');
  }
}

// ---- 3MF ---------------------------------------------------------------------------------

const MF_UNITS: Record<string, LengthUnit> = { millimeter: 'mm', centimeter: 'cm', meter: 'm', inch: 'in', foot: 'ft' };

/** the `unit` attribute of a 3MF's model part (millimetre when absent, per the 3MF spec) */
export function threeMfUnit(zip: Uint8Array): LengthUnit | null {
  try {
    const entries = unzipSync(zip, { filter: (f) => /\.model$/i.test(f.name) });
    for (const name of Object.keys(entries)) {
      const head = new TextDecoder().decode(entries[name].subarray(0, 4096));
      const m = /<model\b[^>]*\bunit\s*=\s*["']([a-z]+)["']/i.exec(head);
      if (/<model\b/i.test(head)) return m ? (MF_UNITS[m[1].toLowerCase()] ?? null) : 'mm';
    }
  } catch {
    return null;
  }
  return null;
}

// ---- three.js object → parts ---------------------------------------------------------

/**
 * Every mesh under `root`, world transform applied, split by material group and (when
 * `useVertexColours`, or the material asks for them) by vertex colour. Reads positions through
 * `getX/getY/getZ` so quantised and interleaved attributes come out as plain floats (the trap
 * `renderElementsGlb.ts` records), and flips the winding of a mirrored instance.
 */
export function partsFromObject(root: THREE.Object3D, useVertexColours: boolean): MeshPart[] {
  root.updateMatrixWorld(true);
  const out: MeshPart[] = [];
  const v = new THREE.Vector3();
  const tmp = new THREE.Matrix4();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || (obj as THREE.Points).isPoints || (obj as THREE.Line).isLine) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos || pos.count < 3) return;
    const index = geo.getIndex();
    const inst = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null;
    const instances = inst ? inst.count : 1;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const colorAttr = geo.getAttribute('color');
    for (let n = 0; n < instances; n++) {
      const m = new THREE.Matrix4().copy(mesh.matrixWorld);
      if (inst) {
        inst.getMatrixAt(n, tmp);
        m.multiply(tmp);
      }
      const flip = m.determinant() < 0;
      const positions = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
        positions[3 * i] = v.x;
        positions[3 * i + 1] = v.y;
        positions[3 * i + 2] = v.z;
      }
      const full = index ? Uint32Array.from({ length: index.count }, (_, i) => index.getX(i)) : null;
      const nIdx = full ? full.length : pos.count;
      const groups = geo.groups.length && materials.length > 1 ? geo.groups : [{ start: 0, count: nIdx, materialIndex: 0 }];
      for (const g of groups) {
        const end = Math.min(nIdx, g.start + g.count);
        const len = Math.max(0, end - g.start);
        const idx = new Uint32Array(len - (len % 3));
        for (let k = 0; k < idx.length; k++) idx[k] = full ? full[g.start + k] : g.start + k;
        if (flip) for (let k = 0; k + 2 < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
        const mat = materials[g.materialIndex ?? 0] ?? materials[0];
        const c = (mat as THREE.MeshStandardMaterial | undefined)?.color;
        const part: MeshPart = {
          positions,
          indices: idx,
          color: c ? [c.r, c.g, c.b] : [DEFAULT_LINEAR[0], DEFAULT_LINEAR[1], DEFAULT_LINEAR[2]],
          name: mesh.name || obj.parent?.name || 'part',
        };
        if (colorAttr && (useVertexColours || (mat as THREE.MeshStandardMaterial | undefined)?.vertexColors)) {
          const cols = new Float32Array(colorAttr.count * 3);
          for (let i = 0; i < colorAttr.count; i++) {
            cols[3 * i] = colorAttr.getX(i);
            cols[3 * i + 1] = colorAttr.getY(i);
            cols[3 * i + 2] = colorAttr.getZ(i);
          }
          out.push(...splitByVertexColour(part, cols));
        } else {
          out.push(part);
        }
      }
    }
  });
  return out;
}
