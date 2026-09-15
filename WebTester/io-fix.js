/* myEFX file I/O safety net
   Keeps the original app handlers, but adds a direct fallback so file selection
   and drag/drop still work even if a local UI handler fails.
*/
(() => {
  const file = document.getElementById('file');
  const frame = document.getElementById('inputFrame');
  const status = document.getElementById('status');
  if (!file || !frame) return;

  let opening = false;
  const setStatus = msg => { if (status) status.textContent = msg; };
  const accept = f => !!f && (
    (f.type || '').startsWith('audio/') || /\.(wav|wave|aif|aiff|flac|mp3|m4a|ogg)$/i.test(f.name || '')
  );

  async function openFile(f) {
    if (!f || opening) return;
    if (!accept(f)) {
      setStatus('這不是可讀取的音檔。請選 WAV / AIFF / FLAC / MP3 / M4A / OGG。');
      return;
    }
    opening = true;
    try {
      if (typeof window.loadFile !== 'function') throw new Error('音檔載入函式未完成初始化');
      await window.loadFile(f);
    } catch (e) {
      console.error('myEFX file fallback', e);
      setStatus('音檔載入失敗：' + (e?.message || e));
    } finally {
      opening = false;
    }
  }

  file.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) openFile(f);
    e.target.value = '';
  }, true);

  frame.addEventListener('click', e => {
    if (e.target === file) return;
    file.click();
  }, true);

  for (const type of ['dragenter', 'dragover']) {
    window.addEventListener(type, e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }, true);
  }
  window.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  }, true);
})();
