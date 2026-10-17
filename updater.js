import CryptoJS from 'https://esm.sh/crypto-js@4.2.0';
import { ESPLoader, Transport } from './vendor/esptool-js-0.5.4.mjs';
const button = document.getElementById('update');
const status = document.getElementById('progress');
button.addEventListener('click', async () => {
  if (!navigator.serial || !window.isSecureContext) {
    status.textContent = 'HTTPSでPC版Chrome / Edgeから開いてください。'; return;
  }
  button.disabled = true;
  window.dispatchEvent(new Event('firmware-update-start'));
  let transport;
  try {
    const port = await navigator.serial.requestPort();
    const response = await fetch('manifest.json', {cache: 'no-store'});
    if (!response.ok) throw Error('配布情報を取得できません。');
    const manifest = await response.json();
    const build = manifest.builds.find(b => b.chipFamily === 'ESP32-C6');
    if (!build) throw Error('ESP32-C6配布情報がありません。');
    const files = [];
    for (const part of build.parts) {
      const r = await fetch(part.path, {cache: 'no-store'});
      if (!r.ok) throw Error('ファームウェアを取得できません。');
      const bytes = new Uint8Array(await r.arrayBuffer());
      const end = Math.ceil((part.offset + bytes.length) / 4096) * 4096;
      if (!Number.isInteger(part.offset) || part.offset < 0 || end > 0x400000 ||
          (part.offset < 0x3f0000 && end > 0x3e0000)) throw Error('書込み範囲が不正です。');
      let data = '';
      for (let i = 0; i < bytes.length; i += 8192) data += String.fromCharCode(...bytes.subarray(i, i + 8192));
      files.push({address: part.offset, data});
    }
    transport = new Transport(port, true);
    const loader = new ESPLoader({transport, baudrate: 460800, terminal: {
      clean() {}, writeLine(s) {status.textContent = s;}, write(s) {status.textContent = s;}
    }});
    await loader.main();
    if (loader.chip.CHIP_NAME !== 'ESP32-C6') throw Error('ESP32-C6専用です。');
    await loader.writeFlash({fileArray: files, flashSize: 'keep', flashMode: 'keep',
      flashFreq: 'keep', eraseAll: false, compress: true,
      calculateMD5Hash: data => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(data)).toString(),
      reportProgress: (i, written, total) => {status.textContent = '書込み中: ' + Math.round(written / total * 100) + '%';}});
    status.textContent = '書込み完了。RESETを押すかUSBを接続し直してください。';
  } catch (e) {status.textContent = '更新できませんでした: ' + e.message;}
  finally {
    if (transport) {try {await transport.disconnect();} catch {}}
    button.disabled = false;
    window.dispatchEvent(new Event('firmware-update-end'));
  }
});
