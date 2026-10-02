import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameSettings } from '../../game';
import type { ImportedMech, RobotSpec, Vec2 } from '../../types';
import { coerceSpec } from '../../sim/spawn';
import { seasonFor } from '../../seasons';
import { FOCUSABLE } from '../../ui/PadNavLayer';
import { loadImporterEngine, type ImporterEngine } from '../engineLoader';
import type { NormalisedModel, PreparedModel } from '../engine/importerEngine';
import type { LoadStage } from '../engine/load';
import { defaultImportSetup, transformParts } from '../geometry';
import { getRobot, newRobotId, putRobot } from '../library';
import { readShareFile, type SharePayload } from '../shareFile';
import { STORED_MESH_TO_ROBOT, type ImportSetup, type LibraryRobot } from '../types';
import { defaultMechFor, mechHandlesFor, mechRobotToModel, validateMechFor } from './placement';
import { invalidateImportedAssets, registerImportedAssets, unregisterImportedAssets } from '../../render/importedAssets';
import { COPY } from './copy';
import { DrivetrainStep } from './DrivetrainStep';
import { dropDraft, flushDraft, keepDraft, liveDraft, restoreDraft, type LiveDraft } from './draftStore';
import type { DropError, Phase } from './DropZone';
import {
  baseName,
  blocks,
  buildSpec,
  draftKey,
  driveNumbers,
  moveWheel,
  rectangleWheels,
  reviewItems,
  reviewSummary,
  stepOf,
  type EditorDoc,
  type ReviewItem,
  type StepIndex,
} from './editorModel';
import { downloadBytes, shareBytes, shareFileName } from './exportRobot';
import { libraryChanged, postRobotNotice, takeHandedFiles } from './handoff';
import { ConfirmDialog, DuplicateDialog } from './LibraryDialogs';
import { MechanismsStep } from './MechanismsStep';
import { ModelStep } from './ModelStep';
import { PreviewPane } from './PreviewPane';
import { ReviewStep } from './ReviewStep';
import { TopDownMap } from './TopDownMap';
import './../../ui/importer.css';

/**
 * THE ROBOT IMPORT EDITOR — `/<game>/configure/robot/import[/<id>]`, a lazy chunk (lane 4 spec §2).
 *
 * One screen: a step rail (Model · Drivetrain · Mechanisms · Review), the step's panel, and a
 * persistent preview. The document it edits (`EditorDoc`) lives in the draft store, not in this
 * component: a test drive unmounts the editor and the way back remounts it, and a reload restores it
 * from IndexedDB, so neither loses a thing.
 *
 * The engine (three.js, the loaders) is fetched on the first file, a draft resume or a re-open —
 * never on an empty editor.
 */
export interface ImportEditorProps {
  settings: GameSettings;
  /** the library robot being edited, or null for a new import */
  editId: string | null;
  onBack: () => void;
  /** saved (or added from a share file): the App makes it active and goes back to the robot page */
  onSaved: (spec: RobotSpec) => void;
  onTestDrive: (spec: RobotSpec) => void;
}

/** focus to restore when the editor comes back from a test drive */
let focusOnReturn: string | null = null;
/** the engine module once loaded, so a remount (the way back from a test drive) has it on its
 *  first render instead of flashing the empty Model step while `import()` resolves again */
let engineCache: ImporterEngine | null = null;

const STAGE_LABEL = (stage: LoadStage, file: string): string => {
  const p = COPY.phase[stage];
  return typeof p === 'function' ? p(file) : p;
};

function freshDoc(settings: GameSettings, key: string, editId: string | null): EditorDoc {
  const base: RobotSpec = { ...settings.spec };
  delete base.imported;
  return {
    v: 1,
    key,
    game: settings.game,
    id: editId ?? newRobotId(),
    editId,
    step: 0,
    setup: defaultImportSetup({ massLb: settings.spec.massLb }),
    detected: null,
    mech: null,
    spec: base,
    source: null,
    savedModel: false,
    created: null,
    sourceName: null,
    updated: Date.now(),
  };
}

