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
  let loadToken = 0;
  let renderToken = 0;
  let renderTimer = 0;
  let slot = 'A';
  let slotA = cloneDefaults();
  let slotB = cloneDefaults();

  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function cloneDefaults() {
    return DEFAULTS.map(b => ({ ...b }));
  }

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
    if (slot === 'A') slotA = currentData();
    else slotB = currentData();
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
    knob.querySelector('.knob-pointer').style.transform = `translateX(-50%) rotate(${angle}deg)`;
    const out = $(input.id + 'Out');
    if (out) out.textContent = formatValue(key, value);
  }

  function setInput(input, value, trigger = true) {
    const key = input.id.replace(/[0-9]+$/, '');
    const d = INFO[key];
    let v = clamp(value, d.min, d.max);
    const decimals = (String(d.step).split('.')[1] || '').length;
    v = Number((Math.round(v / d.step) * d.step).toFixed(decimals));
    input.value = String(v);
    renderKnob(input);
    if (trigger) input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function setBandBypass(i, on, update = true) {
    const btn = $('byp' + i);
    btn.classList.toggle('on', on);
    btn.classList.toggle('off', !on);
    const state = document.querySelector(`.band[data-band="${i}"] .state`);
    if (state) state.textContent = on ? 'ON' : 'BYP';
    if (update) {
      syncGraph();
      saveSlot();
      scheduleProcessedRender();
      drawResponse();
    }
  }

  function applyData(data) {
    for (let i = 1; i <= BAND_COUNT; i++) {
      const b = data[i - 1] || DEFAULTS[i - 1];
      for (const key of Object.keys(INFO)) {
        const input = $(key + i);
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

    const split = c.createBiquadFilter();
    split.type = 'bandpass';

    const rawMinus = c.createGain();
    rawMinus.gain.value = -1;

    const processed = c.createGain();
    const denoiseDry = c.createGain();
    const denoiseWet = c.createGain();
    const denoiseSum = c.createGain();
    const transientDry = c.createGain();
    const transientWet = c.createGain();
    const transientSum = c.createGain();
    const out = c.createGain();
    const deltaSum = c.createGain();

    eq.connect(out);

    split.connect(rawMinus);
    rawMinus.connect(out);
    split.connect(denoiseDry);
    split.connect(denoiseWet);
    denoiseDry.connect(denoiseSum);
    denoiseWet.connect(denoiseSum);
    denoiseSum.connect(transientDry);
    denoiseSum.connect(transientWet);
    transientDry.connect(transientSum);
    transientWet.connect(transientSum);
    transientSum.connect(out);

    rawMinus.connect(deltaSum);
    transientSum.connect(deltaSum);
    processed.connect(deltaSum);

    return {
      eq,
      split,
      denoiseDry,
      denoiseWet,
      denoiseSum,
      transientDry,
      transientWet,
      transientSum,
      out,
      deltaSum,
      denoise: null,
      transient: null
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

    await c.audioWorklet.addModule('denoise-processor.js?v=clean2');
    await c.audioWorklet.addModule('transient-processor.js?v=clean2');

    for (const stage of graph.stages) {
      if (!stage.denoise) {
        stage.denoise = new AudioWorkletNode(c, 'myefx-denoise', {
          parameterData: {
            amount: 0,
            threshold: 1.5,
            reduction: 30,
            adaptation: 1,
            smoothing: 38,
            transientProtect: 72,
            tonalProtect: 12,
            learn: 0
          }
        });
        stage.denoiseWet.disconnect();
        stage.denoiseWet.connect(stage.denoise);
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
      s.split.Q.setTargetAtTime(b.q, now, 0.004);

      const dn = b.bypass ? 0 : b.denoise;
      s.denoiseDry.gain.setTargetAtTime(b.bypass || b.denoise === 0 ? 1 : 0, now, 0.004);
      s.denoiseWet.gain.setTargetAtTime(b.bypass || b.denoise === 0 ? 0 : 1, now, 0.004);
      s.denoise?.parameters.get('amount')?.setTargetAtTime(dn, now, 0.004);

      const mix = b.bypass ? 0 : Math.min(1, (Math.abs(b.punch) + Math.abs(b.sustain)) / 200);
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
      source.connect(graph.stages[deltaBand - 1].split);
      graph.stages[deltaBand - 1].deltaSum.connect(graph.master);
      return;
    }

    let node = source;
    for (const stage of graph.stages) {
      node.connect(stage.eq);
      node.connect(stage.split);
      node = stage.out;
    }
    node.connect(graph.master);
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
    $('play').textContent = '▶ 播放';
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
      const w0 = Math.cos(a);
      const wi0 = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let wr = 1;
        let wi = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j++) {
          const uR = re[i + j];
          const uI = im[i + j];
          const vR = re[i + j + half] * wr - im[i + j + half] * wi;
          const vI = re[i + j + half] * wi + im[i + j + half] * wr;
          re[i + j] = uR + vR;
          im[i + j] = uI + vI;
          re[i + j + half] = uR - vR;
          im[i + j + half] = uI - vI;
          const tr = wr * w0 - wi * wi0;
          wi = wr * wi0 + wi * w0;
          wr = tr;
        }
      }
    }
  }

  function spectrumColor(db) {
    const v = clamp((db + 90) / 90, 0, 1);
    const r = Math.floor(255 * clamp((v - 0.62) * 3, 0, 1));
    const g = Math.floor(255 * clamp((v - 0.28) * 2, 0, 1));
    const b = Math.floor(255 * clamp((v - 0.02) * 2.7, 0, 1));
    return `rgb(${r},${g},${b})`;
  }

  function drawSpectrogram(audio, canvas, processed = null) {
    const id = ++renderToken;
    const width = canvas.clientWidth || 900;
    const height = canvas.clientHeight || 220;
    const n = 512;
    const half = n >> 1;
    const left = audio.getChannelData(0);
    const right = audio.numberOfChannels > 1 ? audio.getChannelData(1) : left;
    const pLeft = processed ? processed.getChannelData(0) : null;
    const pRight = processed && processed.numberOfChannels > 1 ? processed.getChannelData(1) : pLeft;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const pRe = processed ? new Float32Array(n) : null;
    const pIm = processed ? new Float32Array(n) : null;
    const win = new Float32Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));

    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d', { alpha: false });
    g.fillStyle = '#02070a';
    g.fillRect(0, 0, width, height);

    let x = 0;
    function paint() {
      if (id !== renderToken) return;
      for (let z = 0; z < 12 && x < width; z++, x++) {
        const center = Math.floor(x / Math.max(1, width - 1) * Math.max(0, left.length - 1));
        const start = center - (n >> 1);
        for (let i = 0; i < n; i++) {
          const j = clamp(start + i, 0, left.length - 1);
          re[i] = ((left[j] + right[j]) * 0.5) * win[i];
          im[i] = 0;
          if (processed) {
            const k = clamp(start + i, 0, pLeft.length - 1);
            pRe[i] = ((pLeft[k] + pRight[k]) * 0.5) * win[i];
            pIm[i] = 0;
          }
        }
        fft(re, im);
        if (processed) fft(pRe, pIm);

        for (let y = 0; y < height; y++) {
          const f = 20 * Math.pow(1000, 1 - y / Math.max(1, height - 1));
          const bin = clamp(Math.round(f * n / audio.sampleRate), 1, half);
          const inputDb = 20 * Math.log10(Math.hypot(re[bin], im[bin]) / n + 1e-8);
          if (!processed) {
            g.fillStyle = spectrumColor(inputDb);
          } else {
            const outputDb = 20 * Math.log10(Math.hypot(pRe[bin], pIm[bin]) / n + 1e-8);
            const diff = outputDb - inputDb;
            const strength = clamp(Math.abs(diff) / 6, 0, 1);
            if (strength < 0.03) continue;
            g.fillStyle = diff < 0
              ? `rgba(45,174,230,${0.2 + 0.8 * strength})`
              : `rgba(255,150,54,${0.2 + 0.8 * strength})`;
          }
          g.fillRect(x, y, 1, 1);
        }
      }
      if (x < width) requestAnimationFrame(paint);
    }
    paint();
  }

  function responseAt(freq) {
    let total = 0;
    for (const b of currentData()) {
      if (b.bypass) continue;
      const distance = Math.log2(Math.max(20, freq) / b.freq);
      total += b.gain * Math.exp(-0.5 * Math.pow(distance * b.q * 2, 2));
    }
    return total;
  }

  function drawResponse() {
    if (!buffer) return;
    const canvas = $('specIn');
    const g = canvas.getContext('2d');
    const w = canvas.width;
    const top = 76;
    const y0 = top * 0.66;
    g.fillStyle = 'rgba(2,7,10,.84)';
    g.fillRect(0, 0, w, top);
    g.strokeStyle = 'rgba(120,160,170,.24)';
    g.lineWidth = 1;
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = Math.log10(f / 20) / 3 * w;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, top);
      g.stroke();
    }
    g.strokeStyle = '#f4ffff';
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const f = 20 * Math.pow(1000, x / Math.max(1, w - 1) * 3);
      const y = y0 - clamp(responseAt(f), -18, 18) * 1.1;
      if (x) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }

  function clearProcessed() {
    const canvas = $('specOut');
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function renderOffline(input, data) {
    const offline = new OfflineAudioContext(2, input.length, input.sampleRate);
    await offline.audioWorklet.addModule('denoise-processor.js?v=clean2');
    await offline.audioWorklet.addModule('transient-processor.js?v=clean2');

    const ends = data.map(b => {
      const eq = offline.createBiquadFilter();
      eq.type = 'peaking';
      eq.frequency.value = b.freq;
      eq.Q.value = b.q;
      eq.gain.value = b.bypass ? 0 : b.gain;

      const split = offline.createBiquadFilter();
      split.type = 'bandpass';
      split.frequency.value = b.freq;
      split.Q.value = b.q;

      const rawMinus = offline.createGain();
      rawMinus.gain.value = -1;
      const out = offline.createGain();
      const dry = offline.createGain();
      const wet = offline.createGain();
      const dSum = offline.createGain();
      const tDry = offline.createGain();
      const tWet = offline.createGain();
      const tSum = offline.createGain();

      const denoise = new AudioWorkletNode(offline, 'myefx-denoise', {
        parameterData: { amount: b.bypass ? 0 : b.denoise, threshold: 1.5, reduction: 30, adaptation: 1, smoothing: 38, transientProtect: 72, tonalProtect: 12, learn: 0 }
      });
      const transient = new AudioWorkletNode(offline, 'myefx-transient', {
        parameterData: { punch: b.bypass ? 0 : b.punch, sustain: b.bypass ? 0 : b.sustain }
      });

      eq.connect(out);
      split.connect(rawMinus);
      rawMinus.connect(out);
      split.connect(dry);
      split.connect(wet);
      dry.connect(dSum);
      wet.connect(denoise);
      denoise.connect(dSum);
      dSum.connect(tDry);
      dSum.connect(tWet);
      tDry.connect(tSum);
      tWet.connect(transient);
      transient.connect(tSum);
      tSum.connect(out);

      dry.gain.value = b.bypass || !b.denoise ? 1 : 0;
      wet.gain.value = b.bypass || !b.denoise ? 0 : 1;
      const mix = b.bypass ? 0 : Math.min(1, (Math.abs(b.punch) + Math.abs(b.sustain)) / 200);
      tDry.gain.value = 1 - mix;
      tWet.gain.value = mix;
      return out;
    });

    const sourceNode = offline.createBufferSource();
    sourceNode.buffer = input;
    let node = sourceNode;
    for (const end of ends) {
      node.connect(end);
      node = end;
    }
    node.connect(offline.destination);
    sourceNode.start();
    return offline.startRendering();
  }

  async function renderProcessed() {
    if (!buffer || playing) return;
    const id = ++renderToken;
    setStatus('分析 Processed Spectrogram…');
    try {
      const output = await renderOffline(buffer, currentData());
      if (id !== renderToken || playing) return;
      drawSpectrogram(buffer, $('specOut'), output);
      setStatus('Processed Spectrogram 已更新。');
    } catch (e) {
      clearProcessed();
      setStatus('Processed Spectrogram 分析失敗：' + (e.message || e));
      console.warn(e);
    }
  }

  function scheduleProcessedRender() {
    clearTimeout(renderTimer);
    if (!buffer || playing) return;
    renderTimer = setTimeout(renderProcessed, 700);
  }

  async function loadFile(file) {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !/\.(wav|wave|aif|aiff|flac|mp3|m4a|ogg)$/i.test(file.name)) {
      setStatus('請選擇音訊檔。');
      return;
    }

    const id = ++loadToken;
    stopPlayback();
    buffer = null;
    offset = 0;
    clearProcessed();
    $('fileInfo').textContent = '讀取中…';
    setStatus('1/3 讀取音檔…');

    try {
      const c = ensureContext();
      const bytes = await file.arrayBuffer();
      if (id !== loadToken) return;
      setStatus('2/3 解碼 WAV / AIFF / FLAC / MP3…');
      const decoded = await c.decodeAudioData(bytes.slice(0));
      if (id !== loadToken) return;
      if (!decoded || !decoded.length) throw new Error('AudioBuffer 為空');

      buffer = decoded;
      $('dropUi').style.display = 'none';
      $('fileInfo').textContent = `${file.name} · ${buffer.numberOfChannels}ch · ${buffer.sampleRate}Hz · ${buffer.duration.toFixed(2)}s`;
      setCursor(0);
      requestAnimationFrame(() => {
        if (id !== loadToken || !buffer) return;
        drawSpectrogram(buffer, $('specIn'));
        drawResponse();
        setStatus('3/3 音檔已載入；播放時才啟用 DSP。');
        scheduleProcessedRender();
      });
    } catch (e) {
      if (id !== loadToken) return;
      buffer = null;
      $('dropUi').style.display = 'flex';
      $('fileInfo').textContent = '未載入';
      setStatus('音檔載入失敗：' + (e.name === 'NotSupportedError' ? '瀏覽器不支援此格式' : e.message || e));
      console.error('myEFX loadFile', e);
    }
  }

  function bindFileInput() {
    const frame = $('inputFrame');
    const file = $('file');

    file.addEventListener('change', event => {
      const f = event.target.files?.[0];
      event.target.value = '';
      if (f) loadFile(f);
    });

    frame.addEventListener('click', event => {
      if (event.target.closest('.drop-card')) return;
      if (!buffer) {
        file.click();
        return;
      }
      const rect = frame.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / rect.width;
      stopPlayback();
      offset = clamp(ratio, 0, 1) * buffer.duration;
      setCursor(ratio);
    });

    frame.addEventListener('dragover', event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });

    frame.addEventListener('drop', event => {
      event.preventDefault();
      event.stopPropagation();
      const f = event.dataTransfer?.files?.[0];
      if (f) loadFile(f);
    });

    window.addEventListener('dragover', event => {
      if (event.dataTransfer?.files?.length) event.preventDefault();
    });
    window.addEventListener('drop', event => {
      if (event.dataTransfer?.files?.length) event.preventDefault();
    });
  }

  function bindKnobs() {
    document.querySelectorAll('.knob[data-target]').forEach(knob => {
      const input = $(knob.dataset.target);
      let active = false;
      let startY = 0;
      let startValue = 0;
      renderKnob(input);

      knob.addEventListener('pointerdown', event => {
        active = true;
        startY = event.clientY;
        startValue = Number(input.value);
        knob.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });

      knob.addEventListener('pointermove', event => {
        if (!active) return;
        const key = input.id.replace(/[0-9]+$/, '');
        const range = INFO[key].max - INFO[key].min;
        setInput(input, startValue + (startY - event.clientY) * range / 190);
      });

      const end = event => {
        active = false;
        try { knob.releasePointerCapture?.(event.pointerId); } catch (_) {}
      };
      knob.addEventListener('pointerup', end);
      knob.addEventListener('pointercancel', end);

      knob.addEventListener('wheel', event => {
        event.preventDefault();
        const key = input.id.replace(/[0-9]+$/, '');
        setInput(input, Number(input.value) + (event.deltaY < 0 ? INFO[key].step : -INFO[key].step));
      }, { passive: false });

      knob.addEventListener('dblclick', event => {
        event.preventDefault();
        setInput(input, Number(input.defaultValue));
      });

      knob.addEventListener('keydown', event => {
        const key = input.id.replace(/[0-9]+$/, '');
        let value = Number(input.value);
        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') value += INFO[key].step;
        else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') value -= INFO[key].step;
        else if (event.key === 'Home') value = INFO[key].min;
        else if (event.key === 'End') value = INFO[key].max;
        else if (event.key === 'Enter') value = Number(input.defaultValue);
        else return;
        event.preventDefault();
        setInput(input, value);
      });

      input.addEventListener('input', () => {
        renderKnob(input);
        saveSlot();
        syncGraph();
        drawResponse();
        scheduleProcessedRender();
      });
    });
  }

  function bindButtons() {
    $('play').addEventListener('click', () => playing ? stopPlayback() : startPlayback());
    $('stop').addEventListener('click', stopPlayback);
    $('loop').addEventListener('click', () => {
      loop = !loop;
      $('loop').textContent = `LOOP ${loop ? 'ON' : 'OFF'}`;
      $('loop').classList.toggle('active', loop);
      if (source && buffer) {
        source.loop = loop;
        source.loopEnd = buffer.duration;
      }
    });
    $('bypassAll').addEventListener('click', () => {
      bypassAll = !bypassAll;
      $('bypassAll').textContent = `BYPASS ${bypassAll ? 'ON' : 'OFF'}`;
      $('bypassAll').classList.toggle('active', bypassAll);
      if (playing) {
        const p = offset;
        stopPlayback();
        offset = p;
        startPlayback();
      }
    });
    $('ab').addEventListener('click', () => {
      saveSlot();
      slot = slot === 'A' ? 'B' : 'A';
      $('ab').textContent = `A/B · ${slot}`;
      applyData(slot === 'A' ? slotA : slotB);
      setStatus(`已切換到 ${slot}`);
    });
    $('resetAll').addEventListener('click', resetAll);
    $('resetBands').addEventListener('click', resetAll);
    $('sortBtn').addEventListener('click', sortBands);

    document.addEventListener('click', event => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const card = button.closest('.band');
      if (!card) return;
      const i = Number(card.dataset.band);
      if (button.dataset.action === 'bypass') {
        setBandBypass(i, !button.classList.contains('on'));
      } else if (button.dataset.action === 'delta') {
        deltaBand = deltaBand === i ? 0 : i;
        document.querySelectorAll('[data-action="delta"]').forEach(b => {
          const band = b.closest('.band');
          b.classList.toggle('active', Number(band.dataset.band) === deltaBand);
        });
        if (playing) {
          const p = offset;
          stopPlayback();
          offset = p;
          startPlayback();
        }
        setStatus(deltaBand ? `DELTA B${deltaBand}` : 'DELTA OFF');
      } else if (button.dataset.action === 'reset') {
        resetBand(i);
      }
    });
  }

  function init() {
    bindFileInput();
    bindKnobs();
    bindButtons();
    for (let i = 1; i <= BAND_COUNT; i++) {
      setBandBypass(i, true, false);
    }
    const inputCanvas = $('specIn');
    const outputCanvas = $('specOut');
    inputCanvas.width = 900;
    inputCanvas.height = 260;
    outputCanvas.width = 900;
    outputCanvas.height = 205;
    setStatus('尚未載入音檔。');
  }

  init();
})();
