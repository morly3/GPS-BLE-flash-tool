// Uses existing USB commands; firmware and provisioning data are not modified.
export function parseModeLine(line) {
  if (line.includes('[AUTH] denied')) return {error: '本体の通常起動を確認してください。'};
  if (line.includes('mode could not be saved')) return {error: '本体への保存に失敗しました。'};
  if (line.includes('configuration failed; restoring')) return {error: '受信機の設定に失敗しました。'};
  const saved = line.match(/^\[MODE\] saved=([123])\b/);
  if (saved) return {mode: Number(saved[1]), saved: true, verified: false};
  const match = line.match(/^\[QU10T\] mode=([123]) .*?config=(verified|unverified)\b/);
  return match ? {mode: Number(match[1]), verified: match[2] === 'verified'} : null;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function withTimeout(promise, timeout, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), timeout);
    })]);
  } finally {clearTimeout(timer);}
}

export class ModeConnection {
  constructor(onState, onDisconnect) {
    this.onState = onState;
    this.onDisconnect = onDisconnect;
    this.port = null;
    this.state = null;
    this.sequence = 0;
  }
  async connect(port) {
    this.port = port;
    await port.open({baudRate: 115200});
    await port.setSignals({dataTerminalReady: true, requestToSend: false});
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.readTask = this.read();
    await this.send('dbg\n');
    // Let the firmware finish changing USB output modes before requesting status.
    await delay(200);
    await this.send('status\n');
    return this.waitFor(state => !!state.mode, 8000, 0);
  }
  async send(command) {
    if (!this.writer) throw Error('本体が接続されていません。');
    await withTimeout(this.writer.write(new TextEncoder().encode(command)), 3000,
      'USB送信が停止しました。切断して接続し直してください。');
  }
  async read() {
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const {value, done} = await this.reader.read();
        if (done) break;
        pending += decoder.decode(value, {stream: true});
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).replace(/\r/g, '');
          pending = pending.slice(newline + 1);
          const state = parseModeLine(line);
          if (state) {
            if (state.saved) this.savedMode = state.mode;
            if (state.error) this.lastError = state.error;
            this.state = state;
            ++this.sequence;
            this.onState(state);
          }
        }
        if (pending.length > 4096) pending = '';
      }
    } catch (error) {
      if (!this.closing) this.state = {error: 'USB接続が切れました。'};
    } finally {
      this.reader.releaseLock();
      this.reader = null;
      if (!this.closing) {
        this.state = {error: 'USB接続が切れました。'};
        this.onDisconnect();
      }
    }
  }
  async waitFor(predicate, timeout, after) {
    const deadline = Date.now() + timeout;
    let nextQuery = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (this.closing) throw Error('設定確認を中止しました。');
      if (this.lastError || this.state?.error) throw Error(this.lastError || this.state.error);
      if (this.sequence > after && this.state && predicate(this.state)) return this.state;
      if (Date.now() >= nextQuery) {
        await this.send('status\n');
        nextQuery = Date.now() + 1000;
      }
      await delay(100);
    }
    throw Error('設定を確認できませんでした。接続し直して現在のモードを確認してください。');
  }
  async apply(mode) {
    if (![1, 2, 3].includes(mode)) throw Error('モードは1〜3を指定してください。');
    // Discard previous snapshots. Firmware saves mode before applying it to GNSS.
    this.state = null;
    this.lastError = null;
    this.savedMode = null;
    const after = this.sequence;
    await this.send(String(mode) + '\n');
    try {
      await this.waitFor(() => this.savedMode === mode, 5000, after);
    } catch (error) {
      if (!this.lastError && !this.state?.error && !this.closing) {
        throw Error('保存完了を確認できませんでした。本体を最新ファームに更新し、再接続してください。');
      }
      throw error;
    }
    return {mode, saved: true, verified: this.state?.mode === mode && this.state.verified};
  }
  async close() {
    this.closing = true;
    // Restore normal NMEA output before releasing the USB port.
    if (this.writer) {
      try {await this.send('nmea\n');} catch {
        try {await withTimeout(this.writer.abort(), 1000, 'USB切断待ち');} catch {}
      }
      try {this.writer.releaseLock();} catch {}
      this.writer = null;
    }
    if (this.reader) {try {await withTimeout(this.reader.cancel(), 1000, 'USB切断待ち');} catch {}}
    if (this.readTask) {try {await withTimeout(this.readTask, 1000, 'USB切断待ち');} catch {}}
    if (this.port) {try {await withTimeout(this.port.close(), 1000, 'USB切断待ち');} catch {}}
    this.port = null;
  }
}

