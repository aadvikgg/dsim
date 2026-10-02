import { STORED_MESH_TO_ROBOT, TOP_IMAGE_PX } from '../robotImport/types';
import { robotToTopPixel, topImageFrame, topPixelToRobot, type TopImageFrame } from '../robotImport/topFrame';

/**
 * IMPORTED ROBOT VISUALS — the one place a renderer asks for an imported robot's pictures
 * (`docs/robot-import-plan.md` §1 "In a match", §3.2). It STORES NOTHING of its own: a SOURCE
 * answers by `ImportedRobot.id` (the device library, `src/robotImport/library.ts`, by default),
 * and `registerImportedAssets` lends it in-memory blobs (the editor's unsaved draft, a mesh that
 * arrived over a room's relay). Main chunk, DOM only inside functions, no three.js: the 2D
 * sprites, the builder previews and the BIOBUZZ scene chunk all read it, and the smoke suite
 * imports it under Node.
 *
 * ── TWO FRAMES, AND THEY ARE THE IMPORTER'S ─────────────────────────────────────────────────
 * The importer writes both assets (`src/robotImport/engine/bake.ts`) and owns both definitions
 * (`docs/area/robot-import.md` "Frames"); the renderers read them back through these re-exports
 * and nothing else, so a picture and its reader cannot disagree.
 *
 *  - THE TOP-DOWN PNG (`importedTopFrame` = `topImageFrame`): `TOP_IMAGE_PX` (512) square,
 *    transparent, orthographic from above, robot-local: image UP = robot +x (front), image LEFT =
 *    robot +y (left). Framed on the HULL, so a reader needs nothing but the descriptor: centred on
 *    the hull's bounding-box centre (cx, cy), `max(box side) + 1` in wide. Pixel (u, v), origin
 *    top-left, is robot-local x = cx + (px/2 − v)·k, y = cy + (px/2 − u)·k, k = inches per pixel.
 *    That map has determinant −1 in the robot frame, which is right: the 2D camera's y-flip
 *    cancels it, so the picture is never mirrored on screen (the bird's-eye rule in CLAUDE.md).
 *  - THE STORED GLB (`IMPORTED_MESH_TO_ROBOT` = `STORED_MESH_TO_ROBOT`): glTF's own frame, so any
 *    viewer opens it upright — METRES, +Y up, +Z front, +X left, origin on the floor under the
 *    robot-local origin. The BIOBUZZ scene's robot groups are robot-local INCHES, +x front, +y
 *    left, +z up (`scene/renderRobots.ts` poses a group by `rotation.z = heading`), so the scene
 *    puts this matrix on the mesh's root node: x = gltf.z/0.0254, y = gltf.x/0.0254,
 *    z = gltf.y/0.0254 — a proper rotation times a scale, so winding and normals survive.
 *
 * ── THE CACHE ───────────────────────────────────────────────────────────────────────────────
 * Small and capped (`IMPORTED_TOP_CAP` pictures, `IMPORTED_MESH_CAP` mesh lookups), least
 * recently used out first. A decoded top picture holds an OBJECT URL for as long as it is cached
 * — the SVG previews draw it through `<image href>` — and that URL is revoked when the entry is
 * evicted, invalidated, replaced, or when a load finishes for an entry that is already gone.
 */

/** the top-down PNG's side, px (the importer's `TOP_IMAGE_PX`) */
export const IMPORTED_TOP_PX = TOP_IMAGE_PX;
/** how many decoded top pictures stay cached (a room is 4 robots; the rest is the builder) */
export const IMPORTED_TOP_CAP = 8;
/** how many mesh lookups (blob promises) stay cached */
export const IMPORTED_MESH_CAP = 6;

/** STORED GLB → ROBOT-LOCAL INCHES, column-major 4×4 (`THREE.Matrix4.fromArray` order) — the
 * importer's `STORED_MESH_TO_ROBOT` */
export const IMPORTED_MESH_TO_ROBOT: readonly number[] = STORED_MESH_TO_ROBOT;

