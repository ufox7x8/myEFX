/* myEFX file I/O hardening layer
   Purpose: make file selection and OS drag/drop independent from accidental
   listener ordering while still using the single canonical app.js loadFile().
   It runs in the capture phase so the older app.js bubble listeners cannot
   start a second load operation.
*/
(() => {
  'use strict';

  const box = document.getElementById('inputFrame');
  const input = document.getElementById('file');
  const dropUi = document.getElementById('dropUi');

  if (!box || !input) {
    console.error('[myEFX] file I/O hardfix: missing #inputFrame or #file');
    return;
  }

  const isFilePickerVisible = () => {
    if (!dropUi) return !window.__myEFXHasBuffer;
    return getComputedStyle(dropUi).display !== 'none';
  };

  const openFilePicker = () => {
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
      } else {
        input.click();
      }
    } catch (err) {
      console.warn('[myEFX] showPicker fallback:', err);
      try { input.click(); } catch (fallbackErr) {
        console.error('[myEFX] file picker failed:', fallbackErr);
      }
    }
  };

  const setDragState = active => {
    box.classList.toggle('drag-active', !!active);
    if (active) box.style.borderColor = '#72ddd8';
    else box.style.borderColor = '';
  };

  const load = file => {
    if (!file) return;
    const loader = window.loadFile;
    if (typeof loader !== 'function') {
      const status = document.getElementById('status');
      if (status) status.textContent = '檔案系統初始化失敗：loadFile 不存在';
      console.error('[myEFX] canonical loadFile() is unavailable');
      return;
    }
    try {
      const result = loader(file);
      if (result && typeof result.catch === 'function') {
        result.catch(err => console.error('[myEFX] loadFile rejected:', err));
      }
    } catch (err) {
      console.error('[myEFX] loadFile threw:', err);
    }
  };

  // Native picker entry point. Stop the old bubble listener only when the
  // drop overlay is visible; once a buffer exists, normal seek behavior stays intact.
  box.addEventListener('click', event => {
    if (!isFilePickerVisible()) return;
    if (event.target === input) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openFilePicker();
  }, true);

  input.addEventListener('change', event => {
    event.stopImmediatePropagation();
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    if (file) load(file);
  }, true);

  box.addEventListener('dragenter', event => {
    event.preventDefault();
    event.stopPropagation();
    setDragState(true);
  }, true);

  box.addEventListener('dragover', event => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragState(true);
  }, true);

  box.addEventListener('dragleave', event => {
    event.preventDefault();
    event.stopPropagation();
    setDragState(false);
  }, true);

  box.addEventListener('drop', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    setDragState(false);

    const files = event.dataTransfer?.files;
    if (!files || !files.length) return;
    load(files[0]);
  }, true);

  window.addEventListener('dragover', event => {
    // Prevent Chrome from navigating the whole page to a dropped local file
    // when the pointer briefly leaves the exact drop zone.
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  }, false);

  window.addEventListener('drop', event => {
    if (event.target === box || box.contains(event.target)) return;
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  }, false);

  window.myEFXOpenFile = openFilePicker;
  window.myEFXFileIOReady = true;
})();
