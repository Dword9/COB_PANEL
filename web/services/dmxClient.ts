
import { ConnectionStatus, DmxValue } from '../types';
import { debugLog } from '../utils/debugLog';

export class DmxClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onStatusChange: (status: ConnectionStatus) => void;
  private onEvent: ((msg: any) => void) | null;
  private lastSendTime: number = 0;
  private throttleMs: number = 25;
  private isManualClose: boolean = false;
  private reconnectTimer: any = null;

  constructor(url: string, onStatusChange: (status: ConnectionStatus) => void, onEvent?: (msg: any) => void) {
    this.url = url;
    this.onStatusChange = onStatusChange;
    this.onEvent = onEvent ?? null;
    this.connect();
  }

  private connect() {
    if (this.isManualClose) return;

    this.onStatusChange(ConnectionStatus.CONNECTING);
    try {
      console.log(`[DMX] Attempting connection to ${this.url}...`);
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log(`[DMX] Connected to ${this.url}`);
        debugLog.log('ws', `open ${this.url}`);
        if (this.isManualClose) {
          this.ws?.close();
          return;
        }
        this.onStatusChange(ConnectionStatus.CONNECTED);
        // Сбрасываем серверный DMX-буфер при подключении: иначе stale-кадр
        // от предыдущего проекта продолжит мигать/качаться на приборах.
        const blackout: DmxValue[] = Array.from({ length: 512 }, (_, i) => ({ ch: i + 1, val: 0 }));
        this.send(blackout, true);
      };

      this.ws.onclose = (event) => {
        console.warn(`[DMX] Connection closed: ${event.code} ${event.reason}. Reconnecting in 3s...`);
        debugLog.warn('ws', `close code=${event.code} reason="${event.reason}" manual=${this.isManualClose}`);
        if (this.isManualClose) {
          this.onStatusChange(ConnectionStatus.DISCONNECTED);
          return;
        }
        this.onStatusChange(ConnectionStatus.DISCONNECTED);
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      };

      this.ws.onerror = (error) => {
        console.error(`[DMX] WebSocket Error:`, error);
        debugLog.error('ws', 'error', error);
        this.ws?.close();
      };

      // Входящие события сервера (hello_ack, wing_input и т.п.)
      this.ws.onmessage = (ev: MessageEvent) => {
        if (!this.onEvent) return;
        try {
          const msg = JSON.parse(ev.data);
          this.onEvent(msg);
        } catch { /* не-JSON игнорируем */ }
      };
    } catch (e) {
      console.error(`[DMX] Failed to create WebSocket for ${this.url}:`, e);
      this.onStatusChange(ConnectionStatus.DISCONNECTED);
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    }
  }

  // Последние значения по каналам, не ушедшие из-за троттлинга/обрыва — сливаются при первом возможном окне
  private pending: Map<number, number> = new Map();
  private lastDeadLog = 0;
  // Юниверс 2 (17.08): свой pending/троттл, кадр уходит в {"u":2,...}
  private pending2: Map<number, number> = new Map();
  private lastSendTime2: number = 0;

  public sendU2(updates: DmxValue[], force = false) {
    if (!this.ws || this.ws.readyState !== 1) {
      for (const u of updates) this.pending2.set(u.ch, u.val);
      return false;
    }
    const now = Date.now();
    if (!force && now - this.lastSendTime2 < this.throttleMs) {
      for (const u of updates) this.pending2.set(u.ch, u.val);
      return false;
    }
    if (this.pending2.size > 0) {
      for (const u of updates) this.pending2.set(u.ch, u.val);
      updates = Array.from(this.pending2, ([ch, val]) => ({ ch, val }));
      this.pending2.clear();
    }
    if (updates.length > 0 || force) {
      if (updates.length === 1) {
        this.ws.send(JSON.stringify({ u: 2, ch: updates[0].ch, val: updates[0].val }));
      } else {
        this.ws.send(JSON.stringify({ u: 2, values: updates.map(u => [u.ch, u.val]) }));
      }
      this.lastSendTime2 = now;
      return true;
    }
    return false;
  }

  public send(updates: DmxValue[], force = false) {
    if (!this.ws || this.ws.readyState !== 1) {
      // Сокет мёртв: копим последние значения, чтобы дослать после реконнекта
      for (const u of updates) this.pending.set(u.ch, u.val);
      const now = Date.now();
      if (now - this.lastDeadLog > 10000) {
        this.lastDeadLog = now;
        debugLog.warn('dmx', `send-to-dead-socket, pending=${this.pending.size}`);
      }
      return false;
    }
    const now = Date.now();
    if (!force && now - this.lastSendTime < this.throttleMs) {
      // Окно закрыто: не дропаем, а коалесцируем (новое значение затирает старое)
      for (const u of updates) this.pending.set(u.ch, u.val);
      return false;
    }

    let batch: DmxValue[];
    if (this.pending.size > 0) {
      const merged = this.pending;
      for (const u of updates) merged.set(u.ch, u.val);
      batch = Array.from(merged, ([ch, val]) => ({ ch, val }));
      this.pending.clear();
    } else {
      batch = updates;
    }

    if (batch.length > 0 || force) {
      this.ws.send(JSON.stringify(batch));
      this.lastSendTime = now;
      return true; // Activity detected
    }
    return false;
  }

  /** Прямая отправка служебного сообщения (не DMX): wing_leds и т.п. */
  public sendRaw(obj: any): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  public close() {
    this.isManualClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
