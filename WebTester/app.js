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
  const FULL_RANGE_TRAVEL_PX = 240;
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cloneData = d => d.map(x => ({ ...x }));

  let ctx = null, buffer = null, source = null, graph = null;
  let playing = false, loop = false, bypassAll = false;
  let offset = 0, startAt = 0, raf = 0;
  let deltaBand = 0, loopStart = 0, loopEnd = 0;
  let renderTimer = 0, renderToken = 0;
  let slot = 'A', slotA = cloneData(DEFAULTS), slotB = cloneData(DEFAULTS);
  let rangeDrag = null;

  function status(t) { const e = $('status'); if (e) e.textContent = t; }
  function currentData() {
    return Array.from({ length: BAND_COUNT }, (_, n) => {
      const i = n + 1;
      return {
        freq: Number($('freq' + i).value), gain: Number($('gain' + i).value), q: Number($('q' + i).value),
        denoise: Number($('denoise' + i).value), punch: Number($('punch' + i).value), sustain: Number($('sustain' + i).value),
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
    const key = input.id.replace(/[0-9]+$/, ''), d = INFO[key], v = Number(input.value);
    const knob = document.querySelector(`.knob[data-target="${input.id}"]`); if (!knob) return;
    const angle = -135 + 270 * ((v - d.min) / (d.max - d.min));
    const p = knob.querySelector('.knob-pointer'); if (p) p.style.transform = `translateX(-50%) rotate(${angle}deg)`;
    const out = $(input.id + 'Out'); if (out) { out.textContent = formatValue(key, v); out.classList.toggle('show', reveal); }
  }
  function setInput(input, value, trigger = true, reveal = true) {
    const key = input.id.replace(/[0-9]+$/, ''), d = INFO[key];
    const decimals = (String(d.step).split('.')[1] || '').length;
    let v = clamp(value, d.min, d.max);
    v = Number((Math.round(v / d.step) * d.step).toFixed(decimals));
    input.value = String(v); renderKnob(input, reveal);
    if (trigger) input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function knobDeltaPerPixel(key) { const d = INFO[key]; return (d.max - d.min) / FULL_RANGE_TRAVEL_PX; }
  function setBandBypass(i, on, update = true) {
    const b = $('byp' + i); if (!b) return;
    b.classList.toggle('on', on); b.classList.toggle('off', !on);
    const s = document.querySelector(`.band[data-band="${i}"] .state`); if (s) s.textContent = on ? 'ON' : 'BYP';
    if (update) { syncGraph(); saveSlot(); scheduleProcessedRender(); }
  }
  function applyData(data) {
    for (let i = 1; i <= BAND_COUNT; i++) {
      const b = data[i - 1] || DEFAULTS[i - 1];
      for (const k of Object.keys(INFO)) { const input = $(k + i); if (input) { input.value = String(clamp(Number(b[k]), INFO[k].min, INFO[k].max)); renderKnob(input); } }
      setBandBypass(i, !b.bypass, false);
    }
    syncGraph(); scheduleProcessedRender();
  }
  function resetAll() { applyData(cloneData(DEFAULTS)); saveSlot(); status('所有 Sections 已重設。'); }
  function resetBand(i) { const d = currentData(); d[i - 1] = { ...DEFAULTS[i - 1] }; applyData(d); saveSlot(); status(`SECTION ${i} 已重設。`); }
  function sortBands() { const d = currentData().sort((a, b) => a.freq - b.freq); applyData(d); saveSlot(); status('Sections 已依頻率排序。'); }
  function ensureContext() { if (!ctx || ctx.state === 'closed') ctx = new AudioContext(); return ctx; }

  // Four independent parallel Sections. Each Section compares the same band before/after processing.
  // Normal output: original full-band + Σ(WetBand - DryBand).
  // DELTA: only one selected (WetBand - DryBand).
  async function ensureGraph() {
    const c = ensureContext();
    if (!c.audioWorklet) throw new Error('瀏覽器不支援 AudioWorklet');
    if (!graph) {
      await c.audioWorklet.addModule('denoise-processor.js?v=rewrite2');
      await c.audioWorklet.addModule('transient-processor.js?v=rewrite2');
      const master = c.createGain();
      const dryMaster = c.createGain();
      dryMaster.connect(master); master.connect(c.destination);
      const stages = [];
      for (let i = 0; i < BAND_COUNT; i++) {
        const band = c.createBiquadFilter(); band.type = 'bandpass';
        const eq = c.createBiquadFilter(); eq.type = 'peaking';
        const denoise = new AudioWorkletNode(c, 'myefx-denoise', { parameterData: { amount: 0 } });
        const transient = new AudioWorkletNode(c, 'myefx-transient', { parameterData: { punch: 0, sustain: 0 } });
        const wet = c.createGain();
        const dry = c.createGain();
        const invert = c.createGain(); invert.gain.value = -1;
        const change = c.createGain();
        const normalGain = c.createGain();
        const deltaGain = c.createGain();
        dry.connect(invert); invert.connect(change);
        band.connect(dry); band.connect(eq); eq.connect(denoise); denoise.connect(transient); transient.connect(wet); wet.connect(change);
        change.connect(normalGain); normalGain.connect(master);
        change.connect(deltaGain); deltaGain.connect(master);
        stages.push({ band, eq, denoise, transient, wet, dry, invert, change, normalGain, deltaGain });
      }
      graph = { master, dryMaster, stages };
    }
    syncGraph();
    return graph;
  }

  function syncGraph() {
    if (!graph || !ctx) return;
    const now = ctx.currentTime;
    currentData().forEach((b, i) => {
      const s = graph.stages[i];
      s.band.frequency.setTargetAtTime(b.freq, now, .003);
      s.band.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .003);
      s.eq.frequency.setTargetAtTime(b.freq, now, .003);
      s.eq.Q.setTargetAtTime(clamp(b.q, .25, 18), now, .003);
      s.eq.gain.setTargetAtTime(b.gain, now, .003);
      s.denoise.parameters.get('amount')?.setTargetAtTime(b.denoise, now, .003);
      s.transient.parameters.get('punch')?.setTargetAtTime(b.punch, now, .003);
      s.transient.parameters.get('sustain')?.setTargetAtTime(b.sustain, now, .003);
      s.denoise.port.postMessage({ type: 'band', freq: b.freq, q: b.q });
      s.transient.port.postMessage({ type: 'band', freq: b.freq, q: b.q });
      const normal = (!bypassAll && !deltaBand && !b.bypass) ? 1 : 0;
      const monitor = (!bypassAll && deltaBand === i + 1 && !b.bypass) ? 1 : 0;
      s.normalGain.gain.setTargetAtTime(normal, now, .003);
      s.deltaGain.gain.setTargetAtTime(monitor, now, .003);
    });
    graph.dryMaster.gain.setTargetAtTime(bypassAll || deltaBand ? (bypassAll ? 1 : 0) : 1, now, .003);
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
    const a = loopEnd > loopStart ? loopStart : 0, b = loopEnd > loopStart ? loopEnd : buffer.duration;
    source.loop = loop; source.loopStart = a; source.loopEnd = b;
    source.connect(graph.dryMaster);
    graph.stages.forEach(s => source.connect(s.band));
    syncGraph();
  }
  async function startPlayback() {
    if (!buffer) return status('請先載入音檔。');
    try {
      const c = ensureContext(); await c.resume(); await ensureGraph();
      connectPlayback(); startAt = c.currentTime;
      const a = loopEnd > loopStart ? loopStart : 0;
      source.start(0, clamp(loop ? Math.max(a, offset) : offset, 0, Math.max(0, buffer.duration - .001)));
      playing = true; $('play').textContent = '❚❚ 停止';
      status(deltaBand ? `DELTA SECTION ${deltaBand}：只聽該頻帶 Wet−Dry 異動` : loop ? 'LOOP 播放中' : '播放中');
      updateCursor();
    } catch (e) { playing = false; status('播放失敗：' + (e.message || e)); console.error(e); }
  }
  function restartAtCurrentPosition() {
    if (!playing || !ctx || !buffer) return;
    const elapsed = Math.max(0, ctx.currentTime - startAt);
    const a = loopEnd > loopStart ? loopStart : 0, b = loopEnd > loopStart ? loopEnd : buffer.duration;
    offset = loop ? a + ((offset + elapsed - a) % Math.max(.001, b - a)) : Math.min(buffer.duration, offset + elapsed);
    connectPlayback(); startAt = ctx.currentTime; source.start(0, offset);
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
    const p = loop ? a + ((offset + ctx.currentTime - startAt - a) % Math.max(.001, b - a)) : offset + ctx.currentTime - startAt;
    if (!loop && p >= buffer.duration) return stopPlayback();
    setCursor(p / buffer.duration); raf = requestAnimationFrame(updateCursor);
  }
  function setCursor(p) { p = clamp(p, 0, 1); $('cursorIn').style.left = p * 100 + '%'; $('cursorOut').style.left = p * 100 + '%'; $('time').textContent = buffer ? `${(p * buffer.duration).toFixed(2)} / ${buffer.duration.toFixed(2)} s` : '0.00 / 0.00 s'; }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wc = Math.cos(ang), ws = Math.sin(ang);
      for (let i = 0; i < n; i += len) { let wr = 1, wi = 0, h = len >> 1; for (let j = 0; j < h; j++) { const x = i + j, y = x + h, vr = re[y] * wr - im[y] * wi, vi = re[y] * wi + im[y] * wr; re[y] = re[x] - vr; im[y] = im[x] - vi; re[x] += vr; im[x] += vi; const tr = wr * wc - wi * ws; wi = wr * ws + wi * wc; wr = tr; } }
    }
  }
  function drawInputSpectrogram() { if (buffer) drawSpectrogram($('specIn'), false); }
  function drawSpectrogram(canvas, processed) {
    if (!buffer) return;
    const w = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio)), h = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
    canvas.width = w; canvas.height = h;
    const c = canvas.getContext('2d'); c.fillStyle = '#02070a'; c.fillRect(0, 0, w, h);
    const src = buffer.getChannelData(0), N = 1024, bins = N / 2, cols = Math.min(900, w), hop = Math.max(1, Math.floor(src.length / Math.max(1, cols - 1)));
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let x = 0; x < cols; x++) {
      const start = Math.min(x * hop, Math.max(0, src.length - N));
      for (let n = 0; n < N; n++) { const win = .5 - .5 * Math.cos(2 * Math.PI * n / (N - 1)); re[n] = src[start + n] * win; im[n] = 0; }
      fft(re, im);
      for (let y = 0; y < h; y++) {
        const k = clamp(Math.floor((1 - y / h) * bins), 1, bins - 1), hz = k * buffer.sampleRate / N;
        const db = 20 * Math.log10(Math.hypot(re[k], im[k]) / N + 1e-10);
        const strength = processed ? changeStrength(hz) : 1;
        if (processed && strength < .003) continue;
        const v = clamp((db + 90) / 75, 0, 1) * strength;
        if (v < .004) continue;
        const q = Math.round(v * 255); c.fillStyle = `rgb(${q},${Math.min(255, q + 25)},${Math.min(255, q + 45)})`;
        c.fillRect(Math.floor(x * w / cols), y, Math.ceil(w / cols) + 1, 1);
      }
    }
  }
  function bandWeight(hz, b) { const oct = Math.log2(Math.max(.001, hz) / Math.max(20, b.freq)); const width = .35 + 2 / Math.max(.25, b.q); return Math.exp(-Math.pow(oct / width, 2)); }
  function changeStrength(hz) {
    let s = 0;
    for (const b of currentData()) {
      if (b.bypass) continue;
      const w = bandWeight(hz, b);
      const eq = Math.abs(Math.pow(10, b.gain / 20) - 1) * w;
      const dn = (b.denoise / 100) * .8 * w;
      const tr = (Math.abs(b.punch) + Math.abs(b.sustain)) / 200 * .55 * w;
      s += eq + dn + tr;
    }
    return clamp(s, 0, 1);
  }
  function scheduleProcessedRender() { clearTimeout(renderTimer); if (!buffer) return; const token = ++renderToken; renderTimer = setTimeout(() => { if (token !== renderToken) return; drawSpectrogram($('specOut'), true); }, 80); }

  async function loadFile(file) {
    if (!file) return;
    try {
      stopPlayback(); const c = ensureContext(); const data = await file.arrayBuffer(); const decoded = await c.decodeAudioData(data);
      buffer = decoded; offset = 0; loop = false; loopStart = loopEnd = 0; deltaBand = 0;
      $('fileInfo').textContent = `${file.name} · ${decoded.sampleRate} Hz · ${decoded.numberOfChannels} ch · ${decoded.duration.toFixed(2)} s`;
      $('dropUi').style.display = 'none'; setCursor(0); clearRangeUI(); updateDeltaUI(); drawInputSpectrogram(); scheduleProcessedRender(); status('音檔已載入。');
    } catch (e) { buffer = null; $('dropUi').style.display = ''; status('音檔載入失敗：' + (e.message || e)); console.error(e); }
  }
  function clearRangeUI() { ['rangeIn', 'rangeOut'].forEach(id => $(id)?.classList.remove('show')); }
  function drawSelection(which, a, b) { const r = $(which === 'in' ? 'rangeIn' : 'rangeOut'); if (!r) return; r.style.left = a * 100 + '%'; r.style.width = (b - a) * 100 + '%'; r.classList.add('show'); }
  function rangeX(frame, e) { const r = frame.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); }
  function bindRange(which) {
    const frame = $(which === 'in' ? 'inputFrame' : 'outputFrame');
    frame.addEventListener('pointerdown', e => { if (e.button !== 0 || !buffer || e.target.closest('.drop-card')) return; rangeDrag = { which, start: rangeX(frame, e) }; frame.setPointerCapture?.(e.pointerId); });
    frame.addEventListener('pointermove', e => { if (!rangeDrag || rangeDrag.which !== which) return; const x = rangeX(frame, e), a = Math.min(rangeDrag.start, x), b = Math.max(rangeDrag.start, x); drawSelection(which, a, b); });
    frame.addEventListener('pointerup', e => {
      if (!rangeDrag || rangeDrag.which !== which) return;
      const x = rangeX(frame, e), a = Math.min(rangeDrag.start, x), b = Math.max(rangeDrag.start, x); rangeDrag = null;
      if (b - a < .01) return clearRangeUI();
      loopStart = a * buffer.duration; loopEnd = b * buffer.duration; loop = true; offset = loopStart;
      $('loop').textContent = `LOOP ${loopStart.toFixed(2)}–${loopEnd.toFixed(2)}s`; $('loop').classList.add('active');
      drawSelection('in', a, b); drawSelection('out', a, b); if (playing) restartAtCurrentPosition();
      status(`LOOP 範圍 ${loopStart.toFixed(2)}–${loopEnd.toFixed(2)} s`);
    });
    frame.addEventListener('pointercancel', () => { rangeDrag = null; });
    frame.addEventListener('dblclick', e => { e.preventDefault(); loop = false; loopStart = loopEnd = 0; clearRangeUI(); $('loop').textContent = 'LOOP OFF'; $('loop').classList.remove('active'); status('已清除 LOOP 範圍'); if (playing) restartAtCurrentPosition(); });
  }

  function updateDeltaUI() {
    document.querySelectorAll('[data-action="delta"]').forEach((b, idx) => { const on = deltaBand === idx + 1; b.classList.toggle('active', on); b.textContent = on ? 'DELTA ON' : 'DELTA'; });
    if (deltaBand) bypassAll = false;
    if (graph) syncGraph();
    if (playing) { /* graph values update without rebuilding the source */ }
    status(deltaBand ? `DELTA SECTION ${deltaBand}：只聽該頻帶 Wet−Dry 異動` : (buffer ? '音檔已載入。' : '尚未載入音檔。'));
  }
  function toggleBypassAll() {
    bypassAll = !bypassAll; if (bypassAll) deltaBand = 0;
    $('bypassAll').textContent = bypassAll ? 'BYPASS ON' : 'BYPASS OFF'; $('bypassAll').classList.toggle('active', bypassAll);
    updateDeltaUI();
  }
  function toggleLoop() {
    loop = !loop; if (!loop) { loopStart = loopEnd = 0; clearRangeUI(); } else if (buffer && loopEnd <= loopStart) { loopStart = 0; loopEnd = buffer.duration; drawSelection('in', 0, 1); drawSelection('out', 0, 1); }
    $('loop').textContent = loop ? (loopEnd > loopStart ? `LOOP ${loopStart.toFixed(2)}–${loopEnd.toFixed(2)}s` : 'LOOP ON') : 'LOOP OFF'; $('loop').classList.toggle('active', loop); if (playing) restartAtCurrentPosition();
  }
  function toggleAB() { saveSlot(); const other = slot === 'A' ? 'B' : 'A'; slot = other; applyData(other === 'A' ? slotA : slotB); $('ab').textContent = 'A/B · ' + slot; status('已切換到 Slot ' + slot); }

  function setupUI() {
    document.querySelectorAll('.knob').forEach(knob => {
      const id = knob.dataset.target, input = $(id); let lastY = 0;
      knob.addEventListener('pointerenter', () => renderKnob(input, true));
      knob.addEventListener('pointerleave', () => { if (!knob.hasPointerCapture?.()) renderKnob(input, false); });
      knob.addEventListener('pointerdown', e => { e.preventDefault(); lastY = e.clientY; knob.classList.add('active'); knob.setPointerCapture?.(e.pointerId); renderKnob(input, true); });
      knob.addEventListener('pointermove', e => { if (!knob.hasPointerCapture?.(e.pointerId)) return; const key = id.replace(/[0-9]+$/, ''); setInput(input, Number(input.value) + (lastY - e.clientY) * knobDeltaPerPixel(key), true, true); lastY = e.clientY; });
      const done = e => { try { knob.releasePointerCapture?.(e.pointerId); } catch (_) {} knob.classList.remove('active'); renderKnob(input, false); };
      knob.addEventListener('pointerup', done); knob.addEventListener('pointercancel', done);
      knob.addEventListener('wheel', e => { e.preventDefault(); const key = id.replace(/[0-9]+$/, ''); setInput(input, Number(input.value) + (e.deltaY < 0 ? 1 : -1) * knobDeltaPerPixel(key) * 6, true, true); }, { passive: false });
      knob.addEventListener('dblclick', () => setInput(input, Number(input.defaultValue)));
    });
    $('file').addEventListener('change', e => loadFile(e.target.files?.[0]));
    $('dropUi').addEventListener('dragover', e => e.preventDefault()); $('dropUi').addEventListener('drop', e => { e.preventDefault(); loadFile(e.dataTransfer?.files?.[0]); });
    $('inputFrame').addEventListener('dragover', e => e.preventDefault()); $('inputFrame').addEventListener('drop', e => { e.preventDefault(); loadFile(e.dataTransfer?.files?.[0]); });
    $('play').addEventListener('click', togglePlay); $('stop').addEventListener('click', stopPlayback); $('loop').addEventListener('click', toggleLoop); $('bypassAll').addEventListener('click', toggleBypassAll); $('ab').addEventListener('click', toggleAB);
    $('sortBtn').addEventListener('click', sortBands); $('resetAll').addEventListener('click', resetAll); $('resetBands').addEventListener('click', resetAll);
    document.querySelectorAll('.band').forEach(card => {
      const i = Number(card.dataset.band);
      card.querySelector('[data-action="bypass"]').addEventListener('click', () => setBandBypass(i, !$('byp' + i).classList.contains('on')));
      card.querySelector('[data-action="delta"]').addEventListener('click', () => { deltaBand = deltaBand === i ? 0 : i; updateDeltaUI(); });
      card.querySelector('[data-action="reset"]').addEventListener('click', () => resetBand(i));
    });
    bindRange('in'); bindRange('out');
    window.addEventListener('keydown', e => { if (e.code !== 'Space' || e.repeat) return; const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; e.preventDefault(); togglePlay(); });
    window.addEventListener('resize', () => { if (buffer) { drawInputSpectrogram(); scheduleProcessedRender(); } });
    document.querySelectorAll('.knob-input').forEach(renderKnob);
  }

  window.myEFX = { loadFile, togglePlay, stopPlayback, currentData };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupUI, { once: true }); else setupUI();
})();
