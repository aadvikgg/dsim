/**
 * THE VISUALS RELAY — one `Room`'s memory of its imported robots' pictures and meshes, and the
 * pump that streams them to the viewers that ask (docs/area/netcode.md, VISUALS RELAY).
 *
 * ⚠️ MEMORY ONLY, FOR THE LIFE OF THE ROOM. Nothing here is written to a database, a replay row
 * or a disk: a custom room's replay carries a robot's footprint (`RobotSpec.imported`) and nothing
 * of what it looks like, so the bytes cannot outlive the room that held them. `dispose()` frees
 * them, and so does the owner leaving, picking another robot, or the room closing.
 *
 * ⚠️ IT LIVES IN THE ROOM, NOT ON THE SOCKET THREAD, so on a worker room (`SIM_WORKERS`) the bytes,
 * the base64, the GLB validation and the stream timer all run on the worker. The socket thread
 * only writes the frames it would write anyway; the 0.3%-busy-per-client ceiling it already has
 * (docs/area/netcode.md, ROOMS CAN RUN ON WORKER THREADS) is the thing this must not move. The
 * bytes cross the thread boundary twice (the owner's frames in, a viewer's frames out) as the
 * strings the worker's `out()` already batches. And it has to be in the room, because the room
 * is what knows who is seated, which robot each seat holds, and when a seat leaves.
 *
 * Browser-safe (the LAN tab host runs this `Room` in a Worker): no `node:` imports.
 */
import type { Client } from './room';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';
import {
  VISUAL_CHUNK_CHARS,
  VISUAL_ID_RX,
  VISUAL_MAX_BYTES,
  VISUAL_PROCESS_BYTES,
  VISUAL_PUT_STALE_MS,
  VISUAL_REFUSAL_COPY,
  VISUAL_ROOM_BYTES,
  VISUAL_SERVE_CLIENT_BYTES,
  VISUAL_SERVE_ROOM_BYTES,
  VISUAL_STREAMS_PER_CLIENT,
  VISUAL_STREAM_TICK_MS,
  base64ToBytes,
  bytesToBase64,
  hasVisualsCap,
  isVisualKind,
  streamMayWrite,
  validateVisual,
  visualFrames,
  visualSpan,
  type VisualKind,
  type VisualRefusal,
} from '../src/net/importVisuals';

// ---- the per-process budget ---------------------------------------------------------------------

/**
 * ⚠️ THE 64 MiB IS PER PROCESS, NOT PER THREAD. A room on a worker is a different JS heap from
 * the socket thread's, so a plain counter in this module would be one budget per thread and the
 * machine could hold 64 MiB × (workers + 1). So the socket thread makes one `SharedArrayBuffer`
 * of per-thread counters (`makeSharedVisualBudget`), hands it to each worker (`workerData`), and
 * a thread's reservation goes in ITS slot: the total is the sum, and a worker that dies has its
 * slot zeroed by the thread that respawns it, so a crash cannot leak budget for the life of the
 * process. The check-then-add is not atomic across threads; two rooms racing may overshoot by
 * one asset each, which is slack, not a leak.
 */
export const VISUAL_BUDGET_SLOTS = 65;

let cells: Int32Array<ArrayBufferLike> = new Int32Array(new ArrayBuffer(4 * VISUAL_BUDGET_SLOTS));
let mySlot = 0;

/** one SharedArrayBuffer for the whole process, or undefined where the platform has none */
export function makeSharedVisualBudget(): SharedArrayBuffer | undefined {
  return typeof SharedArrayBuffer === 'undefined' ? undefined : new SharedArrayBuffer(4 * VISUAL_BUDGET_SLOTS);
}

/** point this thread at the process's counters, and say which slot is its own */
export function configureVisualBudget(buf: SharedArrayBuffer | ArrayBuffer | undefined, slot: number): void {
  if (!buf || slot < 0 || slot >= VISUAL_BUDGET_SLOTS) return;
  cells = new Int32Array(buf);
  mySlot = slot;
}

/** a thread died: its rooms are gone with it, so its bytes are too */
export function resetVisualSlot(buf: SharedArrayBuffer | undefined, slot: number): void {
  if (buf && slot >= 0 && slot < VISUAL_BUDGET_SLOTS) Atomics.store(new Int32Array(buf), slot, 0);
}

