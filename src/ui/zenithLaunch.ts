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
import { autoTooLarge, loadAutoLibrary, saveAutoLibrary, upsertAuto, type GameAutoLibrary } from '../auto/library';
import { hostLibraryView, leftOutSentence, planHostSave, waypointsForSave, type HostSaveState } from '../auto/hostLibrary';
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
  /**
   * At every project sent: the sentence naming the library autos Zenith was not given because
   * their waypoints clash with the file it was sent (`hostLibraryView`), or null when none was.
   */
  onLeftOut?(sentence: string | null): void;
}

/** Returns null when Zenith opened, or the sentence to show when it could not. */
export function launchZenith(o: LaunchOptions): string | null {
  const { settings } = o;
  const game = settings.game;
  const adapter = autoAdapterFor(game);
  if (!adapter) return 'This game has no Zenith autos.';
  const entry0 = o.open === null ? null : (loadAutoLibrary(game).entries.find((e) => e.name === o.open) ?? null);
  /**
   * What the session remembers between saves (`planHostSave`): the names it may write, Zenith's
   * name for each auto it stored under another one, and the waypoints file Zenith was last shown.
   * A new auto starts from an empty project, so Zenith names it `new-auto` whatever the library
   * holds, and a second New in Zenith session's Save used to replace the first one's by name.
   */
  const state: HostSaveState = { own: new Set(), alias: new Map() };
  /** the auto a reload should open: the one this session saved last, else the one it opened */
  let reopen: string | null = entry0?.name ?? null;
  const session = openZenith({
    // built at every `ready`, from the library as it is NOW (see `ZenithSessionOptions.project`)
    project: () => {
      const lib = loadAutoLibrary(game);
      const entry = reopen === null ? null : (lib.entries.find((e) => e.name === reopen) ?? null);
      // a new auto sends no autos, so Zenith starts from its template
      const view = entry ? hostLibraryView(lib, entry) : { autos: {}, leftOut: [] };
      for (const n of Object.keys(view.autos)) state.own.add(n);
      state.sent = view.waypoints;
      o.onLeftOut?.(leftOutSentence(view.leftOut));
      return {
        project: {
          name: 'DSIM',
          hostLabel: settings.spec.name?.trim() || 'DSIM robot',
          robot: adapter.robot(settings.spec),
          field: adapter.field(),
          ...(view.waypoints ? { waypoints: view.waypoints } : {}),
          autos: view.autos,
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
      const plan = planHostSave(current, state, name, text);
      if (!plan.ok) return plan.error;
      const next = upsertAuto(current, { ...plan.entry, source: 'zenith', savedAt: Date.now() });
      if (!saveAutoLibrary(game, next)) return 'DSIM couldn’t store it on this device: browser storage is full.';
      state.own.add(plan.target);
      state.alias.set(name, plan.target);
      reopen = plan.target;
      o.onLibrary?.(next, plan.target);
      return null;
    },
    onRun: async (name, text) => {
      const own = loadAutoLibrary(game).entries.find((e) => e.name === (state.alias.get(name) ?? name))?.waypoints;
      // the waypoints Zenith drew it against: its own, plus any name it uses from the merged file
      const wp = waypointsForSave(own, state.sent, text);
      return runAutoHeadless({ game, spec: settings.spec, setup: { auto: text, ...(wp ? { waypoints: wp } : {}) } }).trace;
    },
  });
  if (!session) return `Couldn’t open Zenith. Allow pop-ups for this site, or open ${ZENITH_URL} yourself.`;
  return null;
}
