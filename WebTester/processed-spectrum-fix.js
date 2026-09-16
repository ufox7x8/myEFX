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

const drawStatic = `  function drawInputSpectrogram() {
    if (!buffer) return;
    const canvas = $('specIn');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(400, Math.round(rect.width));
    const H = Math.max(120, Math.round(rect.height));
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr;
    const c = canvas.getContext('2d', { alpha: false });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#050304'; c.fillRect(0, 0, W, H);
    const a = buffer.getChannelData(0), sr = buffer.sampleRate, N = 1024, bins = N / 2;
    const re = new Float32Array(N), im = new Float32Array(N);
    const img = c.createImageData(W, H), px = img.data;
    const last = Math.max(0, a.length - N);
    for (let x = 0; x < W; x++) {
      const pos = Math.floor((x / Math.max(1, W - 1)) * last);
      re.fill(0); im.fill(0);
      for (let n = 0; n < N; n++) {
        const idx = pos + n;
        if (idx < a.length) re[n] = a[idx] * (0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)));
      }
      fft(re, im);
      for (let y = 0; y < H; y++) {
        const norm = 1 - y / Math.max(1, H - 1), f = 20 * Math.pow(1000, norm);
        const k = clamp(Math.round(f * N / sr), 1, bins - 1);
        const mag = Math.hypot(re[k], im[k]) / N;
        const q = Math.pow(clamp((20 * Math.log10(mag + 1e-8) + 86) / 72, 0, 1), .68);
        const idx = (y * W + x) * 4;
        px[idx] = 18 + 190 * q; px[idx + 1] = 3 + 42 * q; px[idx + 2] = 12 + 54 * q; px[idx + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    window.__MYEFX_INPUT_RENDERED__ = true;
  }
`;
s = replaceBetween(s, '  function drawInputSpectrogram()', '  function createOfflineStage(c)', drawStatic + '\n');

const live = `  function ensureProcessedAnalyser() {
    if (!ctx || !graph) return null;
    if (!graph.processedAnalyser) {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0.0;
      graph.processedAnalyser = a;
      graph.master.connect(a);
    }
    return graph.processedAnalyser;
  }

  function drawProcessedFrame(analyser, clear = false) {
    const canvas = $('specOut');
    if (!canvas || !analyser) return;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(400, Math.round(rect.width));
    const H = Math.max(120, Math.round(rect.height));
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = W * dpr; canvas.height = H * dpr;
    }
    const c = canvas.getContext('2d', { alpha: false });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (clear) { c.fillStyle = '#050304'; c.fillRect(0, 0, W, H); }
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    if (W > 1) {
      const img = c.getImageData(1, 0, W - 1, H);
      c.putImageData(img, 0, 0);
    }
    const col = c.createImageData(1, H), px = col.data;
    const bins = data.length, nyquist = ctx ? ctx.sampleRate * 0.5 : 24000;
    for (let y = 0; y < H; y++) {
      const norm = 1 - y / Math.max(1, H - 1), f = 20 * Math.pow(1000, norm);
      const k = clamp(Math.round(f / nyquist * (bins - 1)), 0, bins - 1);
      const q = Math.pow(data[k] / 255, .72), p = y * 4;
      px[p] = 18 + 190 * q; px[p + 1] = 3 + 42 * q; px[p + 2] = 12 + 54 * q; px[p + 3] = 255;
    }
    c.putImageData(col, W - 1, 0);
  }

  let processedRaf = 0;
  function runProcessedLive() {
    cancelAnimationFrame(processedRaf);
    const analyser = ensureProcessedAnalyser();
    if (!analyser) return;
    processedRaf = requestAnimationFrame(function tick() {
      drawProcessedFrame(analyser, false);
      if (playing || previewSource) processedRaf = requestAnimationFrame(tick);
    });
  }
  function stopProcessedLive() { cancelAnimationFrame(processedRaf); processedRaf = 0; }

  let previewSource = null;
  let previewStopTimer = 0;
  async function startProcessedPreview() {
    clearTimeout(previewStopTimer);
    if (!buffer || !ctx) return;
    if (!graph) { try { await ensureGraph(); } catch (e) { status('Processed Spectrogram 初始化失敗：' + (e.message || e)); return; } }
    if (playing) return runProcessedLive();
    const analyser = ensureProcessedAnalyser();
    if (!analyser) return;
    try { previewSource?.stop(); } catch (_) {}
    try { previewSource?.disconnect(); } catch (_) {}

    const sr = buffer.sampleRate;
    const previewSamples = Math.min(buffer.length, Math.max(2048, Math.round(sr * 1.0)));
    const center = Math.round(clamp(offset, 0, Math.max(0, buffer.duration)) * sr);
    const start = clamp(center - Math.floor(previewSamples / 2), 0, Math.max(0, buffer.length - previewSamples));
    const previewBuf = ctx.createBuffer(buffer.numberOfChannels, previewSamples, sr);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) previewBuf.copyToChannel(buffer.getChannelData(ch).subarray(start, start + previewSamples), ch);

    const src = ctx.createBufferSource(); src.buffer = previewBuf;
    let node = src;
    for (const st of graph.stages) { node.connect(st.dryFull); node.connect(st.eq); node.connect(st.split); node = st.out; }
    node.connect(analyser);
    const oldGain = graph.master.gain.value;
    graph.master.gain.setValueAtTime(0, ctx.currentTime);
    previewSource = src;
    drawProcessedFrame(analyser, true);
    src.start();
    runProcessedLive();

    previewStopTimer = window.setTimeout(() => {
      try { src.stop(); } catch (_) {}
      try { src.disconnect(); } catch (_) {}
      try { node.disconnect(analyser); } catch (_) {}
      graph.master.gain.setValueAtTime(oldGain, ctx.currentTime);
      if (previewSource === src) previewSource = null;
      stopProcessedLive();
    }, 1050);
  }

  function scheduleProcessedRender() {
    clearTimeout(renderTimer);
    ++renderToken;
    renderTimer = setTimeout(() => {
      if (!buffer || !ctx) return;
      startProcessedPreview();
    }, 35);
  }
`;
s = replaceBetween(s, '  function scheduleProcessedRender()', '  function handleFile(file)', live);

const startMarker = "      playing = true; $('play').textContent = '❚❚ 停止';";
if (!s.includes(startMarker)) throw new Error('play start marker not found');
s = s.replace(startMarker, startMarker + "\n      runProcessedLive();");
const stopMarker = "    playing = false; disconnectPlayback(); cancelAnimationFrame(raf); raf = 0;";
if (!s.includes(stopMarker)) throw new Error('play stop marker not found');
s = s.replace(stopMarker, stopMarker + "\n    stopProcessedLive();");

const resizeOld = "  window.addEventListener('resize', () => { drawInputSpectrogram(); if (buffer) scheduleProcessedRender(); });";
if (s.includes(resizeOld)) s = s.replace(resizeOld, "  window.addEventListener('resize', () => { drawInputSpectrogram(); if (playing) runProcessedLive(); });");

if (s.includes('new OfflineAudioContext') || s.includes('await c.startRendering()')) throw new Error('Blocking OfflineAudioContext processed renderer still present');
for (const marker of ['function ensureProcessedAnalyser', 'function startProcessedPreview', 'function scheduleProcessedRender', 'runProcessedLive();']) {
  if (!s.includes(marker)) throw new Error('live processed renderer marker missing: ' + marker);
}
fs.writeFileSync(path, s, 'utf8');
console.log('Processed Spectrogram uses realtime analyser + 1-second canonical preview; Input is static.');
