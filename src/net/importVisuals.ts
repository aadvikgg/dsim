/**
 * IMPORTED ROBOT VISUALS RELAY — what both halves of the wire share (docs/area/netcode.md,
 * VISUALS RELAY). DOM-free, no three.js, no `node:` imports: `server/room.ts` is bundled for the
 * browser (the LAN host runs a `Room` in a tab), the Room's relay (`server/importVisuals.ts`)
 * imports this, and so does the client (`src/net/importVisualsClient.ts`).
 *
 * An imported robot's footprint rides the spec (`RobotSpec.imported`) to everyone. Its LOOK — a
 * top-down picture (every viewer, 2D is the default view) and a GLB mesh (BIOBUZZ's 3D view only)
 * — lives on the owner's device, so a custom or LAN room relays it: the owner uploads in chunks,
 * the ROOM holds the bytes in memory for its own life, and a viewer fetches only what it asks for.
 *
 * ⚠️ ONE FRAME CARRIES AT MOST `VISUAL_CHUNK_BYTES` OF PAYLOAD, base64 in a JSON frame. The server
 * drops a frame over 64 KiB (`WS_MAX_PAYLOAD`), the LAN DataChannel's default message size is 64 KiB
 * too, and a socket past 240 messages a second is rate-limited, so a chunk is 24 KiB (32 KiB of
 * base64) and the owner is paced at `VISUAL_UPLOAD_GAP_MS`.
 */

/** advertised by clients on `join`/`rejoin`/`spectate` (`CLIENT_CAPS`) and by the server on
 *  `/api/presence` (`SERVER_CAPS`). A build without it is sent none of these messages and its
 *  own are ignored. It degrades: a viewer without it sees the footprint, as before. */
export const IMPORT_VISUALS_CAP = 'importVisuals';

/** does a client advertising `caps` take part in the relay? */
export function hasVisualsCap(caps: readonly string[] | undefined): boolean {
  return !!caps?.includes(IMPORT_VISUALS_CAP);
}

export type VisualKind = 'top' | 'mesh';
export const VISUAL_KINDS: readonly VisualKind[] = ['top', 'mesh'];
export const isVisualKind = (x: unknown): x is VisualKind => x === 'top' || x === 'mesh';

/** `ImportedRobot.id`: 16 lowercase hex chars (`src/robotImport/library.ts` `ROBOT_ID_RX`) */
export const VISUAL_ID_RX = /^[0-9a-f]{16}$/;

// ---- the limits ---------------------------------------------------------------------------

/** the largest asset of each kind, raw bytes. The library's own mesh may be 4 MB; a bigger one is
 *  made lighter (`liteMesh`, `src/robotImport/engine/lite.ts`) or not relayed at all. */
export const VISUAL_MAX_BYTES: Readonly<Record<VisualKind, number>> = { top: 256 * 1024, mesh: 1024 * 1024 };

/** raw payload bytes per frame. 24 KiB is exactly 32,768 base64 characters, so a frame is about
 *  33 KB of JSON: half the 64 KiB frame cap, and under the DataChannel's 64 KiB default. */
export const VISUAL_CHUNK_BYTES = 24 * 1024;
export const VISUAL_CHUNK_CHARS = (VISUAL_CHUNK_BYTES / 3) * 4;

/** a room holds this many robots' worth: the four seats × (a mesh and a top picture) */
export const VISUAL_ROOM_OWNERS = 4;
export const VISUAL_ROOM_BYTES = VISUAL_ROOM_OWNERS * (VISUAL_MAX_BYTES.top + VISUAL_MAX_BYTES.mesh);
/** every room on one machine, all threads together */
export const VISUAL_PROCESS_BYTES = 64 * 1024 * 1024;

/** what ONE viewer may be sent over its life in a room, and what the whole room may send: a
 *  client that asks again and again is egress, which is the bill. 8 MiB is a full room's assets
 *  once and a retry or two. */
export const VISUAL_SERVE_CLIENT_BYTES = 8 * 1024 * 1024;
export const VISUAL_SERVE_ROOM_BYTES = 48 * 1024 * 1024;
/** concurrent downloads per viewer: a top and a mesh for each of four owners */
export const VISUAL_STREAMS_PER_CLIENT = 8;

/** an upload that has gone quiet this long is dropped (and its reservation with it) */
export const VISUAL_PUT_STALE_MS = 60_000;

// ---- pacing -------------------------------------------------------------------------------

/**
 * The owner sends a frame every this many ms: 33 frames a second against a 240-a-second bucket,
 * with the 60 Hz input stream beside it (`MSG_RATE_LIMIT`). A 1 MiB mesh is 43 frames, about 1.3 s.
 */