if (typeof document !== 'undefined') {
  const connect = document.getElementById('mode-connect');
  const disconnect = document.getElementById('mode-disconnect');
  const select = document.getElementById('mode-select');
  const apply = document.getElementById('mode-apply');
  const current = document.getElementById('mode-current');
  const progress = document.getElementById('mode-progress');
  const update = document.getElementById('update');
  let connection = null;
  let busy = false;
  let updating = false;
  let disconnecting = false;
  let operation = 0;
  let appliedMode = null;
  function controls() {
    connect.disabled = busy || updating || !!connection;
    // Users can cancel even while GNSS verification or USB writes are pending.
    disconnect.disabled = disconnecting || !connection;
    select.disabled = apply.disabled = busy || !connection;
    update.disabled = updating || busy || !!connection;
  }
  function stateChanged(state) {
    if (state.mode) current.textContent = '現在のモード：' + state.mode + (state.verified ? '' : '（設定確認中）');
    if (!busy && state.error) progress.textContent = state.error;
    if (!busy && state.verified && state.mode === appliedMode) {
      progress.textContent = 'モード' + state.mode + 'を保存し、受信機の設定を確認しました。';
    }
  }
  async function close() {
    ++operation;
    busy = disconnecting = true;
    const old = connection;
    connection = null;
    controls();
    if (old) await old.close();
    current.textContent = '現在のモード：未接続';
    appliedMode = null;
    busy = disconnecting = false;
    controls();
  }
  connect.addEventListener('click', async () => {
    if (!navigator.serial || !window.isSecureContext) {
      progress.textContent = 'HTTPSでPC版Chrome / Edgeから開いてください。'; return;
    }
    busy = true; controls();
    const id = ++operation;
    try {
      const port = await navigator.serial.requestPort();
      connection = new ModeConnection(stateChanged, () => {
        progress.textContent = 'USB接続が切れました。';
        void close();
      });
      progress.textContent = '本体の設定を確認しています…';
      const state = await connection.connect(port);
      if (id !== operation) return;
      select.value = String(state.mode);
      progress.textContent = '接続しました。変更するモードを選んでください。';
    } catch (error) {
      if (id !== operation) return;
      progress.textContent = error.name === 'NotFoundError' ? '接続をキャンセルしました。' : error.message;
      await close();
    } finally {if (id === operation) {busy = false; controls();}}
  });
  apply.addEventListener('click', async () => {
    busy = true; controls();
    const id = ++operation;
    try {
      progress.textContent = '本体に保存しています…';
      const state = await connection.apply(Number(select.value));
      if (id !== operation) return;
      appliedMode = state.mode;
      progress.textContent = 'モード' + state.mode + 'を保存しました。' +
        (state.verified ? '受信機の設定も確認済みです。' : '受信機の設定確認を続けています。');
    } catch (error) {if (id === operation) progress.textContent = error.message;}
    finally {if (id === operation) {busy = false; controls();}}
  });
  disconnect.addEventListener('click', async () => {
    busy = true; controls();
    await close();
    busy = false; controls();
    progress.textContent = '切断しました。';
  });
  window.addEventListener('firmware-update-start', () => {updating = true; controls();});
  window.addEventListener('firmware-update-end', () => {updating = false; controls();});
}
