(function (global) {
  'use strict';

  // HTTP transport only. The Python service owns all confirmed business state.
  class MarginStorage {
    constructor() {
      this.ready = false;
      this.snapshot = null;
      this.pending = null;
      this.sending = false;
      this.connecting = false;
      this.csrf = '';
      this.clockOffset = 0;
      this.onStatus = () => {};
    }
    async request(path, body) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(path, {
          method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
          credentials: 'same-origin', signal: controller.signal,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Margin-Token': this.csrf },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) {
          const error = new Error(data.message || data.error || '保存未完成。');
          error.status = response.status;
          error.details = data.details;
          throw error;
        }
        return data;
      } catch (error) {
        if (!error.status) error.message = '暂时无法确认保存结果。请保持本页，连接恢复后重试同一操作。';
        throw error;
      } finally { clearTimeout(timeout); }
    }
    accept(envelope) {
      if (!envelope?.state || !Number.isInteger(envelope.revision) || !envelope.databaseId) {
        throw new Error('本机服务返回了无法识别的数据。');
      }
      this.csrf = envelope.csrfToken || this.csrf;
      if (this.snapshot?.databaseId === envelope.databaseId && envelope.revision < this.snapshot.revision) return;
      this.snapshot = envelope;
      this.clockOffset = envelope.serverTime - Date.now();
      this.ready = true;
    }
    journalKey(request) { return 'margin.pending.v1.' + request.databaseId + '.' + request.operationId; }
    remember() {
      try {
        if (this.pending) localStorage.setItem(this.journalKey(this.pending), JSON.stringify(this.pending));
      } catch (_) { /* Memory still retains the exact request during this session. */ }
    }
    forget(request) {
      try { localStorage.removeItem(this.journalKey(request)); } catch (_) {}
      this.pending = null;
    }
    readJournal() {
      try {
        const prefix = 'margin.pending.v1.' + this.snapshot.databaseId + '.';
        const requests = [];
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          try {
            const saved = JSON.parse(localStorage.getItem(key));
            if (saved?.databaseId === this.snapshot.databaseId && saved.operationId && Number.isInteger(saved.expectedRevision) && saved.action && saved.payload) requests.push(saved);
          } catch (_) {}
        }
        return requests.sort((a, b) => a.expectedRevision - b.expectedRevision)[0] || null;
      } catch (_) { return null; }
    }
    async connect() {
      if (this.sending || this.connecting) throw new Error('正在核对保存结果，请稍候再连接。');
      this.connecting = true;
      try { return await this._connect(); }
      finally { this.connecting = false; }
    }
    async _connect() {
      this.onStatus('正在连接本机数据库…');
      this.accept(await this.request('/api/state'));
      if (this.pending && this.pending.databaseId !== this.snapshot.databaseId) this.pending = null;
      this.pending = this.pending || this.readJournal();
      while (this.pending) {
        await this.retry();
        this.pending = this.readJournal();
      }
      this.onStatus('已保存在本机数据库');
      return this.snapshot;
    }
    async command(action, payload) {
      if (!this.ready) throw new Error('本机数据库尚未连接。请先重新连接。');
      if (this.sending || this.pending || this.connecting) throw new Error('上一操作尚待确认，请先重试保存。');
      this.pending = {
        operationId: global.crypto?.randomUUID?.() || 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        expectedRevision: this.snapshot.revision, databaseId: this.snapshot.databaseId, action, payload
      };
      this.remember();
      return this.retry();
    }
    async retry() {
      if (this.sending) throw new Error('正在确认保存，请稍候。');
      if (!this.pending) return this.connect();
      const request = this.pending;
      this.sending = true;
      this.onStatus('正在保存…');
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const envelope = await this.request('/api/commands', request);
            this.accept(envelope);
            this.forget(request);
            this.onStatus('已保存在本机数据库');
            return envelope;
          } catch (error) {
            if (error.status === 403 && attempt === 0) {
              // A restarted service has a new CSRF token, but the same durable receipt.
              this.accept(await this.request('/api/state'));
              if (this.snapshot.databaseId !== request.databaseId) {
                this.pending = null; // Keep the old database's journal for its next connection.
                this.onStatus('数据库已切换 · 原操作保留待核对', true);
                throw new Error('数据库已切换，原操作保留在原数据库的待确认记录中。请核对当前看板。');
              }
              continue;
            }
            if (!error.status && attempt === 0) continue;
            if (error.status && error.status < 500) {
              this.forget(request);
              try { this.accept(await this.request('/api/state')); } catch (_) {}
              this.onStatus(error.status === 409 ? '记录已更新 · 请核对后再操作' : '操作未保存 · 请检查输入', true);
            } else this.onStatus('保存结果待确认 · 请重试', true);
            throw error;
          }
        }
      } finally { this.sending = false; }
    }
    now() { return Date.now() + this.clockOffset; }
  }
  global.MarginStorage = MarginStorage;
})(globalThis);
