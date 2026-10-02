/**
 * ROBOT IMPORT — THE LIBRARY: imported robots on this device (plan §3.2). IndexedDB, no three.js.
 *
 * Two object stores so a list never touches a mesh: `robots` holds each `LibraryEntry` (the spec,
 * the setup, the source facts; keyPath `id`, index `game`) and `files` holds the three blobs
 * under `<id>:mesh`, `<id>:top` and `<id>:thumb`. Every write that touches both is one
 * transaction, so a crash cannot leave a robot without its mesh.
 *
 * Every call resolves (never rejects) to a `LibraryResult`: IndexedDB is missing in some private
 * windows and embedded browsers, and a full disk is an ordinary event, so both come back as a
 * plain sentence the UI can show. The database name is registered in `src/storageKeys.ts`.
 */
import { ROBOT_LIBRARY_DB } from '../storageKeys';
import type { GameId } from '../types';
import type { LibraryEntry, LibraryRobot } from './types';

/** 2 added the two DRAFT stores (lane 4, the editor): `drafts` holds an unfinished import's editor
 *  state (keyPath `key`, index `game`), `draftModels` its simplified source-frame model, written
 *  once per file so an edit rewrites only the small state row. */
const DB_VERSION = 2;
const ROBOTS = 'robots';
const FILES = 'files';
const DRAFTS = 'drafts';
const DRAFT_MODELS = 'draftModels';
const KINDS = ['mesh', 'top', 'thumb'] as const;
type FileKind = (typeof KINDS)[number];
const fileKey = (id: string, kind: FileKind): string => `${id}:${kind}`;

export type LibraryError = 'unavailable' | 'quota' | 'not-found' | 'failed';
export type LibraryResult<T> = { ok: true; value: T } | { ok: false; error: LibraryError; message: string };

const MESSAGES: Record<LibraryError, string> = {
  unavailable:
    'Couldn’t open the robot library on this device. Private browsing can block it; imported robots need a normal window.',
  quota: 'Couldn’t save the robot: this device is out of storage space for DSIM. Delete an imported robot and try again.',
  'not-found': 'Couldn’t find that robot in the library. It may have been deleted in another tab.',
  failed: 'Couldn’t update the robot library. Reload the page and try again.',
};

const err = <T>(error: LibraryError): LibraryResult<T> => ({ ok: false, error, message: MESSAGES[error] });
const ok = <T>(value: T): LibraryResult<T> => ({ ok: true, value });

/** 16 lowercase hex chars, the `ImportedRobot.id` shape */
export function newRobotId(): string {
  const bytes = new Uint8Array(8);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const ROBOT_ID_RX = /^[0-9a-f]{16}$/;

function classify(e: unknown): LibraryError {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota';
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'UnknownError') return 'unavailable';
  return 'failed';
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** whether this browser has IndexedDB at all (it can still refuse to open) */
export function libraryAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (!libraryAvailable()) return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(ROBOT_LIBRARY_DB, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROBOTS)) {
        const s = db.createObjectStore(ROBOTS, { keyPath: 'id' });
        s.createIndex('game', 'game', { unique: false });
      }
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      if (!db.objectStoreNames.contains(DRAFTS)) {
        const d = db.createObjectStore(DRAFTS, { keyPath: 'key' });
        d.createIndex('game', 'game', { unique: false });
      }
      if (!db.objectStoreNames.contains(DRAFT_MODELS)) db.createObjectStore(DRAFT_MODELS);
    };
    req.onsuccess = () => {
      const db = req.result;
      // another tab upgrading the schema: let it, and reopen next time
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  // a failed open is retried on the next call rather than cached forever
  void dbPromise.then((db) => {
    if (!db) dbPromise = null;
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<LibraryError | null> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(null);
    tx.onerror = () => resolve(classify(tx.error));
    tx.onabort = () => resolve(classify(tx.error));
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<LibraryResult<T>>): Promise<LibraryResult<T>> {
  const db = await openDb();
  if (!db) return err('unavailable');
  try {
    return await fn(db);
  } catch (e) {
    return err(classify(e));
  }
}

const entryOf = (r: LibraryRobot | LibraryEntry): LibraryEntry => ({
  id: r.id,
  game: r.game,
  spec: r.spec,
  source: r.source,
  setup: r.setup,
  created: r.created,
  updated: r.updated,
});

/** the library's robots for one game (or all), newest first, without their blobs */
export function listRobots(game?: GameId): Promise<LibraryResult<LibraryEntry[]>> {
  return withDb(async (db) => {
    const tx = db.transaction(ROBOTS, 'readonly');
    const store = tx.objectStore(ROBOTS);
    const rows = (await request(game ? store.index('game').getAll(game) : store.getAll())) as LibraryEntry[];
    rows.sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1));
    return ok(rows.map(entryOf));
  });
}

