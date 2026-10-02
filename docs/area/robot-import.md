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
- **The engine runs two more workers** (see "Workers" below): `importWorker.ts` and
  `measureWorker.ts`, each its own chunk (route `importworker`, by filename, with the import worker's
  lazy `meshoptDecoder-*.js`). A worker is made only as `new Worker(new URL('./x.ts',
  import.meta.url), { type: 'module' })` inside `engine/` (a smoke check pins the form), and what it
  runs touches no DOM (another check).

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
  (simplification commutes with rotation and uniform scale), and measures the ≤ 150k-triangle
  result. Against measuring every triangle of the stress robots (0.5, 1.5 and 3.9 M), that costs at
  most 0.07 in of hull, 0.13 in of wheel centre and 0.01 in of height, with the same units, up axis
  and band count (`stressbench.ts --full`); `npm test` holds the 0.5 M robot to 1/16 in, 0.15 in and
  0.02 in.
- **Two halves, cached** (`measureSession.ts`). `orientParts` (units and up detection, the model
  frame, the raw hull, floor contacts and wheels, bands) depends only on the units, up axis, yaw and
  band switch; `finishMeasure` (the hull cap, manual wheels, the origin, the band shift, the checks)
  on the rest. `measureParts` is the one composed with the other, and the engine keeps one
  orientation per key, so a wheel drag or a drivetrain edit re-runs only the finish (under a
  millisecond) and the model-frame arrays keep their identity (the preview does not rebuild).
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

## Workers: nothing that scales with the triangle count runs on the main thread

A real FTC export is 1–5 M triangles (every screw thread, chain link and gear tooth). Measured
before this rule, a 3.9 M-triangle STL froze the editor for one 3.6 s task and a units click cost
110–200 ms. So, in the editor:

| work | where |
|---|---|
| parse GLB, glTF, STL, OBJ+MTL, PLY; merge by colour; weld; simplify; crease | `importWorker.ts`, one per import, terminated when it answers |
| STEP: occt | `stepWorker.ts`, then its parts go to the import worker for the rest |
| 3MF: three's loader | **main thread** (it needs `DOMParser`, which no worker has); the rest in the import worker |
| a new orientation (units, up axis, turn) | `measureWorker.ts`, one per model in the editor, holding a copy of the prepared model |
| the light half of a measurement, the model-frame arrays | main thread, from the worker's small `OrientedMeasure` (`toModelFrame` rebuilds the arrays bit for bit) |
| the bake's GLB export and its refits | the import worker (`bakeMesh.ts`); the two pictures need WebGL and stay, with `compileAsync` first |

- **Identical outputs.** Every move is the same code in another thread, and `npm test` holds each to
  the old result bit for bit: the halves against `measureParts`, `toModelFrame` against the arrays
  measured on, the streamed STL reader against three's loader, the weld without its three
  quantised arrays against the weld with them, the direct `partsFromObject` read against
  `Vector3.applyMatrix4`. Arrays cross TRANSFERRED; a buffer listed twice is a `DataCloneError`, so
  `partBuffers` dedupes.
- **The streamed STL reader** (`parseBinaryStlWelded`) reads a binary STL in 3.2 MB slices and merges
  bit-identical vertices as it goes, so a 184 MB file never sits in memory un-indexed; an ASCII STL,
  a colour STL or one whose length disagrees with its count goes to three's loader.
- **Cancel terminates** the import's workers (occt and meshopt cannot be interrupted from inside);
  the promise rejects with an `AbortError`, which the editor shows nothing for. A new drop cancels the
  last one. Measured, the core goes idle within 0.25–2 s of the click.
- **While a new orientation is measured** the editor shows the last measurement of this model and
  holds what would act on it (default placements, a wheel drag, Save, Test drive, Export); past
  300 ms the panel title says "Measuring…".
- **Fallbacks.** No `Worker`, or a worker script that does not load: the same steps on the main
  thread (`load.ts`, `normalise` computing the orientation itself). `npm test` runs those paths,
  which is the same code the workers run. A stored mesh, a share file and the dev harness use the
  main-thread `loadModel` on purpose (≤ 4 MB).
- **Memory.** The renderer's peak on the 3.9 M STL went from 1021 MB to 763 MB; what is left is
  meshopt's working set for a 3.9 M-triangle part, in the import worker, returned when it is
  terminated. The main thread holds the prepared model (≤ 150k triangles) and up to six
  orientations of it; two models keep a measure worker (`KEEP_MODELS`), the oldest is released.

Measured 2026-10-02 (`scripts/robot-import/stressprobe.cjs`, production build, offscreen Electron,
software GL, Ryzen 9 7950X; the stress robots from `scripts/robot-import/stress.ts`):

