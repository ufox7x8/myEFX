/* Keep the processing engine functionally at four active bands.
   The existing engine is still 8-stage internally, but sections 5-8 are
   permanently hidden and bypassed so only the four visible sections act.
*/
(() => {
  const disableExtraBands = () => {
    for (let i = 5; i <= 8; i++) {
      const b = document.getElementById('byp' + i);
      if (!b) continue;
      b.classList.remove('on');
      b.classList.add('off');
      const state = document.getElementById('state' + i);
      if (state) state.textContent = 'BYP';
    }
    if (typeof window.syncParams === 'function') {
      try { window.syncParams(); } catch (e) { console.warn('4-band sync', e); }
    }
  };

  disableExtraBands();
  document.addEventListener('click', e => {
    const b = e.target.closest('#resetAll,#resetBands,#sortBtn');
    if (!b) return;
    setTimeout(disableExtraBands, 0);
  }, true);
})();
