(() => {
  'use strict';

  const BAND_COUNT = 4;
  const DEFAULTS = [
    { freq: 31.5, gain: 0, q: 1, denoise: 0, punch: 0, sustain: 0, bypass: false },
    { freq: 125, gain: 0, q: 1, denoise: 0, punch: 0, sustain: 0, bypass: false },
    { freq: 1000, gain: 0, q: 1, denoise: 0, punch: 0, sustain: 0, bypass: false },
    { freq: 8000, gain: 0, q: 1, denoise: 0, punch: 0, sustain: 0, bypass: false }
  ];

  const INFO = {
    freq: { min: 20, max: 20000, step: 1 },
    gain: { min: -24, max: 24, step: 0.1 },
    q: { min: 0.1, max: 20, step: 0.01 },
    denoise: { min: 0, max: 100, step: 1 },
    punch: { min: -100, max: 100, step: 1 },
    sustain: { min: -100, max: 100, step: 1 }
  };

  let ctx = null;
  let buffer = null;
  let source = null;
  let graph = null;
  let playing = false;
  let loop = false;
  let bypassAll = false;
  let offset = 0;
  let startAt = 0;
  let raf = 0;
  let deltaBand = 0;
  let renderToken = 0;
  let renderTimer = 0;
  let slot = 'A';
  let slotA = cloneDefaults();
  let slotB = cloneDefaults();
  let currentOfflineContext = null;

  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function cloneDefaults() { return DEFAULTS.map(b => ({ ...b })); }

  function setStatus(text) {
    const el = $('status');
    if (el) el.textContent = text;
  }

  function currentData() {
    return Array.from({ length: BAND_COUNT }, (_, n) => {
      const i = n + 1;
      return {
        freq: Number($('freq' + i).value),
        gain: Number($('gain' + i).value),
        q: Number($('q' + i).value),
        denoise: Number($('denoise' + i).value),
        punch: Number($('punch' + i).value),
        sustain: Number($('sustain' + i).value),
        bypass: !$('byp' + i).classList.contains('on')
      };
    });
  }

  function saveSlot() {
    if (slot === 'A') slotA = currentData(); else slotB = currentData();
  }

  function formatValue(key, value) {
    if (key === 'freq') {
      return value >= 1000
        ? (value / 1000).toFixed(value >= 10000 ? 1 : 2) + ' kHz'
        : (value % 1 ? value.toFixed(1) : Math.round(value)) + ' Hz';
    }
    if (key === 'gain') return value.toFixed(1) + ' dB';
    if (key === 'q') return value.toFixed(2);
    return Math.round(value) + '%';
  }

  function renderKnob(input) {
    if (!input) return;
    const key = input.id.replace(/[0-9]+$/, '');
    const d = INFO[key];
    const value = Number(input.value);
    const angle = -135 + 270 * ((value - d.min) / (d.max - d.min));
    const knob = document.querySelector(`.knob[data-target="${input.id}"]`);
    if (!knob) return;
    const ptr = knob.querySelector('.knob-pointer');
    if (ptr) ptr.style.transform = `translateX(-50%) rotate(${angle}deg)`;
    const out = $(input.id + 'Out');
    if (out) out.textContent = formatValue(key, value);
  }

  function setInput(input, value, trigger = true) {
    const key = input.id.replace(/[0-9]+$/, '');
    const d = INFO[key];
    const decimals = (String(d.step).split('.')[1] || '').length;
    let v = clamp(value, d.min, d.max);
    v = Number((Math.round(v / d.step) * d.step).toFixed(decimals));
    input.value = String(v);
    renderKnob(input);
    if (trigger) input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function setBandBypass(i, on, update = true) {
    const btn = $('byp' + i);
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.classList.toggle('off', !on);
    const state = document.querySelector(`.band[data-band="${i}"] .state`);
    if (state) state.textContent = on ? 'ON' : 'BYP';
    if (update) {
      syncGraph();
      saveSlot();
      scheduleProcessedRender();
    }
  }

  function applyData(data) {
    for (let i = 1; i <= BAND_COUNT; i++) {
      const b = data[i - 1] || DEFAULTS[i - 1];
      for (const key of Object.keys(INFO)) {
        const input = $(key + i);
        if (!input) continue;
        input.value = String(clamp(Number(b[key]), INFO[key].min, INFO[key].max));
        renderKnob(input);
      }
      setBandBypass(i, !b.bypass, false);
    }
    syncGraph();
    drawResponse();
  }

  function resetAll() {
    applyData(cloneDefaults());
    saveSlot();
    scheduleProcessedRender();
    setStatus('所有 Sections 已重設。');
  }

  function resetBand(i) {
    const data = currentData();
    data[i - 1] = { ...DEFAULTS[i - 1] };
    applyData(data);
    saveSlot();
    scheduleProcessedRender();
    setStatus(`SECTION ${i} 已重設。`);
  }

  function sortBands() {
    const data = currentData().sort((a, b) => a.freq - b.freq);
    applyData(data);
    saveSlot();
    scheduleProcessedRender();
    setStatus('Sections 已依頻率由低到高排序。');
  }

  function ensureContext() {
    if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
    return ctx;
  }

  function createStage(c) {
    const eq = c.createBiquadFilter();
    eq.type = 'peaking';

    // DELTA 的正確定義：processedBand - dryBand。
    // 這裡只建立真正的處理差值，不再把 raw / transient / processed 三路亂加。
    const split = c.createBiquadFilter();
    split.type = 'bandpass';

    const dryBand = c.createGain();
    const denoiseIn = c.createGain();
    const denoiseSum = c.createGain();
    const transientDry = c.createGain();
    const transientWet = c.createGain();
    const transientSum = c.createGain();
    const delta = c.createGain();
    const deltaInvert = c.createGain();
    const out = c.createGain();

    split.connect(dryBand);
    split.connect(denoiseIn);
    denoiseIn.connect(denoiseSum);

    denoiseSum.connect(transientDry);
    denoiseSum.connect(transientWet);
    transientDry.connect(transientSum);
    transientWet.connect(transientSum);

    eq.connect(out);
    dryBand.connect(deltaInvert);
    deltaInvert.gain.value = -1;
    transientSum.connect(delta);
    deltaInvert.connect(delta);
    delta.connect(out);

    return {
      eq, split, dryBand, denoiseIn, denoiseSum,
      transientDry, transientWet, transientSum,
      delta, out, denoise: null, transient: null
    };
  }

  async function ensureGraph() {
    const c = ensureContext();
    if (!graph) {
      const stages = Array.from({ length: BAND_COUNT }, () => createStage(c));
      const master = c.createGain();
      const analyser = c.createAnalyser();
      analyser.fftSize = 2048;
      master.connect(analyser);
      analyser.connect(c.destination);
      graph = { stages, master, analyser };
    }

    await c.audioWorklet.addModule('denoise-processor.js?v=balanced4');
    await c.audioWorklet.addModule('transient-processor.js?v=clean4');

    for (const stage of graph.stages) {
      if (!stage.denoise) {
        stage.denoise = new AudioWorkletNode(c, 'myefx-denoise', {
          parameterData: {
            amount: 0, threshold: 1.5, reduction: 18, adaptation: 1,
            smoothing: 54, transientProtect: 78, tonalProtect: 28, learn: 0
          }
        });
        stage.denoiseIn.disconnect();
        stage.denoiseIn.connect(stage.denoise);
        stage.denoise.connect(stage.denoiseSum);
      }
      if (!stage.transient) {
        stage.transient = new AudioWorkletNode(c, 'myefx-transient', {
          parameterData: { punch: 0, sustain: 0 }
        });
        stage.transientWet.disconnect();
        stage.transientWet.connect(stage.transient);
        stage.transient.connect(stage.transientSum);
      }
    }
    syncGraph();
  }

  function syncGraph() {
    if (!graph || !ctx) return;
    const now = ctx.currentTime;

    currentData().forEach((b, i) => {
      const s = graph.stages[i];
      s.eq.frequency.setTargetAtTime(b.freq, now, 0.004);
      s.eq.Q.setTargetAtTime(b.q, now, 0.004);
      s.eq.gain.setTargetAtTime(b.bypass ? 0 : b.gain, now, 0.004);
      s.split.frequency.setTargetAtTime(b.freq, now, 0.004);
      s.split.Q.setTargetAtTime(clamp(b.q, 0.25, 18), now, 0.004);

      const dn = b.bypass ? 0 : b.denoise;
      s.denoise?.parameters.get('amount')?.setTargetAtTime(dn, now, 0.004);
      s.denoise?.parameters.get('reduction')?.setTargetAtTime(12 + 0.06 * dn, now, 0.004);
      s.denoise?.parameters.get('smoothing')?.setTargetAtTime(48 + 0.12 * dn, now, 0.004);

      // 0% / BYPASS 是真正透明的 denoise bypass；所以 DELTA 在未處理時必定趨近 0。
      s.denoiseIn.gain.setTargetAtTime(1, now, 0.004);
      s.denoiseSum.gain.setTargetAtTime(1, now, 0.004);

      const mix = b.bypass ? 0 : Math.min(1, (Math.abs(b.punch) + Math.abs(b.sustain)) / 160);
      s.transientDry.gain.setTargetAtTime(1 - mix, now, 0.004);
      s.transientWet.gain.setTargetAtTime(mix, now, 0.004);
      s.transient?.parameters.get('punch')?.setTargetAtTime(b.bypass ? 0 : b.punch, now, 0.004);
      s.transient?.parameters.get('sustain')?.setTargetAtTime(b.bypass ? 0 : b.sustain, now, 0.004);
    });
  }

  function disconnectPlayback() {
    if (!source) return;
    try { source.stop(); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
    source = null;
  }

  function connectStageChain() {
    let node = source;
    for (const stage of graph.stages) {
      node.connect(stage.eq);
      node.connect(stage.split);
      node = stage.out;
    }
    node.connect(graph.master);
  }

  function connectPlayback() {
    disconnectPlayback();
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.loopStart = 0;
    source.loopEnd = buffer.duration;

    if (bypassAll) {
      source.connect(ctx.destination);
      return;
    }

    if (deltaBand) {
      // 先通過選定 Band 前面的 Section，然後只把該 Section 的 delta 拉出來。
      let node = source;
      for (let i = 0; i < deltaBand; i++) {
        const stage = graph.stages[i];
        node.connect(stage.eq);
        node.connect(stage.split);
        node = stage.out;
      }
      graph.stages[deltaBand - 1].delta.connect(graph.master);
      return;
    }

    connectStageChain();
  }

  async function startPlayback() {
    if (!buffer) {
      setStatus('請先載入音檔。');
      return;
    }
    try {
      const c = ensureContext();
      await c.resume();
      await ensureGraph();
      syncGraph();
      connectPlayback();
      startAt = c.currentTime;
      source.start(0, clamp(offset, 0, Math.max(0, buffer.duration - 0.001)));
      playing = true;
      $('play').textContent = '❚❚ 播放中';
      setStatus(deltaBand ? `DELTA B${deltaBand} 播放中` : bypassAll ? 'BYPASS 播放中' : '播放中');
      updateCursor();
    } catch (e) {
      playing = false;
      setStatus('播放失敗：' + (e.message || e));
      console.error(e);
    }
  }

  function stopPlayback() {
    if (playing && ctx && buffer) {
      const elapsed = Math.max(0, ctx.currentTime - startAt);
      offset = loop ? (offset + elapsed) % buffer.duration : Math.min(buffer.duration, offset + elapsed);
    }
    playing = false;
    disconnectPlayback();
    cancelAnimationFrame(raf);
    raf = 0;
    if ($('play')) $('play').textContent = '▶ 播放';
    setCursor(buffer ? offset / buffer.duration : 0);
    setStatus('已停止');
  }

  function updateCursor() {
    if (!playing || !buffer || !ctx) return;
    let p = (offset + (ctx.currentTime - startAt)) / buffer.duration;
    if (loop) p = ((offset + (ctx.currentTime - startAt)) % buffer.duration) / buffer.duration;
    if (!loop && p >= 1) {
      p = 1;
      playing = false;
      disconnectPlayback();
      $('play').textContent = '▶ 播放';
      setStatus('播放結束');
    }
    setCursor(p);
    if (playing) raf = requestAnimationFrame(updateCursor);
  }

  function setCursor(p) {
    p = clamp(p, 0, 1);
    $('cursorIn').style.left = p * 100 + '%';
    $('cursorOut').style.left = p * 100 + '%';
    $('time').textContent = buffer
      ? `${(p * buffer.duration).toFixed(2)} / ${buffer.duration.toFixed(2)} s`
      : '0.00 / 0.00 s';
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len;
      const w0 = Math.cos(a), wi0 = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j++) {
          const x = i + j, y = x + half;
          const vr = re[y] * wr - im[y] * wi;
          const vi = re[y] * wi + im[y] * wr;
          re[y] = re[x] - vr; im[y] = im[x] - vi;
          re[x] += vr; im[x] += vi;
          const tr = wr * w0 - wi * wi0;
          wi = wr * wi0 + wi * w0;
          wr = tr;
        }
      }
    }
  }

  function drawInputSpectrogram() {
    if (!buffer) return;
    const canvas = $('specIn');
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(400, Math.round(rect.width));
    const cssH = Math.max(140, Math.round(rect.height));
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;

    const c = canvas.getContext('2d', { alpha: false });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#02070a';
    c.fillRect(0, 0, cssW, cssH);

    const ch = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const N = 1024;
    const hop = 512;
    const bins = N / 2;
    const totalFrames = Math.max(1, Math.ceil((ch.length - N) / hop));
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const image = c.createImageData(cssW, cssH);
    const data = image.data;

    for (let x = 0; x < cssW; x++) {
      const fi = Math.min(totalFrames - 1, Math.floor(x * totalFrames / cssW));
      const pos = fi * hop;
      re.fill(0); im.fill(0);
      for (let n = 0; n < N; n++) {
        const idx = pos + n;
        if (idx < ch.length) re[n] = ch[idx] * (0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)));
      }
      fft(re, im);
      for (let y = 0; y < cssH; y++) {
        const norm = 1 - y / Math.max(1, cssH - 1);
        const freq = 20 * Math.pow(1000, norm);
        const bin = clamp(Math.round(freq * N / sr), 1, bins - 1);
        const mag = Math.hypot(re[bin], im[bin]) / N;
        const db = 20 * Math.log10(mag + 1e-8);
        const q = Math.pow(clamp((db + 86) / 72, 0, 1), 0.72);
        const idx = (y * cssW + x) * 4;
        data[idx] = Math.round(12 + 220 * q);
        data[idx + 1] = Math.round(20 + 150 * q);
        data[idx + 2] = Math.round(24 + 120 * q);
        data[idx + 3] = 255;
      }
    }
    c.putImageData(image, 0, 0);
  }

  // Processed 區塊只畫「前後頻譜確實被改變」的時間/頻率格。
  // 沒有改動的格子保持 #02070a，不再整張重新塗成一般頻譜。
  function drawProcessedDifference(inputBuffer, outputBuffer) {
    const canvas = $('specOut');
    if (!canvas || !inputBuffer || !outputBuffer) return;

    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(400, Math.round(rect.width));
    const cssH = Math.max(120, Math.round(rect.height));
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;

    const c = canvas.getContext('2d', { alpha: false });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#02070a';
    c.fillRect(0, 0, cssW, cssH);

    const inCh = inputBuffer.getChannelData(0);
    const outCh = outputBuffer.getChannelData(0);
    const sr = inputBuffer.sampleRate;
    const N = 1024;
    const bins = N / 2;
    const inRe = new Float32Array(N);
    const inIm = new Float32Array(N);
    const outRe = new Float32Array(N);
    const outIm = new Float32Array(N);
    const image = c.createImageData(cssW, cssH);
    const data = image.data;
    const last = Math.max(0, Math.min(inCh.length, outCh.length) - N);

    for (let x = 0; x < cssW; x++) {
      const pos = Math.min(last, Math.floor((x / Math.max(1, cssW - 1)) * last));
      inRe.fill(0); inIm.fill(0); outRe.fill(0); outIm.fill(0);
      for (let n = 0; n < N; n++) {
        const idx = pos + n;
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1));
        if (idx < inCh.length) inRe[n] = inCh[idx] * w;
        if (idx < outCh.length) outRe[n] = outCh[idx] * w;
      }
      fft(inRe, inIm);
      fft(outRe, outIm);

      for (let y = 0; y < cssH; y++) {
        const norm = 1 - y / Math.max(1, cssH - 1);
        const freq = 20 * Math.pow(1000, norm);
        const bin = clamp(Math.round(freq * N / sr), 1, bins - 1);
        const a = Math.hypot(inRe[bin], inIm[bin]) + 1e-8;
        const b = Math.hypot(outRe[bin], outIm[bin]) + 1e-8;
        const dbChange = 20 * Math.log10(b / a);
        if (Math.abs(dbChange) < 0.70) continue;

        const q = Math.pow(clamp(Math.abs(dbChange) / 12, 0, 1), 0.70);
        const idx = (y * cssW + x) * 4;
        if (dbChange < 0) {
          data[idx] = Math.round(40 + 180 * q);
          data[idx + 1] = Math.round(210 * q);
          data[idx + 2] = Math.round(210 * q);
        } else {
          data[idx] = Math.round(210 * q);
          data[idx + 1] = Math.round(130 + 110 * q);
          data[idx + 2] = Math.round(35 + 65 * q);
        }
        data[idx + 3] = 255;
      }
    }
    c.putImageData(image, 0, 0);
  }

  function drawResponse() {}
  function renderKnobs() { document.querySelectorAll('.knob-input').forEach(renderKnob); }

  function createOfflineStage(c) {
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const split = c.createBiquadFilter(); split.type = 'bandpass';
    const dry = c.createGain();
    const dnIn = c.createGain();
    const dnSum = c.createGain();
    const trDry = c.createGain();
    const trWet = c.createGain();
    const trSum = c.createGain();
    const inv = c.createGain(); inv.gain.value = -1;
    const delta = c.createGain();
    const out = c.createGain();

    split.connect(dry);
    split.connect(dnIn);
    dnIn.connect(dnSum);
    dnSum.connect(trDry);
    dnSum.connect(trWet);
    trDry.connect(trSum);
    trWet.connect(trSum);
    dry.connect(inv);
    inv.connect(delta);
    trSum.connect(delta);
    eq.connect(out);
    delta.connect(out);
    return { eq, split, dry, dnIn, dnSum, trDry, trWet, trSum, inv, delta, out };
  }

  function syncOfflineStage(s, b, c) {
    s.eq.frequency.value = b.freq;
    s.eq.Q.value = b.q;
    s.eq.gain.value = b.bypass ? 0 : b.gain;
    s.split.frequency.value = b.freq;
    s.split.Q.value = clamp(b.q, 0.25, 18);

    const dn = new AudioWorkletNode(c, 'myefx-denoise', {
      parameterData: {
        amount: b.bypass ? 0 : b.denoise,
        threshold: 1.5,
        reduction: 12 + 0.06 * b.denoise,
        adaptation: 1,
        smoothing: 48 + 0.12 * b.denoise,
        transientProtect: 78,
        tonalProtect: 28,
        learn: 0
      }
    });
    s.dnIn.disconnect();
    s.dnIn.connect(dn);
    dn.connect(s.dnSum);

    const tr = new AudioWorkletNode(c, 'myefx-transient', {
      parameterData: { punch: b.bypass ? 0 : b.punch, sustain: b.bypass ? 0 : b.sustain }
    });
    s.trWet.disconnect();
    s.trWet.connect(tr);
    tr.connect(s.trSum);

    const mix = b.bypass ? 0 : Math.min(1, (Math.abs(b.punch) + Math.abs(b.sustain)) / 160);
    s.trDry.gain.value = 1 - mix;
    s.trWet.gain.value = mix;
  }

  async function scheduleProcessedRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(async () => {
      if (!buffer || playing) return;
      const myToken = ++renderToken;
      try {
        setStatus('Spectrogram 分析中…');
        currentOfflineContext = new OfflineAudioContext(
          Math.max(1, buffer.numberOfChannels), buffer.length, buffer.sampleRate
        );
        const c = currentOfflineContext;
        await c.audioWorklet.addModule('denoise-processor.js?v=balanced4');
        await c.audioWorklet.addModule('transient-processor.js?v=clean4');

        const stages = Array.from({ length: BAND_COUNT }, () => createOfflineStage(c));
        const master = c.createGain();
        master.connect(c.destination);

        const src = c.createBufferSource();
        src.buffer = buffer;
        let node = src;
        for (const s of stages) {
          node.connect(s.eq);
          node.connect(s.split);
          node = s.out;
        }
        node.connect(master);
        currentData().forEach((b, i) => syncOfflineStage(stages[i], b, c));
        src.start(0);
        const out = await c.startRendering();

        if (myToken === renderToken && !playing) {
          drawProcessedDifference(buffer, out);
          setStatus('Spectrogram 已更新；未改動頻率維持全黑。');
        }
      } catch (e) {
        console.error(e);
        if (myToken === renderToken) setStatus('Spectrogram 分析失敗：' + (e.message || e));
      } finally {
        currentOfflineContext = null;
      }
    }, 550);
  }

  function handleFile(file) {
    if (!file) return;
    stopPlayback();
    buffer = null;
    const token = ++renderToken;
    setStatus('讀取與解碼音檔…');

    file.arrayBuffer()
      .then(bytes => ensureContext().decodeAudioData(bytes.slice(0)))
      .then(decoded => {
        if (token !== renderToken) return;
        buffer = decoded;
        offset = 0;
        $('fileInfo').textContent = `${file.name} · ${decoded.sampleRate} Hz · ${decoded.numberOfChannels} ch · ${decoded.duration.toFixed(2)} s`;
        $('dropUi').style.display = 'none';
        drawInputSpectrogram();
        setCursor(0);
        scheduleProcessedRender();
        setStatus('音檔已載入；現在才會啟用 DSP。');
      })
      .catch(e => {
        console.error(e);
        buffer = null;
        $('dropUi').style.display = '';
        setStatus('音檔載入失敗：' + (e.message || e));
      });
  }

  function setDelta(i) {
    deltaBand = deltaBand === i ? 0 : i;
    document.querySelectorAll('[data-action="delta"]').forEach((b, idx) => {
      const on = deltaBand === idx + 1;
      b.classList.toggle('active', on);
      b.textContent = on ? 'DELTA ON' : 'DELTA';
    });
    if (deltaBand) bypassAll = false;
    if (playing) restartAtCurrentPosition();
    setStatus(deltaBand ? `DELTA B${deltaBand}：只聽該段處理差異` : 'DELTA 已關閉');
  }

  function restartAtCurrentPosition() {
    if (!playing || !ctx || !buffer) return;
    const elapsed = Math.max(0, ctx.currentTime - startAt);
    offset = loop ? (offset + elapsed) % buffer.duration : Math.min(buffer.duration, offset + elapsed);
    connectPlayback();
    startAt = ctx.currentTime;
    source.start(0, offset);
  }

  function toggleBypassAll() {
    bypassAll = !bypassAll;
    if (bypassAll) {
      deltaBand = 0;
      document.querySelectorAll('[data-action="delta"]').forEach(b => {
        b.classList.remove('active');
        b.textContent = 'DELTA';
      });
    }
    const btn = $('bypassAll');
    btn.textContent = bypassAll ? 'BYPASS ON' : 'BYPASS OFF';
    btn.classList.toggle('active', bypassAll);
    if (playing) restartAtCurrentPosition();
  }

  function toggleAB() {
    saveSlot();
    const other = slot === 'A' ? 'B' : 'A';
    applyData(other === 'A' ? slotA : slotB);
    slot = other;
    $('ab').textContent = 'A/B · ' + slot;
    saveSlot();
    scheduleProcessedRender();
    setStatus('已切換到 Slot ' + slot);
  }

  function setupUI() {
    renderKnobs();

    document.querySelectorAll('.knob').forEach(knob => {
      const id = knob.dataset.target;
      const input = $(id);
      let lastY = 0;

      knob.addEventListener('pointerdown', e => {
        lastY = e.clientY;
        try { knob.setPointerCapture(e.pointerId); } catch (_) {}
      });
      knob.addEventListener('pointermove', e => {
        if (!knob.hasPointerCapture?.(e.pointerId)) return;
        const key = id.replace(/[0-9]+$/, '');
        const step = INFO[key].step * (e.shiftKey ? 0.1 : 1);
        setInput(input, Number(input.value) + (lastY - e.clientY) * step * 2);
        lastY = e.clientY;
      });
      knob.addEventListener('wheel', e => {
        e.preventDefault();
        const key = id.replace(/[0-9]+$/, '');
        setInput(input, Number(input.value) + (e.deltaY < 0 ? INFO[key].step : -INFO[key].step));
      }, { passive: false });
      knob.addEventListener('dblclick', () => setInput(input, Number(input.defaultValue)));
      knob.addEventListener('keydown', e => {
        const key = id.replace(/[0-9]+$/, '');
        const step = INFO[key].step;
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); setInput(input, Number(input.value) + step); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); setInput(input, Number(input.value) - step); }
        else if (e.key === 'Home') setInput(input, INFO[key].min);
        else if (e.key === 'End') setInput(input, INFO[key].max);
      });

      input.addEventListener('input', () => {
        renderKnob(input);
        syncGraph();
        saveSlot();
        scheduleProcessedRender();
      });
    });

    $('file').addEventListener('change', e => handleFile(e.target.files?.[0]));
    const frame = $('inputFrame');
    ['dragenter', 'dragover'].forEach(type => frame.addEventListener(type, e => {
      e.preventDefault(); e.stopPropagation(); $('dropUi').style.display = '';
    }));
    ['dragleave', 'drop'].forEach(type => frame.addEventListener(type, e => {
      e.preventDefault(); e.stopPropagation();
      if (type === 'drop') handleFile(e.dataTransfer.files?.[0]);
    }));

    $('play').addEventListener('click', () => playing ? stopPlayback() : startPlayback());
    $('stop').addEventListener('click', stopPlayback);
    $('loop').addEventListener('click', () => {
      loop = !loop;
      $('loop').textContent = loop ? 'LOOP ON' : 'LOOP OFF';
      $('loop').classList.toggle('active', loop);
    });
    $('bypassAll').addEventListener('click', toggleBypassAll);
    $('ab').addEventListener('click', toggleAB);
    $('sortBtn').addEventListener('click', sortBands);
    $('resetAll').addEventListener('click', resetAll);
    $('resetBands').addEventListener('click', resetAll);

    document.querySelectorAll('.band').forEach(card => {
      const i = Number(card.dataset.band);
      card.querySelector('[data-action="bypass"]').addEventListener('click', () => {
        const btn = $('byp' + i);
        setBandBypass(i, !btn.classList.contains('on'));
      });
      card.querySelector('[data-action="delta"]').addEventListener('click', () => setDelta(i));
      card.querySelector('[data-action="reset"]').addEventListener('click', () => resetBand(i));
    });

    window.addEventListener('resize', () => {
      drawInputSpectrogram();
      if (buffer) scheduleProcessedRender();
    });
  }

  setupUI();
})();
