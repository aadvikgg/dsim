/**
 * OPEN ZENITH FOR THIS PLAYER'S AUTO LIBRARY — the one place a DSIM screen does it, so the
 * Autonomous section's "Edit in Zenith" and the match screen's "Open run in Zenith" hand Zenith the
 * same project and take a Save back the same way (`zenith-host/1`, `zenithHost.ts`).
 *
 * SYNCHRONOUS on purpose: `window.open` must run inside the click that asked for it or the browser
 * blocks the popup. So this file is reached only through the lazy `zenithEditor.ts` entry, which a
 * screen has already loaded by the time its button can be clicked, and it is not in the main chunk.
 */
import type { GameSettings } from '../types';
import { AUTO_LIBRARY_MAX, autoTooLarge, loadAutoLibrary, saveAutoLibrary, upsertAuto, type GameAutoLibrary } from '../auto/library';
import { autoAdapterFor, parseAutoText, runAutoHeadless } from '../auto/zenithAutos';
import { openZenith, ZENITH_URL } from './zenithHost';

export interface LaunchOptions {
  settings: GameSettings;
  /** the auto to open, by library name; null starts a new one */
  open: string | null;
  /** a recorded run of `open` to lay over the plan as soon as Zenith has it */
  trace?: unknown;
  /** the library after a Save from Zenith landed in it */
  onLibrary?(lib: GameAutoLibrary, savedName: string): void;
}

/** Returns null when Zenith opened, or the sentence to show when it could not. */
export function launchZenith(o: LaunchOptions): string | null {
  const { settings } = o;
  const game = settings.game;
  const adapter = autoAdapterFor(game);
  if (!adapter) return 'This game has no Zenith autos.';
  const entry0 = o.open === null ? null : (loadAutoLibrary(game).entries.find((e) => e.name === o.open) ?? null);
  /**
   * THE NAMES THIS SESSION MAY WRITE: every auto it sent Zenith, and every auto it has saved.
   * A new auto starts from an empty project, so Zenith names it `new-auto` whatever the library
   * holds, and a second New in Zenith session's Save used to replace the first one's by name. A
   * save under a library name this session never sent is stored under a free name instead, and
   * `alias` keeps Zenith's name pointing at it for the rest of the session.
   */
  const own = new Set<string>();
  const alias = new Map<string, string>();
  /** the auto a reload should open: the one this session saved last, else the one it opened */
  let reopen: string | null = entry0?.name ?? null;
  const readWaypoints = (text: string | undefined): unknown => {
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  };
  const session = openZenith({
    // built at every `ready`, from the library as it is NOW (see `ZenithSessionOptions.project`)
    project: () => {
      const lib = loadAutoLibrary(game);
      const entry = reopen === null ? null : (lib.entries.find((e) => e.name === reopen) ?? null);
      const waypoints = entry ? readWaypoints(entry.waypoints) : undefined;
      const autos: Record<string, string> = {};
      for (const e of lib.entries) autos[e.name] = e.auto;
      if (entry) for (const e of lib.entries) own.add(e.name);
      return {
        project: {
          name: 'DSIM',
          hostLabel: settings.spec.name?.trim() || 'DSIM robot',
          robot: adapter.robot(settings.spec),
          field: adapter.field(),
          ...(waypoints ? { waypoints } : {}),
          // a new auto sends no autos, so Zenith starts from its template
          autos: entry ? autos : {},
        },
        ...(entry ? { open: entry.name } : {}),
      };
    },
    ...(entry0 && o.trace !== undefined ? { trace: o.trace, traceAuto: entry0.name } : {}),
    onSave: async (name, text) => {
      try {
        parseAutoText(text);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const tooLarge = autoTooLarge(text);
      if (tooLarge) return tooLarge;
      const current = loadAutoLibrary(game);
      let target = alias.get(name) ?? name;
      let prior = current.entries.find((e) => e.name === target);
      if (prior && !own.has(target)) {
        target = freeAutoName(current, target);
        prior = undefined;
      }
      // a full library used to drop its oldest auto here, even the one AUTO plays
      if (!prior && current.entries.length >= AUTO_LIBRARY_MAX) {
        return `DSIM keeps ${AUTO_LIBRARY_MAX} autos and its library is full. Delete one in DSIM's Autonomous panel, then save again.`;
      }
      const wp = prior?.waypoints ?? entry0?.waypoints;
      const next = upsertAuto(current, {
        ...(prior ? { id: prior.id } : {}),
        name: target,
        auto: text,
        ...(wp ? { waypoints: wp } : {}),
        source: 'zenith',
        savedAt: Date.now(),
      });
      if (!saveAutoLibrary(game, next)) return 'DSIM couldn’t store it on this device: browser storage is full.';
      own.add(target);
      alias.set(name, target);
      reopen = target;
      o.onLibrary?.(next, target);
      return null;
    },
    onRun: async (name, text) => {
      const wp = loadAutoLibrary(game).entries.find((e) => e.name === (alias.get(name) ?? name))?.waypoints ?? entry0?.waypoints;
      return runAutoHeadless({ game, spec: settings.spec, setup: { auto: text, ...(wp ? { waypoints: wp } : {}) } }).trace;
    },
  });
  if (!session) return `Couldn’t open Zenith. Allow pop-ups for this site, or open ${ZENITH_URL} yourself.`;
  return null;
}

/** `base`, else `base-2`, `base-3`…: the first name no library entry has (Zenith's own scheme) */
function freeAutoName(lib: GameAutoLibrary, base: string): string {
  const names = new Set(lib.entries.map((e) => e.name));
  let i = 2;
  while (names.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}