| model (file MB) | import: longest task, ms | import: blocked total, ms | first frame, ms | peak renderer MB | Units/Up/Turn: longest task / settled, ms | wheel nudge: longest / settled, ms | drivetrain pick, ms | Save: longest task, ms |
|---|---|---|---|---|---|---|---|---|
| 0.47 M GLB (5.7) | 237 → 0 | 435 → 0 | 752 → 625 | 323 → 260 | 159/198 → 0/198 | 104/131 → 0/32 | 72 → 0 | 0 → 0 |
| 0.47 M GLB flat (14.2) | 236 → 0 | 433 → 0 | 777 → 606 | 340 → 327 | 178/213 → 0/167 | 96/115 → 0/31 | 70 → 0 | 0 → 0 |
| 0.47 M STL (22.5) | 324 → 0 | 570 → 0 | 811 → 798 | 362 → 267 | 109/131 → 0/165 | 121/143 → 0/34 | 77 → 0 | 120 → 0 |
| 0.47 M STEP (8.6) | 108 → 0 | 182 → 0 | 7616 → 7363 | 952 → 965 | 68/90 → 0/115 | 53/66 → 0/33 | 0 → 0 | 0 → 0 |
| 1.55 M GLB (8.1) | 897 → 0 | 1157 → 0 | 1606 → 1260 | 477 → 434 | 172/197 → 0/180 | 111/132 → 0/32 | 74 → 0 | 104 → 0 |
| 1.55 M GLB flat (34.7) | 875 → 0 | 1161 → 0 | 1681 → 1326 | 508 → 510 | 198/233 → 0/233 | 83/115 → 0/34 | 87 → 0 | 94 → 0 |
| 1.55 M STL (74) | 1281 → 50 | 1532 → 50 | 1893 → 1944 | 549 → 430 | 127/150 → 0/183 | 135/164 → 0/33 | 73 → 0 | 103 → 0 |
| 3.85 M GLB (12.4) | 2326 → 0 | 2577 → 0 | 3311 → 2660 | 795 → 811 | 168/198 → 0/197 | 110/128 → 0/34 | 79 → 0 | 118 → 0 |
| 3.85 M GLB flat (79.7) | 2747 → 50 | 3008 → 50 | 3969 → 3347 | 791 → 934 | 137/165 → 0/197 | 104/132 → 0/34 | 71 → 0 | 97 → 0 |
| 3.85 M STL (183.8) | 3569 → 0 | 3843 → 0 | 4408 → 4389 | 1021 → 763 | 120/143 → 0/197 | 152/179 → 0/33 | 79 → 0 | 91 → 0 |