/** one robot with its blobs */
export function getRobot(id: string): Promise<LibraryResult<LibraryRobot>> {
  return withDb(async (db) => {
    const tx = db.transaction([ROBOTS, FILES], 'readonly');
    const entry = (await request(tx.objectStore(ROBOTS).get(id))) as LibraryEntry | undefined;
    if (!entry) return err('not-found');
    const files = tx.objectStore(FILES);
    const [mesh, top, thumb] = (await Promise.all(KINDS.map((k) => request(files.get(fileKey(id, k)))))) as (Blob | undefined)[];
    if (!mesh || !top || !thumb) return err('not-found');
    return ok({ ...entryOf(entry), mesh, top, thumb });
  });
}

/** add or replace a robot (and its three blobs) in one transaction */
export function putRobot(robot: LibraryRobot): Promise<LibraryResult<LibraryEntry>> {
  return withDb(async (db) => {
    if (!ROBOT_ID_RX.test(robot.id)) return err('failed');
    const tx = db.transaction([ROBOTS, FILES], 'readwrite');
    const entry = entryOf(robot);
    tx.objectStore(ROBOTS).put(entry);
    const files = tx.objectStore(FILES);
    files.put(robot.mesh, fileKey(robot.id, 'mesh'));
    files.put(robot.top, fileKey(robot.id, 'top'));
    files.put(robot.thumb, fileKey(robot.id, 'thumb'));
    const e = await done(tx);
    if (e) return err(e);
    topCache.delete(robot.id);
    return ok(entry);
  });
}

/** change a robot's name (`spec.name`) */
export function renameRobot(id: string, name: string): Promise<LibraryResult<LibraryEntry>> {
  return withDb(async (db) => {
    const tx = db.transaction(ROBOTS, 'readwrite');
    const store = tx.objectStore(ROBOTS);
    const entry = (await request(store.get(id))) as LibraryEntry | undefined;
    if (!entry) return err('not-found');
    const next: LibraryEntry = { ...entry, spec: { ...entry.spec, name: name.trim().slice(0, 64) }, updated: Date.now() };
    store.put(next);
    const e = await done(tx);
    return e ? err(e) : ok(next);
  });
}

/** a copy under a new id, named "<name> copy" */
export async function duplicateRobot(id: string): Promise<LibraryResult<LibraryEntry>> {
  const got = await getRobot(id);
  if (!got.ok) return got;
  const src = got.value;
  const nid = newRobotId();
  const now = Date.now();
  const spec = {
    ...src.spec,
    name: `${src.spec.name} copy`.slice(0, 64),
    ...(src.spec.imported ? { imported: { ...src.spec.imported, id: nid } } : {}),
  };
  return putRobot({ ...src, id: nid, spec, created: now, updated: now });
}

/** remove a robot and its blobs */
export function deleteRobot(id: string): Promise<LibraryResult<void>> {
  return withDb(async (db) => {
    const tx = db.transaction([ROBOTS, FILES], 'readwrite');
    tx.objectStore(ROBOTS).delete(id);
    const files = tx.objectStore(FILES);
    for (const k of KINDS) files.delete(fileKey(id, k));
    const e = await done(tx);
    if (e) return err(e);
    topCache.delete(id);
    return ok(undefined);
  });
}

