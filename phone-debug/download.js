void (() => {
  if (location.origin !== 'http://192.168.50.100') {
    alert('Open http://192.168.50.100/cpthru.html first.');
    return;
  }
  const old = document.getElementById('cp-debug-download');
  if (old) { old.scrollIntoView(); return; }
  const a = document.createElement('a');
  a.id = 'cp-debug-download';
  a.href = '/cgi-bin/minizip.cgi?logID=local&';
  a.download = 'carlinkit-logs.zip';
  a.textContent = 'Download current logs';
  a.style.cssText = 'display:block;padding:20px;margin:12px;background:#fff;color:#124d70;border:2px solid #124d70;border-radius:10px;text-align:center;font:18px system-ui;position:relative;z-index:99999';
  a.addEventListener('click', () => {
    a.style.pointerEvents = 'none';
    a.textContent = 'Download requested. Save the ZIP in Files. Reload this page if the download fails.';
  }, {once:true});
  document.body.prepend(a);
  a.scrollIntoView();
})();
