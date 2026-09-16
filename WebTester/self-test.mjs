import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = 4173;
const failures = [];
const fail = msg => failures.push(msg);

function wavFile(filePath, sampleRate = 48000, seconds = 1.5) {
  const frames = Math.floor(sampleRate * seconds), bytes = frames * 2, buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames; i++) { const t = i / sampleRate; const s = 0.25 * Math.sin(2 * Math.PI * 1000 * t) + 0.08 * Math.sin(2 * Math.PI * 440 * t); buf.writeInt16LE(Math.round(clamp(s, -1, 1) * 32767), 44 + i * 2); }
  fs.writeFileSync(filePath, buf);
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]); if (rel === '/') rel = '/index-fixed.html';
  const file = path.join(root, rel); if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, body) => { if (err) { res.writeHead(404); return res.end('not found'); } const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream'; res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); });
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myefx-')); const wav = path.join(tmp, 'tone.wav'); wavFile(wav);
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
page.on('pageerror', e => fail('PAGEERROR: ' + e.message)); page.on('console', m => { if (m.type() === 'error') fail('CONSOLE: ' + m.text()); });

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

  const stage1 = await page.evaluate(() => {
    const errors = [];
    for (let i = 0; i < 650; i++) {
      if (document.querySelectorAll('.knob').length !== 24) errors.push('knobs');
      if (document.querySelectorAll('.knob-input').length !== 24) errors.push('inputs');
      if (document.querySelectorAll('.band-byp').length !== 4) errors.push('bypass');
      if (!document.querySelector('script[src$="/app-final.js?v=1"]')) errors.push('app-path');
      const d = window.myEFX?.currentData?.(); if (!d || d.length !== 4) errors.push('api');
      if (Math.abs((d?.[0]?.freq ?? 0) - 31.5) > .001 || d?.[1]?.freq !== 125 || d?.[2]?.freq !== 1000 || d?.[3]?.freq !== 8000) errors.push('defaults');
    }
    return [...new Set(errors)];
  });
  if (stage1.length) fail('STAGE1 ' + stage1.join(',')); else console.log('STAGE1 650 structural/path/wiring iterations: PASS');

  await page.locator('#file').setInputFiles(wav);
  await page.waitForFunction(() => window.myEFX?.debugState()?.loaded === true);

  const stage2 = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.knob-input')], errors = [];
    for (let i = 0; i < 450; i++) {
      const el = inputs[i % inputs.length]; const min = +el.min, max = +el.max; el.value = String(min + (max - min) * ((i % 21) / 20)); el.dispatchEvent(new Event('input', { bubbles: true }));
      const st = window.myEFX.debugState(), key = el.id.replace(/\d+$/, ''), bi = +el.id.match(/\d+$/)[0] - 1;
      if (Math.abs(st.bands[bi][key] - +el.value) > Math.max(+el.step, .02)) errors.push('knob-sync');
      if (i % 9 === 0) document.querySelector('#byp' + (i % 4 + 1)).click();
      if (i % 11 === 0) document.querySelectorAll('[data-action="delta"]')[i % 4].click();
      if (i % 17 === 0) document.querySelectorAll('[data-action="reset"]')[i % 4].click();
      if (i % 19 === 0) document.querySelector('#sortBtn').click();
      if (i % 23 === 0) document.querySelector('#resetAll').click();
      if (i % 29 === 0) document.querySelector('#ab').click();
    }
    return [...new Set(errors)];
  });
  if (stage2.length) fail('STAGE2 ' + stage2.join(',')); else console.log('STAGE2 450 control/function iterations: PASS');

  await page.locator('#resetAll').click(); await page.locator('#play').click(); await page.waitForTimeout(350);
  const play = await page.evaluate(() => ({ s: window.myEFX.debugState(), rms: window.myEFX.meterRms(), status: document.querySelector('#status')?.textContent }));
  console.log('PLAYBACK CHECK', JSON.stringify(play));
  if (!play.s.graphReady || !play.s.playing || play.rms <= 1e-5) fail('playback failed: ' + JSON.stringify(play));

  const stage3 = await page.evaluate(() => {
    const errors = [];
    const all = sel => document.querySelectorAll(sel);
    for (let i = 0; i < 480; i++) {
      if (i % 4 === 0 || i % 4 === 1) document.querySelector('#bypassAll').click();
      if (i % 7 === 0) all('[data-action="delta"]')[i % 4].click();
      if (i % 9 === 0) document.querySelector('#loop').click();
      if (i % 13 === 0) document.querySelector('#loop').click();
      if (i % 17 === 0) all('[data-action="bypass"]')[i % 4].click();
      if (i % 19 === 0) all('[data-action="reset"]')[i % 4].click();
      if (i % 23 === 0) document.querySelector('#ab').click();
      if (i % 29 === 0) document.querySelector('#resetBands').click();
      const s = window.myEFX.debugState(); if (s.bands.length !== 4 || !s.graphReady || !['ScriptProcessor'].includes(s.graphMode)) errors.push('graph/state');
    }
    return [...new Set(errors)];
  });
  if (stage3.length) fail('STAGE3 ' + stage3.join(',')); else console.log('STAGE3 480 live-graph/control stress iterations: PASS');

  await page.evaluate(() => { document.querySelector('#resetAll').click(); const g = document.querySelector('#gain3'); g.value = '12'; g.dispatchEvent(new Event('input', { bubbles: true })); document.querySelectorAll('[data-action="delta"]')[2].click(); });
  await page.waitForTimeout(220);
  const delta = await page.evaluate(() => ({ s: window.myEFX.debugState(), rms: window.myEFX.meterRms() }));
  console.log('DELTA CHECK', JSON.stringify(delta));
  if (!delta.s.playing || delta.s.delta !== 3 || delta.rms <= 1e-7) fail('delta failed: ' + JSON.stringify(delta));

  const frame = page.locator('#inputFrame'), box = await frame.boundingBox();
  if (!box) fail('frame missing'); else { await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * .7, box.y + box.height / 2); await page.mouse.up(); await page.waitForTimeout(30); const s = await page.evaluate(() => window.myEFX.debugState()); if (!s.loop || s.loopEnd <= s.loopStart) fail('drag-loop failed'); }

  const stage4 = await page.evaluate(() => {
    const errors = [];
    for (let i = 0; i < 320; i++) {
      const g = document.querySelector('#gain3'); g.value = String((i % 49) - 24); g.dispatchEvent(new Event('input', { bubbles: true }));
      if (i % 3 === 0) document.querySelector('[data-action="delta"]').click();
      if (i % 5 === 0) document.querySelector('#bypassAll').click();
      if (i % 7 === 0) document.querySelector('#bypassAll').click();
      if (i % 11 === 0) document.querySelector('#ab').click();
      if (i % 13 === 0) document.querySelector('#sortBtn').click();
      if (i % 17 === 0) document.querySelector('#resetAll').click();
      if (i % 19 === 0) document.querySelector('#stop').click();
      if (window.myEFX.debugState().bands.length !== 4) errors.push('state');
    }
    return [...new Set(errors)];
  });
  if (stage4.length) fail('STAGE4 ' + stage4.join(',')); else console.log('STAGE4 320 final regression iterations: PASS');
  await page.locator('#stop').click();
} catch (e) { fail('HARNESS: ' + e.stack); }
finally { await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
if (failures.length) { console.error('\nFAILURES'); for (const f of failures) console.error(f); process.exit(1); }
console.log('ALL 1900 ITERATIONS PASS');