async function fileFor(id: string, kind: FileKind): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(FILES, 'readonly');
    const blob = (await request(tx.objectStore(FILES).get(fileKey(id, kind)))) as Blob | undefined;
    return blob ?? null;
  } catch {
    return null;
  }
}

/** the stored GLB for the 3D renderer (frame: `STORED_MESH_TO_ROBOT`), or null on this device */
export function meshFor(id: string): Promise<Blob | null> {
  return fileFor(id, 'mesh');
}

const topCache = new Map<string, Promise<Blob | null>>();

/** the top-down PNG for the 2D renderer (frame: `topImageFrame`), cached per id */
export function topFor(id: string): Promise<Blob | null> {
  let p = topCache.get(id);
  if (!p) {
    p = fileFor(id, 'top');
    topCache.set(id, p);
    void p.then((b) => {
      if (!b) topCache.delete(id);
    });
  }
  return p;
}

/** the card thumbnail */
export function thumbFor(id: string): Promise<Blob | null> {
  return fileFor(id, 'thumb');
}

// ---- drafts: an import the editor has not saved yet (lane 4) ---------------------------------
//
// Keyed `<game>:new` (a new import) or `<game>:<id>` (unsaved edits to a library robot). The state
// row is small and rewritten on every edit (debounced by the editor); the model is the simplified
// SOURCE-frame model, structured-cloned as is (typed arrays and all), written once per file. A
// reload restores both, so corrections still re-run from the source exactly as before.

/** an unfinished import's editor state. The editor owns the shape; the library stores it. */
export interface DraftRecord {
  key: string;
  game: GameId;
  updated: number;
  [field: string]: unknown;
}

/** drafts older than this are dropped the next time the list is read */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** save a draft's state, and its model when `model` is given */
export function putDraft(state: DraftRecord, model?: unknown): Promise<LibraryResult<void>> {
  return withDb(async (db) => {
    const stores = model === undefined ? [DRAFTS] : [DRAFTS, DRAFT_MODELS];
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore(DRAFTS).put(state);
    if (model !== undefined) tx.objectStore(DRAFT_MODELS).put(model, state.key);
    const e = await done(tx);
    return e ? err(e) : ok(undefined);
  });
}

/** a draft's state and model (null when either is missing) */
export function getDraft(key: string): Promise<LibraryResult<{ state: DraftRecord; model: unknown } | null>> {
  return withDb(async (db) => {
    const tx = db.transaction([DRAFTS, DRAFT_MODELS], 'readonly');
    const state = (await request(tx.objectStore(DRAFTS).get(key))) as DraftRecord | undefined;
    if (!state) return ok(null);
    const model = await request(tx.objectStore(DRAFT_MODELS).get(key));
    return ok(model === undefined ? null : { state, model });
  });
}

/** the drafts for one game, without their models; prunes the stale ones */
export function listDrafts(game: GameId): Promise<LibraryResult<DraftRecord[]>> {
  return withDb(async (db) => {
    const tx = db.transaction([DRAFTS, DRAFT_MODELS], 'readwrite');
    const store = tx.objectStore(DRAFTS);
    const rows = (await request(store.index('game').getAll(game))) as DraftRecord[];
    const now = Date.now();
    const keep: DraftRecord[] = [];
    for (const r of rows) {
      if (now - r.updated > DRAFT_MAX_AGE_MS) {
        store.delete(r.key);
        tx.objectStore(DRAFT_MODELS).delete(r.key);
      } else keep.push(r);
    }
    const e = await done(tx);
    return e ? err(e) : ok(keep);
  });
}

/** remove a draft and its model */
export function deleteDraft(key: string): Promise<LibraryResult<void>> {
  return withDb(async (db) => {
    const tx = db.transaction([DRAFTS, DRAFT_MODELS], 'readwrite');
    tx.objectStore(DRAFTS).delete(key);
    tx.objectStore(DRAFT_MODELS).delete(key);
    const e = await done(tx);
    return e ? err(e) : ok(undefined);
  });
}