/** bytes in use across the process, as this thread sees it */
export function visualBytesInUse(): number {
  let n = 0;
  for (let i = 0; i < cells.length; i++) n += Atomics.load(cells, i);
  return n;
}

export interface VisualBudget {
  reserve(bytes: number): boolean;
  release(bytes: number): void;
}

/** the process budget (`limit` is for tests) */
export function processVisualBudget(limit = VISUAL_PROCESS_BYTES): VisualBudget {
  return {
    reserve(bytes) {
      if (visualBytesInUse() + bytes > limit) return false;
      Atomics.add(cells, mySlot, bytes);
      return true;
    },
    release(bytes) {
      Atomics.add(cells, mySlot, -bytes);
    },
  };
}

/** a budget of its own, for a check that must not touch the process's */
export function localVisualBudget(limit: number): VisualBudget & { used(): number } {
  let used = 0;
  return {
    reserve(bytes) {
      if (used + bytes > limit) return false;
      used += bytes;
      return true;
    },
    release(bytes) {
      used -= bytes;
    },
    used: () => used,
  };
}

// ---- the relay ------------------------------------------------------------------------------------

/** what a relay needs to know about its room */
export interface RelayHost {
  /** may an imported robot play here at all? (`Room.allowsImportedRobots`) */
  allows(): boolean;
  /** a seat or a watcher, by client id */
  find(id: string): Client | undefined;
  /** the robot id (`spec.imported.id`) a SEAT holds right now, if it holds an imported robot */
  importId(id: string): string | undefined;
  /** every seat and every watcher: who is told an asset is ready */
  recipients(): Iterable<Client>;
  /** a match is being played, so a viewer's stream is held to a slower pace */
  live(): boolean;
}

interface Asset {
  id: string;
  kind: VisualKind;
  total: number;
  buf: Uint8Array;
  got: number;
  /** the next `seq` expected while the upload is open */
  next: number;
  ready: boolean;
  touched: number;
}
interface Owner {
  /** the robot id this owner's assets are for */
  id: string;
  top?: Asset;
  mesh?: Asset;
}
interface Stream {
  owner: string;
  asset: Asset;
  seq: number;
}
interface Outbox {
  list: Stream[];
  lastAt: number;
}

type Raw = Record<string, unknown>;

export class VisualRelay {
  private readonly owners = new Map<string, Owner>();
  private reserved = 0;
  private readonly streams = new Map<string, Outbox>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** bytes this room has been asked to send, per viewer and in all (a request is charged in full) */
  private readonly served = new Map<string, number>();
  private servedRoom = 0;
  private disposed = false;

  constructor(
    private readonly host: RelayHost,
    private readonly budget: VisualBudget = processVisualBudget(),
  ) {}

  /** `visualPut` / `visualGet` from a seat or a watcher. A client without the capability is
   *  ignored, and is never answered: it cannot have meant to send either. */
  onMessage(id: string, msg: ClientMsg): void {
    if (this.disposed) return;
    const c = this.host.find(id);
    if (!c || !hasVisualsCap(c.caps)) return;
    if (msg.t === 'visualPut') this.put(c, msg as unknown as Raw);
    else if (msg.t === 'visualGet') this.get(c, msg as unknown as Raw);
  }

  // ---- the owner's upload ----------------------------------------------------------------

