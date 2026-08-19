import { HTTP_API_URL } from '../constants';

// ---------------------------------------------------------------------------
// Отладочный лог пользовательских действий фронта (для агента-отладчика).
// Кольцевой буфер последних N записей + окно в server_v4.py POST /debug-log
// (пишет в logs/debug_web.log). Достать буфер извне: window.__debugLog.dump()
// (webshot --js "window.__debugLog.dump()") или .dumpJSON().
// ---------------------------------------------------------------------------

export interface DebugEntry {
  t: number;
  tag: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
  data?: unknown;
}

const MAX = 4000;
let ring: DebugEntry[] = [];
let pending: DebugEntry[] = [];
let flushTimer: number | null = null;
let postDisabledUntil = 0;

function sanitize(data: unknown): unknown {
  if (data === undefined || data === null) return data;
  if (typeof data === 'string' && data.length > 400) return data.slice(0, 400) + '…';
  try {
    const s = JSON.stringify(data);
    if (s && s.length > 800) return JSON.parse(s.slice(0, 800));
    return data;
  } catch {
    return String(data).slice(0, 400);
  }
}

function push(level: DebugEntry['level'], tag: string, msg: string, data?: unknown) {
  const e: DebugEntry = { t: Date.now(), tag, level, msg, data: sanitize(data) };
  ring.push(e);
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
  pending.push(e);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flush();
  }, 1500);
}

function flush() {
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  if (Date.now() < postDisabledUntil) return; // сервер лежит/не знает роут — не спамим
  try {
    fetch(`${HTTP_API_URL}/debug-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: batch }),
      keepalive: true,
    }).catch(() => {
      postDisabledUntil = Date.now() + 60000; // нет связи — пауза минуту
    });
  } catch {
    postDisabledUntil = Date.now() + 60000;
  }
}

// Финальный сброс при уходе со страницы (keepalive-фетч)
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      navigator.sendBeacon(`${HTTP_API_URL}/debug-log`, JSON.stringify({ logs: batch }));
    } catch { /* ignore */ }
  });
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

const fmt = (e: DebugEntry) => {
  const d = new Date(e.t);
  const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  let line = `${ts} [${e.tag}] ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
  if (e.data !== undefined && e.data !== null) {
    const s = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
    if (s) line += ` | ${s.slice(0, 900)}`;
  }
  return line;
};

export const debugLog = {
  log(tag: string, msg: string, data?: unknown) { push('info', tag, msg, data); },
  warn(tag: string, msg: string, data?: unknown) { push('warn', tag, msg, data); },
  error(tag: string, msg: string, data?: unknown) { push('error', tag, msg, data); },
};

if (typeof window !== 'undefined') {
  (window as any).__debugLog = {
    dump: () => ring.map(fmt).join('\n'),
    dumpJSON: () => ring.slice(),
    clear: () => { ring = []; pending = []; },
    count: () => ring.length,
  };
}