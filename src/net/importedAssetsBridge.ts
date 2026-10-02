/**
 * THE ADAPTER between the visuals relay (`importVisualsClient.ts`) and the renderers' asset
 * registry (`src/render/importedAssets.ts`): `registerImportedAssets(id, { top?, mesh? })` lends an
 * in-memory blob that WINS over the device library, and `unregisterImportedAssets(id)` takes it
 * back — "a mesh that arrived over a room's relay", in that file's own words.
 *
 * It exists so the relay holds one small seam and not the registry's whole surface, and so a check
 * can stand a recorder in for the registry (`setRelayedAssetSink`). It remembers which robot ids it
 * has delivered, so the relay can ask "do I already have this one?" without a second lookup.
 * DOM-free: it makes Blobs, nothing more.
 */
import { registerImportedAssets, unregisterImportedAssets } from '../render/importedAssets';
import type { VisualKind } from './importVisuals';

export interface RelayedAssetSink {
  register(id: string, assets: { top?: Blob | null; mesh?: Blob | null }): void;
  unregister(id: string): void;
}

const MIME: Record<VisualKind, string> = { top: 'image/png', mesh: 'model/gltf-binary' };

/** the renderers' own registry: where relayed assets go unless a check says otherwise */
const REGISTRY: RelayedAssetSink = { register: registerImportedAssets, unregister: unregisterImportedAssets };
let sink: RelayedAssetSink = REGISTRY;
/** what the relay has delivered and not yet given up: robot id → which kinds */
const held = new Map<string, { top?: true; mesh?: true }>();

/** stand another sink in for the registry (a check), or null for the registry again */
export function setRelayedAssetSink(next: RelayedAssetSink | null): void {
  sink = next ?? REGISTRY;
}

/** a validated asset arrived for robot `id` */
export function registerRelayedAsset(id: string, kind: VisualKind, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], { type: MIME[kind] });
  held.set(id, { ...held.get(id), [kind]: true });
  sink.register(id, { [kind]: blob });
}

/** has the relay already delivered this asset on this device? */
export function hasRelayedAsset(id: string, kind: VisualKind): boolean {
  return !!held.get(id)?.[kind];
}

/** the relay is done with these robots (the room was left, or the viewer turned them off) */
export function unregisterRelayedAssets(ids: Iterable<string>): void {
  for (const id of ids) {
    if (!held.delete(id)) continue;
    sink.unregister(id);
  }
}

/** every robot id the relay is holding something for */
export function relayedAssetIds(): string[] {
  return [...held.keys()];
}