  private put(c: Client, raw: Raw): void {
    const kind = raw.kind;
    if (!isVisualKind(kind)) return;
    const id = typeof raw.id === 'string' && VISUAL_ID_RX.test(raw.id) ? raw.id : '';
    const refuse = (reason: VisualRefusal): void =>
      c.send({ t: 'visualRefused', op: 'put', owner: c.id, id, kind, reason, message: VISUAL_REFUSAL_COPY[reason] });
    if (!this.host.allows()) return refuse('room');
    const cur = this.host.importId(c.id);
    if (!cur || cur !== id) return refuse('id');
    const total = raw.total;
    const seq = raw.seq;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1 || total > VISUAL_MAX_BYTES[kind]) return refuse('size');
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq >= visualFrames(total)) return refuse('seq');
    const now = Date.now();
    this.sweep(now);
    const held = this.owners.get(c.id);
    if (held && held.id !== cur) this.freeOwner(c.id);

    if (seq === 0) {
      // a new upload of this kind replaces whatever was here, ready or half sent
      this.freeAsset(c.id, kind);
      for (const [other, o] of this.owners) if (other !== c.id && o.id === id) return refuse('dup');
      if (this.reserved + total > VISUAL_ROOM_BYTES || !this.budget.reserve(total)) return refuse('budget');
      this.reserved += total;
      let o = this.owners.get(c.id);
      if (!o) this.owners.set(c.id, (o = { id }));
      o[kind] = { id, kind, total, buf: new Uint8Array(total), got: 0, next: 0, ready: false, touched: now };
    }
    const o = this.owners.get(c.id);
    const a = o?.[kind];
    // a chunk after the asset completed (a duplicate frame) is not worth losing a good asset over
    if (a?.ready && seq > 0) return;
    if (!o || !a || a.id !== id || a.total !== total || a.next !== seq) {
      this.freeAsset(c.id, kind);
      return refuse('seq');
    }
    const data = raw.data;
    const bytes = typeof data === 'string' && data.length <= VISUAL_CHUNK_CHARS ? base64ToBytes(data) : null;
    const span = visualSpan(total, seq);
    if (!bytes || bytes.length !== span.end - span.start) {
      this.freeAsset(c.id, kind);
      return refuse('size');
    }
    a.buf.set(bytes, span.start);
    a.got += bytes.length;
    a.next++;
    a.touched = now;
    if (a.got < total) return;
    if (validateVisual(kind, a.buf)) {
      this.freeAsset(c.id, kind);
      return refuse('format');
    }
    a.ready = true;
    this.announce(c.id, a);
  }

  /** tell everyone who takes part (the owner included) that `a` can be asked for */
  private announce(owner: string, a: Asset): void {
    const msg: ServerMsg = { t: 'visualReady', owner, id: a.id, kind: a.kind, bytes: a.total };
    let raw: string | null = null;
    for (const r of this.host.recipients()) {
      if (!hasVisualsCap(r.caps)) continue;
      if (r.sendRaw) r.sendRaw((raw ??= JSON.stringify(msg)));
      else r.send(msg);
    }
  }

  /** a client has just attached (joined, spectated, reclaimed a seat): say what is ready */
  greet(c: Client): void {
    if (this.disposed || !hasVisualsCap(c.caps) || !this.host.allows()) return;
    for (const [owner, o] of this.owners) {
      for (const kind of ['top', 'mesh'] as const) {
        const a = o[kind];
        if (a?.ready) c.send({ t: 'visualReady', owner, id: a.id, kind, bytes: a.total });
      }
    }
  }

  // ---- a viewer's download ---------------------------------------------------------------

  private get(c: Client, raw: Raw): void {
    const kind = raw.kind;
    if (!isVisualKind(kind)) return;
    const id = typeof raw.id === 'string' && VISUAL_ID_RX.test(raw.id) ? raw.id : '';
    const owner = typeof raw.owner === 'string' && raw.owner.length <= 64 ? raw.owner : '';
    const refuse = (reason: VisualRefusal): void =>
      c.send({ t: 'visualRefused', op: 'get', owner, id, kind, reason, message: VISUAL_REFUSAL_COPY[reason] });
    if (!this.host.allows()) return refuse('room');
    const o = this.owners.get(owner);
    const a = o?.[kind];
    if (!o || !a || !a.ready || o.id !== id || owner === c.id || this.host.importId(owner) !== id) return refuse('none');
    const box = this.streams.get(c.id);
    if (box?.list.some((s) => s.owner === owner && s.asset === a)) return; // already on its way
    if ((box?.list.length ?? 0) >= VISUAL_STREAMS_PER_CLIENT) return refuse('busy');
    const mine = this.served.get(c.id) ?? 0;
    if (mine + a.total > VISUAL_SERVE_CLIENT_BYTES || this.servedRoom + a.total > VISUAL_SERVE_ROOM_BYTES) return refuse('busy');
    this.served.set(c.id, mine + a.total);
    this.servedRoom += a.total;
    const out = box ?? { list: [], lastAt: 0 };
    out.list.push({ owner, asset: a, seq: 0 });
    this.streams.set(c.id, out);
    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), VISUAL_STREAM_TICK_MS);
    // a timer must never be what keeps a process (or a test) alive
    (this.timer as { unref?: () => void }).unref?.();
  }

  private live(s: Stream): boolean {
    const o = this.owners.get(s.owner);
    return !!o && o[s.asset.kind] === s.asset && s.asset.ready;
  }

  /** one chunk per viewer per pump, paced by the socket's own backlog (`streamMayWrite`) */
  private pump(): void {
    const now = Date.now();
    const liveMatch = this.host.live();
    const allowed = this.host.allows();
    for (const [rid, box] of this.streams) {
      const c = this.host.find(rid);
      if (!c || !allowed) {
        this.streams.delete(rid);
        continue;
      }
      for (let i = box.list.length - 1; i >= 0; i--) if (!this.live(box.list[i])) box.list.splice(i, 1);
      if (!box.list.length) {
        this.streams.delete(rid);
        continue;
      }
      // a held seat (its socket dropped inside the reconnect grace) waits for its new one
      if (c.connected === false) continue;
      if (!streamMayWrite({ backlog: c.backlog ? c.backlog() : undefined, now, lastAt: box.lastAt, live: liveMatch })) continue;
      const s = box.list[0];
      const a = s.asset;
      const span = visualSpan(a.total, s.seq);
      const msg: ServerMsg = {
        t: 'visualChunk',
        owner: s.owner,
        id: a.id,
        kind: a.kind,
        total: a.total,
        seq: s.seq,
        data: bytesToBase64(a.buf, span.start, span.end),
      };
      if (c.sendRaw) c.sendRaw(JSON.stringify(msg));
      else c.send(msg);
      box.lastAt = now;
      s.seq++;
      box.list.shift();
      if (s.seq < visualFrames(a.total)) box.list.push(s); // round-robin across this viewer's streams
      if (!box.list.length) this.streams.delete(rid);
    }
    if (!this.streams.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---- freeing -----------------------------------------------------------------------------

  private freeAsset(owner: string, kind: VisualKind): void {
    const o = this.owners.get(owner);
    const a = o?.[kind];
    if (!o || !a) return;
    delete o[kind];
    this.reserved -= a.total;
    this.budget.release(a.total);
    if (!o.top && !o.mesh) this.owners.delete(owner);
  }

  /** the owner has left, or a seat's robot is no longer the one its assets were for */
  freeOwner(owner: string): void {
    this.freeAsset(owner, 'top');
    this.freeAsset(owner, 'mesh');
  }

  /** a seat's spec changed: its assets stay only while it holds the robot they are for */
  specChanged(seat: string): void {
    const o = this.owners.get(seat);
    if (o && this.host.importId(seat) !== o.id) this.freeOwner(seat);
  }

  /** every seat, after a change that may have stripped imports (`Room.beginMatch`) */
  reconcile(): void {
    for (const seat of [...this.owners.keys()]) this.specChanged(seat);
  }

  /** a viewer is gone: its streams and its quota go with it */
  dropRecipient(id: string): void {
    this.streams.delete(id);
    this.served.delete(id);
  }

  /** an upload that went quiet is not worth the bytes it reserved */
  private sweep(now: number): void {
    for (const [owner, o] of this.owners) {
      for (const kind of ['top', 'mesh'] as const) {
        const a = o[kind];
        if (a && !a.ready && now - a.touched > VISUAL_PUT_STALE_MS) this.freeAsset(owner, kind);
      }
    }
  }

  /** the room is closing: give everything back */
  dispose(): void {
    this.disposed = true;
    for (const owner of [...this.owners.keys()]) this.freeOwner(owner);
    this.streams.clear();
    this.served.clear();
    this.servedRoom = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** what this relay holds, for a check */
  stats(): { reserved: number; owners: number; streams: number; ready: number; servedRoom: number } {
    let ready = 0;
    for (const o of this.owners.values()) for (const k of ['top', 'mesh'] as const) if (o[k]?.ready) ready++;
    return { reserved: this.reserved, owners: this.owners.size, streams: this.streams.size, ready, servedRoom: this.servedRoom };
  }
}
