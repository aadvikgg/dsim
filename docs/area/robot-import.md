<!-- governs: src/robotImport/** -->
# Robot import — the importer engine, its frames and its budgets

The contract is `docs/robot-import-plan.md` (§3 and §4 bind). This guide is the engine's half:
which frame every number is in, how detection works, and what each budget is. Read it before
touching `src/robotImport/**`.

## Layout and the lazy boundary

| file | imports | chunk |
|---|---|---|
| `types.ts` | nothing but types | main-safe |
| `drive.ts` | `src/sim/drivetrain`, `src/config` | main-safe, DOM-free |
| `geometry.ts` | `src/types` | main-safe, DOM-free |
| `shareFile.ts` | nothing | main-safe, no three |
| `library.ts` | `storageKeys`, IndexedDB `decodesim.robots` | main-safe, no three |
| `engineLoader.ts` | one dynamic `import()` | main-safe |
| `engine/**` | three.js, loaders, meshopt, occt | **lazy**: `engine/importerEngine.ts` is the one entry |

- three.js may be imported only under `src/games/biobuzz/scene/` and `src/robotImport/engine/`.
  Every caller reaches the engine through `loadImporterEngine()` (`engineLoader.ts`), the one
  dynamic specifier. The RENDER lane (`scripts/smoke-biobuzz/render.ts`) fails a static import of
  `engine/` from outside it, a second specifier, or three.js anywhere but the two zones.
- `engine/stepReader.ts` is reached by its own `import()` from `engine/load.ts` and runs occt in a
  worker (`stepWorker.ts`), so the glue and its 7.6 MB wasm (a Vite `?url` asset) are fetched only
  when a STEP file is dropped, and a 50 MB STEP does not freeze the page. occt-import-js is
  LGPL-2.1, a devDependency like three (bundled, never installed on the server); it needs a credit
  on the Contributors page.
- Two lazy zones share three.js, so once both are reachable Rollup hoists three (with GLTFLoader,
  the meshopt decoder and BufferGeometryUtils) into a shared chunk named after one of its modules.
  `bundleaudit` bills it to `scene` by its `WebGLRenderer` marker and routes `renderScene-*.js`,
  `importerEngine-*.js` and the STEP files by filename. Until a screen imports the loader, a
  production build drops the engine; `npm run bundleaudit:importer` builds with the loader as an
  extra entry and audits that.

## Frames — every number is in exactly one of these

1. **Source**: whatever the file says. glTF is metres, +Y up, front +Z (glTF 2.0 §3.4). STEP is
   read by occt in millimetres (`linearUnit: 'millimeter'`). 3MF carries a `unit` attribute.
   STL, OBJ and PLY carry no units.
2. **Model frame**: inches, +x front, +y left, +z up, floor at z = 0, x/y origin at the centre of
   the footprint's bounding box. Independent of the wheels, so it does not move when a wheel is
   dragged. Wheel overrides and mechanism placements made in the editor are stored here.
3. **Robot-local frame** (plan §3.1): the model frame shifted so the origin is the wheelbase
   centre (the mean of the four wheel contacts; the footprint box centre when wheels are unknown).
   `ImportedRobot` is in this frame. `modelToRobot` / `robotToModel` convert.
4. **Stored mesh** (the library GLB and the share file): glTF conventions, so any viewer shows it
   upright, life-size and facing the viewer — metres, +Y up, +Z front, +X left, origin at the
   robot-local origin on the floor. `STORED_MESH_TO_ROBOT` (column-major 4×4, `types.ts`) maps it
   to robot-local inches: x = z/0.0254, y = x/0.0254, z = y/0.0254. It is a pure rotation and
   scale (det > 0), so winding is preserved.
5. **Top image**: 512 px square, transparent, front = image up, robot left = image left.
   `topImageFrame(hull)` gives its centre (the hull's box centre) and inches per pixel (the larger
   box side plus 0.5 in a side, over 512). A pixel (u, v), origin top-left, is robot-local
   x = cx + (256 − v)·s, y = cy + (256 − u)·s. Renderers recompute it from `spec.imported.hull`.

## Detection

- **Units**: the robot's largest extent should be near 15 in. Every candidate unit (mm, cm, m,
  in, ft) is scored by |ln(extent/15 in)|; the format's own unit gets a 0.35 head start. STEP and
  3MF units are read, not guessed. A glTF exported in millimetres is 450 "metres" long and loses.
- **Up axis**: the format default (glTF +Y, everything else +Z) plus a geometric tiebreak over all
  six signed axes. A robot stands on its wheels, so the right "down" has (a) floor contacts that
  spread across the footprint, (b) a centre of mass inside the support polygon, and (c) almost no
  flat, downward-facing area at the very bottom. A robot on its side fails (b) and (c).
- **Front**: no geometric cue is reliable, so the default is the CAD front view: −Y front when Z
  is up, +Z front when Y is up. The UI's rotate control turns it in quarter turns.
- **Floor contacts → wheels**: vertices within 0.15 in of the floor (0.5 in if that finds fewer
  than four wheels), joined when within 1 in of each other OR when a mesh edge runs between them
  inside the slab. The edges matter: a cylinder's contact line is two cap vertices a wheel-width
  apart (one wheel, not two), and an intake roller's is one edge a robot-width long (one long
  contact, not two wheels). Clusters longer than 3.5 in are an intake or a skid. Four or more wheel
  clusters → the four corner ones (extremes of ±x ± y after normalising by the layout's extent);
  fewer → a reason, and the rectangle default.
- **Footprint hull**: monotone chain on every vertex's (x, y), reduced to ≤ 16 vertices by a
  MIN-MAX search (binary search on the tolerance; farthest-reach walks from every start), an inner
  approximation whose measured maximum deviation is reported. Greedy removal alone is a local
  optimum (a 64-gon circle cut to 16: 0.26 in, against 0.17 for even spacing). Then quantised to
  1/64 in and re-hulled so `coerceImported` leaves it unchanged.
- **Measured on the simplified mesh.** The engine simplifies once per file, in the source frame
  (simplification commutes with rotation and uniform scale), and `normalise` re-measures the
  ≤ 150k-triangle result on every editor change in tens of milliseconds.
- **Colours are linear RGB** everywhere (`MeshPart.color`, three's working space, glTF's
  `baseColorFactor`). occt already returns linear: converting its colours again darkens them.
- **Height bands** (BIOBUZZ 3D): triangles are clipped into 0.5 in slices, each slice hulled, and
  the slices split into ≤ 3 contiguous bands by DP on the volume a band's hull wastes. Bands are
  emitted only when they save ≥ 5 % of the single prism's volume. Each band hull ≤ 12 vertices.

## Budgets

- ≤ 150,000 triangles after simplification (meshopt `simplify`, then `simplifySloppy` if the
  error-bounded pass stalls), split across parts in proportion to their triangle counts. One
  material per source colour; textures are dropped.
- Stored GLB ≤ 4 MB: positions, creased normals (40°), Uint16/Uint32 indices. If a bake comes out
  larger, the triangle target drops in proportion and the mesh is simplified again.
- `ImportedRobot` ≤ 2 KB JSON (16 + 3 × 12 hull vertices at 1/64 in is about 1.2 KB).
- The drivetrain numbers shown are `driveParams`/`pushForce` of the spec that will be saved. The
  equivalent rpm is motor free rpm ÷ gearbox ÷ external ratio × (wheel mm / 104), because the sim
  models wheel rpm at a 104 mm wheel (`SPEED_PER_RPM`). Catalogue sources are cited in `drive.ts`.

## Proving it

- `npm test` runs the DOM-free half (a block at the end of `scripts/smoke.ts`): the catalogue,
  hull/reduction/wheels/bands, units and up axis in every orientation, HANDEDNESS (the synthetic
  robot carries a flag on its left side only), the descriptor's contract shape, the frame
  matrices, and the share file's byte layout.
- `scripts/robot-import/harness/` is a throwaway Vite page (`npx vite scripts/robot-import/harness
  --port 5191`) that runs every fixture format through the real engine in a browser, re-imports
  each baked GLB to check the stored frame round-trips, and writes the outputs to
  `$ROBOT_IMPORT_OUT`. Fixtures (`scripts/fixtures/robot-import/`) are regenerated by
  `npm run robot-import:fixtures`; each format uses a different unit and up axis on purpose.
