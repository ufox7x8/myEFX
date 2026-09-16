const fs = require('fs');
const path = 'WebTester/app.js';
let s = fs.readFileSync(path, 'utf8');

function replaceBetween(text, start, end, replacement) {
  const a = text.indexOf(start);
  if (a < 0) throw new Error(`start not found: ${start}`);
  const b = text.indexOf(end, a);
  if (b < 0) throw new Error(`end not found: ${end}`);
  return text.slice(0, a) + replacement + text.slice(b);
}

const draw = `  function drawProcessedSpectrogram(outBuf, refBuf) {
    const canvas = $('specOut');
    if (!canvas || !outBuf || !refBuf) return;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(400, Math.round(rect.width));
    const H = Math.max(120, Math.round(rect.height));
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr;
    const c = canvas.getContext('2d', { alpha: false });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#050304'; c.fillRect(0, 0, W, H);

    const a = outBuf.getChannelData(0);
    const sr = outBuf.sampleRate;
    const N = 1024, bins = N / 2, re = new Float32Array(N), im = new Float32Array(N);
    const img = c.createImageData(W, H), px = img.data;
    const last = Math.max(0, a.length - N);
    for (let x = 0; x < W; x++) {
      const pos = Math.floor((x / Math.max(1, W - 1)) * last);
      re.fill(0); im.fill(0);
      for (let n = 0; n < N; n++) {
        const idx = pos + n;
        const w = .5 - .5 * Math.cos(2 * Math.PI * n / (N - 1));
        if (idx < a.length) re[n] = a[idx] * w;
      }
      fft(re, im);
      for (let y = 0; y < H; y++) {
        const norm = 1 - y / Math.max(1, H - 1);
        const f = 20 * Math.pow(1000, norm);
        const k = clamp(Math.round(f * N / sr), 1, bins - 1);
        const mag = Math.hypot(re[k], im[k]) / N;
        const db = 20 * Math.log10(mag + 1e-9);
        const q = Math.pow(clamp((db + 86) / 72, 0, 1), .68);
        const idx = (y * W + x) * 4;
        // Original red-toned processed view: brightness encodes processed level.
        px[idx] = 18 + 190 * q;
        px[idx + 1] = 3 + 42 * q;
        px[idx + 2] = 12 + 54 * q;
        px[idx + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }

  function drawDifferenceOrInput(diff, inBuf, outBuf) {
    if (diff) { drawProcessedSpectrogram(outBuf, inBuf); return; }
    const canvas = $('specIn'); if (!canvas || !inBuf) return;
    const rect = canvas.getBoundingClientRect(), W = Math.max(400, Math.round(rect.width)), H = Math.max(120, Math.round(rect.height)), dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr;
    const c = canvas.getContext('2d', { alpha: false }); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = '#050304'; c.fillRect(0, 0, W, H);
    const a = inBuf.getChannelData(0), sr = inBuf.sampleRate, N = 1024, bins = N / 2;
    const re = new Float32Array(N), im = new Float32Array(N), img = c.createImageData(W, H), px = img.data;
    const last = Math.max(0, a.length - N);
    for (let x = 0; x < W; x++) {
      const pos = Math.floor((x / Math.max(1, W - 1)) * last); re.fill(0); im.fill(0);
      for (let n = 0; n < N; n++) { const idx = pos + n, w = .5 - .5 * Math.cos(2 * Math.PI * n / (N - 1)); if (idx < a.length) re[n] = a[idx] * w; }
      fft(re, im);
      for (let y = 0; y < H; y++) {
        const norm = 1 - y / Math.max(1, H - 1), f = 20 * Math.pow(1000, norm), k = clamp(Math.round(f * N / sr), 1, bins - 1), mag = Math.hypot(re[k], im[k]) / N, q = Math.pow(clamp((20 * Math.log10(mag + 1e-8) + 86) / 72, 0, 1), .68), idx = (y * W + x) * 4;
        px[idx] = 18 + 190 * q; px[idx + 1] = 3 + 42 * q; px[idx + 2] = 12 + 54 * q; px[idx + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }
`;
s = replaceBetween(s, '  function drawInputSpectrogram()', '  function createOfflineStage(c)', '  function drawInputSpectrogram() { if (!buffer) return; drawDifferenceOrInput(false, buffer, null); }\n\n' + draw);

const render = `  function scheduleProcessedRender() {
    clearTimeout(renderTimer); if (!buffer) return; const token = ++renderToken;
    renderTimer = setTimeout(async () => {
      try {
        const c = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        await c.audioWorklet.addModule('denoise-processor.js?v=delta16');
        await c.audioWorklet.addModule('transient-processor.js?v=delta16');
        const stages = Array.from({ length: BAND_COUNT }, () => createOfflineStage(c));
        const master = c.createGain(); master.connect(c.destination);
        const src = c.createBufferSource(); src.buffer = buffer; let node = src;
        for (const st of stages) { node.connect(st.dryFull); node.connect(st.eq); node.connect(st.split); node = st.out; }
        node.connect(master);
        currentData().forEach((b, i) => syncOfflineStage(stages[i], b, c));
        src.start(0);
        const out = await c.startRendering();
        if (token === renderToken) { drawProcessedSpectrogram(out, buffer); status('Processed Spectrogram：顯示實際處理後音訊。'); }
      } catch (e) { if (token === renderToken) status('Processed Spectrogram 分析失敗：' + (e.message || e)); }
    }, 220);
  }
`;
s = replaceBetween(s, '  function scheduleProcessedRender()', '  function handleFile(file)', render);

for (const marker of ['function drawProcessedSpectrogram', "drawProcessedSpectrogram(out, buffer)", "denoise-processor.js?v=delta16", "transient-processor.js?v=delta16"]) {
  if (!s.includes(marker)) throw new Error('processed spectrogram marker missing: ' + marker);
}
fs.writeFileSync(path, s, 'utf8');
console.log('Processed Spectrogram now renders the actual processed output spectrum.');
