import { useEffect, useState } from 'react';
import type { GameId } from '../../games/types';
import type { LibraryEntry } from '../types';
import type { DraftRecord } from '../library';
import { onLibraryChange } from './handoff';

/**
 * THE IMPORTED ROBOTS OF ONE GAME ON THIS DEVICE, for the robot page (the row, the hero, the
 * panel). `library.ts` is `import()`ed here rather than imported, so the main chunk carries this
 * hook and not the IndexedDB code; the cards land one read after the first paint, beside an add
 * card that was there from the start.
 *
 * Thumbnails are object URLs kept for the life of the document, keyed by id and `updated`, so a
 * remount of the page does not re-read and re-decode them; a robot that changes or goes has its
 * old URL revoked.
 */

export interface LibraryView {
  /** null until the first read lands */
  entries: LibraryEntry[] | null;
  /** id → object URL of the card thumbnail */
  thumbs: Record<string, string>;
  /** this game's unsaved new import, when there is one */
  draft: DraftRecord | null;
  /** IndexedDB refused (private window, blocked storage): the sentence to show */
  error: string | null;
}

const urls = new Map<string, { updated: number; url: string }>();

function lib() {
  return import('../library');
}

async function thumbUrl(id: string, updated: number): Promise<string | null> {
  const have = urls.get(id);
  if (have && have.updated === updated) return have.url;
  const { thumbFor } = await lib();
  const blob = await thumbFor(id);
  if (!blob) return null;
  if (have) URL.revokeObjectURL(have.url);
  const url = URL.createObjectURL(blob);
  urls.set(id, { updated, url });
  return url;
}

export async function readLibrary(game: GameId): Promise<LibraryView> {
  const { listRobots, listDrafts } = await lib();
  const [list, drafts] = await Promise.all([listRobots(game), listDrafts(game)]);
  if (!list.ok) return { entries: [], thumbs: {}, draft: null, error: list.message };
  const thumbs: Record<string, string> = {};
  await Promise.all(
    list.value.map(async (e) => {
      const u = await thumbUrl(e.id, e.updated);
      if (u) thumbs[e.id] = u;
    }),
  );
  // a robot that left the library takes its URL with it
  for (const [id, v] of urls) {
    if (!list.value.some((e) => e.id === id)) {
      URL.revokeObjectURL(v.url);
      urls.delete(id);
    }
  }
  const draft = drafts.ok ? (drafts.value.find((d) => d.key === `${game}:new`) ?? null) : null;
  return { entries: list.value, thumbs, draft, error: null };
}

export function useLibrary(game: GameId): LibraryView {
  const [view, setView] = useState<LibraryView>({ entries: null, thumbs: {}, draft: null, error: null });
  useEffect(() => {
    let dead = false;
    const read = (): void => {
      void readLibrary(game)
        .then((v) => {
          if (!dead) setView(v);
        })
        .catch((e: unknown) => {
          console.warn('[import] library read failed', e);
          if (!dead) setView({ entries: [], thumbs: {}, draft: null, error: null });
        });
    };
    read();
    const off = onLibraryChange(read);
    return () => {
      dead = true;
      off();
    };
  }, [game]);
  return view;
}