export const VISUAL_UPLOAD_GAP_MS = 30;

/** the room's download pump runs this often */
export const VISUAL_STREAM_TICK_MS = 20;
/** a socket with more than this queued (`ws.bufferedAmount`; on a worker room, the mirror of it,
 *  which reports from 16 KiB up) is not handed another chunk. Well under `SNAP_BACKLOG_BYTES`
 *  (256 KB), because a snapshot that finds its socket backed up is skipped and the next one is a
 *  full keyframe — a download must never be what causes that. */
export const VISUAL_STREAM_BACKLOG_BYTES = 40 * 1024;
/** while a match is being played a viewer's stream is held to one chunk per this many ms
 *  (about 240 KB/s), so a late spectator's download cannot crowd out its snapshots */
export const VISUAL_STREAM_LIVE_GAP_MS = 100;

/** frames a payload of `total` bytes takes */
export const visualFrames = (total: number): number => Math.ceil(total / VISUAL_CHUNK_BYTES);

/** the byte range chunk `seq` of a `total`-byte asset covers */
export function visualSpan(total: number, seq: number): { start: number; end: number } {
  const start = seq * VISUAL_CHUNK_BYTES;
  return { start, end: Math.min(total, start + VISUAL_CHUNK_BYTES) };
}

/**
 * MAY THE ROOM WRITE A VIEWER'S NEXT CHUNK NOW? The one pacing rule, pure so a check can pin it.
 * `backlog` is undefined for a socket the room cannot read (the LAN tab host's DataChannel, a
 * test): those are paced by time alone, one chunk per pump.
 */
export function streamMayWrite(o: { backlog: number | undefined; now: number; lastAt: number; live: boolean }): boolean {
  if (o.backlog !== undefined && o.backlog >= VISUAL_STREAM_BACKLOG_BYTES) return false;
  if (o.live && o.now - o.lastAt < VISUAL_STREAM_LIVE_GAP_MS) return false;
  return true;
}

// ---- base64 -------------------------------------------------------------------------------

type NodeBuffer = {
  from(data: ArrayBuffer | Uint8Array | string, enc?: string | number, len?: number): Uint8Array & { toString(enc: string, start?: number, end?: number): string };
};
const NODE_BUFFER = (globalThis as { Buffer?: NodeBuffer }).Buffer;

/** `bytes[start, end)` as base64 */
export function bytesToBase64(bytes: Uint8Array, start = 0, end = bytes.length): string {
  if (NODE_BUFFER) return NODE_BUFFER.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString('base64', start, end);
  let s = '';
  // 8 KiB at a time: String.fromCharCode(...args) has an argument limit
  for (let i = start; i < end; i += 8192) s += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 8192)));
  return btoa(s);
}

const B64_RX = /^[A-Za-z0-9+/]*={0,2}$/;

/** base64 → bytes, or null when `s` is not well-formed base64 (Node's decoder is forgiving:
 *  it would skip a stray character, and this is attacker-controlled input) */
export function base64ToBytes(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !B64_RX.test(s)) return null;
  if (NODE_BUFFER) return new Uint8Array(NODE_BUFFER.from(s, 'base64'));
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ---- validation: a PNG ----------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** the widest side a relayed top picture may declare. The importer bakes 512; a PNG is a
 *  decompression bomb in 256 KiB (65,535 × 65,535 fits), and the viewer decodes it. */
export const VISUAL_TOP_MAX_SIDE = 1024;

/**
 * Is `b` a well-formed PNG of a sane size, as far as its CHUNK STRUCTURE goes? Null when yes, else
 * why not. Signature, an IHDR first with a legal depth/colour type and a side of 1..1024, chunk
 * lengths that tile the file exactly, at least one IDAT, and an IEND that ends it. CRCs are left
 * to the decoder: this is a gate against what must never reach one (a bomb, a polyglot, a
 * truncated file), not a decoder.
 */
