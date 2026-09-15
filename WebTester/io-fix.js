/* myEFX file I/O — single deterministic handler. */
(() => {
  'use strict';
  const file = document.getElementById('file');
  const frame = document.getElementById('inputFrame');
  const status = document.getElementById('status');
  const transport = document.querySelector('.transport');
  if (!file || !frame) {
    console.error('[myEFX] file I/O elements missing');
    return;
  }

  const setStatus = msg => { if (status) status.textContent = msg; };
  const isAudio = f => !!f && (
    (f.type || '').startsWith('audio/') ||
    /\.(wav|wave|aif|aiff|flac|mp3|m4a|ogg)$/i.test(f.name || '')
  );
  let opening = false;

  file.hidden = false;
  file.style.position = 'absolute';
  file.style.width = '1px';
  file.style.height = '1px';
  file.style.opacity = '0';
  file.style.pointerEvents = 'none';
  file.style.left = '0';
  file.style.top = '0';

  function openPicker() {
    try {
      if (typeof file.showPicker === 'function') file.showPicker();
      else file.click();
    } catch (e) {
      file.click();
    }
  }

  function resolveLoader() {
    if (typeof window.myEFXLoadFile === 'function') return window.myEFXLoadFile;
    if (typeof window.loadFile === 'function') return window.loadFile;
    try {
      const fn = window.eval('typeof loadFile === "function" ? loadFile : null');
      if (typeof fn === 'function') return fn;
    } catch (e) {
      console.error('[myEFX] cannot resolve loadFile', e);
    }
    return null;
  }

  async function openFile(f) {
    if (!f || !isAudio(f)) {
      if (f) setStatus('請選擇音訊檔：WAV / AIFF / FLAC / MP3 / M4A / OGG');
      return;
    }
    if (opening) return;
    opening = true;
    setStatus('正在讀取：' + (f.name || '音檔'));
    try {
      const loader = resolveLoader();
      if (!loader) throw new Error('loadFile 尚未初始化；請檢查 app.js 是否成功載入');
      await loader(f);
    } catch (e) {
      console.error('[myEFX] loadFile failed', e);
      setStatus('讀取失敗：' + (e?.name ? e.name + ': ' : '') + (e?.message || String(e)));
    } finally {
      opening = false;
    }
  }

  file.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) void openFile(f);
    e.target.value = '';
  });

  if (transport && !document.getElementById('openFile')) {
    const b = document.createElement('button');
    b.id = 'openFile';
    b.type = 'button';
    b.textContent = '開啟音檔';
    b.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      openPicker();
    });
    transport.insertBefore(b, transport.firstChild);
  }

  frame.addEventListener('click', e => {
    if (e.target.closest('.cursor')) return;
    e.preventDefault();
    e.stopPropagation();
    openPicker();
  }, true);

  const cancelDrag = e => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  window.addEventListener('dragenter', cancelDrag, true);
  window.addEventListener('dragover', cancelDrag, true);
  window.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer?.files?.[0];
    if (f) void openFile(f);
  }, true);

  window.myEFXOpenFile = openPicker;
  console.info('[myEFX] deterministic file I/O ready');
})();