/** where the top-down PNG sits in the robot frame — the importer's `TopImageFrame` */
export type ImportedTopFrame = TopImageFrame;
/** THE top-down PNG frame for a hull — the importer's `topImageFrame`, the one definition */
export const importedTopFrame = topImageFrame;
export { robotToTopPixel, topPixelToRobot };

/**
 * The canvas transform that draws the image (in its own pixels) into the ROBOT-LOCAL frame:
 * `ctx.transform(a, b, c, d, e, f)` with pixel (u, v) → robot (a·u + c·v + e, b·u + d·v + f).
 * Image right (+u) is robot −y and image down (+v) is robot −x — the header's map, as a matrix.
 */
export function topImageTransform(f: ImportedTopFrame): [number, number, number, number, number, number] {
  const k = f.inPerPx;
  return [0, -k, -k, 0, f.cx + (f.px / 2) * k, f.cy + (f.px / 2) * k];
}

// ─────────────────────────────────────────────────────────────── the source ──

/** where library assets come from. Each method resolves `null` for "not on this device". */
export interface ImportedAssetSource {
  top(id: string): Promise<Blob | null>;
  mesh(id: string): Promise<Blob | null>;
}

/**
 * THE DEVICE LIBRARY (`src/robotImport/library.ts`'s `topFor`/`meshFor`) — the default source.
 * Reached through a dynamic `import()` the first time an import is DRAWN, so a player who never
 * meets an imported robot never downloads it, and the main chunk does not carry IndexedDB code
 * for them. A library that cannot open (a private window, no IndexedDB, the server) resolves
 * `null`, so the robot draws as its hull (2D) or its placeholder (3D) — exactly what a remote
 * player without the mesh sees, never an error.
 */
export const LIBRARY_ASSET_SOURCE: ImportedAssetSource = {
  top: (id) => import('../robotImport/library').then((lib) => lib.topFor(id)),
  mesh: (id) => import('../robotImport/library').then((lib) => lib.meshFor(id)),
};

let source: ImportedAssetSource | null = LIBRARY_ASSET_SOURCE;

export function setImportedAssetSource(next: ImportedAssetSource | null): void {
  if (next === source) return;
  source = next;
  // a different source can answer differently for EVERY id, including ones nobody has cached (a
  // 3D placeholder that settled on "no mesh" before the library was plugged in): drop every
  // cached lookup (revoking the pictures' URLs), move the epoch every version includes, and tell
  // every reader to ask again
  for (const id of [...new Set<string>([...tops.keys(), ...meshes.keys()])]) dropCached(id);
  epoch++;
  notify(ANY_ID);
}

/** the id listeners are called with when EVERY id may have changed (the source was swapped) */
export const ANY_ID = '*';

/** in-memory blobs lent by their owner (the editor's draft, a relayed mesh) — never evicted.
 *  `lender`: '' for this device (the editor), `relay:<owner>` for a room's relay */
const registered = new Map<string, { top?: Blob; mesh?: Blob; lender: string }>();

/**
 * Lend in-memory assets for `id` (an unsaved draft in the editor, a mesh received over a room's
 * relay). They win over the source. Passing `null` for a kind removes that kind; omitting it
 * leaves it. Readers are told, and the cached decode of anything replaced is dropped (its URL
 * revoked), so a replaced draft redraws with the new picture.
 *
 * ⚠️ ONE LENDER PER ID. `lender` is '' for this device and `relay:<owner>` for a room's relay
 * (`importedAssetsBridge.ts`). A relayed asset never replaces what another lender lent for that id
 * (this device's draft, or another seat's look) and is refused (`false`); this device may replace
 * anything. Taking assets back is the lender's own (`unregisterImportedAssets(id, lender)`).
 *
 * NOT capped: the owner holds them and must call `unregisterImportedAssets` when it is done (the
 * editor on Save/Discard, the relay on leaving the room).
 */
