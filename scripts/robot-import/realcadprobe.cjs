/* REAL ROBOT CAD THROUGH THE REAL EDITOR. An OFFSCREEN Electron window against a PRODUCTION build,
 * one file at a time (a big STEP keeps several cores and gigabytes busy for minutes):
 *
 *   npm run build && npx vite preview --port 4173 --strictPort
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/robot-import/realcadprobe.cjs \
 *       --files <path>[,<path>…] --out <dir> [--port 4173] [--game decode]
 *
 * The files are vendors' published CAD (a STEP, or the zip it is published in), never committed:
 * goBILDA publishes no licence, REV's is CC BY-NC-SA. Per file, in a FRESH window:
 *   1. the drop: the status-line timeline, every long task (> 50 ms) on the page, the renderer's
 *      peak working set (the import's workers are threads of it), and the time to the preview;
 *   2. what the Model step says (size, triangles, wheels, units, up, front) and pictures of it;
 *   3. Save, then the library record's descriptor (hull, wheels, height, in robot-local inches);
 *   4. the saved robot re-opened, Review, Test drive: pictures of the match, before and after
 *      driving (field-centric: away from the start wall) and turning.
 * Writes `<out>/<file>-*.png` and `<out>/results.json`. A measurement, not a test.
 */
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${argOf('port', '4173')}`;
const FILES = argOf('files', '').split(',').filter(Boolean);
const OUT = path.resolve(argOf('out', 'scratch/realcad'));
const GAME = argOf('game', 'decode');
fs.mkdirSync(OUT, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => {
  console.log('WATCHDOG');
  process.exit(2);
}, 3 * 3600000);

const OBSERVE = `window.__lt = [];
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: e.startTime, d: e.duration }); }).observe({ type: 'longtask' }); } catch {}`;

function serve() {
  return new Promise((resolve) => {
    const byName = new Map(FILES.map((f) => [path.basename(f), f]));
    const srv = http.createServer((req, res) => {
      const f = byName.get(decodeURIComponent(req.url.slice(1)));
      if (!f || !fs.existsSync(f)) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Length': fs.statSync(f).size, 'Content-Type': 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { srv, port } = await serve();
  const results = [];
  for (const file of FILES) {
    const name = path.basename(file);
    const tag = name.replace(/\.[^.]+$/, '');
    const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
    win.webContents.setAudioMuted(true);
    const logs = [];
    win.webContents.on('console-message', (e) => {
      const m = e.message ?? '';
      if (/\[import\]|error|warn/i.test(m)) logs.push(m.slice(0, 400));
    });
    await win.loadURL(BASE + '/');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE });
    const js = (s) => win.webContents.executeJavaScript(s);
    const until = (cond, ms = 30000) => js(`(async () => { const t0 = performance.now(); while (!(${cond})) { if (performance.now() - t0 > ${ms}) return false; await new Promise((r) => setTimeout(r, 50)); } return true; })()`);
    const shot = async (what) => {
      await sleep(300);
      await win.webContents.capturePage();
      const img = await win.webContents.capturePage();
      const p = path.join(OUT, `${tag}-${what}.png`);
      fs.writeFileSync(p, img.toPNG());
      return p;
    };
    const click = (sel, text) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${text ? `x.textContent.trim().startsWith(${JSON.stringify(text)})` : 'true'}); if (!b) return false; b.click(); return true; })()`);
    const key = async (keyCode, holdMs) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      await sleep(holdMs);
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    };
    const pid = win.webContents.getOSProcessId();
    let memPeak = 0;
    let allPeak = 0;
    let sampling = false;
    const sampler = setInterval(() => {
      const ms = app.getAppMetrics();
      const m = ms.find((x) => x.pid === pid);
      if (!m || !sampling) return;
      memPeak = Math.max(memPeak, m.memory.workingSetSize / 1024);
      allPeak = Math.max(allPeak, ms.reduce((s, x) => s + x.memory.workingSetSize / 1024, 0));
    }, 100);
    const row = { file: name, mb: +(fs.statSync(file).size / 1048576).toFixed(1) };
    try {
      await session.defaultSession.clearCache();
      await js(`localStorage.clear(); new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
      await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
      await until(`document.querySelector('.ds-import-drop input[type=file]')`);
      await sleep(800);
      await js(`(async () => { const r = await fetch('http://127.0.0.1:${port}/${encodeURIComponent(name)}'); window.__file = new File([await r.blob()], ${JSON.stringify(name)}); return 1; })()`);
      await sleep(500);
      const mem0 = app.getAppMetrics().find((x) => x.pid === pid)?.memory.workingSetSize / 1024;
      await js(`window.__lt.length = 0; window.__tl = []; (() => {
        const t0 = performance.now(); window.__t0 = t0;
        const seen = (s) => { const last = window.__tl[window.__tl.length - 1]; if (!last || last.s !== s) window.__tl.push({ t: Math.round(performance.now() - t0), s }); };
        new MutationObserver(() => {
          const od = document.querySelector('.ds-import-drop .od');
          const fill = document.querySelector('.ds-import-drop .rec-fill');
          if (od) seen(od.textContent + (fill && fill.style.width ? ' ' + fill.style.width : ''));
        }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        const input = document.querySelector('.ds-import-drop input[type=file]');
        const dt = new DataTransfer(); dt.items.add(window.__file);
        input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      memPeak = mem0;
      sampling = true;
      const t0 = Date.now();
      await until(`(document.querySelector('.ds-import-filerow') && document.querySelector('.ds-import-canvas-host canvas')) || document.querySelector('.ds-import-drop .od.err') || document.querySelector('.ds-import-drop [role=alert]')`, 3600000);
      const ok = await js(`!!document.querySelector('.ds-import-filerow')`);
      row.importS = +((Date.now() - t0) / 1000).toFixed(1);
      await sleep(2500);
      sampling = false;
      const lt = await js(`JSON.stringify({ lt: window.__lt.map((x) => ({ t: x.t - window.__t0, d: x.d })), tl: window.__tl })`).then(JSON.parse);
      const tasks = lt.lt.filter((x) => x.t >= -5);
      // the timeline, thinned to one entry per stage label (the bar's width changes are many)
      const tl = [];
      for (const p of lt.tl) {
        const label = p.s.replace(/ \d+(\.\d+)?%$/, '');
        if (!tl.length || tl[tl.length - 1].label !== label) tl.push({ t: p.t, label });
      }
      row.import = {
        ok,
        timeline: tl.map((p) => `${(p.t / 1000).toFixed(1)}s ${p.label}`),
        longTasks: tasks.length,
        longestMs: Math.round(tasks.reduce((m, x) => Math.max(m, x.d), 0)),
        blockedMs: Math.round(tasks.reduce((s, x) => s + x.d, 0)),
        memBaseMB: Math.round(mem0),
        rendererPeakMB: Math.round(memPeak),
        allProcessesPeakMB: Math.round(allPeak),
      };
      console.log(`\n${name} (${row.mb} MB): ${ok ? 'imported' : 'FAILED'} in ${row.importS} s; longest task ${row.import.longestMs} ms (${row.import.longTasks} tasks, ${row.import.blockedMs} ms); renderer ${row.import.memBaseMB} → ${row.import.rendererPeakMB} MB, all processes peak ${row.import.allProcessesPeakMB} MB`);
      console.log(`  ${row.import.timeline.join(' → ')}`);
      if (!ok) {
        row.error = await js(`(document.querySelector('.ds-import-drop')?.innerText ?? '').replace(/\\s+/g, ' ')`);
        console.log(`  error: ${row.error}`);
        await shot('error');
        throw new Error('import failed');
      }
      row.facts = await js(`[...document.querySelectorAll('.ds-facts dt')].map((d) => d.textContent.trim() + ': ' + d.nextElementSibling.textContent.trim())`);
      row.fields = await js(`[...document.querySelectorAll('.ds-field .cap, .ds-import-opt .cap, [id^=ri-] .cap')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean)`);
      row.mapStatus = await js(`(document.querySelector('#ri-wheels [role=status], #ri-wheels .ds-hint')?.textContent ?? '').trim()`);
      console.log(`  ${row.facts.join(' | ')}`);
      console.log(`  ${row.fields.join(' | ')}`);
      await shot('model');
      // the preview from the top and the front
      for (const view of ['Top', 'Front', 'Side']) {
        if (await click('.ds-import-cams button, [aria-label="Preview camera"] button', view)) await shot(`model-${view.toLowerCase()}`);
      }
      // Review, Save
      for (const s of ['Next: Drivetrain', 'Next: Mechanisms', 'Next: Review']) {
        await click('button', s);
        await sleep(600);
      }
      row.review = await js(`[...document.querySelectorAll('.ds-import-checks li')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim())`);
      await shot('review');
      const saveClicked = await click('button.ds-btn.primary', 'Save');
      await until(`!location.pathname.includes('/import')`, 120000);
      await sleep(1500);
      row.saved = saveClicked;
      row.library = await js(`new Promise((res) => {
        const q = indexedDB.open('decodesim.robots');
        q.onsuccess = () => {
          const db = q.result;
          const tx = db.transaction('robots', 'readonly');
          const all = tx.objectStore('robots').getAll();
          all.onsuccess = () => res(JSON.stringify(all.result.filter((r) => r && r.spec && r.spec.imported).map((r) => ({ id: r.id, name: r.spec.name, imported: r.spec.imported, source: r.source, setup: r.setup, meshBytes: r.mesh && r.mesh.size }))));
          all.onerror = () => res('[]');
        };
        q.onerror = () => res('[]');
      })`).then(JSON.parse);
      const rec = row.library[0];
      if (rec) {
        const xs = rec.imported.hull.map((p) => p.x);
        const ys = rec.imported.hull.map((p) => p.y);
        row.footprintIn = { length: +(Math.max(...xs) - Math.min(...xs)).toFixed(2), width: +(Math.max(...ys) - Math.min(...ys)).toFixed(2), height: rec.imported.heightIn };
        row.wheelsIn = rec.imported.wheels ?? null;
        console.log(`  saved: footprint ${row.footprintIn.length} × ${row.footprintIn.width} in, height ${row.footprintIn.height} in, wheels ${JSON.stringify(row.wheelsIn)}, mesh ${rec.meshBytes} B`);
        await shot('robot-page');
        // the stored mesh (glTF frame, robot-local origin) and the top picture, for offline checks
        for (const kind of ['mesh', 'top']) {
          const b64 = await js(`new Promise((res) => {
            const q = indexedDB.open('decodesim.robots');
            q.onsuccess = () => {
              const g = q.result.transaction('files', 'readonly').objectStore('files').get(${JSON.stringify(rec.id)} + ':${kind}');
              g.onsuccess = async () => {
                if (!g.result) return res('');
                const u8 = new Uint8Array(await g.result.arrayBuffer());
                let s = '';
                for (let i = 0; i < u8.length; i += 4096) s += String.fromCharCode(...u8.subarray(i, i + 4096));
                res(btoa(s));
              };
              g.onerror = () => res('');
            };
            q.onerror = () => res('');
          })`);
          if (b64) fs.writeFileSync(path.join(OUT, `${tag}-stored.${kind === 'mesh' ? 'glb' : 'png'}`), Buffer.from(b64, 'base64'));
        }
        // re-open, Review, Test drive
        await win.loadURL(`${BASE}/${GAME}/configure/robot/import/${rec.id}`);
        await until(`document.querySelector('.ds-import-filerow')`, 120000);
        await sleep(1500);
        for (const s of ['Next: Drivetrain', 'Next: Mechanisms', 'Next: Review']) {
          await click('button', s);
          await sleep(600);
        }
        await click('#ri-testdrive');
        await until(`!document.querySelector('.ds-import-filerow') && !document.querySelector('.game-loading') && document.querySelectorAll('canvas').length > 0`, 120000);
        await sleep(3000);
        // the field takes the keys once clicked
        for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: 720, y: 520, button: 'left', clickCount: 1 });
        win.webContents.focus();
        await sleep(1000);
        await shot('drive-0');
        // the drive is field-centric by default and the start is against a wall: S and A drive
        // away from it (down and left on the screen), E turns
        await key('S', 1500);
        await sleep(300);
        await shot('drive-moved');
        await key('E', 700);
        await key('A', 1000);
        await sleep(300);
        await shot('drive-turned');
      }
    } catch (e) {
      row.failure = String(e && e.message ? e.message : e);
      console.log(`  ${row.failure}`);
    } finally {
      clearInterval(sampler);
      row.logs = logs.slice(-20);
      results.push(row);
      fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
      win.destroy();
      await sleep(2000);
    }
  }
  srv.close();
  app.exit(0);
});
