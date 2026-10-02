/* THE IMPORTER, BY CONTROLLER ONLY (lane 4). A pad-only walkthrough of the import editor in an
 * OFFSCREEN Electron window: a scripted standard-mapping gamepad (`navigator.getGamepads` stubbed,
 * `gamepadconnected` fired) drives the real `PadNavLayer` and the editor's grab mode, and every
 * step is asserted on the DOM. rAF does not run in a hidden browser tab, so this cannot be done in
 * a background browser; an offscreen Electron window keeps painting.
 *
 *   npx vite --port 5194 --strictPort            # in another shell
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/importpad.cjs [--port 5194]
 *
 * The one step a pad cannot do is pick a file (an OS dialog): the run hands the editor the STL
 * fixture through its file input, then puts the mouse away for good.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${argOf('port', '5194')}`;
const OUT = path.resolve(argOf('out', path.join('scratch', 'importpad')));
fs.mkdirSync(OUT, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 300000);

const PAD = `(() => {
  const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)', connected: true, mapping: 'standard', index: 0,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })), axes: [0, 0, 0, 0], timestamp: 0 };
  navigator.getGamepads = () => [pad];
  window.__pad = pad;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__press = async (i, ms = 90) => { pad.buttons[i] = { pressed: true, value: 1, touched: true }; await wait(ms); pad.buttons[i] = { pressed: false, value: 0, touched: false }; await wait(160); };
  window.__hold = (i, on) => { pad.buttons[i] = { pressed: on, value: on ? 1 : 0, touched: on }; };
  window.dispatchEvent(new Event('gamepadconnected'));
  return true;
})()`;

const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
  win.webContents.setAudioMuted(true);
  const js = (s) => win.webContents.executeJavaScript(s);
  let failures = 0;
  const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  };
  const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());

  await win.loadURL(BASE + '/');
  await js(`localStorage.clear(); localStorage.setItem('decodesim.theme', 'dark');
    new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
  await win.loadURL(BASE + '/decode/configure/robot/import');
  await sleep(1500);
  await js(`(async () => {
    const b = await (await fetch('/scripts/fixtures/robot-import/robot.stl')).blob();
    const input = document.querySelector('.ds-import-drop input[type=file]');
    const dt = new DataTransfer(); dt.items.add(new File([b], 'robot.stl'));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 60 && !document.querySelector('.ds-import-filerow'); i++) await new Promise((r) => setTimeout(r, 200));
    return !!document.querySelector('.ds-import-filerow');
  })()`);
  await sleep(800);
  await js(PAD);
  await sleep(400);
  const tab = () => js(`document.querySelector('.ds-import-steps .ds-tab.on')?.textContent.trim().slice(0, 1)`);
  const active = () => js(`(document.activeElement && (document.activeElement.id || document.activeElement.textContent.trim().slice(0, 30))) || ''`);

  // a first d-pad press puts focus on the page, as the layer does when nothing has it
  await js(`__press(${DOWN})`);
  check('pad: a d-pad press gives the page focus', (await active()) !== '');
  check('pad: the layer marks the pad active (the focus ring shows)', await js(`document.documentElement.dataset.padnav === 'on'`));

  // LB/RB walk the step rail, wherever focus is
  await js(`document.getElementById('ri-h-w0').focus()`);
  await js(`__press(${RB})`);
  check('pad: RB from a control in the body goes to the next STEP, not the next destination', (await tab()) === '2', await tab());
  await js(`__press(${RB})`);
  check('pad: RB again: Mechanisms', (await tab()) === '3', await tab());
  await js(`__press(${LB})`);
  await js(`__press(${LB})`);
  check('pad: LB twice: back on Model', (await tab()) === '1', await tab());
  check('pad: still in the editor (the rail did not take the press)', await js(`location.pathname.endsWith('/configure/robot/import')`));

  // grab a wheel: A grabs, the d-pad moves it, A drops (commit), B cancels (restore)
  await js(`document.getElementById('ri-h-w0').focus(); document.getElementById('ri-h-w0').scrollIntoView({ block: 'center' })`);
  const before = await js(`document.getElementById('ri-h-w0').getAttribute('aria-label')`);
  await js(`__press(${A})`);
  check('pad: A on a handle GRABS it (held)', await js(`document.getElementById('ri-h-w0').classList.contains('held')`));
  check('pad: the map says how to move it, in this pad’s glyphs', /Move with .* or the left stick\. A to drop, B to cancel\./.test(await js(`[...document.querySelectorAll('.ds-import-map-status')].map((e) => e.textContent).join(' ')`)));
  await shot('grabbed');
  for (let i = 0; i < 4; i++) await js(`__press(${UP})`);
  check('pad: while grabbed, the d-pad MOVES the handle (focus stays on it)', (await js(`document.activeElement?.id`)) === 'ri-h-w0');
  await js(`__press(${A})`);
  await sleep(400);
  const after = await js(`document.getElementById('ri-h-w0')?.getAttribute('aria-label')`);
  const fwd = (s) => Number(/([\d.]+) in (forward|back)/.exec(s ?? '')?.[1] ?? NaN) * (/ in back/.test(s ?? '') ? -1 : 1);
  check('pad: A drops it: the wheel moved forward by 4 × 0.25 in', Math.abs(fwd(after) - fwd(before) - 1) < 0.051, `${before} → ${after}`);
  check('pad: dropped, the layer navigates again', !(await js(`document.getElementById('ri-h-w0')?.classList.contains('held')`)));
  await js(`document.getElementById('ri-h-w1').focus()`);
  const b1 = await js(`document.getElementById('ri-h-w1').getAttribute('aria-label')`);
  await js(`__press(${A})`);
  for (let i = 0; i < 3; i++) await js(`__press(${LEFT})`);
  await js(`__press(${B})`);
  await sleep(400);
  check('pad: B cancels a grab and puts the handle back', (await js(`document.getElementById('ri-h-w1')?.getAttribute('aria-label')`)) === b1);
  check('pad: B in a grab does not leave the editor', await js(`location.pathname.endsWith('/configure/robot/import')`));

  // Y is the step's primary action
  await js(`__press(${Y})`);
  check('pad: Y presses the primary action (Next: Drivetrain)', (await tab()) === '2', await tab());
  // a range: ◄► nudge a focused slider through the layer
  await js(`__press(${RB})`);
  await sleep(300);
  await js(`(() => { const r = document.querySelector('.ds-import-body input[type=range]'); r?.scrollIntoView({ block: 'center' }); r?.focus(); return !!r; })()`);
  const v0 = await js(`document.activeElement?.value`);
  await js(`__press(${RIGHT})`);
  check('pad: ◄► nudge a focused range (Mechanisms)', (await js(`document.activeElement?.value`)) !== v0, `${v0}`);
  await shot('mechanisms');
  // B leaves for the robot page; the draft stays
  await js(`document.querySelector('.ds-import-steps .ds-tab')?.focus()`);
  await js(`__press(${B})`);
  await sleep(800);
  check('pad: B leaves the editor for the robot page', await js(`location.pathname.endsWith('/configure/robot')`));
  check('pad: …and the import waits there as Resume import', await js(`!!document.querySelector('.ds-opt-add') && document.querySelector('.ds-opt-add').textContent.includes('Resume import')`));
  await shot('robot-resume');

  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  app.exit(failures ? 1 : 0);
});