Before → after, per stage (long tasks are the browser's, 50 ms and over). The import's work all left
the main thread: what remains is two 50 ms tasks at the first frame, and the measure worker's
answer, 115–230 ms after a Units, Up or Turn click, with nothing blocked meanwhile. A wheel nudge
or a drivetrain pick re-runs only the light half. A Save no longer blocks either. Cancel: before,
the click waited behind the frozen page (up to the longest task, 3.6 s) and a STEP read ran to its
end; now it is handled at once and the workers are terminated (the core is idle within 0.25–2 s,
the time this Electron takes to stop even a bare busy-loop worker). Memory: the streamed STL reader
cut the STL peaks by a quarter; a GLB's peak is about what it was (18 % higher on the 80 MB flat\none: the worker holds the buffers the main thread did), and a STEP's is occt's.

## Relayed to a room (VISUALS RELAY)

The picture and mesh live on the owner's device, so a custom or LAN room relays them (`docs/area/netcode.md`, VISUALS RELAY has the wire, budgets and validation). What the importer owns:

- **What goes:** the top PNG (every viewer, 2D is the default) and the GLB (BIOBUZZ's 3D view only). Caps: PNG ≤ 256 KiB with a side ≤ 1024 px (the bake is 512), GLB ≤ 1 MiB.
- **`liteMesh`** (`engine/lite.ts`, reached through `loadImporterEngine()`) makes the 1 MiB mesh when the stored one (≤ 4 MB) is bigger. It does NOT go back through `normalise`/`bake`: a re-measure could re-detect the wheels or the origin and land the mesh a hair off the footprint the sim was told about. It reads the stored GLB, simplifies the same vertices with the importer's simplifier, re-creases the normals and writes it back in the SAME stored mesh frame, so a viewer places it with `STORED_MESH_TO_ROBOT` exactly as the full one. Measured against real GLTFExporter output: 140k triangles, 2.5 MB → 0.9 MB, bounding box unchanged to 0.1 mm, both colours kept. It returns null below 400 triangles, and the relay then sends the picture alone.
- **`meshLite`** is cached on the library record (`LibraryRobot.meshLite`, `meshLiteFor`, `putMeshLite`; the file key `<id>:meshLite`). `putRobot` drops it unless the save carries one, because the mesh it was cut from may have changed; `deleteRobot` removes it; `getRobot` returns it when present. It is never required.
- **A viewer sees what the owner's device would**: the relayed blobs are lent to the renderers' registry, which prefers a lent blob over the library, and are taken back when the room is left or the viewer turns "Show other players’ imported robots" off. A lent blob carries its LENDER (`registerImportedAssets(id, assets, lender)`): `''` is this device (the editor's draft) and always wins; `relay:<owner>` is a room's, and never replaces another lender's look for that id.
- **The relayed mesh must be what the exporter writes and nothing more.** The relay's GLB check (`validateMeshGlb`) is an allowlist sized to `exportGlbStored`'s output: no glTF extensions, no images or textures, only POSITION/NORMAL/TANGENT/COLOR_0/TEXCOORD_0-1 attributes, nodes with a mesh, children and a transform. If the bake ever writes something new (a material extension, quantised attributes), add it to `VISUAL_GLB_EXTENSIONS` or the key lists WITH a check of its fields, or every relayed mesh is refused and viewers see outlines.
- **Robot ids are unique within a room.** A seat may not hold an id another seat holds (`IMPORT_ID_TAKEN`). An import of a SHARE FILE should therefore mint a new id (`duplicateRobot` does), or two teammates who loaded the same file cannot sit in one room until one duplicates it.

## The importer UI (`src/robotImport/ui/`)

Route `/<game>/configure/robot/import[/<id>]` (`App.tsx` matches it BEFORE the configure section
pattern, or `import` reads as a section name). Four steps: Model, Drivetrain, Mechanisms, Review.

**Two halves, two chunks.** The robot page is in `main`; the editor is lazy.

| main (the robot page, the lobby, Modes) | lazy (`ImportEditor-*.js`, route `importerui`) |
|---|---|
| `pageCopy.ts` (row, panel, dialog strings), `handoff.ts` (files handed to the editor, the one-shot notice, the `dsim-robot-library` BroadcastChannel), `useLibrary.ts`, `ImportedRobots.tsx` (row, panel, actions) | `ImportEditor.tsx` and the four steps, `copy.ts` (every editor string), `editorModel.ts`, `placement.ts`, `draftStore.ts`, `TopDownMap.tsx`, `PreviewPane.tsx`, `useHandleGrab.ts`, `src/ui/importer.css` |
| reached by `import()` on a click: `LibraryDialogs.tsx`, `exportRobot.ts`, `shareFile.ts` | |

- ⚠️ **A main-side file must not import `geometry.ts` or `ui/copy.ts`.** Rollup puts a module
  imported by `main` wholly in `main`, so one static import moved the measurement code (8 KB)
  and the editor's strings into every page load. The robot page uses `polyBounds` from
  `src/sim/imported.ts` and `pageCopy.ts`. A smoke check greps for it.
- ⚠️ **Three more things stay OUT of `main`, and each was in it once** (`npm run bundleaudit` is
  what noticed). (1) `library.ts` (IndexedDB) is reached only by `import()`: the renderers' asset
  seam and the visuals relay's client both do it that way, and its `library` route reading
  `absent` means someone imported it statically. (2) The relay's PNG/GLB validators are
  `src/net/visualCheck.ts`, imported statically by the server (and so by the LAN host worker) and
  by `import()` from the client, which needs them only when a look is uploaded or received; put
  them back into `importVisuals.ts`, which `api.ts` and `protocol.ts` import for a capability
  string, and ~12 KB of minified code is in every page load. (3) The per-game placement checks
  (`<game>/importChecks.ts`) are reached only through `src/games/importMechChecks.ts`, which only
  `placement.ts` (this editor) imports; they are not on `GameSimModule`.
- **The editor works in the MODEL frame** (wheels, handles, the map); `ImportedMech` is stored
  ROBOT-local. `placement.ts` converts (`mechRobotToModel`, and `mechModelToRobot` in
  `geometry.ts` on the way out) and wraps lane 2's `mechHandles` / `defaultImportedMech` /
  `validateImportedMech` (all three from `src/games/importMechChecks.ts`). The mount pickers (`intakeMount` …) still decide WHICH edges exist;
  the map only places them. A player's placement is never moved by a later default.
- **Re-opening a saved robot re-reads its STORED mesh**, not the source file (the library does
  not keep it), so the setup is units `m`, up `+y`, quarter turns 0, and the placements are the
  saved ones converted back to the model frame.
- **Drafts.** `decodesim.robots` v2 adds `drafts` and `draftModels`. Key
  `<game>:<editId | new>`. The document is written 800 ms after the last edit; the parsed model
  once. A draft is deleted on save, on Discard, and with its robot; `listDrafts` prunes any older
  than `DRAFT_MAX_AGE_MS` (30 days). The robot page's add card turns into Resume import while
  one exists.
- ⚠️ **Review blocks what `coerceImported` would refuse.** A spec whose import `coerceImported`
  drops (a side under `IMPORT_MIN_SIDE`, an area under `IMPORT_MIN_AREA`, a sliver) saves fine
  and then plays as its parametric fallback with no word said. `reviewItems` blocks whenever the
  built spec has no `imported`, so a new refusal there is covered without a new item.
- ⚠️ **`computeBands` gives up above 1.5 × the 18 in cube** (`BAND_MAX_HEIGHT_IN`). Its cost
  grows with the cube of the slice count; a model in the wrong units (381 in tall) took 42 s
  and froze the editor between two clicks on Units. A robot that tall is refused anyway.
- **Test drive** passes the draft's spec to `GameView` (`testDrive`), frozen at mount: free
  drive, its own assists, the default start, no other robots, no Zenith auto. Leaving the
  match returns to the editor route, and the draft is flushed first, so nothing is lost.
- **The preview takes a fresh `<canvas>` per controller.** Re-using one after `dispose()`
  (which forces a context loss) threw `Cannot read properties of null (reading 'precision')`
  on the next mount. A lost context falls back to the top-down map.
- **The pictures come from the engine**: `bake` on save, and for a shared `.dsim.glb` added as it is,
  `renderTop` / `renderThumb` on its parts moved by `STORED_MESH_TO_ROBOT`. Never a UI-side render.

## Proving it

- `npm test` runs the DOM-free half (a block at the end of `scripts/smoke.ts`): the catalogue,
  hull/reduction/wheels/bands, units and up axis in every orientation, HANDEDNESS (the synthetic
  robot carries a flag on its left side only), the descriptor's contract shape, the frame
  matrices, and the share file's byte layout. The `robot import (scale)` block after it holds the
  worker moves to the old outputs bit for bit, and the simplified measurement to its tolerance.
- `scripts/robot-import/harness/` is a throwaway Vite page (`npx vite scripts/robot-import/harness
  --port 5191`) that runs every fixture format through the real engine in a browser, re-imports
  each baked GLB to check the stored frame round-trips, and writes the outputs to
  `$ROBOT_IMPORT_OUT`. Fixtures (`scripts/fixtures/robot-import/`) are regenerated by
  `npm run robot-import:fixtures`; each format uses a different unit and up axis on purpose.
- The UI's DOM-free half is the `import UI …` checks in the same smoke block: the copy rules,
  the review list per game (an ordinary robot passes, a 0.5 in one blocks), the draft key, the
  wheel mirror, and source pins on the test drive, the route order and the pad rail.
- `scripts/importshots.cjs` photographs every editor state at 1440×900, 1100×720 and 390×844 in
  both themes, in an OFFSCREEN Electron window, into `scratch/importshots/<sha>/` with an
  `index.html` sheet. `scripts/importpad.cjs` walks the editor by stubbed gamepad and then by
  real key events and asserts each step. Both need `npx vite --port 5194 --strictPort` running
  and `env -u ELECTRON_RUN_AS_NODE npx electron scripts/<file>`.
- `scripts/importprobe.cjs` measures the UI's cost against a PRODUCTION build (`npx vite preview
  --port 4173`), cold cache, long tasks observed from before the first script. Measured
  2026-10-01 (desktop, software GL): six imports add no long task to the robot page; the empty
  editor fetches its chunk and `geometry-*.js` (the measurement code it runs) but not the engine;
  the 18 KB GLB fixture reaches its first frame in ~200 ms with no long task; 150k triangles:
  first frame 524 ms, longest task 142 ms (budget 200); re-opening a saved import 147 ms the
  first time, 24 ms warm; ten editor trips: heap flat after GC, no "Too many active WebGL
  contexts".
  Past ~250k triangles the longest task broke 200 ms (368k gave 307 ms, nearly all `simplifyModel`);
  that is what moved into the import worker (see "Workers").
- **At real-CAD scale**: `npx tsx scripts/robot-import/stress.ts` writes the stress robots (0.5, 1.5
  and 3.9 M triangles as shared-mesh GLB, flat GLB and binary STL, and an analytic STEP) to
  `%TEMP%/dsim-robot-stress` (30–190 MB each, never committed). `scripts/robot-import/stressprobe.cjs`
  drives the real editor with them against a production build (import timeline, long tasks, renderer
  memory, each Model-step edit, a preview zoom, Save, Cancel with the CPU after it), and
  `scripts/robot-import/stressbench.ts` times the engine's stages in Node and, with `--full`, the
  accuracy of measuring the simplified mesh against the full one.