export function registerImportedAssets(id: string, assets: { top?: Blob | null; mesh?: Blob | null }, lender = ''): boolean {
  const had = registered.get(id);
  if (had && had.lender !== lender && lender !== '') return false;
  const cur = { ...(had && had.lender === lender ? had : {}), lender };
  if (assets.top !== undefined) {
    if (assets.top) cur.top = assets.top;
    else delete cur.top;
  }
  if (assets.mesh !== undefined) {
    if (assets.mesh) cur.mesh = assets.mesh;
    else delete cur.mesh;
  }
  if (cur.top || cur.mesh) registered.set(id, cur);
  else registered.delete(id);
  dropCached(id);
  // the MESH version moves only when the mesh may have: a draft whose picture was re-rendered
  // must not make the 3D scene re-parse a GLB it already has (a lender change moves it too)
  bump(id, assets.mesh !== undefined || (!!had && had.lender !== lender && !!had.mesh));
  return true;
}

/** forget everything `lender` lent for `id` (see `registerImportedAssets`); another lender's stays */
export function unregisterImportedAssets(id: string, lender = ''): void {
  const cur = registered.get(id);
  if (!cur || cur.lender !== lender) return;
  registered.delete(id);
  dropCached(id);
  bump(id, cur.mesh !== undefined);
}

/**
 * Forget what is CACHED for `id` (not what is registered) and tell readers — for the library when
 * a record is saved, replaced or deleted, so the next draw asks the source again.
 */
export function invalidateImportedAssets(id: string): void {
  dropCached(id);
  bump(id, true);
}

// ──────────────────────────────────────────────────────────── versions, listeners ──

const versions = new Map<string, number>();
const meshVersions = new Map<string, number>();
/** moves when the SOURCE is swapped — every id's versions include it */
let epoch = 0;
const listeners = new Set<(id: string) => void>();
/** versions of one id stay well under this; the epoch multiplies it */
const EPOCH_STRIDE = 1 << 20;

/**
 * A number per id that moves whenever what a reader would get for it may have changed: a picture
 * finished decoding, a blob was registered or removed, the cache was invalidated, the source was
 * swapped. React readers subscribe to it (`ui/useImportedAssets.ts`).
 */
export function importedAssetVersion(id: string): number {
  return epoch * EPOCH_STRIDE + (versions.get(id) ?? 0);
}

/**
 * The same, for the MESH alone — what the 3D scene keys its loaded template on. A picture decoding
 * does not move it, so the scene never re-parses a GLB because a PNG landed.
 */
export function importedMeshVersion(id: string): number {
  return epoch * EPOCH_STRIDE + (meshVersions.get(id) ?? 0);
}

/** called with the id (or `ANY_ID`) whenever its versions move. Returns the unsubscribe. */
export function subscribeImportedAssets(cb: (id: string) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify(id: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(id);
    } catch {
      /* a reader's throw is its own */
    }
  }
}

function bump(id: string, mesh = false): void {
  versions.set(id, (versions.get(id) ?? 0) + 1);
  if (mesh) meshVersions.set(id, (meshVersions.get(id) ?? 0) + 1);
  notify(id);
}

// ─────────────────────────────────────────────────────────────── top pictures ──

interface TopEntry {
  state: 'loading' | 'ready' | 'missing';
  img: HTMLImageElement | null;
  url: string | null;
}

/** LRU by insertion order: a hit is re-inserted at the end, eviction takes from the front */
const tops = new Map<string, TopEntry>();

function canDecode(): boolean {
  return (
    typeof Image === 'function' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    typeof URL.revokeObjectURL === 'function'
  );
}

function revoke(e: TopEntry): void {
  if (e.url) URL.revokeObjectURL(e.url);
  e.url = null;
  e.img = null;
}

function dropCached(id: string): void {
  const t = tops.get(id);
  if (t) {
    revoke(t);
    tops.delete(id);
  }
  meshes.delete(id);
}

function evictTops(): void {
  while (tops.size > IMPORTED_TOP_CAP) {
    const oldest = tops.keys().next().value as string;
    const e = tops.get(oldest);
    if (e) revoke(e);
    tops.delete(oldest);
  }
}