export default function ImportEditor({ settings, editId, onBack, onSaved, onTestDrive }: ImportEditorProps) {
  const game = settings.game;
  const key = draftKey(game, editId);
  const [draft, setDraftState] = useState<LiveDraft | null>(() => liveDraft(key));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [eng, setEng] = useState<ImporterEngine | null>(engineCache);
  const engRef = useRef<ImporterEngine | null>(engineCache);
  const [notFound, setNotFound] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState<DropError | null>(null);
  const [wheelDrag, setWheelDrag] = useState<Vec2[] | null>(null);
  const [selWheel, setSelWheel] = useState(0);
  const [mirror, setMirror] = useState(true);
  const [selHandle, setSelHandle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: 'discard' } | { kind: 'dup'; name: string; replace: () => void; keepBoth: () => void } | null
  >(null);
  const gen = useRef(0);
  const pendingFocus = useRef<string | null>(null);

  const setDraft = useCallback((d: LiveDraft | null) => {
    draftRef.current = d;
    setDraftState(d);
    if (d) keepDraft(d);
  }, []);
  /** edit the document (and keep the draft) */
  const update = useCallback(
    (fn: (d: EditorDoc) => EditorDoc) => {
      const cur = draftRef.current;
      if (!cur) return;
      setDraft({ ...cur, doc: { ...fn(cur.doc), updated: Date.now() } });
    },
    [setDraft],
  );

  const ensureEngine = useCallback(async (): Promise<ImporterEngine> => {
    if (engRef.current) return engRef.current;
    const e = await loadImporterEngine();
    engineCache = e;
    engRef.current = e;
    setEng(e);
    return e;
  }, []);

  // ---- reading files ---------------------------------------------------------------------

  /** read dropped files into a prepared model and a fresh measurement */
  const readModel = useCallback(
    async (files: File[], opts: { setup?: Partial<ImportSetup>; savedModel?: boolean; spec?: RobotSpec; keepSource?: EditorDoc['source'] } = {}) => {
      const my = ++gen.current;
      const name = files[0]?.name ?? '';
      setError(null);
      setActionError(null);
      setPhase({ title: name, label: COPY.phase.engine });
      let e: ImporterEngine;
      try {
        e = await ensureEngine();
      } catch (err) {
        console.warn('[import] engine failed to load', err);
        if (my === gen.current) {
          setPhase(null);
          setError({ text: COPY.engineFailed, extra: { label: COPY.tryAgain, run: () => void readModel(files, opts) } });
        }
        return;
      }
      try {
        const model = await e.loadModel(files, (stage) => {
          if (my === gen.current) setPhase({ title: name, label: STAGE_LABEL(stage, name) });
        });
        if (my !== gen.current) return;
        setPhase({ title: name, label: COPY.phase.simplify(model.trisIn.toLocaleString('en-US')) });
        // a frame for the label to paint before the synchronous part of simplification
        await new Promise((r) => setTimeout(r, 30));
        const cur = draftRef.current;
        const baseDoc = cur?.doc ?? freshDoc(settings, key, editId);
        const prepared = await e.simplifyModel(model, baseDoc.setup.triBudget);
        if (my !== gen.current) return;
        setPhase({ title: name, label: COPY.phase.measure });
        await new Promise((r) => setTimeout(r, 30));
        const setup: ImportSetup = { ...baseDoc.setup, units: 'auto', up: 'auto', yaw: 0, wheels: null, ...opts.setup };
        const n = e.normalise(prepared, setup);
        if (my !== gen.current) return;
        const spec = opts.spec ?? baseDoc.spec;
        const doc: EditorDoc = {
          ...baseDoc,
          step: 0,
          setup,
          detected: { units: n.measurement.units, up: n.measurement.up },
          mech: null,
          // a NEW import is named after its file; an edit keeps its name
          spec: { ...spec, name: opts.spec?.name ?? (baseDoc.editId ? spec.name : baseName(model.name)) },
          source: opts.keepSource ?? {
            name: model.name,
            format: model.format,
            bytes: model.bytes,
            trisIn: model.trisIn,
            trisOut: prepared.trisOut,
          },
          sourceName: model.name,
          savedModel: !!opts.savedModel,
          updated: Date.now(),
        };
        setDraft({ doc, model: prepared, modelStored: false, baked: null });
        setPhase(null);
      } catch (err) {
        if (my !== gen.current) return;
        console.warn('[import] read failed', err);
        setPhase(null);
        const msg = err instanceof Error && err.name === 'ImportError' ? err.message : `Couldn’t read ${name}. Export it again and retry.`;
        const step = err instanceof Error && (err as { code?: string }).code === 'step-failed';
        setError({ text: step ? COPY.stepReader : msg, extra: step ? { label: COPY.tryAgain, run: () => void readModel(files, opts) } : undefined });
      }
    },
    [ensureEngine, settings, key, editId, setDraft],
  );

  /** a `.glb` that carries a DSIM setup goes straight into the library */
  const addShared = useCallback(
    async (file: File, payload: SharePayload) => {
      const my = ++gen.current;
      setError(null);
      if (payload.game !== game) {
        const season = seasonFor(game).name;
        setError({
          text: COPY.wrongGame(payload.name, season, seasonFor(payload.game).name),
          extra: {
            label: COPY.setUpFor(season),
            run: () => void readModel([file], { setup: { units: 'm', up: '+y', yaw: 0, drive: payload.setup.drive }, savedModel: true }),
          },
        });
        return;
      }
      setPhase({ title: file.name, label: COPY.phase.adding(payload.name) });
      try {
        const e = await ensureEngine();
        const spec: RobotSpec = { ...coerceSpec(payload.spec, undefined, game), name: payload.name.slice(0, 24) };
        if (!spec.imported) throw new Error('share file without an import');
        const model = await e.loadModel([file]);
        const robotParts = transformParts(model.parts, STORED_MESH_TO_ROBOT);
        const top = await e.renderTop(robotParts, spec.imported.hull);
        const thumb = await e.renderThumb(robotParts);
        if (my !== gen.current) return;
        const now = Date.now();
        const record = (s: RobotSpec): LibraryRobot => ({
          id: s.imported!.id,
          game,
          spec: s,
          mesh: file,
          top,
          thumb,
          source: { name: file.name, format: 'glb', bytes: file.size, trisIn: model.trisIn, trisOut: model.trisIn },
          setup: { ...payload.setup, units: 'm', up: '+y', yaw: 0 },
          created: now,
          updated: now,
        });
        const finish = async (s: RobotSpec): Promise<void> => {
          setDialog(null);
          const r = await putRobot(record(s));
          setPhase(null);
          if (!r.ok) {
            setError({ text: r.message });
            return;
          }
          invalidateImportedAssets(s.imported!.id);
          libraryChanged();
          postRobotNotice(COPY.added(s.name));
          onSaved(s);
        };
        const have = await getRobot(spec.imported.id);
        if (have.ok) {
          setDialog({
            kind: 'dup',
            name: spec.name,
            replace: () => void finish(spec),
            keepBoth: () => {
              const id = newRobotId();
              void finish({ ...spec, name: `${spec.name.slice(0, 22)} 2`, imported: { ...spec.imported!, id } });
            },
          });
          return;
        }
        await finish(spec);
      } catch (err) {
        console.warn('[import] share file failed', err);
        setPhase(null);
        setError({ text: COPY.bakeFailed });
      }
    },
    [game, ensureEngine, readModel, onSaved],
  );

  /** files from the drop box, the picker, Replace, or the robot page's add card */
  const onFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 1 && /\.glb$/i.test(files[0].name)) {
        try {
          const res = readShareFile(await files[0].arrayBuffer());
          if (res.ok) return void addShared(files[0], res.payload);
          if (res.error === 'newer-version') {
            setError({ text: COPY.newer, extra: { label: COPY.setUpAgain, run: () => void readModel(files) } });
            return;
          }
        } catch (err) {
          console.warn('[import] share check failed', err);
        }
      }
      void readModel(files);
    },
    [addShared, readModel],
  );

  // ---- boot: a handed file, the live draft, the stored draft, a library robot, or empty ----
  useEffect(() => {
    let dead = false;
    void (async () => {
      const files = takeHandedFiles();
      let d = liveDraft(key);
      if (!d && !files) {
        setRestoring(true);
        d = await restoreDraft(key).catch(() => null);
        if (dead) return;
        setRestoring(false);
      }
      if (d) {
        setDraft(d);
        if (d.model) void ensureEngine().catch(() => setError({ text: COPY.engineFailed }));
        if (files) void onFiles(files);
        if (focusOnReturn) {
          pendingFocus.current = focusOnReturn;
          focusOnReturn = null;
        }
        return;
      }
      if (editId) {
        setRestoring(true);
        const got = await getRobot(editId);
        if (dead) return;
        setRestoring(false);
        if (!got.ok) {
          setNotFound(true);
          return;
        }
        const rec = got.value;
        const base = freshDoc(settings, key, editId);
        setDraft({ doc: { ...base, id: rec.id, spec: { ...rec.spec }, created: rec.created, setup: rec.setup }, model: null, modelStored: false, baked: null });
        const file = new File([rec.mesh], `${baseName(rec.source.name)}.glb`);
        await readModel([file], {
          setup: { ...rec.setup, units: 'm', up: '+y', yaw: 0, wheels: rec.setup.wheels },
          savedModel: true,
          spec: { ...rec.spec },
          keepSource: rec.source,
        });
        // the saved placements, back into the model frame
        const cur = draftRef.current;
        const imp = rec.spec.imported;
        if (cur?.model && imp?.mech && engRef.current) {
          const n = engRef.current.normalise(cur.model, cur.doc.setup);
          setDraft({ ...cur, doc: { ...cur.doc, mech: mechRobotToModel(imp.mech, n.measurement.origin) } });
        }
        return;
      }
      setDraft({ doc: freshDoc(settings, key, null), model: null, modelStored: false, baked: null });
      if (files) void onFiles(files);
    })();
    return () => {
      dead = true;
      flushDraft(key);
    };
    // the boot runs once per draft key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // ---- derived -------------------------------------------------------------------------------
  const doc = draft?.doc ?? null;
  const model = draft?.model ?? null;
  const normalised: NormalisedModel | null = useMemo(() => {
    if (!eng || !model || !doc) return null;
    try {
      return eng.normalise(model as PreparedModel, doc.setup);
    } catch (err) {
      console.warn('[import] normalise failed', err);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, model, doc?.setup]);
  const m = normalised?.measurement ?? null;
  const built = useMemo(() => (doc && m ? buildSpec(doc, m) : null), [doc, m]);
  const defs = useMemo(() => (built ? mechHandlesFor(game, built.spec) : []), [built, game]);
  const items = useMemo(() => reviewItems(m, built, game), [m, built, game]);
  const mechChecks = useMemo(() => (built ? validateMechFor(built.spec, game) : []), [built, game]);
  const numbers = useMemo(() => (built ? driveNumbers(built, game) : null), [built, game]);

  // placements default in once there is a footprint, and again when a mechanism appears
  useEffect(() => {
    if (!doc || !m || !built || m.hull.length < 3) return;
    const next = defaultMechFor(game, built.spec, m.origin, doc.mech);
    if (JSON.stringify(next) !== JSON.stringify(doc.mech)) update((d) => ({ ...d, mech: next }));
  }, [doc, m, built, game, update]);

  // focus after a "Fix", a step change, or a return from the test drive
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    const target = el.matches(FOCUSABLE) ? el : (el.querySelector<HTMLElement>(FOCUSABLE) ?? el);
    // a control that is still disabled (the checks not yet run) keeps the request for later
    if ((target as HTMLButtonElement).disabled) return;
    pendingFocus.current = null;
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  });

  // ---- actions -------------------------------------------------------------------------------
  const step = doc?.step ?? 0;
  const goStep = (s: StepIndex, focus?: string): void => {
    pendingFocus.current = focus ?? null;
    update((d) => ({ ...d, step: s }));
  };
  const blocked = blocks(items) > 0;

  const finalSpec = (): RobotSpec | null => {
    if (!built || !doc) return null;
    const name = (doc.spec.name.trim() || baseName(doc.source?.name ?? 'Robot')).slice(0, 24);
    return { ...built.spec, name, teamName: (doc.spec.teamName ?? '').slice(0, 48) };
  };

  const ensureBaked = async (): Promise<NonNullable<LiveDraft['baked']> | null> => {
    const cur = draftRef.current;
    const e = engRef.current;
    if (!cur || !e || !normalised || !built?.spec.imported) return null;
    const stamp = JSON.stringify([cur.doc.setup, cur.doc.mech, built.spec.imported]);
    if (cur.baked?.stamp === stamp) return cur.baked;
    const r = await e.bake({ modelParts: normalised.modelParts, origin: normalised.measurement.origin, descriptor: built.spec.imported });
    const baked = { stamp, mesh: r.mesh, top: r.top, thumb: r.thumb, trisOut: r.trisOut };
    cur.baked = baked;
    return baked;
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      console.warn('[import] action failed', err);
      setActionError(COPY.bakeFailed);
    } finally {
      setBusy(false);
    }
  };

  const save = (): void =>
    void run(async () => {
      const spec = finalSpec();
      const b = await ensureBaked();
      const cur = draftRef.current;
      if (!spec || !b || !cur?.doc.source) return;
      const now = Date.now();
      const r = await putRobot({
        id: cur.doc.id,
        game,
        spec,
        mesh: b.mesh,
        top: b.top,
        thumb: b.thumb,
        source: { ...cur.doc.source, trisOut: b.trisOut },
        setup: cur.doc.setup,
        created: cur.doc.created ?? now,
        updated: now,
      });
      if (!r.ok) {
        setActionError(r.message);
        return;
      }
      await dropDraft(key);
      // the draft's lent pictures go, and the renderers read the library's copy from now on
      unregisterImportedAssets(cur.doc.id);
      invalidateImportedAssets(cur.doc.id);
      libraryChanged();
      postRobotNotice(COPY.saved(spec.name));
      onSaved(spec);
    });

  const testDrive = (): void =>
    void run(async () => {
      const spec = finalSpec();
      const b = await ensureBaked();
      if (!spec || !b) return;
      // lent to the renderers until the draft is saved or discarded (lane 6's asset seam)
      registerImportedAssets(spec.imported!.id, { top: b.top, mesh: b.mesh });
      flushDraft(key);
      focusOnReturn = 'ri-testdrive';
      onTestDrive(spec);
    });

  const exportIt = (): void =>
    void run(async () => {
      const spec = finalSpec();
      const b = await ensureBaked();
      const cur = draftRef.current;
      if (!spec || !b || !cur) return;
      const bytes = await shareBytes(b.mesh, { game, spec, setup: cur.doc.setup, name: spec.name });
      downloadBytes(bytes, shareFileName(spec.name));
    });

  const discard = async (): Promise<void> => {
    setDialog(null);
    gen.current++;
    const id = draftRef.current?.doc.id;
    await dropDraft(key);
    if (id) unregisterImportedAssets(id);
    onBack();
  };

  // ---- wheels ----------------------------------------------------------------------------------
  const baseWheels = m ? (m.wheelsUsed ?? (m.hull.length >= 3 ? rectangleWheels(m.hull) : null)) : null;
  const shownWheels = wheelDrag ?? baseWheels;
  const onWheel = (i: number, p: Vec2, final: boolean): void => {
    if (!m || !baseWheels) return;
    const next = moveWheel(baseWheels, i, p, mirror, m.hull);
    if (!final) return setWheelDrag(next);
    setWheelDrag(null);
    update((d) => ({ ...d, setup: { ...d.setup, wheels: next } }));
  };

  // ---- render ----------------------------------------------------------------------------------
  if (notFound) {
    return (
      <>
        <div className="ds-head">
          <button type="button" className="ds-back" onClick={onBack}>
            {COPY.back}
          </button>
        </div>
        <div className="ds-empty">
          <p className="big">{COPY.notFoundBig}</p>
          <p>{COPY.notFoundText}</p>
          <button type="button" className="ds-btn" onClick={onBack}>
            {COPY.backToRobot}
          </button>
        </div>
      </>
    );
  }
  if (!doc) return <div className="ds-loading">{restoring ? COPY.restoring : COPY.loading}</div>;

  const hasModel = !!m;
  const stepCounts = [0, 0, 0, 0];
  for (const it of items) if (it.level === 'block' || it.level === 'warn') stepCounts[stepOf(it)]++;
  const title = doc.editId ? COPY.titleEdit(doc.spec.name || 'robot') : COPY.titleNew;
  const previewState = m && normalised
    ? {
        parts: normalised.modelParts,
        hull: m.hull,
        wheels: shownWheels,
        contacts: m.wheels.contacts,
        origin: m.origin,
        mech: doc.mech,
        size: m.size,
        showCube: true,
      }
    : null;

  const mechPanel =
    built && m && doc.mech ? (
      <MechanismsStep
        game={game}
        spec={built.spec}
        onSpec={(patch) => update((d) => ({ ...d, spec: { ...d.spec, ...patch } }))}
        hull={m.hull}
        heightIn={m.heightIn}
        mech={doc.mech}
        defs={defs}
        checks={mechChecks}
        selected={selHandle}
        onSelect={setSelHandle}
        onMech={(next: ImportedMech) => update((d) => ({ ...d, mech: next }))}
        onReset={() => update((d) => ({ ...d, mech: null }))}
      />
    ) : null;

  const why = blocked ? COPY.fixFirst : undefined;
  return (
    <>
      <div className="ds-head">
        <button
          type="button"
          className="ds-back"
          onClick={() => {
            flushDraft(key);
            onBack();
          }}
        >
          {COPY.back}
        </button>
        <span className="ds-head-spacer" />
        {hasModel ? (
          <button type="button" className="ds-btn ghost small" onClick={() => setDialog({ kind: 'discard' })}>
            {doc.editId ? COPY.discardEdit : COPY.discardNew}
          </button>
        ) : null}
      </div>
      <h1 className="ds-h1">{title}</h1>

      <div className="ds-import">
        <div className="ds-import-in">
        <nav className="ds-tabs ds-import-steps" aria-label={COPY.stepsAria} data-padnav-sections>
          {COPY.steps.map((label, i) => (
            <button
              key={label}
              type="button"
              className={`ds-tab${step === i ? ' on' : ''}`}
              aria-current={step === i ? 'step' : undefined}
              disabled={i > 0 && !hasModel}
              onClick={() => goStep(i as StepIndex)}
            >
              <span className="n">{i + 1}</span> {label}
              {hasModel ? (
                <span className={`ds-badge ${stepCounts[i] ? 'warn' : 'ok'}`}>
                  {stepCounts[i] ? stepCounts[i] : '✓'}
                  <span className="ds-sr"> {stepCounts[i] ? COPY.stepOpen(stepCounts[i]) : COPY.stepOk}</span>
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        <PreviewPane
          eng={eng}
          state={previewState}
          empty={<p className="ds-hint ds-import-preview-empty">{COPY.previewEmpty}</p>}
          fallback={
            m ? (
              <TopDownMap
                hull={m.hull}
                handles={[]}
                contacts={m.wheels.contacts}
                origin={m.origin}
                selected={null}
                ariaLabel={COPY.footprintAria}
                readOnly
              />
            ) : null
          }
        />

        <section className="ds-panel ds-import-body">
          <div className="ds-panel-h">
            {step === 3 && hasModel ? (
              <h2 className={`ds-panel-title notice${blocked ? ' error' : ''}`} role="status">
                {actionError ?? (busy ? COPY.working : reviewSummary(items))}
              </h2>
            ) : (
              <h2 className="ds-panel-title">{actionError ?? COPY.steps[step]}</h2>
            )}
          </div>
          <div className="ds-panel-body stack">
            {step === 0 || !hasModel ? (
              <ModelStep
                doc={doc}
                m={m}
                phase={phase}
                error={error}
                wheels={shownWheels}
                selectedWheel={selWheel}
                mirror={mirror}
                onFiles={(f) => void onFiles(f)}
                onCancel={() => {
                  gen.current++;
                  setPhase(null);
                }}
                onSetup={(patch) =>
                  update((d) => ({
                    ...d,
                    setup: { ...d.setup, ...patch },
                    // units, up and yaw move the model frame, and the placements with it
                    mech: 'units' in patch || 'up' in patch || 'yaw' in patch ? null : d.mech,
                  }))
                }
                onWheel={onWheel}
                onSelectWheel={setSelWheel}
                onMirror={setMirror}
              />
            ) : step === 1 ? (
              <DrivetrainStep
                drive={doc.setup.drive}
                numbers={numbers}
                onDrive={(patch) => update((d) => ({ ...d, setup: { ...d.setup, drive: { ...d.setup.drive, ...patch } } }))}
              />
            ) : step === 2 ? (
              mechPanel
            ) : (
              <ReviewStep
                items={items}
                spec={doc.spec}
                onIdentity={(patch) => update((d) => ({ ...d, spec: { ...d.spec, ...patch } }))}
                onFix={(it: ReviewItem) => it.fix && goStep(it.fix.step, it.fix.focus)}
              />
            )}
          </div>
        </section>

        <div className="ds-actions ds-import-foot">
          {step > 0 ? (
            <button type="button" className="ds-btn ghost" data-padnav-secondary onClick={() => goStep((step - 1) as StepIndex)}>
              {COPY.prev}
            </button>
          ) : null}
          <span className="ds-head-spacer" />
          {step < 3 ? (
            <button
              type="button"
              className="ds-btn primary"
              disabled={!hasModel}
              onClick={() => goStep((step + 1) as StepIndex)}
            >
              {COPY.next(COPY.steps[step + 1])}
            </button>
          ) : (
            <>
              <button type="button" className="ds-btn" disabled={blocked || busy} aria-describedby={why ? 'ri-why' : undefined} onClick={exportIt}>
                {COPY.exportFile}
              </button>
              <button
                type="button"
                id="ri-testdrive"
                className="ds-btn"
                disabled={blocked || busy}
                aria-describedby={why ? 'ri-why' : undefined}
                onClick={testDrive}
              >
                {COPY.testDrive}
              </button>
              <button
                type="button"
                className="ds-btn primary"
                disabled={blocked || busy}
                aria-describedby={why ? 'ri-why' : undefined}
                onClick={save}
              >
                {doc.editId ? COPY.saveEdit : COPY.saveNew}
              </button>
              {why ? (
                <span id="ri-why" className="ds-sr">
                  {why}
                </span>
              ) : null}
            </>
          )}
        </div>
        </div>
      </div>

      {dialog?.kind === 'discard' ? (
        <ConfirmDialog
          title={doc.editId ? COPY.discardTitleEdit : COPY.discardTitleNew}
          body={<p className="ds-hint">{doc.editId ? COPY.discardBodyEdit(doc.spec.name || 'This robot') : COPY.discardBodyNew}</p>}
          confirm={COPY.discard}
          danger
          onConfirm={() => void discard()}
          onClose={() => setDialog(null)}
        />
      ) : dialog?.kind === 'dup' ? (
        <DuplicateDialog
          name={dialog.name}
          onReplace={dialog.replace}
          onKeepBoth={dialog.keepBoth}
          onClose={() => {
            setDialog(null);
            setPhase(null);
          }}
        />
      ) : null}
    </>
  );
}