export function validateTopPng(b: Uint8Array, maxBytes = VISUAL_MAX_BYTES.top): string | null {
  if (b.length > maxBytes) return 'too large';
  if (b.length < 8 + 25 + 12) return 'too short';
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return 'not a PNG';
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8;
  let first = true;
  let idat = false;
  while (pos < b.length) {
    if (pos + 12 > b.length) return 'truncated chunk';
    const len = dv.getUint32(pos);
    const next = pos + 12 + len;
    if (len > 0x7fffffff || next > b.length) return 'chunk length';
    let name = '';
    for (let i = 4; i < 8; i++) {
      const c = b[pos + i];
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return 'chunk type';
      name += String.fromCharCode(c);
    }
    if (first) {
      if (name !== 'IHDR' || len !== 13) return 'no IHDR';
      const w = dv.getUint32(pos + 8);
      const h = dv.getUint32(pos + 12);
      if (w < 1 || h < 1 || w > VISUAL_TOP_MAX_SIDE || h > VISUAL_TOP_MAX_SIDE) return 'picture size';
      const depth = b[pos + 16];
      const colour = b[pos + 17];
      if (![1, 2, 4, 8, 16].includes(depth) || ![0, 2, 3, 4, 6].includes(colour)) return 'IHDR';
      if (b[pos + 18] !== 0 || b[pos + 19] !== 0 || b[pos + 20] > 1) return 'IHDR';
      first = false;
    } else if (name === 'IHDR') {
      return 'second IHDR';
    }
    if (name === 'IDAT') idat = true;
    if (name === 'IEND') return len === 0 && next === b.length && idat ? null : 'IEND';
    pos = next;
  }
  return 'no IEND';
}

// ---- validation: a GLB ------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;
const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const GLB_JSON_MAX = 256 * 1024;
/** the importer's own ceiling (`MAX_TRIANGLES`); a relayed mesh is under it by construction */
export const VISUAL_MAX_TRIANGLES = 150_000;
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown, max: number): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= max;

/** does any object anywhere under `root` have a key called `uri`? Iterative, node-capped. */
function hasUri(root: unknown): boolean | 'huge' {
  const stack: unknown[] = [root];
  let seen = 0;
  while (stack.length) {
    const x = stack.pop();
    if (typeof x !== 'object' || x === null) continue;
    if (++seen > 100_000) return 'huge';
    if (Array.isArray(x)) {
      for (const v of x) stack.push(v);
    } else {
      for (const k of Object.keys(x)) {
        if (k === 'uri') return true;
        stack.push((x as Json)[k]);
      }
    }
  }
  return false;
}

/**
 * Is `b` a binary glTF a viewer may load, as far as STRUCTURE goes? Null when yes, else why not.
 *
 * ⚠️ EVERYTHING MUST BE IN THE FILE. A `uri` anywhere (a buffer, an image, a data URI) is refused
 * outright, because the viewer's loader would FETCH it: a relayed mesh that names a URL is a request
 * the room's owner made from every viewer's browser. No images and no textures either (the importer
 * keeps colours only), and no required extension (it would need a decoder this client may not
 * have). The rest is a bounds check, so the loader never sees an accessor that reads past its
 * buffer: the header and chunk lengths tile the file, buffer views sit inside the one BIN buffer,
 * accessors inside their views, and the triangle count is the importer's own ceiling.
 */