function topBlob(id: string): Promise<Blob | null> {
  const lent = registered.get(id)?.top;
  if (lent) return Promise.resolve(lent);
  if (!source) return Promise.resolve(null);
  try {
    return source.top(id).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

function startTop(id: string): TopEntry {
  const entry: TopEntry = { state: 'loading', img: null, url: null };
  tops.set(id, entry);
  evictTops();
  void topBlob(id).then((blob) => {
    // a load that finishes for an entry that was evicted or replaced meanwhile is discarded
    if (tops.get(id) !== entry) return;
    if (!blob) {
      entry.state = 'missing';
      return;
    }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (tops.get(id) !== entry) {
        URL.revokeObjectURL(url);
        return;
      }
      entry.state = 'ready';
      entry.img = img;
      entry.url = url;
      bump(id);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (tops.get(id) === entry) entry.state = 'missing';
    };
    img.src = url;
  });
  return entry;
}

function topEntry(id: string): TopEntry | null {
  if (!id || !canDecode()) return null;
  let e = tops.get(id);
  if (e) {
    // a hit moves to the back of the LRU
    tops.delete(id);
    tops.set(id, e);
  } else {
    e = startTop(id);
  }
  return e;
}

/**
 * The top-down picture for `id`, decoded and ready to `drawImage` — or `null` (not loaded YET, not
 * on this device, or no DOM). SYNCHRONOUS and cheap enough to call every frame: the first call
 * starts the load, and `subscribeImportedAssets` fires when it lands. Draw it through
 * `importedTopFrame` / `topImageTransform`.
 */
export function importedTopImage(id: string): HTMLImageElement | null {
  const e = topEntry(id);
  return e && e.state === 'ready' ? e.img : null;
}

/** the same picture as an object URL for an SVG `<image href>` — valid while it stays cached */
export function importedTopUrl(id: string): string | null {
  const e = topEntry(id);
  return e && e.state === 'ready' ? e.url : null;
}

// ─────────────────────────────────────────────────────────────────── meshes ──

/** LRU of mesh lookups (the blob itself, never a decode — the 3D scene keeps its own template) */
const meshes = new Map<string, Promise<Blob | null>>();

/**
 * The stored GLB for `id` (frame: `IMPORTED_MESH_TO_ROBOT`), or `null` when this device does not
 * have it. A registered in-memory blob wins over the source. Cached (`IMPORTED_MESH_CAP`); a miss
 * is NOT cached, so a mesh that arrives later is found by the next ask.
 */
export function importedMeshBlob(id: string): Promise<Blob | null> {
  const lent = registered.get(id)?.mesh;
  if (lent) return Promise.resolve(lent);
  const hit = meshes.get(id);
  if (hit) {
    meshes.delete(id);
    meshes.set(id, hit);
    return hit;
  }
  if (!source || !id) return Promise.resolve(null);
  let p: Promise<Blob | null>;
  try {
    p = source.mesh(id).catch(() => null);
  } catch {
    p = Promise.resolve(null);
  }
  meshes.set(id, p);
  while (meshes.size > IMPORTED_MESH_CAP) meshes.delete(meshes.keys().next().value as string);
  void p.then((b) => {
    if (!b && meshes.get(id) === p) meshes.delete(id);
  });
  return p;
}

/** TEST ONLY: empty every cache, the registry and the versions (revoking URLs); the source goes
 * back to the library */
export function resetImportedAssetsForTests(): void {
  for (const e of tops.values()) revoke(e);
  tops.clear();
  meshes.clear();
  registered.clear();
  versions.clear();
  meshVersions.clear();
  listeners.clear();
  source = LIBRARY_ASSET_SOURCE;
  epoch = 0;
}

/** TEST ONLY: how many entries each cache holds */
export function importedAssetCacheSizes(): { tops: number; meshes: number; registered: number } {
  return { tops: tops.size, meshes: meshes.size, registered: registered.size };
}
