// Runs only as a bookmarklet on the adapter's original page. No flash code.
(() => {
  if (location.origin !== 'http://192.168.50.100') {
    alert('Open http://192.168.50.100 in Safari, then run this bookmark.');
    return;
  }
  const id = 'carlinkit-local-upload';
  if (window.CPDiag?.busy()) {
    alert('Wait until the debug ZIP is ready, then run this bookmark again. No upload started.');
    return;
  }
  if (document.getElementById(id)) {
    document.getElementById(id).scrollIntoView();
    return;
  }
  const stockButton = document.getElementById('download_btn');
  const stockProgress = document.getElementById('download-bar');
  const C = window.CryptoJS;
  if (!stockButton || !stockProgress || !C?.algo?.MD5 || !C?.algo?.SHA256 ||
      !C?.lib?.WordArray || typeof window.uploadChunks !== 'function') {
    alert('This page does not match the expected adapter updater. Stop and report this.');
    return;
  }
  if (stockButton.disabled || stockProgress.value > 0 ||
      getComputedStyle(stockProgress).display !== 'none' || window.program_filename) {
    alert('A stock update may be in progress. Wait for it to finish before loading a fresh page and running this bookmark.');
    return;
  }
  const blockStock = () => alert('Local upload helper is active. Do not start an online update.');
  for (const name of ['program', 'uploadChunks', 'btnaddEv', 'downloadAliFile']) {
    window[name] = blockStock;
  }
  stockButton.disabled = true;
  const panel = document.createElement('fieldset');
  panel.id = id;
  panel.style.cssText = 'margin:16px;padding:16px;min-width:0;background:Canvas;color:CanvasText;position:relative;z-index:99999';
  panel.innerHTML = '<legend>Local firmware upload</legend><p>Upload and verify only. Keep Safari open. Temporarily turn off Low Power Mode and set Auto-Lock to Never; restore afterwards. Use only this tab; do not start an online update.</p><label>Choose firmware <input type="file"></label><p><button type="button" disabled>Upload and verify</button></p><progress max="100" value="0"></progress><p role="status">Choose the SWU saved in Files.</p>';
  document.body.prepend(panel);
  const input = panel.querySelector('input');
  const button = panel.querySelector('button');
  const progress = panel.querySelector('progress');
  const status = panel.querySelector('[role=status]');
  input.style.maxWidth = '100%';
  button.style.cssText = 'height:auto;line-height:normal;padding:12px;white-space:normal';
  const say = text => { status.textContent = text; };
  input.onchange = () => {
    button.disabled = !input.files.length;
    say(input.files[0]?.name || 'Choose the SWU saved in Files.');
  };
  let attempted = false;
  button.onclick = async () => {
    if (attempted || !input.files.length) return;
    if (window.CPDiag?.busy()) {
      say('Wait until the debug ZIP is ready, then tap Upload and verify again.');
      return;
    }
    attempted = true;
    input.disabled = button.disabled = true;
    let sent = false;
    try {
      const file = input.files[0];
      const known = __KNOWN_IMAGES__;
      if (!known.some(image => image.size === file.size)) throw Error('Wrong file size.');
      say('Checking file...');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const md5 = C.algo.MD5.create(), sha = C.algo.SHA256.create();
      for (let start = 0; start < bytes.length; start += 262144) {
        const words = C.lib.WordArray.create(bytes.subarray(start, start + 262144));
        md5.update(words);
        sha.update(words);
        progress.value = Math.min(100, (start + 262144) / bytes.length * 100);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const digest = md5.finalize().toString(), strong = sha.finalize().toString();
      const image = known.find(item => item.md5 === digest && item.sha256 === strong && item.size === bytes.length);
      if (!image) throw Error(__MISMATCH__);
      const total = Math.ceil(bytes.length / 10240), started = Date.now();
      for (let chunk = 0; chunk < total; chunk++) {
        const last = chunk === total - 1;
        const suffix = chunk === 0 ? '.0' : last ? ':' + digest + '.2' : '.1';
        const form = new FormData();
        form.append('chunk', new Blob([bytes.subarray(chunk * 10240, (chunk + 1) * 10240)],
          {type: 'application/octet-stream'}), image.name + suffix);
        say(image.label + ': chunk ' + (chunk + 1) + '/' + total + ', ' + Math.round((Date.now() - started) / 1000) + ' seconds');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        let text;
        try {
          sent = true;
          const response = await fetch('/cgi-bin/downfile.cgi', {
            method: 'POST', body: form, redirect: 'error', signal: controller.signal
          });
          if (response.status !== 200) throw Error('Upload HTTP ' + response.status);
          text = await response.text();
        } finally { clearTimeout(timer); }
        const lines = text.split(/\r?\n/).map(line => line.trim());
        const exact = line => lines.filter(value => value === line).length === 1;
        if (/fail|invalid|could not|error|no valid/i.test(text) ||
            !exact('write data------success') ||
            !exact('result is /mnt/UDISK/swupdate/' + image.name) ||
            lines.filter(line => line.startsWith('result is ')).length !== 1 ||
            (last && (!exact('file check success') || !exact('md5_str is ' + digest))) ||
            (!last && lines.some(line => line.startsWith('file check ')))) {
          throw Error('Adapter rejected the transfer or checksum. Storage may be full.');
        }
        progress.value = (chunk + 1) / total * 100;
      }
      say('Uploaded and verified: ' + image.name + '. NOT flashed. Success applies to this attempt only. Keep the adapter powered and this tab open. Do not upload again. Report this result.');
      panel.dataset.result = 'success';
    } catch (error) {
      say((sent ? 'STOP: staged file is incomplete/invalid. Do NOT flash; previous success is no longer valid. ' : 'No file uploaded. ') +
        error.message + ' To restart, reload the page and run the bookmark again.');
      panel.dataset.result = 'failure';
    }
  };
  panel.scrollIntoView();
})();
