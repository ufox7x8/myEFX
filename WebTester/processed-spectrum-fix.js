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
      a.minDecibels = -110;
      a.maxDecibels = -8;
      graph.processedAnalyser = a;
      graph.master.connect(a);
    }
    if (!graph.inputReferenceAnalyser) {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0.0;
      a.minDecibels = -110;
      a.maxDecibels = -8;
      graph.inputReferenceAnalyser = a;
    }
    return graph.processedAnalyser;
  }

  function colorDifference(q, px, p) {
    q = clamp(q, 0, 1);
    if (q <= 0) {
      px[p] = 2; px[p + 1] = 4; px[p + 2] = 7; px[p + 3] = 255;
      return;
    }
    // Weak -> strong: deep blue -> cyan -> green -> yellow -> orange -> red -> white.
    let r, g, b;
    if (q < .20) {
      const t = q / .20; r = 8; g = 22 + 170 * t; b = 70 + 150 * t;
    } else if (q < .40) {
      const t = (q - .20) / .20; r = 8; g = 192 + 45 * t; b = 220 - 135 * t;
    } else if (q < .60) {
      const t = (q - .40) / .20; r = 20 + 235 * t; g = 237; b = 85 - 70 * t;
    } else if (q < .80) {
      const t = (q - .60) / .20; r = 255; g = 237 - 150 * t; b = 15 - 8 * t;
    } else {
      const t = (q - .80) / .20; r = 255; g = 87 + 168 * t; b = 7 + 248 * t;
    }
    px[p] = Math.round(r); px[p + 1] = Math.round(g); px[p + 2] = Math.round(b); px[p + 3] = 255;
  }

  function differenceStrength(inputDb, processedDb) {
    const inputPower = Math.pow(10, inputDb / 10);
    const processedPower = Math.pow(10, processedDb / 10);
    const floorPower = Math.pow(10, -104 / 10);
    if (Math.max(inputPower, processedPower) <= floorPower) return 0;
    const dbDiff = Math.abs(processedDb - inputDb);
    if (!Number.isFinite(dbDiff) || dbDiff < 0.8) return 0;
    // 0.8 dB = visually unchanged; 18 dB+ = fully saturated color.
    return Math.pow(clamp((dbDiff - 0.8) / 17.2, 0, 1), .72);
  }

  function drawProcessedFrame(processedAnalyser, clear = false) {
    const canvas = $('specOut');
    const inputAnalyser = graph && graph.inputReferenceAnalyser;
    if (!canvas || !processedAnalyser || !inputAnalyser) return;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(400, Math.round(rect.width));
    const H = Math.max(120, Math.round(rect.height));
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = W * dpr; canvas.height = H * dpr;
    }
    const c = canvas.getContext('2d', { alpha: false });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (clear) { c.fillStyle = '#020407'; c.fillRect(0, 0, W, H); }

    const processed = new Float32Array(processedAnalyser.frequencyBinCount);
    const input = new Float32Array(inputAnalyser.frequencyBinCount);
    processedAnalyser.getFloatFrequencyData(processed);
    inputAnalyser.getFloatFrequencyData(input);

    if (W > 1) {
      const img = c.getImageData(1, 0, W - 1, H);
      c.putImageData(img, 0, 0);
    }

    const col = c.createImageData(1, H), px = col.data;
    const bins = Math.min(processed.length, input.length);
    const nyquist = ctx ? ctx.sampleRate * 0.5 : 24000;
    for (let y = 0; y < H; y++) {
      const norm = 1 - y / Math.max(1, H - 1), f = 20 * Math.pow(1000, norm);
      const k = clamp(Math.round(f / nyquist * (bins - 1)), 0, bins - 1);
      const q = differenceStrength(input[k], processed[k]);
      colorDifference(q, px, y * 4);
    }
    c.putImageData(col, W - 1, 0);
    window.__MYEFX_PROCESSED_DIFF__ = true;
  }

  let processedRaf = 0;
  function runProcessedLive() {
    cancelAnimationFrame(processedRaf);
    const analyser = ensureProcessedAnalyser();
    if (!analyser || !graph.inputReferenceAnalyser) return;
    processedRaf = requestAnimationFrame(function tick() {
      drawProcessedFrame(analyser, false);
      if (playing || previewSource) processedRaf = requestAnimationFrame(tick);
    });
  }
  function stopProcessedLive() { cancelAnimationFrame(processedRaf); processedRaf = 0; }

  function patchPlaybackReferenceForSource(src) {
    if (!src || !graph || !graph.inputReferenceAnalyser) return;
    try { src.connect(graph.inputReferenceAnalyser); } catch (_) {}
  }

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
    patchPlaybackReferenceForSource(src);
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

const connectMarker = '      connectPlayback(); startAt = c.currentTime;';
if (!s.includes(connectMarker)) throw new Error('playback connect marker not found');
s = s.replace(connectMarker, "      ensureProcessedAnalyser();\n      connectPlayback();\n      patchPlaybackReferenceForSource(source); startAt = c.currentTime;");

const startMarker = "      playing = true; $('play').textContent = '❚❚ 停止';";
if (!s.includes(startMarker)) throw new Error('play start marker not found');
s = s.replace(startMarker, startMarker + "\n      runProcessedLive();");
const stopMarker = "    playing = false; disconnectPlayback(); cancelAnimationFrame(raf); raf = 0;";
if (!s.includes(stopMarker)) throw new Error('play stop marker not found');
s = s.replace(stopMarker, stopMarker + "\n    stopProcessedLive();");

const resizeOld = "  window.addEventListener('resize', () => { drawInputSpectrogram(); if (buffer) scheduleProcessedRender(); });";
if (s.includes(resizeOld)) s = s.replace(resizeOld, "  window.addEventListener('resize', () => { drawInputSpectrogram(); if (playing) runProcessedLive(); });");

if (s.includes('new OfflineAudioContext') || s.includes('await c.startRendering()')) throw new Error('Blocking OfflineAudioContext processed renderer still present');
for (const marker of [
  'function ensureProcessedAnalyser',
  'function differenceStrength',
  'function colorDifference',
  'function drawProcessedFrame',
  'function startProcessedPreview',
  'function scheduleProcessedRender',
  'runProcessedLive();',
  'patchPlaybackReferenceForSource'
]) {
  if (!s.includes(marker)) throw new Error('processed diff renderer marker missing: ' + marker);
}
fs.writeFileSync(path, s, 'utf8');
console.log('Processed Spectrogram now shows only measured INPUT-vs-PROCESSED spectral differences with multicolor intensity.');
