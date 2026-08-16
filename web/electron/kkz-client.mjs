/**
 * Общий KKZ-клиент для ноды KkzNode.tsx (renderer) и трея main.cjs (Electron
 * main). Единый источник правды по URL/PIN и низкоуровневому fetch с
 * таймаутом и маппингом ошибок. Импортируется из TS через Vite (ESM) и из
 * CJS main.cjs через динамический import(). Зависимостей нет.
 */

export const KKZ_URL = 'https://kkz-button.207.174.31.143.sslip.io:8445';
export const KKZ_PIN = '3033';
export const KKZ_TIMEOUT_MS = 4000;

/**
 * fetch с заголовком X-Pin, AbortController-таймаутом и нормализацией ошибок.
 * @param {string} url  базовый URL сервера (может быть персональным в ноде)
 * @param {string} path путь вида /api/status
 * @param {object} [opts]
 * @param {string} [opts.pin=KKZ_PIN]
 * @param {string} [opts.method='GET']
 * @param {object|string} [opts.body] тело — сериализуется в JSON, если не строка
 * @param {object} [opts.headers] дополнительные заголовки (X-Pin проставляется сам)
 * @param {number} [opts.timeout=KKZ_TIMEOUT_MS] мс
 * @returns {Promise<any>} распарсенный JSON-ответ
 */
export async function kkzFetch(url, path, { pin = KKZ_PIN, method = 'GET', body, headers = {}, timeout = KKZ_TIMEOUT_MS } = {}) {
  const h = { 'X-Pin': pin, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: ctrl.signal,
    });
    if (res.status === 403) throw new Error('Неверный PIN');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}
