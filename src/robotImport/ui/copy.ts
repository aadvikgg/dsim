/**
 * EVERY STRING THE IMPORTER UI SHOWS, in one place (the lane 4 spec's copy table, §7). DOM-free,
 * so `npm test` holds it to the house rules: typographic ’ “ ” …, sentence case, `Couldn’t …` with
 * a next step, no padding words, no dash doing a full stop's job (`docs/area/ui.md`, UI COPY).
 *
 * The engine's own sentences (`ImportError.message`, `ImportCheck.message`, the drive checks, the
 * library's `LibraryResult.message`) are written to the same rules in their own files and shown as
 * they come; this file is what the UI adds around them.
 */
import type { LengthUnit, UpAxis } from '../types';
import { FORMAT_LABEL, PAGE_COPY } from './pageCopy';

export { FORMAT_LABEL };

export const COPY = {
  ...PAGE_COPY,
  // ---- the editor ----
  back: '← Robot',
  titleNew: 'Import a robot',
  titleEdit: (name: string) => `Edit ${name}`,
  discardNew: 'Discard import',
  discardEdit: 'Discard changes',
  discardTitleNew: 'Discard this import?',
  discardTitleEdit: 'Discard your changes?',
  discardBodyNew: 'The model and everything set here are removed.',
  discardBodyEdit: (name: string) => `${name} goes back to how it was saved.`,
  discard: 'Discard',
  steps: ['Model', 'Drivetrain', 'Mechanisms', 'Review'] as const,
  stepsAria: 'Import steps',
  stepOk: 'no problems',
  stepOpen: (n: number) => `${n} to check`,
  prev: 'Back',
  next: (step: string) => `Next: ${step}`,
  notFoundBig: 'Robot not found',
  notFoundText: 'It isn’t in this device’s library.',
  backToRobot: 'Back to Robot',
  loading: 'Loading the importer…',
  restoring: 'Restoring your import…',

  // ---- Model ----
  dropTitle: 'Choose a file or drop it here',
  choose: 'Choose a file',
  dropFormats: 'GLB, glTF, STEP, STL, OBJ, 3MF or PLY, up to 400 MB',
  sidecarHint: 'A glTF or OBJ comes with a .bin or .mtl file. Drop them together.',
  dropNow: 'Drop to import',
  phase: {
    read: (file: string) => `Reading ${file}…`,
    parse: (file: string) => `Reading ${file}…`,
    'step-wasm': 'Loading the STEP reader…',
    'step-parse': (file: string) => `Reading ${file}…`,
    convert: 'Converting the model…',
    simplify: (n: string) => `Simplifying ${n} triangles…`,
    measure: 'Measuring…',
    engine: 'Loading the importer…',
    adding: (name: string) => `Adding ${name}…`,
  },
  progressAria: 'Import progress',
  fileCap: 'File',
  fileVal: (name: string, format: string, size: string) => `${name} · ${format} · ${size}`,
  savedModel: 'saved model',
  replace: 'Replace',
  size: 'Size',
  fits: 'Fits 18 in',
  over: 'Over 18 in',
  triangles: 'Triangles',
  wheels: 'Wheels',
  wheelsFound: '4 found',
  wheelsManual: 'Placed by hand',
  wheelsNone: 'None found. Drag all four into place.',
  units: 'Units',
  up: 'Up axis',
  detected: (v: string) => `Detected: ${v}`,
  front: 'Front',
  frontDetected: 'Detected',
  frontTurned: (deg: number) => `Turned ${deg}° from detected`,
  turnLeft: 'Turn left',
  turnRight: 'Turn right',
  footprint: 'Footprint and wheels',
  footprintAria: 'Footprint, seen from above, front up',
  frontMark: 'Front',
  wheelNames: ['Front left wheel', 'Front right wheel', 'Back left wheel', 'Back right wheel'] as const,
  mirror: 'Mirror left and right',
  forward: 'Forward',
  left: 'Left',
  useDetected: 'Use detected wheels',
  grabPad: (dpad: string, a: string, b: string) => `Move with ${dpad} or the left stick. ${a} to drop, ${b} to cancel.`,
  grabKeys: 'Arrow keys move it. Hold Shift for small steps. Home puts it back.',
  handleAria: (label: string, x: number, y: number, z?: number) => `${label}, ${where(x, y, z)}`,

  // ---- errors the UI adds (the engine's own come as ImportError messages) ----
  stepReader: 'Couldn’t load the STEP reader. Check your connection and try again, or export as GLB or STL.',
  engineFailed: 'Couldn’t load the importer. Check your connection, then try again.',
  wrongGame: (name: string, season: string, other: string) => `Couldn’t add ${name} to ${season}. It was set up for ${other}.`,
  setUpFor: (season: string) => `Set it up for ${season}`,
  newer: 'Couldn’t read the DSIM setup in this file. A newer DSIM made it. Reload the page, or set it up again.',
  setUpAgain: 'Set it up again',
  chooseAnother: 'Choose another file',
  tryAgain: 'Try again',
  previewOff: 'Couldn’t start the 3D preview on this device. Showing the footprint.',
  bakeFailed: 'Couldn’t prepare the model. Try again, or reload the page.',
  storageBlocked: 'Saving needs site storage, which this browser is blocking.',

  // ---- preview ----
  cameras: [
    ['iso', '3/4'],
    ['top', 'Top'],
    ['front', 'Front'],
    ['side', 'Side'],
  ] as const,
  cameraAria: 'Preview camera',
  collision: 'Collision shape',
  previewEmpty: 'Your robot shows here, on a field tile beside the 18 in cube.',
  resetView: 'Reset view',

  // ---- Drivetrain ----
  drivetrain: 'Drivetrain',
  motor: 'Motor',
  motorFamilies: [
    ['gobilda', 'goBILDA 5203'],
    ['revHdHex', 'REV HD Hex'],
    ['revCoreHex', 'REV Core Hex'],
    ['neverest', 'NeveRest Orbital'],
    ['custom', 'Custom'],
  ] as const,
  gearbox: 'Gearbox',
  freeSpeed: 'Free speed',
  extRatio: 'External ratio',
  extRatioHint: 'motor turns per wheel turn',
  tankRatio: 'Traction ratio',
  wheel: 'Wheel',
  custom: 'Custom',
  diameter: 'Diameter',
  weight: 'Weight',
  weightHint: 'with the battery in',
  statRpm: 'Drive rpm',
  statSpeed: 'Top speed',
  statAccel: 'Accel',
  statPush: 'Push',
  limitsTitle: 'How the sim reads it',
  rpmOk: (dt: string, min: number, max: number) => `The sim drives ${dt} from ${min} to ${max} rpm.`,
  rpmHigh: (dt: string, max: number) => `Over the sim’s ${max} rpm for ${dt}. It drives at ${max}.`,
  rpmLow: (dt: string, min: number) => `Under the sim’s ${min} rpm for ${dt}. It drives at ${min}.`,
  massOk: (min: number, max: number) => `This build drives from ${min} to ${max} lb.`,
  massLow: (min: number) => `Under this build’s ${min} lb minimum. It drives as ${min} lb.`,
  massHigh: (max: number) => `Over ${max} lb. It drives as ${max} lb.`,
  speedLine: 'Follows drive rpm and the drivetrain.',
  pushLine: 'Grows with weight and traction, and with gearing down.',

  // ---- Mechanisms ----
  mechanisms: 'Mechanisms',
  placement: 'Placement',
  mechAria: 'Mechanisms, seen from above, front up',
  height: 'Height',
  width: 'Width',
  centre: 'Centre',
  resetPlacement: 'Reset placement',
  placed: (label: string, x: number, y: number, z?: number) => `${label}: ${where(x, y, z)}`,
  span: (label: string, w: number, c: number) => `${label}: ${w.toFixed(1)} in wide, centred ${c.toFixed(1)} in along the edge`,
  noHandles: 'Pick the mechanisms above to place them here.',

  // ---- Review ----
  checks: 'Checks',
  allPass: 'All checks pass',
  toFix: (n: number) => `${n} to fix before saving`,
  notes: (n: number) => `Ready, with ${n} ${n === 1 ? 'note' : 'notes'}`,
  passFits: 'Fits the 18 in cube',
  tooSmall: (side: number, min: number) =>
    `The footprint is only ${side.toFixed(1)} in across. The sim needs ${min} in a side, so check the units.`,
  passWheels: 'Four wheels on the footprint',
  passWeight: 'Weight in the sim’s range',
  passRpm: 'Drive rpm in the sim’s range',
  passMech: 'Mechanisms placed',
  fix: 'Fix',
  fixAria: (s: string) => `Fix: ${s}`,
  teamName: 'Team name',
  teamNumber: 'Team #',
  testDrive: 'Test drive',
  saveNew: 'Save robot',
  saveEdit: 'Save changes',
  fixFirst: 'Fix the checks above first.',
  working: 'Preparing the model…',
  levelNames: { block: 'must fix', warn: 'note', info: 'note', ok: 'passes' } as const,

  // ---- test drive (the HUD's own ALL CAPS voice) ----
  hudBack: 'EDITOR',
  hudBackTitle: 'Back to the importer (Esc)',
} as const;

/** "4.5 in forward, 5.3 in right, 12.0 in high": signs as words, from the footprint's centre */
export function where(x: number, y: number, z?: number): string {
  const a = (v: number): string => Math.abs(v).toFixed(1);
  const h = z === undefined ? '' : `, ${z.toFixed(1)} in high`;
  return `${a(x)} in ${x < 0 ? 'back' : 'forward'}, ${a(y)} in ${y < 0 ? 'right' : 'left'}${h}`;
}

export const UNIT_LABEL: Record<LengthUnit, string> = { mm: 'mm', cm: 'cm', m: 'm', in: 'in', ft: 'ft' };

/** "+Z" / "−Z": the minus is U+2212, not a hyphen */
export function upLabel(a: UpAxis): string {
  return `${a[0] === '-' ? '−' : '+'}${a[1].toUpperCase()}`;
}

/** 38.2 MB, 640 KB */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

