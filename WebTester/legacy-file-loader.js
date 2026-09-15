/* myEFX legacy file loader
   Restores the simple, known-working file input path used by the early Web Tester.
   No capture-phase fallback, no duplicate global drag handlers. */
(() => {
  'use strict';
  const box = document.getElementById('inputFrame');
  const fileInput = document.getElementById('file');
  const status = document.getElementById('status');
  const dropUi = document.getElementById('dropUi');
  if (!box || !fileInput) {
    console.error('[myEFX] file UI elements missing');
    return;
  }

  const setStatus = text => {
    if (status) status.textContent = text;
  };

  const isAudioFile = file => !!file && (
    (file.type || '').startsWith('audio/') ||
    /\.(wav|wave|aif|aiff|flac|mp3|m4a|ogg)$/i.test(file.name || '')
  );

  async function loadLegacyFile(file) {
    if (!file) return;
    if (!isAudioFile(file)) {
      setStatus('請選擇音訊檔。');
      return;
    }

    try {
      setStatus('正在讀取：' + file.name);
      if (!ctx) ctx = new AudioContext();

      const data = await file.arrayBuffer();
      if (!data || data.byteLength === 0) {
        throw new Error('檔案內容為空');
      }

      const decoded = await ctx.decodeAudioData(data.slice(0));
      if (!decoded) throw new Error('瀏覽器無法解碼此音檔');

      buffer = decoded;
      playOffset = 0;
      window.__myEFXHasBuffer = true;

      if (dropUi) dropUi.style.display = 'none';
      const info = document.getElementById('fileInfo');
      if (info) {
        info.textContent = `${file.name} · ${decoded.numberOfChannels}ch · ${decoded.sampleRate}Hz · ${decoded.duration.toFixed(2)}s`;
      }

      if (typeof setCursor === 'function') setCursor(0);
      if (typeof drawSpectrogram === 'function') drawSpectrogram(decoded, document.getElementById('specIn'));

      const out = document.getElementById('specOut');
      if (out) {
        const g = out.getContext('2d');
        if (g) g.clearRect(0, 0, out.width, out.height);
      }

      setStatus('音檔已載入：' + file.name);

      if (typeof ensureGraph === 'function') {
        await ensureGraph();
      }
      if (typeof scheduleProcessedRender === 'function') {
        scheduleProcessedRender();
      }
    } catch (err) {
      buffer = null;
      window.__myEFXHasBuffer = false;
      if (dropUi) dropUi.style.display = 'flex';
      const info = document.getElementById('fileInfo');
      if (info) info.textContent = '未載入';
      setStatus('音檔載入失敗：' + (err?.message || err));
      console.error('[myEFX] loadLegacyFile', err);
    }
  }

  // Expose the same function name used by the old UI path.
  window.loadFile = loadLegacyFile;
  window.myEFXLoadFile = loadLegacyFile;
  window.myEFXOpenFile = () => fileInput.click();

  fileInput.addEventListener('change', event => {
    const selected = event.target.files && event.target.files[0];
    if (selected) void loadLegacyFile(selected);
    event.target.value = '';
  });

  box.addEventListener('click', event => {
    if (event.target.closest('.cursor')) {
      if (buffer) {
        const r = (event.clientX - box.getBoundingClientRect().left) / box.clientWidth;
        if (typeof stop === 'function') stop();
        playOffset = Math.max(0, Math.min(1, r)) * buffer.duration;
        if (typeof setCursor === 'function') setCursor(r);
      }
      return;
    }
    if (!buffer) {
      fileInput.click();
    } else {
      const r = (event.clientX - box.getBoundingClientRect().left) / box.clientWidth;
      if (typeof stop === 'function') stop();
      playOffset = Math.max(0, Math.min(1, r)) * buffer.duration;
      if (typeof setCursor === 'function') setCursor(r);
    }
  });

  box.addEventListener('dragenter', event => {
    event.preventDefault();
    box.style.borderColor = '#72ddd8';
  });
  box.addEventListener('dragover', event => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  box.addEventListener('dragleave', event => {
    event.preventDefault();
    box.style.borderColor = '';
  });
  box.addEventListener('drop', event => {
    event.preventDefault();
    event.stopPropagation();
    box.style.borderColor = '';
    const dropped = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (dropped) void loadLegacyFile(dropped);
  });
})();
