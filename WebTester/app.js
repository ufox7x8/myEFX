(() => {
  'use strict';

  const BAND_COUNT = 4;
  const KNOB_INFO = {
    freq: { min: 20, max: 20000, step: 0.1 },
    gain: { min: -24, max: 24, step: 0.1 },
    q: { min: 0.1, max: 20, step: 0.01 },
    denoise: { min: 0, max: 100, step: 1 },
    punch: { min: -100, max: 100, step: 1 },
    sustain: { min: -100, max: 100, step: 1 }
  };
  const DEFAULTS = [
    { freq: 31.5, gain: 0, q: 1, denoise: 0, punch: 0, sustain: 0, bypass: false },
    { freq: 125, gain: 0, q: 1, denoise: 0, punch: 0, sustain: 0, bypass: false },
    { freq: 1000, gain: 0, q: 1, denoise: 0, punch: 0, sustain: 0, bypass: false },
    { freq: 8000, gain: 0, q: 1, denoise: 0, punch: 0, sustain: 0, bypass: false }
  ];
  const KNOB_TRAVEL_PX = 240;
  const $ = id => document.getElementById(id);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const copyBands = bands => bands.map(b => ({ ...b }));

  let audioContext = null;
  let buffer = null;
  let source = null;
  let graph = null;
  let graphPromise = null;
  let graphError = '';
  let playing = false;
  let loopEnabled = false;
  let globalBypass = false;
  let deltaBand = 0;
  let loopStart = 0;
  let loopEnd = 0;
  let offset = 0;
  let startedAt = 0;
  let animationFrame = 0;
  let rangeDrag = null;
  let renderTimer = 0;
  let renderSerial = 0;
  let abSlot = 'A';
  let slotA = copyBands(DEFAULTS);
  let slotB = copyBands(DEFAULTS);

  function setStatus(text) {
    const el = $('status');
    if (el) el.textContent = text;
  }

  function currentData() {
    return Array.from({ length: BAND_COUNT }, (_, n) => {
      const i = n + 1;
      return {
        freq: Number($("freq" + i).value),
        gain: Number($("gain" + i).value),
        q: Number($("q" + i).value),
        denoise: Number($("denoise" + i).value),
        punch: Number($("punch" + i).value),
        sustain: Number($("sustain" + i).value),
        bypass: !$("byp" + i).classList.contains('on')
      };
    });
  }

  function saveABSlot() {
    if (abSlot === 'A') slotA = currentData();
    else slotB = currentData();
  }

  function formatValue(key, value) {
    if (key === 'freq') return value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 1 : 2) + ' kHz' : (value % 1 ? value.toFixed(1) : Math.round(value)) + ' Hz';
    if (key === 'gain') return value.toFixed(1) + ' dB';
    if (key === 'q') return value.toFixed(2);
    return Math.round(value) + '%';
  }

  function renderKnob(input, reveal = false) {
    if (!input) return;
    const key = input.id.replace(/\d+$/, '');
    const info = KNOB_INFO[key];
    const value = Number(input.value);
    const knob = document.querySelector('.knob[data-target="' + input.id + '"]');
    if (!knob) return;
    const angle = -135 + 270 * ((value - info.min) / (info.max - info.min));
    const pointer = knob.querySelector('.knob-pointer');
    if (pointer) pointer.style.transform = 'translateX(-50%) rotate(' + angle + 'deg)';
    const readout = $(input.id + 'Out');
    if (readout) {
      readout.textContent = formatValue(key, value);
      readout.classList.toggle('show', reveal);
    }
  }

  function setInputValue(input, rawValue, reveal = true, notify = true) {
    const key = input.id.replace(/\d+$/, '');
    const info = KNOB_INFO[key];
    const decimals = (String(info.step).split('.')[1] || '').length;
    let value = clamp(Number(rawValue), info.min, info.max);
    value = Number((Math.round(value / info.step) * info.step).toFixed(decimals));
    input.value = String(value);
    renderKnob(input, reveal);
    if (notify) input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function knobDeltaPerPixel(key) {
    const info = KNOB_INFO[key];
    return (info.max - info.min) / KNOB_TRAVEL_PX;
  }

  function setBandBypass(index, enabled, update = true) {
    const button = $('byp' + index);
    if (!button) return;
    button.classList.toggle('on', enabled);
    button.classList.toggle('off', !enabled);
    const state = document.querySelector('.band[data-band="' + index + '"] .state');
    if (state) state.textContent = enabled ? 'ON' : 'BYP';
    if (update) {
      saveABSlot();
      syncGraph();
      scheduleProcessedRender();
    }
  }

  function applyBands(bands, writeSlot = false) {
    const safeBands = bands || DEFAULTS;
    for (let i = 1; i <= BAND_COUNT; i++) {
      const b = safeBands[i - 1] || DEFAULTS[i - 1];
      for (const key of Object.keys(KNOB_INFO)) {
        const input = $(key + i);
        if (!input) continue;
        input.value = String(clamp(Number(b[key]), KNOB_INFO[key].min, KNOB_INFO[key].max));
        renderKnob(input, false);
      }
      setBandBypass(i, !b.bypass, false);
    }
    if (writeSlot) saveABSlot();
    syncGraph();
    scheduleProcessedRender();
  }

  function resetAll() {
    deltaBand = 0;
    globalBypass = false;
    $('bypassAll').textContent = 'BYPASS OFF';
    $('bypassAll').classList.remove('active');
    applyBands(copyBands(DEFAULTS), true);
    updateDeltaUI();
    setStatus('所有 Sections 已重設。');
  }

  function resetBand(index) {
    const data = currentData();
    data[index - 1] = { ...DEFAULTS[index - 1] };
    applyBands(data, true);
    setStatus('SECTION ' + index + ' 已重設。');
  }

  function sortBands() {
    const sorted = currentData().sort((a, b) => a.freq - b.freq);
    applyBands(sorted, true);
    setStatus('Sections 已依頻率排序。');
  }

  function ensureAudioContext() {
    if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContext();
    return audioContext;
  }

  async function addWorkletModule(ctx, relativePath) {
    const url = new URL(relativePath, location.href).href;
    setStatus('載入 DSP：' + relativePath);
    await ctx.audioWorklet.addModule(url);
  }

  async function buildGraph() {
    const ctx = ensureAudioContext();
    if (!ctx.audioWorklet) throw new Error('瀏覽器不支援 AudioWorklet。');

    graphError = '';
    await addWorkletModule(ctx, 'denoise-processor.js');
    await addWorkletModule(ctx, 'transient-processor.js');

    const master = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.05;
    master.connect(analyser);
    analyser.connect(ctx.destination);

    const dryBus = ctx.createGain();
    const normalBus = ctx.createGain();
    const deltaBus = ctx.createGain();
    const dryMaster = ctx.createGain();
    const normalMaster = ctx.createGain();
    const deltaMaster = ctx.createGain();
    dryBus.connect(dryMaster);
    dryMaster.connect(master);
    normalBus.connect(normalMaster);
    normalMaster.connect(master);
    deltaBus.connect(deltaMaster);
    deltaMaster.connect(master);

    const stages = [];
    for (let i = 0; i < BAND_COUNT; i++) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      const eq = ctx.createBiquadFilter();
      eq.type = 'peaking';
      const denoise = new AudioWorkletNode(ctx, 'myefx-denoise', { parameterData: { amount: 0 } });
      const transient = new AudioWorkletNode(ctx, 'myefx-transient', { parameterData: { punch: 0, sustain: 0 } });
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const invertDry = ctx.createGain();
      invertDry.gain.value = -1;
      const change = ctx.createGain();
      const normalGate = ctx.createGain();
      const deltaGate = ctx.createGain();

      band.connect(dry);
      dry.connect(invertDry);
      invertDry.connect(change);
      band.connect(eq);
      eq.connect(denoise);
      denoise.connect(transient);
      transient.connect(wet);
      wet.connect(change);
      change.connect(normalGate);
      normalGate.connect(normalBus);
      change.connect(deltaGate);
      deltaGate.connect(deltaBus);

      stages.push({ band, eq, denoise, transient, dry, wet, invertDry, change, normalGate, deltaGate });
    }

    graph = { master, analyser, dryBus, normalBus, deltaBus, dryMaster, normalMaster, deltaMaster, stages };
    syncGraph();
    return graph;
  }

  async function ensureGraph() {
    if (graph) return graph;
    if (graphPromise) return graphPromise;
    graphPromise = buildGraph().catch(error => {
      graph = null;
      graphError = error?.stack || error?.message || String(error);
      setStatus('DSP 初始化失敗：' + (error?.message || error));
      console.error('myEFX graph init failed', error);
      throw error;
    }).finally(() => {
      graphPromise = null;
    });
    return graphPromise;
  }

  function syncGraph() {
    if (!graph || !audioContext) return;
    const now = audioContext.currentTime;
    const data = currentData();
    graph.stages.forEach((stage, i) => {
      const b = data[i];
      stage.band.frequency.setTargetAtTime(b.freq, now, 0.003);
      stage.band.Q.setTargetAtTime(clamp(b.q, 0.25, 18), now, 0.003);
      stage.eq.frequency.setTargetAtTime(b.freq, now, 0.003);
      stage.eq.Q.setTargetAtTime(clamp(b.q, 0.25, 18), now, 0.003);
      stage.eq.gain.setTargetAtTime(b.gain, now, 0.003);
      stage.denoise.parameters.get('amount')?.setTargetAtTime(b.denoise, now, 0.003);
      stage.transient.parameters.get('punch')?.setTargetAtTime(b.punch, now, 0.003);
      stage.transient.parameters.get('sustain')?.setTargetAtTime(b.sustain, now, 0.003);
      stage.denoise.port.postMessage({ type: 'band', freq: b.freq, q: b.q });
      stage.transient.port.postMessage({ type: 'band', freq: b.freq, q: b.q });
      const active = !globalBypass && !b.bypass;
      stage.normalGate.gain.setTargetAtTime(active && !deltaBand ? 1 : 0, now, 0.003);
      stage.deltaGate.gain.setTargetAtTime(active && deltaBand === i + 1 ? 1 : 0, now, 0.003);
    });
    graph.dryMaster.gain.setTargetAtTime(globalBypass || !deltaBand ? 1 : 0, now, 0.003);
    graph.normalMaster.gain.setTargetAtTime(globalBypass || deltaBand ? 0 : 1, now, 0.003);
    graph.deltaMaster.gain.setTargetAtTime(globalBypass ? 0 : (deltaBand ? 1 : 0), now, 0.003);
  }

  function disconnectSource() {
    if (!source) return;
    try { source.stop(); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
    source = null;
  }

  function activeLoopBounds() {
    if (buffer && loopEnd > loopStart) return [loopStart, loopEnd];
    return [0, buffer ? buffer.duration : 0];
  }

  function connectSource() {
    disconnectSource();
    source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = loopEnabled;
    const [a, b] = activeLoopBounds();
    if (b > a) {
      source.loopStart = a;
      source.loopEnd = b;
    }
    source.connect(graph.dryBus);
    graph.stages.forEach(stage => source.connect(stage.band));
    syncGraph();
  }

  async function startPlayback() {
    if (!buffer) {
      setStatus('請先載入音檔。');
      return;
    }
    try {
      const ctx = ensureAudioContext();
      await ctx.resume();
      await ensureGraph();
      connectSource();
      const [a, b] = activeLoopBounds();
      let startOffset = offset;
      if (loopEnabled) startOffset = clamp(startOffset, a, Math.max(a, b - 0.001));
      else startOffset = clamp(startOffset, 0, Math.max(0, buffer.duration - 0.001));
      startedAt = ctx.currentTime;
      source.start(0, startOffset);
      playing = true;
      $('play').textContent = '❚❚ 停止';
      setStatus(deltaBand ? 'DELTA SECTION ' + deltaBand + '：只聽該頻帶 Wet−Dry 異動' : loopEnabled ? 'LOOP 播放中' : '播放中');
      tickCursor();
    } catch (error) {
      playing = false;
      disconnectSource();
      if (!graphError) graphError = error?.stack || error?.message || String(error);
      setStatus('播放失敗：' + (error?.message || error));
      console.error(error);
    }
  }

  function stopPlayback() {
    if (playing && audioContext && buffer) {
      const elapsed = Math.max(0, audioContext.currentTime - startedAt);
      const [a, b] = activeLoopBounds();
      if (loopEnabled && b > a) {
        const length = b - a;
        offset = a + ((offset + elapsed - a) % length + length) % length;
      } else {
        offset = clamp(offset + elapsed, 0, buffer.duration);
      }
    }
    playing = false;
    disconnectSource();
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    $('play').textContent = '▶ 播放';
    setCursor(buffer ? offset / buffer.duration : 0);
    setStatus('已停止');
  }

  function togglePlay() {
    if (playing) stopPlayback();
    else startPlayback();
  }

  function restartPlaybackAtCurrentPosition() {
    if (!playing || !buffer || !audioContext || !graph) return;
    const elapsed = Math.max(0, audioContext.currentTime - startedAt);
    const [a, b] = activeLoopBounds();
    if (loopEnabled && b > a) {
      const length = b - a;
      offset = a + ((offset + elapsed - a) % length + length) % length;
    } else {
      offset = clamp(offset + elapsed, 0, buffer.duration);
    }
    connectSource();
    startedAt = audioContext.currentTime;
    source.start(0, offset);
  }

  function tickCursor() {
    if (!playing || !buffer || !audioContext) return;
    const elapsed = Math.max(0, audioContext.currentTime - startedAt);
    const [a, b] = activeLoopBounds();
    let position;
    if (loopEnabled && b > a) position = a + ((offset + elapsed - a) % (b - a) + (b - a)) % (b - a);
    else position = offset + elapsed;
    if (!loopEnabled && position >= buffer.duration) {
      offset = buffer.duration;
      stopPlayback();
      return;
    }
    setCursor(position / buffer.duration);
    animationFrame = requestAnimationFrame(tickCursor);
  }

  function setCursor(progress) {
    const p = clamp(progress, 0, 1);
    if ($('cursorIn')) $('cursorIn').style.left = (p * 100) + '%';
    if ($('cursorOut')) $('cursorOut').style.left = (p * 100) + '%';
    $('time').textContent = buffer ? `${(p * buffer.duration).toFixed(2)} / ${buffer.duration.toFixed(2)} s` : '0.00 / 0.00 s';
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const angle = -2 * Math.PI / len;
      const wc = Math.cos(angle), ws = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j++) {
          const x = i + j, y = x + half;
          const vr = re[y] * wr - im[y] * wi;
          const vi = re[y] * wi + im[y] * wr;
          re[y] = re[x] - vr; im[y] = im[x] - vi;
          re[x] += vr; im[x] += vi;
          const nextWr = wr * wc - wi * ws;
          wi = wr * ws + wi * wc; wr = nextWr;
        }
      }
    }
  }

  function bandWeight(hz, band) {
    const octaves = Math.log2(Math.max(20, hz) / Math.max(20, band.freq));
    const width = 0.35 + 2 / Math.max(0.25, band.q);
    return Math.exp(-Math.pow(octaves / width, 2));
  }

  function changeStrength(hz) {
    let strength = 0;
    for (const b of currentData()) {
      if (b.bypass) continue;
      const w = bandWeight(hz, b);
      strength += Math.abs(Math.pow(10, b.gain / 20) - 1) * w;
      strength += (b.denoise / 100) * 0.8 * w;
      strength += ((Math.abs(b.punch) + Math.abs(b.sustain)) / 200) * 0.55 * w;
    }
    return clamp(strength, 0, 1);
  }

  function drawSpectrogram(canvas, processed) {
    if (!buffer || !canvas) return;
    const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    g.fillStyle = '#02070a';
    g.fillRect(0, 0, width, height);
    const input = buffer.getChannelData(0), N = 1024, bins = N / 2;
    const columns = Math.min(900, width), hop = Math.max(1, Math.floor(input.length / Math.max(1, columns - 1)));
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let x = 0; x < columns; x++) {
      const start = Math.min(x * hop, Math.max(0, input.length - N));
      for (let n = 0; n < N; n++) {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1));
        re[n] = input[start + n] * window; im[n] = 0;
      }
      fft(re, im);
      for (let y = 0; y < height; y++) {
        const k = clamp(Math.floor((1 - y / height) * bins), 1, bins - 1);
        const hz = k * buffer.sampleRate / N;
        const db = 20 * Math.log10(Math.hypot(re[k], im[k]) / N + 1e-10);
        const strength = processed ? changeStrength(hz) : 1;
        if (processed && strength < 0.003) continue;
        const intensity = clamp((db + 90) / 75, 0, 1) * strength;
        if (intensity < 0.004) continue;
        const q = Math.round(intensity * 255);
        g.fillStyle = 'rgb(' + q + ',' + Math.min(255, q + 25) + ',' + Math.min(255, q + 45) + ')';
        g.fillRect(Math.floor(x * width / columns), y, Math.ceil(width / columns) + 1, 1);
      }
    }
  }

  function drawInputSpectrogram() { if (buffer) drawSpectrogram($('specIn'), false); }
  function scheduleProcessedRender() {
    if (!buffer) return;
    clearTimeout(renderTimer);
    const serial = ++renderSerial;
    renderTimer = setTimeout(() => { if (serial === renderSerial) drawSpectrogram($('specOut'), true); }, 60);
  }

  async function loadFile(file) {
    if (!file) return;
    try {
      stopPlayback();
      const ctx = ensureAudioContext();
      const arrayBuffer = await file.arrayBuffer();
      buffer = await ctx.decodeAudioData(arrayBuffer);
      offset = 0; loopEnabled = false; loopStart = 0; loopEnd = 0; deltaBand = 0; globalBypass = false;
      $('bypassAll').textContent = 'BYPASS OFF';
      $('bypassAll').classList.remove('active');
      $('fileInfo').textContent = `${file.name} · ${buffer.sampleRate} Hz · ${buffer.numberOfChannels} ch · ${buffer.duration.toFixed(2)} s`;
      $('dropUi').style.display = 'none';
      $('loop').textContent = 'LOOP OFF';
      $('loop').classList.remove('active');
      clearRangeUI(); setCursor(0); updateDeltaUI(); drawInputSpectrogram(); scheduleProcessedRender();
      setStatus('音檔已載入。');
    } catch (error) {
      buffer = null; $('dropUi').style.display = ''; setStatus('音檔載入失敗：' + (error?.message || error)); console.error(error);
    }
  }

  function clearRangeUI() { ['rangeIn', 'rangeOut'].forEach(id => $(id)?.classList.remove('show')); }
  function drawSelection(which, start, end) {
    const range = $(which === 'in' ? 'rangeIn' : 'rangeOut');
    if (!range) return;
    range.style.left = (start * 100) + '%'; range.style.width = ((end - start) * 100) + '%'; range.classList.add('show');
  }
  function rangeProgress(frame, event) {
    const rect = frame.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  }
  function bindRange(which) {
    const frame = $(which === 'in' ? 'inputFrame' : 'outputFrame');
    if (!frame) return;
    frame.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !buffer || event.target.closest('.drop-card')) return;
      rangeDrag = { which, start: rangeProgress(frame, event) }; frame.setPointerCapture?.(event.pointerId);
    });
    frame.addEventListener('pointermove', event => {
      if (!rangeDrag || rangeDrag.which !== which) return;
      const x = rangeProgress(frame, event); drawSelection(which, Math.min(rangeDrag.start, x), Math.max(rangeDrag.start, x));
    });
    frame.addEventListener('pointerup', event => {
      if (!rangeDrag || rangeDrag.which !== which) return;
      const x = rangeProgress(frame, event), a = Math.min(rangeDrag.start, x), b = Math.max(rangeDrag.start, x); rangeDrag = null;
      if (b - a < 0.01) return;
      loopStart = a * buffer.duration; loopEnd = b * buffer.duration; loopEnabled = true; offset = loopStart;
      drawSelection('in', a, b); drawSelection('out', a, b);
      $('loop').textContent = `LOOP ${loopStart.toFixed(2)}–${loopEnd.toFixed(2)}s`; $('loop').classList.add('active');
      if (playing) restartPlaybackAtCurrentPosition();
      setStatus(`LOOP 範圍 ${loopStart.toFixed(2)}–${loopEnd.toFixed(2)} s`);
    });
    frame.addEventListener('pointercancel', () => { rangeDrag = null; });
    frame.addEventListener('dblclick', event => {
      event.preventDefault(); loopEnabled = false; loopStart = 0; loopEnd = 0; offset = 0; clearRangeUI();
      $('loop').textContent = 'LOOP OFF'; $('loop').classList.remove('active'); setStatus('已清除 LOOP 範圍');
      if (playing) restartPlaybackAtCurrentPosition();
    });
  }

  function updateDeltaUI() {
    document.querySelectorAll('[data-action="delta"]').forEach((button, index) => {
      const selected = deltaBand === index + 1;
      button.classList.toggle('active', selected); button.textContent = selected ? 'DELTA ON' : 'DELTA';
    });
    if (deltaBand) globalBypass = false;
    syncGraph();
    setStatus(deltaBand ? `DELTA SECTION ${deltaBand}：只聽該頻帶 Wet−Dry 異動` : (buffer ? '音檔已載入。' : '尚未載入音檔。'));
  }

  function toggleGlobalBypass() {
    globalBypass = !globalBypass;
    if (globalBypass) deltaBand = 0;
    $('bypassAll').textContent = globalBypass ? 'BYPASS ON' : 'BYPASS OFF'; $('bypassAll').classList.toggle('active', globalBypass); updateDeltaUI();
  }

  function toggleLoop() {
    loopEnabled = !loopEnabled;
    if (!loopEnabled) { loopStart = 0; loopEnd = 0; clearRangeUI(); }
    else if (buffer && loopEnd <= loopStart) { loopStart = 0; loopEnd = buffer.duration; drawSelection('in', 0, 1); drawSelection('out', 0, 1); }
    $('loop').textContent = loopEnabled ? (loopEnd > loopStart ? `LOOP ${loopStart.toFixed(2)}–${loopEnd.toFixed(2)}s` : 'LOOP ON') : 'LOOP OFF';
    $('loop').classList.toggle('active', loopEnabled); if (playing) restartPlaybackAtCurrentPosition();
  }

  function toggleAB() {
    saveABSlot(); abSlot = abSlot === 'A' ? 'B' : 'A'; applyBands(abSlot === 'A' ? slotA : slotB, false); $('ab').textContent = 'A/B · ' + abSlot; setStatus('已切換到 Slot ' + abSlot);
  }

  function bindKnobInput(input) {
    input.addEventListener('input', () => { renderKnob(input, true); saveABSlot(); syncGraph(); scheduleProcessedRender(); });
    input.addEventListener('change', () => renderKnob(input, false));
  }

  function setupUI() {
    document.querySelectorAll('.knob-input').forEach(input => { bindKnobInput(input); renderKnob(input, false); });
    document.querySelectorAll('.knob').forEach(knob => {
      const id = knob.dataset.target, input = $(id); let lastY = 0;
      knob.addEventListener('pointerenter', () => renderKnob(input, true));
      knob.addEventListener('pointerleave', () => { if (!knob.hasPointerCapture?.()) renderKnob(input, false); });
      knob.addEventListener('pointerdown', event => { event.preventDefault(); lastY = event.clientY; knob.classList.add('active'); knob.setPointerCapture?.(event.pointerId); renderKnob(input, true); });
      knob.addEventListener('pointermove', event => { if (!knob.hasPointerCapture?.(event.pointerId)) return; const key = id.replace(/\d+$/, ''); setInputValue(input, Number(input.value) + (lastY - event.clientY) * knobDeltaPerPixel(key), true, true); lastY = event.clientY; });
      const finish = event => { try { knob.releasePointerCapture?.(event.pointerId); } catch (_) {} knob.classList.remove('active'); renderKnob(input, false); };
      knob.addEventListener('pointerup', finish); knob.addEventListener('pointercancel', finish);
      knob.addEventListener('wheel', event => { event.preventDefault(); const key = id.replace(/\d+$/, ''); setInputValue(input, Number(input.value) + (event.deltaY < 0 ? 1 : -1) * knobDeltaPerPixel(key) * 6, true, true); }, { passive: false });
      knob.addEventListener('dblclick', () => setInputValue(input, Number(input.defaultValue), true, true));
    });
    $('file').addEventListener('change', event => loadFile(event.target.files?.[0]));
    $('dropUi').addEventListener('dragover', event => event.preventDefault()); $('dropUi').addEventListener('drop', event => { event.preventDefault(); loadFile(event.dataTransfer?.files?.[0]); });
    $('inputFrame').addEventListener('dragover', event => event.preventDefault()); $('inputFrame').addEventListener('drop', event => { event.preventDefault(); loadFile(event.dataTransfer?.files?.[0]); });
    $('play').addEventListener('click', togglePlay); $('stop').addEventListener('click', stopPlayback); $('loop').addEventListener('click', toggleLoop); $('bypassAll').addEventListener('click', toggleGlobalBypass); $('ab').addEventListener('click', toggleAB);
    $('sortBtn').addEventListener('click', sortBands); $('resetAll').addEventListener('click', resetAll); $('resetBands').addEventListener('click', resetAll);
    document.querySelectorAll('.band').forEach(card => {
      const index = Number(card.dataset.band);
      card.querySelector('[data-action="bypass"]').addEventListener('click', () => setBandBypass(index, !$('byp' + index).classList.contains('on')));
      card.querySelector('[data-action="delta"]').addEventListener('click', () => { deltaBand = deltaBand === index ? 0 : index; updateDeltaUI(); });
      card.querySelector('[data-action="reset"]').addEventListener('click', () => resetBand(index));
    });
    bindRange('in'); bindRange('out');
    window.addEventListener('keydown', event => { if (event.code !== 'Space' || event.repeat) return; const target = event.target; if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return; event.preventDefault(); togglePlay(); });
    window.addEventListener('resize', () => { if (!buffer) return; drawInputSpectrogram(); scheduleProcessedRender(); });
  }

  function meterRms() {
    if (!graph) return 0;
    const data = new Float32Array(graph.analyser.fftSize);
    graph.analyser.getFloatTimeDomainData(data);
    let sum = 0; for (const sample of data) sum += sample * sample;
    return Math.sqrt(sum / data.length);
  }

  function debugState() {
    return {
      loaded: Boolean(buffer), playing, loopEnabled, globalBypass, deltaBand, loopStart, loopEnd, offset, slot: abSlot,
      graphReady: Boolean(graph), graphLoading: Boolean(graphPromise), graphError, audioState: audioContext?.state || 'none',
      bands: currentData()
    };
  }

  window.myEFX = { loadFile, togglePlay, stopPlayback, currentData, debugState, meterRms };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupUI, { once: true });
  else setupUI();
})();