export function validateMeshGlb(b: Uint8Array, maxBytes = VISUAL_MAX_BYTES.mesh): string | null {
  if (b.length > maxBytes) return 'too large';
  if (b.length < 12 + 8 + 2) return 'too short';
  if (b.length % 4 !== 0) return 'not 4-byte aligned';
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) return 'not a GLB';
  if (dv.getUint32(4, true) !== 2) return 'not glTF 2';
  if (dv.getUint32(8, true) !== b.length) return 'GLB length';
  let off = 12;
  let n = 0;
  let json: unknown;
  let binLen = -1;
  while (off < b.length) {
    if (off + 8 > b.length) return 'truncated chunk';
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (len % 4 !== 0 || start + len > b.length) return 'chunk length';
    if (n === 0) {
      if (type !== GLB_JSON) return 'first chunk is not JSON';
      if (len > GLB_JSON_MAX) return 'JSON too large';
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(start, start + len)));
      } catch {
        return 'JSON';
      }
    } else if (n === 1 && type === GLB_BIN) {
      binLen = len;
    } else {
      return 'unexpected chunk';
    }
    n++;
    off = start + len;
  }
  if (!isObj(json)) return 'JSON';
  const uri = hasUri(json);
  if (uri) return uri === 'huge' ? 'JSON too large' : 'external reference';
  const g = json;
  if (Array.isArray(g.images) && g.images.length) return 'images';
  if (Array.isArray(g.textures) && g.textures.length) return 'textures';
  if (Array.isArray(g.extensionsRequired) && g.extensionsRequired.length) return 'required extension';
  for (const [key, max] of [['nodes', 512], ['meshes', 512], ['materials', 256], ['accessors', 4096], ['bufferViews', 4096], ['scenes', 8]] as const) {
    const v = g[key];
    if (v !== undefined && (!Array.isArray(v) || v.length > max)) return `${key}`;
  }
  const buffers = (g.buffers ?? []) as unknown[];
  if (!Array.isArray(buffers) || buffers.length > 1) return 'buffers';
  let bufLen = 0;
  if (buffers.length === 1) {
    const bf = buffers[0];
    if (!isObj(bf) || !isCount(bf.byteLength, b.length)) return 'buffer';
    if (binLen < 0 || bf.byteLength > binLen) return 'buffer is not in the file';
    bufLen = bf.byteLength;
  }
  const views = (g.bufferViews ?? []) as unknown[];
  const viewLen: number[] = [];
  const viewStride: number[] = [];
  for (const v of views) {
    if (!isObj(v) || v.buffer !== 0 || !isCount(v.byteLength, bufLen)) return 'bufferView';
    const o = v.byteOffset === undefined ? 0 : v.byteOffset;
    if (!isCount(o, bufLen) || o + v.byteLength > bufLen) return 'bufferView range';
    if (v.byteStride !== undefined && !isCount(v.byteStride, 252)) return 'bufferView stride';
    viewLen.push(v.byteLength);
    viewStride.push((v.byteStride as number | undefined) ?? 0);
  }
  const accessors = (g.accessors ?? []) as unknown[];
  const counts: number[] = [];
  for (const a of accessors) {
    if (!isObj(a) || a.sparse !== undefined) return 'accessor';
    const comp = COMPONENT_BYTES[a.componentType as number];
    const per = TYPE_COMPONENTS[a.type as string];
    if (!comp || !per || !isCount(a.count, 500_000) || a.count < 1) return 'accessor';
    if (!isCount(a.bufferView, views.length - 1)) return 'accessor has no buffer view';
    const at = a.byteOffset === undefined ? 0 : a.byteOffset;
    if (!isCount(at, bufLen)) return 'accessor offset';
    const elem = comp * per;
    const stride = viewStride[a.bufferView] || elem;
    if (at + (a.count - 1) * stride + elem > viewLen[a.bufferView]) return 'accessor range';
    counts.push(a.count);
  }
  let tris = 0;
  let prims = 0;
  for (const m of (g.meshes ?? []) as unknown[]) {
    if (!isObj(m) || !Array.isArray(m.primitives)) return 'mesh';
    for (const p of m.primitives as unknown[]) {
      if (!isObj(p) || !isObj(p.attributes)) return 'primitive';
      if (p.mode !== undefined && p.mode !== 4) return 'primitive mode';
      const pos = p.attributes.POSITION;
      if (!isCount(pos, accessors.length - 1)) return 'primitive has no positions';
      if (p.indices !== undefined && !isCount(p.indices, accessors.length - 1)) return 'primitive indices';
      for (const k of Object.keys(p.attributes)) if (!isCount(p.attributes[k], accessors.length - 1)) return 'primitive attribute';
      tris += Math.floor(counts[p.indices === undefined ? pos : (p.indices as number)] / 3);
      prims++;
    }
  }
  if (!prims) return 'no geometry';
  if (tris > VISUAL_MAX_TRIANGLES) return 'too many triangles';
  return null;
}

/** the validator for a kind */
export function validateVisual(kind: VisualKind, b: Uint8Array): string | null {
  return kind === 'top' ? validateTopPng(b) : validateMeshGlb(b);
}

// ---- refusals -----------------------------------------------------------------------------------

export type VisualRefusal = 'room' | 'id' | 'size' | 'format' | 'budget' | 'seq' | 'dup' | 'none' | 'busy';

/** plain sentences (docs/area/ui.md): what happened, and what the viewer sees instead */
export const VISUAL_REFUSAL_COPY: Readonly<Record<VisualRefusal, string>> = {
  room: 'Couldn’t share your robot’s look here. Only custom and LAN rooms show imported robots. Others see its outline.',
  id: 'Couldn’t share your robot’s look. It doesn’t match the robot you picked. Others see its outline.',
  size: 'Couldn’t share your robot’s look. The file is too large to send. Others see its outline.',
  format: 'Couldn’t share your robot’s look. The file isn’t a picture or model the room can use. Others see its outline.',
  budget: 'Couldn’t share your robot’s look. This room is out of space for it. Others see its outline.',
  seq: 'Couldn’t share your robot’s look. The upload was interrupted. Others see its outline.',
  dup: 'Couldn’t share your robot’s look. Another driver here already uses a robot with the same id. Others see its outline.',
  none: 'That robot’s look isn’t available. It is shown as an outline.',
  busy: 'Couldn’t download that robot’s look right now. It is shown as an outline.',
};
