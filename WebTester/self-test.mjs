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

function wavFile(filePath, sampleRate = 48000, seconds = 1.25) {
  const frames = Math.floor(sampleRate * seconds);
  const channels = 1;
  const bits = 16;
  const blockAlign = channels * bits / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(byteRate, 28); buf.writeUInt16LE(blockAlign, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const sample = 0.22 * Math.sin(2 * Math.PI * 1000 * t) + 0.08 * Math.sin(2 * Math.PI * 440 * t);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index-fixed.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myefx-test-'));
const wav = path.join(tmp, 'test-tone.wav');
wavFile(wav);

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
page.on('pageerror', err => fail('PAGEERROR: ' + err.message));
page.on('console', msg => { if (msg.type() === 'error') fail('CONSOLE: ' + msg.text()); });

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

  const stage1 = await page.evaluate(() => {
    const errors = [];
    for (let i = 0; i < 650; i++) {
      if (document.querySelectorAll('.knob').length !== 24) errors.push('knob-count');
      if (document.querySelectorAll('.knob-input').length !== 24) errors.push('input-count');
      if (document.querySelectorAll('.band-byp').length !== 4) errors.push('bypass-count');
      if (!window.myEFX || typeof window.myEFX.currentData !== 'function') errors.push('api');
      const scripts = [...document.scripts].map(s => s.src).filter(Boolean);
      if (!scripts.some(s => s.endsWith('/app.js?v=13'))) errors.push('app-path');
      if (scripts.some(s => s.includes('/WebTester/app.js') && !s.endsWith('/app.js?v=13'))) errors.push('stale-app-path');
      const data = window.myEFX.currentData();
      if (data.length !== 4) errors.push('data-length');
      if (Math.abs(data[0].freq - 31.5) > 0.001 || data[1].freq !== 125 || data[2].freq !== 1000 || data[3].freq !== 8000) errors.push('defaults');
    }
    return [...new Set(errors)];
  });
  if (stage1.length) fail('STAGE1 ' + stage1.join(','));
  console.log('STAGE1 650 structural/path/wiring iterations: PASS');

  await page.locator('#file').setInputFiles(wav);
  await page.waitForFunction(() => window.myEFX?.debugState()?.loaded === true, null, { timeout: 10000 });

  const stage2 = await page.evaluate(() => {
    const knobs = [...document.querySelectorAll('.knob-input')];
    const errors = [];
    for (let i = 0; i < 450; i++) {
      const input = knobs[i % knobs.length];
      const min = Number(input.min), max = Number(input.max);
      const p = (i % 21) / 20;
      input.value = String(min + (max - min) * p);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const state = window.myEFX.debugState();
      const key = input.id.replace(/\d+$/, '');
      const band = Number(input.id.match(/\d+$/)[0]) - 1;
      const expected = Number(input.value);
      const tolerance = Math.max(Number(input.step) || 0.01, 0.02);
      if (Math.abs(state.bands[band][key] - expected) > tolerance) errors.push('knob-sync');
      if (i % 9 === 0) document.querySelector('#byp' + ((i % 4) + 1)).click();
      if (i % 11 === 0) document.querySelectorAll('[data-action="delta"]')[i % 4].click();
      if (i % 17 === 0) document.querySelectorAll('[data-action="reset"]')[i % 4].click();
      if (i % 19 === 0) document.querySelector('#sortBtn').click();
      if (i % 23 === 0) document.querySelector('#resetAll').click();
      if (i % 29 === 0) document.querySelector('#ab').click();
    }
    return [...new Set(errors)];
  });
  if (stage2.length) fail('STAGE2 ' + stage2.join(','));
  console.log('STAGE2 450 control/function iterations: PASS');

  await page.locator('#resetAll').click();
  await page.waitForTimeout(100);
  await page.locator('#play').click();
  await page.waitForTimeout(250);
  const before = await page.evaluate(() => ({ state: window.myEFX.debugState(), rms: window.myEFX.meterRms(), status: document.querySelector('#status')?.textContent || '' }));
  console.log('PLAYBACK CHECK', JSON.stringify(before));
  if (!before.state.playing || before.rms <= 1e-5) fail('playback/meter failed: ' + JSON.stringify(before));

  const stage3 = await page.evaluate(() => {
    const errors = [];
    const pick = (sel, i) => document.querySelectorAll(sel)[i % document.querySelectorAll(sel).length];
    for (let i = 0; i < 480; i++) {
      if (i % 4 === 0) document.querySelector('#bypassAll').click();
      if (i % 4 === 1) document.querySelector('#bypassAll').click();
      if (i % 7 === 0) pick('[data-action="delta"]', i).click();
      if (i % 9 === 0) document.querySelector('#loop').click();
      if (i % 13 === 0) document.querySelector('#loop').click();
      if (i % 17 === 0) pick('[data-action="bypass"]', i).click();
      if (i % 19 === 0) pick('[data-action="reset"]', i).click();
      if (i % 23 === 0) document.querySelector('#ab').click();
      if (i % 29 === 0) document.querySelector('#resetBands').click();
      const state = window.myEFX.debugState();
      if (state.bands.length !== 4) errors.push('state-length');
      if (state.deltaBand < 0 || state.deltaBand > 4) errors.push('delta-range');
    }
    return [...new Set(errors)];
  });
  if (stage3.length) fail('STAGE3 ' + stage3.join(','));
  console.log('STAGE3 480 live-graph/control stress iterations: PASS');

  await page.evaluate(() => {
    document.querySelector('#resetAll').click();
    const input = document.querySelector('#gain3');
    input.value = '12';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelectorAll('[data-action="delta"]')[2].click();
  });
  await page.waitForTimeout(300);
  const delta = await page.evaluate(() => ({ state: window.myEFX.debugState(), rms: window.myEFX.meterRms(), status: document.querySelector('#status')?.textContent || '' }));
  console.log('DELTA CHECK', JSON.stringify(delta));
  if (!delta.state.playing || !delta.state.deltaBand || delta.rms <= 1e-7) fail('delta path silent: ' + JSON.stringify(delta));

  const frame = page.locator('#inputFrame');
  const box = await frame.boundingBox();
  if (!box) fail('input frame box missing');
  else {
    await page.mouse.move(box.x + box.width * 0.22, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.5);
    await page.mouse.up();
    await page.waitForTimeout(50);
    const loopState = await page.evaluate(() => window.myEFX.debugState());
    if (!loopState.loopEnabled || loopState.loopEnd <= loopState.loopStart) fail('drag-loop failed');
  }

  const stage4 = await page.evaluate(() => {
    const errors = [];
    for (let i = 0; i < 320; i++) {
      const input = document.querySelector('#gain3');
      input.value = String((i % 49) - 24);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (i % 3 === 0) document.querySelector('[data-action="delta"]').click();
      if (i % 5 === 0) document.querySelector('#bypassAll').click();
      if (i % 7 === 0) document.querySelector('#bypassAll').click();
      if (i % 11 === 0) document.querySelector('#ab').click();
      if (i % 13 === 0) document.querySelector('#sortBtn').click();
      if (i % 17 === 0) document.querySelector('#resetAll').click();
      if (i % 19 === 0) document.querySelector('#stop').click();
      const state = window.myEFX.debugState();
      if (state.bands.length !== 4) errors.push('final-state');
    }
    return [...new Set(errors)];
  });
  if (stage4.length) fail('STAGE4 ' + stage4.join(','));
  console.log('STAGE4 320 final regression iterations: PASS');

  await page.locator('#stop').click();
} catch (error) {
  fail('HARNESS: ' + error.stack);
} finally {
  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error('\nFAILURES');
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log('ALL 1900 ITERATIONS PASS');
