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
  // GAIN currently takes 48 dB over about 240 px. All requested knobs use the same full-range travel.
  const FULL_RANGE_TRAVEL_PX = 240;

  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cloneData = d => d.map(x => ({ ...x }));

  let ctx = null, buffer = null, source = null, graph = null;
  let playing = false, loop = false, bypassAll = false;
  let offset = 0, startAt = 0, raf = 0, deltaBand = 0;
  let loopStart = 0, loopEnd = 0;
  let renderTimer = 0, renderToken = 0;
  let slot = 'A', slotA = cloneData(DEFAULTS), slotB = cloneData(DEFAULTS);

  function status(t) { const e = $('status'); if (e) e.textContent = t; }

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

  function saveSlot() { if (slot === 'A') slotA = currentData(); else slotB = currentData(); }

  function formatValue(key, v) {
    if (key === 'freq') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : (v % 1 ? v.toFixed(1) : Math.round(v)) + ' Hz';
    if (key === 'gain') return v.toFixed(1) + ' dB';
    if (key === 'q') return v.toFixed(2);
    return Math.round(v) + '%';
  }

  function renderKnob(input, reveal = false) {
    if (!input) return;
    const key = input.id.replace(/[0-9]+$/, ''), d = INFO[key], value = Number(input.value);
    const knob = document.querySelector(`.knob[data-target="${input.id}"]`);
    if (!knob) return;
    const angle = -135 + 270 * ((value - d.min) / (d.max - d.min));
    const p = knob.querySelector('.knob-pointer'); if (p) p.style.transform = `translateX(-50%) rotate(${angle}deg)`;
    const out = $(input.id + 'Out'); if (out) { out.textContent = formatValue(key, value); out.classList.toggle('show', reveal); }
  }

  function setInput(input, value, trigger = true, reveal = true) {
    const key = input.id.replace(/[0-9]+$/, ''), d = INFO[key];
    const decimals = (String(d.step).split('.')[1] || '').length;
    let v = clamp(value, d.min, d.max);
    v = Number((Math.round(v / d.step) * d.step).toFixed(decimals));
    input.value = String(v);
    renderKnob(input, reveal);
    if (trigger) input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function knobDeltaPerPixel(key) {
    const d = INFO[key];
    return (d.max - d.min) / FULL_RANGE_TRAVEL_PX;
  }

  function setBandBypass(i, on, update = true) {
    const b = $('byp' + i); if (!b) return;
    b.classList.toggle('on', on); b.classList.toggle('off', !on);
    const s = document.querySelector(`.band[data-band="${i}"] .state`); if (s) s.textContent = on ? 'ON' : 'BYP';
    if (update) { syncGraph(); saveSlot(); scheduleProcessedRender(); }
  }

  function applyData(data) {
    for (let i = 1; i <= BAND_COUNT; i++) {
      const b = data[i - 1] || DEFAULTS[i - 1];
      for (const k of Object.keys(INFO)) {
        const input = $(k + i);
        if (input) { input.value = String(clamp(Number(b[k]), INFO[k].min, INFO[k].max)); renderKnob(input); }
      }
      setBandBypass(i, !b.bypass, false);
    }
    syncGraph();
    scheduleProcessedRender();
  }

  function resetAll() { applyData(cloneData(DEFAULTS)); saveSlot(); status('所有 Sections 已重設。'); }
  function resetBand(i) { const d = currentData(); d[i - 1] = { ...DEFAULTS[i - 1] }; applyData(d); saveSlot(); status(`SECTION ${i} 已重設。`); }
  function sortBands() { const d = currentData().sort((a, b) => a.freq - b.freq); applyData(d); saveSlot(); status('Sections 已依頻率排序。'); }

  function ensureContext() { if (!ctx || ctx.state === 'closed') ctx = new AudioContext(); return ctx; }

  function createStage(c) {
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const split = c.createBiquadFilter(); split.type = 'bandpass';
    const dryFull = c.createGain();
    const eqInvert = c.createGain(); eqInvert.gain.value = -1;
    const eqDelta = c.createGain();
    const dryBand = c.createGain();
    const bandInvert = c.createGain(); bandInvert.gain.value = -1;
    const dnIn = c.createGain(), dnSum = c.createGain();
    const trDry = c.createGain(), trWet = c.createGain(), trSum = c.createGain();
    const delta = c.createGain();
    const out = c.createGain();

    // EQ delta = EQ output - exact pre-EQ input.
    dryFull.connect(eqInvert);
    eqInvert.connect(eqDelta);
    eq.connect(out);
    eq.connect(eqDelta);
    eqDelta.connect(delta);

    // Spectral-section delta = processed band - exact dry band.
    split.connect(dryBand);
    split.connect(dnIn);
    dnIn.connect(dnSum);
    dnSum.connect(trDry);
    dnSum.connect(trWet);
    trDry.connect(trSum);
    trWet.connect(trSum);
    dryBand.connect(bandInvert);
    bandInvert.connect(delta);
    trSum.connect(delta);

    // Total stage output = normal EQ signal + only the changed spectral-band component.
    delta.connect(out);

    return {
      eq, split, dryFull, eqInvert, eqDelta, dryBand, bandInvert,
      dnIn, dnSum, trDry, trWet, trSum, delta, out,
      denoise: null, transient: null
    };
  }

  async function ensureGraph() {
    const c = ensureContext();
    if (!graph) {
      const stages = Array.from({ length: BAND_COUNT }, () => createStage(c));
      const master = c.createGain();
      const analyser = c.createAnalyser(); analyser.fftSize = 2048;
      master.connect(analyser); analyser.connect(c.destination);
      graph = { stages, master, analyser };
    }
    await c.audioWorklet.addModule('denoise-processor.js?v=rxgate3');
    await c.audioWorklet.addModule('transient-processor.js?v=clean4');
    for (const s of graph.stages) {
      if (!s.denoise) {
        s.denoise = new AudioWorkletNode(c, 'myefx-denoise', { parameterData: { amount: 0 } });
        s.dnIn.disconnect(); s.dnIn.connect(s.denoise); s.denoise.connect(s.dnSum);
      }
      if (!s.transient) {
        s.transient = new AudioWorkletNode(c, 'myefx-transient', { parameterData: { punch: 0, sustain: 0 } });
        s.trWet.disconnect(); s.trWet.connect(s.transient); s.transient.connect(s.trSum);
      }
    }
    syncGraph();
  }

  function syncGraph() {
    if (!graph || !ctx) return;
    const now = ctx.currentTime;
    currentData().forEach((b, i) => {
      const s = graph.stages[i];
      s.eq.frequency.setTargetAtTime(b.freq, now, .004);
      s.eq.Q.setTargetAtTime(b.q, now, .004);
      s.eq.gain.setTargetAtTime(b.bypass ? 0 : b.gain, now, .004);
      s.split.frequency.setTargetAtTime(b.freq, now, .004);
      s.split.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .004);
      s.denoise?.parameters.get('amount')?.setTargetAtTime(b.bypass ? 0 : b.denoise, now, .004);

      const mix = b.bypass ? 0 : Math.min(1, (Math.abs(b.punch) + Math.abs(b.sustain)) / 160);
      s.trDry.gain.setTargetAtTime(1 - mix, now, .004);
      s.trWet.gain.setTargetAtTime(mix, now, .004);
      s.transient?.parameters.get('punch')?.setTargetAtTime(b.bypass ? 0 : b.punch, now, .004);
      s.transient?.parameters.get('sustain')?.setTargetAtTime(b.bypass ? 0 : b.sustain, now, .004);
    });
  }

  function disconnectPlayback() {
    if (!source) return;
    try { source.stop(); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
    source = null;
  }

  function connectPlayback() {
    disconnectPlayback();
    source = ctx.createBufferSource(); source.buffer = buffer;
    const ls = loopEnd > loopStart ? loopStart : 0;
    const le = loopEnd > loopStart ? loopEnd : buffer.duration;
    source.loop = loop; source.loopStart = ls; source.loopEnd = le;

    if (bypassAll) { source.connect(ctx.destination); return; }

    if (deltaBand) {
      // Feed prior sections normally, then solo only the selected section's true delta.
      let node = source;
      for (let i = 0; i < deltaBand - 1; i++) {
        const s = graph.stages[i];
        node.connect(s.dryFull);
        node.connect(s.eq);
        node.connect(s.split);
        node = s.out;
      }
      const selected = graph.stages[deltaBand - 1];
      node.connect(selected.dryFull);
      node.connect(selected.eq);
      node.connect(selected.split);
      selected.delta.connect(graph.master);
      return;
    }

    let node = source;
    for (const s of graph.stages) {
      node.connect(s.dryFull);
      node.connect(s.eq);
      node.connect(s.split);
      node = s.out;
    }
    node.connect(graph.master);
  }

  function restartAtCurrentPosition() {
    if (!playing || !ctx || !buffer) return;
    const now = ctx.currentTime, elapsed = Math.max(0, now - startAt);
    const a = loopEnd > loopStart ? loopStart : 0;
    const b = loopEnd > loopStart ? loopEnd : buffer.duration;
    offset = loop ? a + ((offset + elapsed - a) % Math.max(.001, b - a)) : Math.min(buffer.duration, offset + elapsed);
    connectPlayback(); startAt = ctx.currentTime; source.start(0, offset);
  }

  async function startPlayback() {
    if (!buffer) return status('請先載入音檔。');
    try {
      const c = ensureContext(); await c.resume(); await ensureGraph();
      connectPlayback(); startAt = c.currentTime;
      const a = loopEnd > loopStart ? loopStart : 0;
      const startPos = loop ? Math.max(a, offset) : offset;
      source.start(0, clamp(startPos, 0, Math.max(0, buffer.duration - .001)));
      playing = true; $('play').textContent = '❚❚ 停止';
      status(deltaBand ? `DELTA B${deltaBand}：只聽被處理改變的內容` : loop ? 'LOOP 播放中' : '播放中');
      updateCursor();
    } catch (e) {
      playing = false; status('播放失敗：' + (e.message || e)); console.error(e);
    }
  }

  function stopPlayback() {
    if (playing && ctx && buffer) {
      const elapsed = Math.max(0, ctx.currentTime - startAt);
      const a = loopEnd > loopStart ? loopStart : 0, b = loopEnd > loopStart ? loopEnd : buffer.duration;
      offset = loop ? a + ((offset + elapsed - a) % Math.max(.001, b - a)) : Math.min(buffer.duration, offset + elapsed);
    }
    playing = false; disconnectPlayback(); cancelAnimationFrame(raf); raf = 0;
    $('play').textContent = '▶ 播放'; setCursor(buffer ? offset / buffer.duration : 0); status('已停止');
  }
  function togglePlay() { playing ? stopPlayback() : startPlayback(); }

  function updateCursor() {
    if (!playing || !buffer || !ctx) return;
    const a = loopEnd > loopStart ? loopStart : 0, b = loopEnd > loopStart ? loopEnd : buffer.duration;
    let p = loop ? a + ((offset + ctx.currentTime - startAt - a) % Math.max(.001, b - a)) : offset + ctx.currentTime - startAt;
    if (!loop && p >= buffer.duration) { stopPlayback(); return; }
    setCursor(p / buffer.duration); raf = requestAnimationFrame(updateCursor);
  }

  function setCursor(p) {
    p = clamp(p, 0, 1);
    $('cursorIn').style.left = p * 100 + '%';
    $('cursorOut').style.left = p * 100 + '%';
    $('time').textContent = buffer ? `${(p * buffer.duration).toFixed(2)} / ${buffer.duration.toFixed(2)} s` : '0.00 / 0.00 s';
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) [re[i], re[j]] = [re[j], re[i]], [im[i], im[j]] = [im[j], im[i]];
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wc = Math.cos(a), ws = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0; const h = len >> 1;
        for (let j = 0; j < h; j++) {
          const x = i + j, y = x + h, vr = re[y] * wr - im[y] * wi, vi = re[y] * wi + im[y] * wr;
          re[y] = re[x] - vr; im[y] = im[x] - vi; re[x] += vr; im[x] += vi;
          const tr = wr * wc - wi * ws; wi = wr * ws + wi * wc; wr = tr;
        }
      }
    }
  }

  function drawInputSpectrogram() { if (!buffer) return; drawDifferenceOrInput(false, buffer, null); }

  function drawDifferenceOrInput(diff, inBuf, outBuf) {
    const canvas = diff ? $('specOut') : $('specIn'); if (!canvas || !inBuf) return;
    const rect = canvas.getBoundingClientRect(), W = Math.max(400, Math.round(rect.width)), H = Math.max(120, Math.round(rect.height)), dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr;
    const c = canvas.getContext('2d', { alpha: false }); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = '#02070a'; c.fillRect(0, 0, W, H);
    const a = inBuf.getChannelData(0), b = outBuf?.getChannelData(0), sr = inBuf.sampleRate, N = 1024, bins = N / 2;
    const reA = new Float32Array(N), imA = new Float32Array(N), reB = new Float32Array(N), imB = new Float32Array(N), img = c.createImageData(W, H), px = img.data;
    const last = Math.max(0, Math.min(a.length, b ? b.length : a.length) - N);
    for (let x = 0; x < W; x++) {
      const pos = Math.floor((x / Math.max(1, W - 1)) * last); reA.fill(0); imA.fill(0); if (b) { reB.fill(0); imB.fill(0); }
      for (let n = 0; n < N; n++) { const idx = pos + n, w = .5 - .5 * Math.cos(2 * Math.PI * n / (N - 1)); if (idx < a.length) reA[n] = a[idx] * w; if (b && idx < b.length) reB[n] = b[idx] * w; }
      fft(reA, imA); if (b) fft(reB, imB);
      for (let y = 0; y < H; y++) {
        const norm = 1 - y / Math.max(1, H - 1), f = 20 * Math.pow(1000, norm), k = clamp(Math.round(f * N / sr), 1, bins - 1), idx = (y * W + x) * 4;
        if (!b) {
          const m = Math.hypot(reA[k], imA[k]) / N, q = Math.pow(clamp((20 * Math.log10(m + 1e-8) + 86) / 72, 0, 1), .72);
          px[idx] = 12 + 220 * q; px[idx + 1] = 20 + 150 * q; px[idx + 2] = 24 + 120 * q; px[idx + 3] = 255;
        } else {
          const aa = Math.hypot(reA[k], imA[k]) + 1e-8, bb = Math.hypot(reB[k], imB[k]) + 1e-8, ch = 20 * Math.log10(bb / aa);
          if (Math.abs(ch) < .7) continue;
          const q = Math.pow(clamp(Math.abs(ch) / 12, 0, 1), .7);
          px[idx] = ch < 0 ? 40 + 180 * q : 210 * q; px[idx + 1] = ch < 0 ? 210 * q : 130 + 110 * q; px[idx + 2] = ch < 0 ? 210 * q : 35 + 65 * q; px[idx + 3] = 255;
        }
      }
    }
    c.putImageData(img, 0, 0);
  }

  function createOfflineStage(c) {
    return createStage(c);
  }

  function syncOfflineStage(s, b, c) {
    s.eq.frequency.value = b.freq; s.eq.Q.value = b.q; s.eq.gain.value = b.bypass ? 0 : b.gain;
    s.split.frequency.value = b.freq; s.split.Q.value = clamp(b.q, .25, 18);
    const dn = new AudioWorkletNode(c, 'myefx-denoise', { parameterData: { amount: b.bypass ? 0 : b.denoise } });
    s.dnIn.disconnect(); s.dnIn.connect(dn); dn.connect(s.dnSum);
    const tr = new AudioWorkletNode(c, 'myefx-transient', { parameterData: { punch: b.bypass ? 0 : b.punch, sustain: b.bypass ? 0 : b.sustain } });
    const mix = b.bypass ? 0 : Math.min(1, (Math.abs(b.punch) + Math.abs(b.sustain)) / 160);
    s.trDry.gain.value = 1 - mix; s.trWet.gain.value = mix; s.trWet.disconnect(); s.trWet.connect(tr); tr.connect(s.trSum);
  }

  function scheduleProcessedRender() {
    clearTimeout(renderTimer); if (!buffer) return; const token = ++renderToken;
    renderTimer = setTimeout(async () => {
      if (playing) return;
      try {
        const c = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        await c.audioWorklet.addModule('denoise-processor.js?v=rxgate3'); await c.audioWorklet.addModule('transient-processor.js?v=clean4');
        const stages = Array.from({ length: BAND_COUNT }, () => createOfflineStage(c));
        const master = c.createGain(); master.connect(c.destination);
        const src = c.createBufferSource(); src.buffer = buffer; let node = src;
        for (const s of stages) { node.connect(s.dryFull); node.connect(s.eq); node.connect(s.split); node = s.out; }
        node.connect(master);
        currentData().forEach((b, i) => syncOfflineStage(stages[i], b, c));
        src.start(0); const out = await c.startRendering();
        if (token === renderToken && !playing) { drawDifferenceOrInput(true, buffer, out); status('Spectrogram 已更新；未改動區域保持全黑。'); }
      } catch (e) { if (token === renderToken) status('Spectrogram 分析失敗：' + (e.message || e)); }
    }, 500);
  }

  function handleFile(file) {
    if (!file) return; stopPlayback(); buffer = null; renderToken++;
    status('讀取與解碼音檔…');
    file.arrayBuffer().then(x => ensureContext().decodeAudioData(x.slice(0))).then(b => {
      buffer = b; offset = 0; loopStart = 0; loopEnd = 0;
      $('fileInfo').textContent = `${file.name} · ${b.sampleRate} Hz · ${b.numberOfChannels} ch · ${b.duration.toFixed(2)} s`;
      $('dropUi').style.display = 'none'; drawInputSpectrogram(); setCursor(0); scheduleProcessedRender(); status('音檔已載入。');
    }).catch(e => { buffer = null; $('dropUi').style.display = ''; status('音檔載入失敗：' + (e.message || e)); });
  }

  function setRangeFromCanvas(which, x0, x1) {
    if (!buffer) return;
    const frame = $(which === 'in' ? 'inputFrame' : 'outputFrame'), rect = frame.getBoundingClientRect();
    const a = clamp(Math.min(x0, x1) / rect.width, 0, 1) * buffer.duration;
    const b = clamp(Math.max(x0, x1) / rect.width, 0, 1) * buffer.duration;
    if (b - a < .03) return;
    loopStart = a; loopEnd = b; loop = true; offset = a;
    $('loop').textContent = `LOOP ${a.toFixed(2)}–${b.toFixed(2)}s`; $('loop').classList.add('active');
    drawSelection(which, a / buffer.duration, b / buffer.duration); if (playing) restartAtCurrentPosition();
    status(`LOOP 範圍 ${a.toFixed(2)}–${b.toFixed(2)} s`);
  }

  function drawSelection(which, a, b) { const r = $(which === 'in' ? 'rangeIn' : 'rangeOut'); if (!r) return; r.style.left = (a * 100) + '%'; r.style.width = ((b - a) * 100) + '%'; r.classList.add('show'); }
  function clearSelection() { loopStart = loopEnd = 0; const a = $('rangeIn'), b = $('rangeOut'); if (a) a.classList.remove('show'); if (b) b.classList.remove('show'); }

  function bindRange(which) {
    const frame = $(which === 'in' ? 'inputFrame' : 'outputFrame'); let down = false, startX = 0;
    frame.addEventListener('pointerdown', e => { if (e.button !== 0 || !buffer) return; down = true; startX = e.clientX - frame.getBoundingClientRect().left; frame.setPointerCapture?.(e.pointerId); });
    frame.addEventListener('pointermove', e => { if (!down || !buffer) return; const r = frame.getBoundingClientRect(), x = clamp(e.clientX - r.left, 0, r.width), a = Math.min(startX, x) / r.width, b = Math.max(startX, x) / r.width; drawSelection(which, a, b); });
    frame.addEventListener('pointerup', e => { if (!down) return; down = false; setRangeFromCanvas(which, startX, e.clientX - frame.getBoundingClientRect().left); });
    frame.addEventListener('dblclick', e => { e.preventDefault(); clearSelection(); loop = false; $('loop').textContent = 'LOOP OFF'; $('loop').classList.remove('active'); status('已清除 LOOP 範圍'); });
  }

  function setDelta(i) {
    deltaBand = deltaBand === i ? 0 : i;
    document.querySelectorAll('[data-action="delta"]').forEach((b, idx) => { const on = deltaBand === idx + 1; b.classList.toggle('active', on); b.textContent = on ? 'DELTA ON' : 'DELTA'; });
    if (deltaBand) bypassAll = false;
    if (playing) restartAtCurrentPosition();
    status(deltaBand ? `DELTA B${deltaBand}：只聽被處理改變的內容` : 'DELTA 已關閉');
  }
  function toggleBypassAll() { bypassAll = !bypassAll; if (bypassAll) deltaBand = 0; $('bypassAll').textContent = bypassAll ? 'BYPASS ON' : 'BYPASS OFF'; $('bypassAll').classList.toggle('active', bypassAll); if (playing) restartAtCurrentPosition(); }
  function toggleLoop() { loop = !loop; if (!loop) clearSelection(); $('loop').textContent = loop ? (loopEnd > loopStart ? `LOOP ${loopStart.toFixed(2)}–${loopEnd.toFixed(2)}s` : 'LOOP ON') : 'LOOP OFF'; $('loop').classList.toggle('active', loop); if (playing) restartAtCurrentPosition(); }
  function toggleAB() { saveSlot(); const other = slot === 'A' ? 'B' : 'A'; applyData(other === 'A' ? slotA : slotB); slot = other; $('ab').textContent = 'A/B · ' + slot; saveSlot(); status('已切換到 Slot ' + slot); }

  function setupUI() {
    document.querySelectorAll('.knob').forEach(knob => {
      const id = knob.dataset.target, input = $(id); let lastY = 0;
      knob.addEventListener('pointerenter', () => renderKnob(input, true));
      knob.addEventListener('pointerleave', () => { if (!knob.hasPointerCapture?.(1)) renderKnob(input, false); });
      knob.addEventListener('pointerdown', e => { lastY = e.clientY; knob.classList.add('active'); knob.setPointerCapture?.(e.pointerId); renderKnob(input, true); });
      knob.addEventListener('pointermove', e => {
        if (!knob.hasPointerCapture?.(e.pointerId)) return;
        const key = id.replace(/[0-9]+$/, ''), stepPerPixel = knobDeltaPerPixel(key);
        setInput(input, Number(input.value) + (lastY - e.clientY) * stepPerPixel, true, true);
        lastY = e.clientY;
      });
      const done = e => { try { knob.releasePointerCapture?.(e.pointerId); } catch (_) {} knob.classList.remove('active'); renderKnob(input, false); };
      knob.addEventListener('pointerup', done); knob.addEventListener('pointercancel', done);
      knob.addEventListener('wheel', e => { e.preventDefault(); const key = id.replace(/[0-9]+$/, ''); setInput(input, Number(input.value) + (e.deltaY < 0 ? INFO[key].step : -INFO[key].step), true, true); }, { passive: false });
      knob.addEventListener('dblclick', () => setInput(input, Number(input.defaultValue)));
      knob.addEventListener('keydown', e => { const key = id.replace(/[0-9]+$/, ''); if (['ArrowUp','ArrowRight'].includes(e.key)) { e.preventDefault(); setInput(input, Number(input.value) + INFO[key].step); } else if (['ArrowDown','ArrowLeft'].includes(e.key)) { e.preventDefault(); setInput(input, Number(input.value) - INFO[key].step); } });
      input.addEventListener('input', () => { renderKnob(input, true); syncGraph(); saveSlot(); scheduleProcessedRender(); });
    });

    $('file').addEventListener('change', e => handleFile(e.target.files?.[0]));
    const frame = $('inputFrame');
    ['dragenter','dragover'].forEach(t => frame.addEventListener(t, e => { e.preventDefault(); e.stopPropagation(); }));
    frame.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); handleFile(e.dataTransfer.files?.[0]); });
    $('play').addEventListener('click', togglePlay); $('stop').addEventListener('click', stopPlayback); $('loop').addEventListener('click', toggleLoop); $('bypassAll').addEventListener('click', toggleBypassAll); $('ab').addEventListener('click', toggleAB); $('sortBtn').addEventListener('click', sortBands); $('resetAll').addEventListener('click', resetAll); $('resetBands').addEventListener('click', resetAll);
    document.querySelectorAll('.band').forEach(card => { const i = Number(card.dataset.band); card.querySelector('[data-action="bypass"]').addEventListener('click', () => { const b = $('byp' + i); setBandBypass(i, !b.classList.contains('on')); }); card.querySelector('[data-action="delta"]').addEventListener('click', () => setDelta(i)); card.querySelector('[data-action="reset"]').addEventListener('click', () => resetBand(i)); });
    bindRange('in'); bindRange('out');
    window.addEventListener('keydown', e => { if (e.code !== 'Space' || e.repeat) return; const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; e.preventDefault(); togglePlay(); });
    window.addEventListener('resize', () => { drawInputSpectrogram(); if (buffer) scheduleProcessedRender(); });
  }

  setupUI();
})();
