(() => {
  'use strict';

  const N = 4;
  const DEFAULTS = [31.5, 125, 1000, 8000].map(freq => ({ freq, gain: 0, q: 1, denoise: 0, punch: 0, sustain: 0, bypass: false }));
  const LIMITS = {
    freq: [20, 20000, 0.1], gain: [-24, 24, 0.1], q: [0.1, 20, 0.01],
    denoise: [0, 100, 1], punch: [-100, 100, 1], sustain: [-100, 100, 1]
  };
  const $ = id => document.getElementById(id);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const clone = a => a.map(x => ({ ...x }));

  let ctx = null, buffer = null, source = null, graph = null;
  let playing = false, offset = 0, startedAt = 0, raf = 0;
  let loop = false, loopStart = 0, loopEnd = 0, delta = 0, allBypass = false;
  let ab = 'A', slotA = clone(DEFAULTS), slotB = clone(DEFAULTS);
  let drag = null, renderTimer = 0, graphMode = '';

  function status(s) { if ($('status')) $('status').textContent = s; }
  function data() {
    return Array.from({ length: N }, (_, i) => {
      const k = i + 1;
      return { freq: +$('freq' + k).value, gain: +$('gain' + k).value, q: +$('q' + k).value,
        denoise: +$('denoise' + k).value, punch: +$('punch' + k).value, sustain: +$('sustain' + k).value,
        bypass: !$('byp' + k).classList.contains('on') };
    });
  }
  function saveSlot() { if (ab === 'A') slotA = data(); else slotB = data(); }
  function fmt(key, v) {
    if (key === 'freq') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : (v % 1 ? v.toFixed(1) : v.toFixed(0)) + ' Hz';
    if (key === 'gain') return v.toFixed(1) + ' dB';
    if (key === 'q') return v.toFixed(2);
    return Math.round(v) + '%';
  }
  function drawKnob(input, show = false) {
    const key = input.id.replace(/\d+$/, ''), [min, max] = LIMITS[key], v = +input.value;
    const knob = document.querySelector(`.knob[data-target="${input.id}"]`); if (!knob) return;
    const p = knob.querySelector('.knob-pointer'); if (p) p.style.transform = `translateX(-50%) rotate(${-135 + 270 * (v - min) / (max - min)}deg)`;
    const r = $(input.id + 'Out'); if (r) { r.textContent = fmt(key, v); r.classList.toggle('show', show); }
  }
  function setKnob(input, value, show = true) {
    const key = input.id.replace(/\d+$/, ''), [min, max, step] = LIMITS[key];
    const d = (String(step).split('.')[1] || '').length;
    input.value = clamp(Math.round(clamp(+value, min, max) / step) * step, min, max).toFixed(d);
    drawKnob(input, show); input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function setBypass(i, on, update = true) {
    const b = $('byp' + i); b.classList.toggle('on', on); b.classList.toggle('off', !on);
    const st = document.querySelector(`.band[data-band="${i}"] .state`); if (st) st.textContent = on ? 'ON' : 'BYP';
    if (update) { saveSlot(); sync(); renderProcessedSoon(); }
  }
  function apply(a, save = false) {
    for (let i = 1; i <= N; i++) {
      const b = a[i - 1] || DEFAULTS[i - 1];
      for (const key of Object.keys(LIMITS)) {
        const input = $(key + i); input.value = String(clamp(+b[key], LIMITS[key][0], LIMITS[key][1])); drawKnob(input, false);
      }
      setBypass(i, !b.bypass, false);
    }
    if (save) saveSlot(); sync(); renderProcessedSoon();
  }

  function resetAll() {
    delta = 0; allBypass = false; $('bypassAll').classList.remove('active'); $('bypassAll').textContent = 'BYPASS OFF';
    apply(clone(DEFAULTS), true); updateDelta(); status('所有 Sections 已重設。');
  }
  function resetBand(i) { const a = data(); a[i - 1] = { ...DEFAULTS[i - 1] }; apply(a, true); status('SECTION ' + i + ' 已重設。'); }
  function sortBands() { apply(data().sort((a, b) => a.freq - b.freq), true); status('Sections 已依頻率排序。'); }

  function ensureCtx() { if (!ctx || ctx.state === 'closed') ctx = new AudioContext(); return ctx; }

  // 固定串接：source -> dryBus；source -> Section BandPass -> (dry | EQ -> dynamic processor) -> Wet-Dry changeBus.
  // 正常：原始完整訊號 + 每段 change。DELTA：僅指定 Section change。其他 Section 永遠不進 DELTA。
  function makeStage() {
    const c = ensureCtx();
    const band = c.createBiquadFilter(); band.type = 'bandpass';
    const eq = c.createBiquadFilter(); eq.type = 'peaking';
    const dry = c.createGain();
    const neg = c.createGain(); neg.gain.value = -1;
    const change = c.createGain();
    const normal = c.createGain(); const deltaGate = c.createGain();
    const proc = c.createScriptProcessor(512, 2, 2);
    const state = { dFast: 0, dSlow: 0, dNoise: 1e-5, dGain: 1, dOpen: true, tFast: 0, tSlow: 0, settings: DEFAULTS[0] };

    proc.onaudioprocess = e => {
      const inp = e.inputBuffer, out = e.outputBuffer, s = state, b = s.settings || DEFAULTS[0];
      const frames = out.length, ch = Math.min(inp.numberOfChannels, out.numberOfChannels);
      const amount = clamp(+b.denoise || 0, 0, 100) / 100;
      const punch = (+b.punch || 0) / 100, sustain = (+b.sustain || 0) / 100;
      for (let i = 0; i < frames; i++) {
        let peak = 0;
        for (let c = 0; c < ch; c++) peak = Math.max(peak, Math.abs(inp.getChannelData(c)[i]));
        let dg = 1;
        if (amount > 0.0001) {
          s.dFast += (peak - s.dFast) * 0.24; s.dSlow += (peak - s.dSlow) * 0.018;
          const quiet = s.dFast <= s.dSlow * 1.15, nr = quiet ? 0.02 : 0.004;
          s.dNoise += (s.dFast - s.dNoise) * nr; s.dNoise = Math.max(1e-7, s.dNoise);
          const snr = s.dFast / s.dNoise, openT = 2.15, closeT = 1.65;
          if (s.dOpen ? snr < closeT : snr > openT) s.dOpen = !s.dOpen;
          const lo = Math.log10(closeT), hi = Math.log10(openT), x = Math.log10(Math.max(snr, 1e-6));
          let p = clamp((x - lo) / (hi - lo), 0, 1); p = p * p * (3 - 2 * p); if (!s.dOpen) p *= 0.35;
          const red = 18 * amount * (1 - p), target = Math.pow(10, -red / 20);
          s.dGain += (target - s.dGain) * (target < s.dGain ? 0.28 : 0.065); s.dGain = clamp(s.dGain, Math.pow(10, -18 * amount / 20), 1);
          dg = s.dGain;
        } else { dg = 1; }

        let tg = 1;
        if (Math.abs(punch) > 0.0001 || Math.abs(sustain) > 0.0001) {
          const smp = peak * dg; s.tFast += (smp - s.tFast) * 0.28; s.tSlow += (smp - s.tSlow) * 0.018;
          const tr = clamp((s.tFast - s.tSlow) / Math.max(s.tFast, 1e-5), 0, 1), sr = clamp(s.tSlow / Math.max(s.tFast, 1e-5), 0, 1);
          tg = clamp((1 + punch * 0.85 * tr) * (1 + sustain * 0.45 * sr), 0.05, 2.25);
        }
        for (let c = 0; c < ch; c++) out.getChannelData(c)[i] = inp.getChannelData(c)[i] * dg * tg;
        for (let c = ch; c < out.numberOfChannels; c++) out.getChannelData(c)[i] = 0;
      }
    };
    return { band, eq, dry, neg, change, normal, deltaGate, proc, state };
  }

  function buildGraph() {
    const c = ensureCtx();
    const master = c.createGain(), analyser = c.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.05; master.connect(analyser); analyser.connect(c.destination);
    const dryBus = c.createGain(), normalBus = c.createGain(), deltaBus = c.createGain();
    const dryMaster = c.createGain(), normalMaster = c.createGain(), deltaMaster = c.createGain();
    dryBus.connect(dryMaster); dryMaster.connect(master); normalBus.connect(normalMaster); normalMaster.connect(master); deltaBus.connect(deltaMaster); deltaMaster.connect(master);
    const stages = [];
    for (let i = 0; i < N; i++) {
      const s = makeStage();
      s.band.connect(s.dry); s.dry.connect(s.neg); s.neg.connect(s.change);
      s.band.connect(s.eq); s.eq.connect(s.proc); s.proc.connect(s.change);
      s.change.connect(s.normal); s.normal.connect(normalBus); s.change.connect(s.deltaGate); s.deltaGate.connect(deltaBus);
      stages.push(s);
    }
    graph = { master, analyser, dryBus, normalBus, deltaBus, dryMaster, normalMaster, deltaMaster, stages };
    graphMode = 'ScriptProcessor'; sync(); return graph;
  }
  function ensureGraph() { if (!graph) buildGraph(); return Promise.resolve(graph); }

  function sync() {
    if (!graph || !ctx) return;
    const now = ctx.currentTime, a = data();
    graph.stages.forEach((s, i) => {
      const b = a[i]; s.state.settings = b;
      s.band.frequency.setTargetAtTime(b.freq, now, 0.003); s.band.Q.setTargetAtTime(clamp(b.q, 0.25, 18), now, 0.003);
      s.eq.frequency.setTargetAtTime(b.freq, now, 0.003); s.eq.Q.setTargetAtTime(clamp(b.q, 0.25, 18), now, 0.003); s.eq.gain.setTargetAtTime(b.gain, now, 0.003);
      const active = !allBypass && !b.bypass;
      s.normal.gain.setTargetAtTime(active && !delta ? 1 : 0, now, 0.003);
      s.deltaGate.gain.setTargetAtTime(active && delta === i + 1 ? 1 : 0, now, 0.003);
    });
    graph.dryMaster.gain.setTargetAtTime(allBypass || !delta ? 1 : 0, now, 0.003);
    graph.normalMaster.gain.setTargetAtTime(allBypass || delta ? 0 : 1, now, 0.003);
    graph.deltaMaster.gain.setTargetAtTime(allBypass ? 0 : (delta ? 1 : 0), now, 0.003);
  }

  function disconnectSource() { if (!source) return; try { source.stop(); } catch (_) {} try { source.disconnect(); } catch (_) {} source = null; }
  function loopBounds() { return buffer && loopEnd > loopStart ? [loopStart, loopEnd] : [0, buffer ? buffer.duration : 0]; }
  function connectSource() {
    disconnectSource(); source = ctx.createBufferSource(); source.buffer = buffer; source.loop = loop;
    const [a, b] = loopBounds(); if (b > a) { source.loopStart = a; source.loopEnd = b; }
    source.connect(graph.dryBus); graph.stages.forEach(s => source.connect(s.band)); sync();
  }
  async function start() {
    if (!buffer) return status('請先載入音檔。');
    try {
      const c = ensureCtx(); await c.resume(); await ensureGraph(); connectSource();
      const [a, b] = loopBounds(); offset = loop ? clamp(offset, a, Math.max(a, b - 0.001)) : clamp(offset, 0, Math.max(0, buffer.duration - 0.001));
      startedAt = c.currentTime; source.start(0, offset); playing = true; $('play').textContent = '❚❚ 停止'; status(delta ? `DELTA SECTION ${delta}：只聽 Wet−Dry` : (loop ? 'LOOP 播放中' : '播放中')); tick();
    } catch (e) { playing = false; disconnectSource(); status('播放失敗：' + (e?.message || e)); console.error(e); }
  }
  function stop() {
    if (playing && ctx && buffer) { const el = Math.max(0, ctx.currentTime - startedAt), [a, b] = loopBounds(); offset = loop && b > a ? a + ((offset + el - a) % (b - a) + (b - a)) % (b - a) : clamp(offset + el, 0, buffer.duration); }
    playing = false; disconnectSource(); cancelAnimationFrame(raf); raf = 0; $('play').textContent = '▶ 播放'; cursor(offset / (buffer?.duration || 1)); status('已停止');
  }
  function togglePlay() { playing ? stop() : start(); }
  function tick() {
    if (!playing || !buffer || !ctx) return;
    const el = Math.max(0, ctx.currentTime - startedAt), [a, b] = loopBounds();
    const pos = loop && b > a ? a + ((offset + el - a) % (b - a) + (b - a)) % (b - a) : offset + el;
    if (!loop && pos >= buffer.duration) return stop();
    cursor(pos / buffer.duration); raf = requestAnimationFrame(tick);
  }
  function cursor(p) { p = clamp(p, 0, 1); if ($('cursorIn')) $('cursorIn').style.left = p * 100 + '%'; if ($('cursorOut')) $('cursorOut').style.left = p * 100 + '%'; $('time').textContent = buffer ? `${(p * buffer.duration).toFixed(2)} / ${buffer.duration.toFixed(2)} s` : '0.00 / 0.00 s'; }

  function fft(re, im) {
    for (let i = 1, j = 0; i < re.length; i++) { let bit = re.length >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= re.length; len <<= 1) { const a = -2 * Math.PI / len, c = Math.cos(a), s = Math.sin(a); for (let i = 0; i < re.length; i += len) { let wr = 1, wi = 0; for (let j = 0; j < len / 2; j++) { const x = i + j, y = x + len / 2, vr = re[y] * wr - im[y] * wi, vi = re[y] * wi + im[y] * wr; re[y] = re[x] - vr; im[y] = im[x] - vi; re[x] += vr; im[x] += vi; const nr = wr * c - wi * s; wi = wr * s + wi * c; wr = nr; } } }
  }
  function strength(hz) {
    let z = 0; for (const b of data()) { if (b.bypass) continue; const o = Math.log2(Math.max(20, hz) / Math.max(20, b.freq)), w = 0.35 + 2 / Math.max(0.25, b.q), g = Math.exp(-Math.pow(o / w, 2)); z += Math.abs(Math.pow(10, b.gain / 20) - 1) * g + 0.8 * b.denoise / 100 * g + 0.55 * (Math.abs(b.punch) + Math.abs(b.sustain)) / 200 * g; } return clamp(z, 0, 1);
  }
  function spectro(canvas, processed, h) {
    if (!buffer || !canvas) return; const w = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio)), hh = Math.max(1, Math.floor((h || canvas.clientHeight) * devicePixelRatio)); canvas.width = w; canvas.height = hh;
    const g = canvas.getContext('2d'); g.fillStyle = '#02070a'; g.fillRect(0, 0, w, hh); const x = buffer.getChannelData(0), M = 1024, bins = M / 2, cols = Math.min(700, w), hop = Math.max(1, Math.floor(x.length / Math.max(1, cols - 1))), re = new Float64Array(M), im = new Float64Array(M);
    for (let col = 0; col < cols; col++) { const start = Math.min(col * hop, Math.max(0, x.length - M)); for (let n = 0; n < M; n++) { re[n] = x[start + n] * (0.5 - 0.5 * Math.cos(2 * Math.PI * n / (M - 1))); im[n] = 0; } fft(re, im); for (let y = 0; y < hh; y++) { const k = clamp(Math.floor((1 - y / hh) * bins), 1, bins - 1), hz = k * buffer.sampleRate / M, db = 20 * Math.log10(Math.hypot(re[k], im[k]) / M + 1e-9), st = processed ? strength(hz) : 1; if (processed && st < 0.003) continue; const a = clamp((db + 90) / 75, 0, 1) * st; if (a < 0.004) continue; const q = Math.round(a * 255); g.fillStyle = `rgb(${q},${Math.min(255,q+25)},${Math.min(255,q+45)})`; g.fillRect(Math.floor(col * w / cols), y, Math.ceil(w / cols) + 1, 1); } }
  }
  function renderProcessedSoon() { if (!buffer) return; clearTimeout(renderTimer); renderTimer = setTimeout(() => spectro($('specOut'), true, 205), 60); }
  function clearRange() { $('rangeIn')?.classList.remove('show'); $('rangeOut')?.classList.remove('show'); }
  function selectRange(which, a, b) { const el = $(which === 'in' ? 'rangeIn' : 'rangeOut'); if (!el) return; el.style.left = a * 100 + '%'; el.style.width = (b - a) * 100 + '%'; el.classList.add('show'); }
  function bindRange(which) {
    const f = $(which === 'in' ? 'inputFrame' : 'outputFrame'); if (!f) return;
    f.addEventListener('pointerdown', e => { if (e.button !== 0 || !buffer || e.target.closest('.drop-card')) return; const r = f.getBoundingClientRect(); drag = { which, a: clamp((e.clientX - r.left) / r.width, 0, 1) }; f.setPointerCapture?.(e.pointerId); });
    f.addEventListener('pointermove', e => { if (!drag || drag.which !== which) return; const r = f.getBoundingClientRect(), x = clamp((e.clientX - r.left) / r.width, 0, 1); selectRange(which, Math.min(drag.a, x), Math.max(drag.a, x)); });
    f.addEventListener('pointerup', e => { if (!drag || drag.which !== which) return; const r = f.getBoundingClientRect(), x = clamp((e.clientX - r.left) / r.width, 0, 1), a = Math.min(drag.a, x), b = Math.max(drag.a, x); drag = null; if (b - a < 0.01) return; loop = true; loopStart = a * buffer.duration; loopEnd = b * buffer.duration; offset = loopStart; selectRange('in', a, b); selectRange('out', a, b); $('loop').textContent = `LOOP ${loopStart.toFixed(2)}–${loopEnd.toFixed(2)}s`; $('loop').classList.add('active'); if (playing) { stop(); start(); } status(`LOOP 範圍 ${loopStart.toFixed(2)}–${loopEnd.toFixed(2)} s`); });
    f.addEventListener('dblclick', e => { e.preventDefault(); loop = false; loopStart = loopEnd = offset = 0; clearRange(); $('loop').textContent = 'LOOP OFF'; $('loop').classList.remove('active'); status('已清除 LOOP 範圍'); if (playing) { stop(); start(); } });
  }
  async function loadFile(file) {
    if (!file) return; try { stop(); const c = ensureCtx(); buffer = await c.decodeAudioData(await file.arrayBuffer()); offset = loopStart = loopEnd = 0; loop = false; delta = 0; allBypass = false; $('dropUi').style.display = 'none'; $('fileInfo').textContent = `${file.name} · ${buffer.sampleRate} Hz · ${buffer.numberOfChannels} ch · ${buffer.duration.toFixed(2)} s`; $('loop').textContent = 'LOOP OFF'; $('loop').classList.remove('active'); clearRange(); cursor(0); spectro($('specIn'), false, 260); renderProcessedSoon(); updateDelta(); status('音檔已載入。'); } catch (e) { buffer = null; $('dropUi').style.display = ''; status('音檔載入失敗：' + (e?.message || e)); }
  }
  function updateDelta() { document.querySelectorAll('[data-action="delta"]').forEach((b, i) => { const on = delta === i + 1; b.classList.toggle('active', on); b.textContent = on ? 'DELTA ON' : 'DELTA'; }); if (delta) allBypass = false; sync(); }
  function toggleBypassAll() { allBypass = !allBypass; if (allBypass) delta = 0; $('bypassAll').classList.toggle('active', allBypass); $('bypassAll').textContent = allBypass ? 'BYPASS ON' : 'BYPASS OFF'; updateDelta(); }
  function toggleLoop() { loop = !loop; if (loop && buffer && loopEnd <= loopStart) { loopStart = 0; loopEnd = buffer.duration; selectRange('in', 0, 1); selectRange('out', 0, 1); } if (!loop) { loopStart = loopEnd = 0; clearRange(); } $('loop').textContent = loop ? `LOOP ${loopStart.toFixed(2)}–${loopEnd.toFixed(2)}s` : 'LOOP OFF'; $('loop').classList.toggle('active', loop); if (playing) { stop(); start(); } }
  function toggleAB() { saveSlot(); ab = ab === 'A' ? 'B' : 'A'; apply(ab === 'A' ? slotA : slotB, false); $('ab').textContent = 'A/B · ' + ab; status('已切換到 Slot ' + ab); }
  function setup() {
    document.querySelectorAll('.knob-input').forEach(inp => { inp.addEventListener('input', () => { drawKnob(inp, true); saveSlot(); sync(); renderProcessedSoon(); }); inp.addEventListener('change', () => drawKnob(inp, false)); drawKnob(inp, false); });
    document.querySelectorAll('.knob').forEach(k => { const inp = $(k.dataset.target); let y = 0; k.addEventListener('pointerenter', () => drawKnob(inp, true)); k.addEventListener('pointerleave', () => drawKnob(inp, false)); k.addEventListener('pointerdown', e => { e.preventDefault(); y = e.clientY; k.setPointerCapture?.(e.pointerId); k.classList.add('active'); }); k.addEventListener('pointermove', e => { if (!k.hasPointerCapture?.(e.pointerId)) return; const key = inp.id.replace(/\d+$/, ''); setKnob(inp, +inp.value + (y - e.clientY) * ((LIMITS[key][1] - LIMITS[key][0]) / 240)); y = e.clientY; }); k.addEventListener('pointerup', () => { k.classList.remove('active'); drawKnob(inp, false); }); k.addEventListener('wheel', e => { e.preventDefault(); const key = inp.id.replace(/\d+$/, ''); setKnob(inp, +inp.value + (e.deltaY < 0 ? 1 : -1) * ((LIMITS[key][1] - LIMITS[key][0]) / 240) * 6); }, { passive: false }); k.addEventListener('dblclick', () => setKnob(inp, +inp.defaultValue)); });
    $('file').addEventListener('change', e => loadFile(e.target.files?.[0])); $('dropUi').addEventListener('dragover', e => e.preventDefault()); $('dropUi').addEventListener('drop', e => { e.preventDefault(); loadFile(e.dataTransfer?.files?.[0]); }); $('inputFrame').addEventListener('dragover', e => e.preventDefault()); $('inputFrame').addEventListener('drop', e => { e.preventDefault(); loadFile(e.dataTransfer?.files?.[0]); });
    $('play').addEventListener('click', togglePlay); $('stop').addEventListener('click', stop); $('loop').addEventListener('click', toggleLoop); $('bypassAll').addEventListener('click', toggleBypassAll); $('ab').addEventListener('click', toggleAB); $('sortBtn').addEventListener('click', sortBands); $('resetAll').addEventListener('click', resetAll); $('resetBands').addEventListener('click', resetAll);
    document.querySelectorAll('.band').forEach(card => { const i = +card.dataset.band; card.querySelector('[data-action="bypass"]').addEventListener('click', () => setBypass(i, !$('byp' + i).classList.contains('on'))); card.querySelector('[data-action="delta"]').addEventListener('click', () => { delta = delta === i ? 0 : i; updateDelta(); status(delta ? `DELTA SECTION ${delta}：只聽 Wet−Dry` : 'DELTA OFF'); }); card.querySelector('[data-action="reset"]').addEventListener('click', () => resetBand(i)); });
    bindRange('in'); bindRange('out'); window.addEventListener('keydown', e => { if (e.code !== 'Space' || e.repeat) return; const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; e.preventDefault(); togglePlay(); }); window.addEventListener('resize', () => { if (buffer) { spectro($('specIn'), false, 260); renderProcessedSoon(); } });
  }
  function rms() { if (!graph) return 0; const d = new Float32Array(graph.analyser.fftSize); graph.analyser.getFloatTimeDomainData(d); let s = 0; for (const x of d) s += x * x; return Math.sqrt(s / d.length); }
  function debug() { return { loaded: !!buffer, playing, loop, loopStart, loopEnd, delta, allBypass, graphReady: !!graph, graphMode, audioState: ctx?.state || 'none', bands: data() }; }
  window.myEFX = { loadFile, togglePlay, stopPlayback: stop, currentData: data, debugState: debug, meterRms: rms };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true }); else setup();
})();
