/* myEFX file I/O — single, deterministic handler.
   File chooser uses a real user gesture; drag/drop is handled once at window level. */
(() => {
  'use strict';
  const file = document.getElementById('file');
  const frame = document.getElementById('inputFrame');
  const status = document.getElementById('status');
  const transport = document.querySelector('.transport');
  if (!file || !frame) return;

  const setStatus = msg => { if (status) status.textContent = msg; };
  const isAudio = f => !!f && ((f.type || '').startsWith('audio/') || /\.(wav|wave|aif|aiff|flac|mp3|m4a|ogg)$/i.test(f.name || ''));
  let opening = false;

  // Make the file input programmatically usable in all Chromium builds.
  file.hidden = false;
  file.style.position = 'absolute';
  file.style.width = '1px';
  file.style.height = '1px';
  file.style.opacity = '0';
  file.style.pointerEvents = 'none';
  file.style.left = '0';
  file.style.top = '0';

  const openPicker = () => {
    try {
      if (typeof file.showPicker === 'function') file.showPicker();
      else file.click();
    } catch (e) {
      file.click();
    }
  };

  async function openFile(f) {
    if (!isAudio(f) || opening) {
      if (f && !isAudio(f)) setStatus('請選擇音訊檔：WAV / AIFF / FLAC / MP3 / M4A / OGG');
      return;
    }
    opening = true;
    setStatus('正在讀取：' + (f.name || '音檔'));
    try {
      const loader = window.loadFile;
      if (typeof loader !== 'function') throw new Error('loadFile 尚未初始化，app.js 沒有成功載入');
      await loader(f);
    } catch (e) {
      console.error('[myEFX] loadFile failed', e);
      setStatus('讀取失敗：' + (e && e.message ? e.message : String(e)));
    } finally {
      opening = false;
    }
  }

  file.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) void openFile(f);
    e.target.value = '';
  });

  // Explicit native file button, independent from canvas click handling.
  if (transport && !document.getElementById('openFile')) {
    const b = document.createElement('button');
    b.id = 'openFile';
    b.type = 'button';
    b.textContent = '開啟音檔';
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openPicker(); });
    transport.insertBefore(b, transport.firstChild);
  }

  // Unloaded frame: click opens file chooser. Loaded frame: app.js keeps waveform seeking.
  frame.addEventListener('click', e => {
    if (e.target.closest('.cursor')) return;
    if (window.__myEFXHasBuffer === true) return;
    e.preventDefault();
    e.stopPropagation();
    openPicker();
  }, true);

  // One and only one document-level drag/drop path.
  const cancelDrag = e => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  window.addEventListener('dragenter', cancelDrag, true);
  window.addEventListener('dragover', cancelDrag, true);
  window.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) void openFile(f);
  }, true);
})();
