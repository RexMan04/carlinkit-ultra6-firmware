// First-install bookmark (0.2+): injects the same updater the project page
// has built in (web/cpthru_fw.js) into the stock page or an older test page.
// It accepts any valid image for this adapter and base, so it does not need
// replacing for later project releases.
(() => {
  if (location.origin !== 'http://192.168.50.100') {
    alert('Open http://192.168.50.100 in Safari, then run this bookmark.');
    return;
  }
  if (document.getElementById('fw-panel') && document.querySelector('#fw-panel .fw-file')) {
    location.hash = '#update';
    alert('This adapter page already has a built-in Firmware update section. Use it instead of the bookmark.');
    return;
  }
  if (window.CPDiag?.busy()) {
    alert('Wait until the debug ZIP is ready, then run this bookmark again.');
    return;
  }
  const id = 'carlinkit-local-upload';
  if (document.getElementById(id)) { document.getElementById(id).scrollIntoView(); return; }
  const stockButton = document.getElementById('download_btn');
  const stockProgress = document.getElementById('download-bar');
  if ((stockButton && stockButton.disabled) || (stockProgress && (stockProgress.value > 0 ||
      getComputedStyle(stockProgress).display !== 'none')) || window.program_filename) {
    alert('A stock online update may be in progress. Wait for it to finish, reload the page, then run this bookmark.');
    return;
  }
  const blockStock = () => alert('The local updater is active. Do not start an online update.');
  for (const name of ['program', 'uploadChunks', 'btnaddEv', 'downloadAliFile']) {
    if (typeof window[name] === 'function') window[name] = blockStock;
  }
  if (stockButton) stockButton.disabled = true;
  __CPFW__
  const panel = document.createElement('fieldset');
  panel.id = id;
  panel.style.cssText = 'margin:16px;padding:16px;min-width:0;background:Canvas;color:CanvasText;position:relative;z-index:99999;border:2px solid;border-radius:8px';
  panel.innerHTML = '<legend style="font-weight:700">Firmware update (first-install bookmark)</legend><div></div>';
  document.body.prepend(panel);
  window.CPFW.mount(panel.querySelector('div'), {
    busyOthers: () => (window.CPDiag?.busy() ? 'wait until the debug ZIP is ready.' : null)
  });
  panel.scrollIntoView();
})();
