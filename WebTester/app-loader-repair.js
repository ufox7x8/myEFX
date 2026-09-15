/* myEFX audio-load repair
   Canonical file decoding bridge for the current WebTester.
   It intentionally separates: File -> ArrayBuffer -> decode -> app buffer.
   DSP/worklet construction is NOT part of file loading; playback can build it later.
*/
(() => {
  'use strict';

  const status = document.getElementById('status');
  const dropUi = document.getElementById('dropUi');
  const fileInfo = document.getElementById('fileInfo');
  const specIn = document.getElementById('specIn');
  const specOut = document.getElementById('specOut');
  let loadSerial = 0;

  const say = text => {
    if (status) status.textContent = text;
  };

  const audioFile = file => !!file && (
    /^audio\//i.test(file.type || '') ||
    /\.(wav|wave|aif|aiff|flac|mp3|m4a|ogg|opus)$/i.test(file.name || '')
  );

  const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + '逾時')), ms))
  ]);

  const getAppVar = name => window.eval(name);
  const setAppVars = decoded => {
    window.__myEFXDecodedBuffer = decoded;
    window.eval('buffer = window.__myEFXDecodedBuffer; playOffset = 0;');
  };

  async function getContext() {
    let c = getAppVar('ctx');
    if (!c || c.state === 'closed') {
      c = new (window.AudioContext || window.webkitAudioContext)();
      window.__myEFXDecodeContext = c;
      window.eval('ctx = window.__myEFXDecodeContext; stages = []; outputGain = null; analyser = null; source = null; playing = false;');
    }
    return c;
  }

  async function decode(file, serial) {
    if (!audioFile(file)) throw new Error('不支援的音檔格式');

    const c = await getContext();
    const bytes = await withTimeout(file.arrayBuffer(), 30000, '檔案讀取');
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
      throw new Error('檔案資料為空');
    }

    say(`正在解碼：${file.name}（${(bytes.byteLength / 1048576).toFixed(1)} MB）`);

    let decoded;
    try {
      decoded = await withTimeout(c.decodeAudioData(bytes), 60000, '音檔解碼');
    } catch (promiseError) {
      decoded = await withTimeout(new Promise((resolve, reject) => {
        try {
          c.decodeAudioData(bytes.slice(0), resolve, reject);
        } catch (err) {
          reject(err);
        }
      }), 60000, '音檔解碼');
      if (!decoded) throw promiseError;
    }

    if (serial !== loadSerial) return null;
    if (!decoded || !decoded.length || !decoded.duration) {
      throw new Error('decodeAudioData 沒有產生有效 AudioBuffer');
    }
    return decoded;
  }

  async function loadFile(file) {
    if (!file) return;
    if (!audioFile(file)) {
      say('請選擇 WAV / AIFF / FLAC / MP3 / M4A / OGG 音檔。');
      return;
    }

    const serial = ++loadSerial;
    try {
      say(`正在讀取：${file.name}`);
      const decoded = await decode(file, serial);
      if (!decoded || serial !== loadSerial) return;

      setAppVars(decoded);

      if (dropUi) dropUi.style.display = 'none';
      if (fileInfo) {
        fileInfo.textContent = `${file.name} · ${decoded.numberOfChannels}ch · ${decoded.sampleRate}Hz · ${decoded.duration.toFixed(2)}s`;
      }

      if (typeof window.setCursor === 'function') window.setCursor(0);
      if (specOut) {
        const g = specOut.getContext('2d');
        if (g) g.clearRect(0, 0, specOut.width, specOut.height);
      }

      say(`音檔已載入：${file.name}`);
      window.__myEFXHasBuffer = true;

      if (typeof window.drawSpectrogram === 'function' && specIn) {
        requestAnimationFrame(() => {
          if (serial !== loadSerial) return;
          try { window.drawSpectrogram(decoded, specIn); }
          catch (err) { console.error('[myEFX spectrogram]', err); }
        });
      }
    } catch (err) {
      if (serial !== loadSerial) return;
      window.__myEFXHasBuffer = false;
      if (dropUi) dropUi.style.display = 'flex';
      if (fileInfo) fileInfo.textContent = '未載入';
      say(`音檔載入失敗：${err?.message || err}`);
      console.error('[myEFX load repair]', err);
    }
  }

  window.myEFXLoadFile = loadFile;
  window.loadFile = loadFile;
  window.__myEFXLoadRepairReady = true;
})();
