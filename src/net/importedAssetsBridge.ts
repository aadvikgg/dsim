/**
 * THE ADAPTER between the visuals relay (`importVisualsClient.ts`) and the renderers' asset
 * registry (lane 6, `src/render/importedAssets.ts`: `registerImportedAssets(id, { top?, mesh? })`
 * and `unregisterImportedAssets(id)`, which lend in-memory blobs that win over the device library).
 *
 * ⚠️ INTEGRATION: the registry was in flight when the relay was written, so this file imports
 * nothing from it. It holds what the relay received (so nothing is lost if the registry is wired
 * late) and hands it to a SINK once there is one. Wiring is one line, in the app's start-up, after
 * both lanes are on the branch:
 *
 *     setRelayedAssetSink({ register: registerImportedAssets, unregister: unregisterImportedAssets });
 *
 * A sink set late is given everything already held. DOM-free: it makes Blobs, nothing more.
 */
import type { VisualKind } from './importVisuals';

export interface RelayedAssetSink {
  register(id: string, assets: { top?: Blob | null; mesh?: Blob | null }): void;
  unregister(id: string): void;
}

const MIME: Record<VisualKind, string> = { top: 'image/png', mesh: 'model/gltf-binary' };

let sink: RelayedAssetSink | null = null;
/** what the relay has received and not yet given up: robot id → its blobs */
const held = new Map<string, { top?: Blob; mesh?: Blob }>();

/** plug the renderers' registry in (or null to unplug); it is handed everything already held */
export function setRelayedAssetSink(next: RelayedAssetSink | null): void {
  sink = next;
  if (next) for (const [id, assets] of held) next.register(id, assets);
}

/** a validated asset arrived for robot `id` */
export function registerRelayedAsset(id: string, kind: VisualKind, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], { type: MIME[kind] });
  const cur = held.get(id) ?? {};
  cur[kind] = blob;
  held.set(id, cur);
  sink?.register(id, { [kind]: blob });
}

/** has the relay already delivered this asset on this device? */
export function hasRelayedAsset(id: string, kind: VisualKind): boolean {
  return !!held.get(id)?.[kind];
}

/** the relay is done with these robots (the room was left, or the viewer turned them off) */
export function unregisterRelayedAssets(ids: Iterable<string>): void {
  for (const id of ids) {
    if (!held.delete(id)) continue;
    sink?.unregister(id);
  }
}

/** every robot id the relay is holding something for */
export function relayedAssetIds(): string[] {
  return [...held.keys()];
}
