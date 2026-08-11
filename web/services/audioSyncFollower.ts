/**
 * Синхрон со входом звукача (кнопка «СИНХРОН» в ноде MIDI-трек, 28.07).
 *
 * Сценарий: песню играет ДИДЖЕЙ со своего пульта, сигнал приходит в линейный
 * вход звуковой карты (у юзера — внешняя карта, каналы 3/4). Локально MP3 не
 * запускают руками: follower слушает вход, по спектру находит, где сейчас
 * диджей в треке, и ВЕДЁТ транспорт midiTrackManager (позиция через seek,
 * тишина у диджея → пауза). Локальный звук при этом muted — в зал играет пульт.
 *
 * Метод: лог-спектрограмма (12 полос 30 Гц..8 кГц, кадр ~93 мс) эталонного MP3
 * против скользящего окна (≤12 с) живого входа. Позиция = максимум
 * нормированной кросс-корреляции. Каждый кадр нормирован (среднее 0, σ 1),
 * поэтому громкость пульта не важна.
 *
 * Потеря синхры (выбор за юзера, 28.07): «coast» — транспорт едет по своим
 * часам дальше (свет не замирает посреди номера), синхра вернулась — лок.
 * Тишина во входе >1.5 с (диджей на паузе) → пауза и у нас.
 */

import { midiTrackManager } from './midiTrackManager';

// --- Настройки --------------------------------------------------------------
const REF_SR = 22050;        // частота эталона (достаточно для полос до 8 кГц)
const FFT_SIZE = 4096;       // окно FFT (93+93 мс перекрытие)
const HOP = 2048;            // шаг ~92.9 мс @22050 → 10.76 кадр/с
const BANDS = 12;            // лог-полосы
const F_MIN = 30, F_MAX = 8000;
const WIN_S = 12;            // скользящее окно живого сигнала, с
const MIN_WIN_S = 6;         // первый лок возможен уже по 6 с окна
const LIVE_PULL_MS = 90;     // период съёма кадра с анализатора (~fps эталона)
const MATCH_MS = 500;        // период поиска корреляции
const CTRL_MS = 250;         // период ведения транспорта
const LOCK_SCORE = 0.5;      // порог NCC для лока
const LOCK_MARGIN = 0.02;    // отрыв от второго кандидата (вне ±полуокна)
const LOCK_HOLD_MISS = 3;    // сколько промахов подряд держим лок
const SEEK_DRIFT = 0.18;     // расхождение часов, больше → seek
const SILENCE_DB = -68;      // средний dB окна ниже — у диджея тишина
const SILENCE_PAUSE_S = 1.5; // тишина дольше — ставим и себя на паузу
export const SYNC_LOOKAHEAD = 0.30; // компенсация задержки захвата+матчинга, с

export type SyncMode = 'off' | 'starting' | 'locked' | 'coast' | 'silent';

export interface SyncState {
  mode: SyncMode;
  /** позиция в треке (с), актуальна в locked; в coast — «по нашим часам» */
  position: number;
  /** сила последнего совпадения 0..1 */
  confidence: number;
  /** id ноды, чей транспорт ведём */
  attachId: string | null;
  /** сколько секунд окна накоплено (для «слушаю… 8/12 с») */
  windowSec: number;
  /** каналов реально дала карта */
  channels: number;
  error: string | null;
}

// --- Чистая математика (тестируется в node, без WebAudio) --------------------

const bandEdges = (): Float64Array => {
  const e = new Float64Array(BANDS + 1);
  for (let k = 0; k <= BANDS; k++) e[k] = F_MIN * Math.pow(F_MAX / F_MIN, k / BANDS);
  return e;
};

/** Диапазоны бинов [lo, hi] для каждой полосы при данном sampleRate/fftSize. */
const bandBins = (sampleRate: number, fftSize: number): Array<[number, number]> => {
  const e = bandEdges();
  const binHz = sampleRate / fftSize;
  const maxBin = fftSize / 2 - 1;
  const out: Array<[number, number]> = [];
  for (let k = 0; k < BANDS; k++) {
    const lo = Math.max(1, Math.ceil(e[k] / binHz));       // DC-бин не берём
    const hi = Math.min(maxBin, Math.floor(e[k + 1] / binHz));
    out.push([lo, Math.max(lo, hi)]);
  }
  return out;
};

/** Radix-2 FFT in-place (re/im длиной 2^k). Компактная реализация для эталона. */
function fftInPlace(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = i + k + half;
        const vr = re[b] * cwr - im[b] * cwi;
        const vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
}

/** Нормировка каждого кадра: среднее 0, σ 1. Тишина (σ≈0) → нулевой кадр. */
export function normalizeFrames(data: Float32Array, frames: number, bands = BANDS) {
  for (let f = 0; f < frames; f++) {
    const off = f * bands;
    let mean = 0;
    for (let b = 0; b < bands; b++) mean += data[off + b];
    mean /= bands;
    let v = 0;
    for (let b = 0; b < bands; b++) { const d = data[off + b] - mean; v += d * d; }
    const std = Math.sqrt(v / bands);
    if (std < 1e-6) { for (let b = 0; b < bands; b++) data[off + b] = 0; continue; }
    for (let b = 0; b < bands; b++) data[off + b] = (data[off + b] - mean) / std;
  }
}

/**
 * Спектрограмма PCM-моно: 12 лог-полос на кадр (~93 мс), значения в dB,
 * кадры нормированы. Асинхронная порциями — 15-мин трек не вешает UI.
 */
export async function spectrogramFromPcm(
  pcm: Float32Array, sampleRate: number,
  onProgress?: (frac: number) => void,
): Promise<{ data: Float32Array; frames: number; frameSec: number; duration: number }> {
  const frames = Math.max(0, Math.floor((pcm.length - FFT_SIZE) / HOP) + 1);
  const data = new Float32Array(frames * BANDS);
  const bins = bandBins(sampleRate, FFT_SIZE);
  const re = new Float32Array(FFT_SIZE), im = new Float32Array(FFT_SIZE);
  // Окно Ханна заранее
  const hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  let yieldMark = 0;
  for (let f = 0; f < frames; f++) {
    const base = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) { re[i] = pcm[base + i] * hann[i]; im[i] = 0; }
    fftInPlace(re, im);
    const fo = f * BANDS;
    for (let k = 0; k < BANDS; k++) {
      const [lo, hi] = bins[k];
      let acc = 0;
      for (let i = lo; i <= hi; i++) acc += Math.hypot(re[i], im[i]);
      // mean magnitude → dB; шкала свободная — нормировка кадра её снимет
      data[fo + k] = 20 * Math.log10(acc / (hi - lo + 1) + 1e-9);
    }
    if (f - yieldMark >= 150) {
      yieldMark = f;
      onProgress?.(f / frames);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  normalizeFrames(data, frames);
  onProgress?.(1);
  return { data, frames, frameSec: HOP / sampleRate, duration: pcm.length / sampleRate };
}

export interface MatchResult {
  /** лучший сдвиг в кадрах эталона; -1 = окно длиннее эталона */
  offset: number;
  /** NCC лучшего (−1..1, нормированные кадры → косинус) */
  score: number;
  /** отрыв от лучшего кандидата вне ±полуокна (защита от автокорреляции) */
  margin: number;
}

/** Нормированная кросс-корреляция окна по эталону (двухпроходная, честный margin). */
export function matchWindow(
  ref: Float32Array, refFrames: number,
  win: Float32Array, winFrames: number,
  bands = BANDS,
): MatchResult {
  const span = refFrames - winFrames;
  if (span < 0 || winFrames <= 0) return { offset: -1, score: 0, margin: 0 };
  const cell = winFrames * bands;
  const scan = (skipOff: number, skipRad: number): { s: number; o: number } => {
    let best = -Infinity, bestO = 0;
    for (let o = 0; o <= span; o++) {
      if (skipRad >= 0 && Math.abs(o - skipOff) <= skipRad) continue;
      let acc = 0;
      let ri = o * bands;
      for (let t = 0; t < winFrames; t++) {
        const wi = t * bands;
        for (let b = 0; b < bands; b++) acc += win[wi + b] * ref[ri + b];
        ri += bands;
      }
      const s = acc / cell;
      if (s > best) { best = s; bestO = o; }
    }
    return { s: best, o: bestO };
  };
  const first = scan(-1, -1);
  const second = scan(first.o, winFrames >> 1);
  return { offset: first.o, score: first.s, margin: first.s - second.s };
}

/** Решение «лок/не лок» по силе и отрыву. */
export const isLock = (score: number, margin: number): boolean =>
  score >= LOCK_SCORE && margin >= LOCK_MARGIN;

// --- Живой сервис (браузер) --------------------------------------------------

class AudioSyncFollower {
  private ref: Float32Array | null = null;
  private refFrames = 0;
  private refUrl: string | null = null;
  private refDuration = 0;
  private refPromise: Promise<void> | null = null;

  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private liveBins: Array<[number, number]> = [];
  private freqBuf: Float32Array = new Float32Array(0);

  private winBuf: Float32Array;         // кольцевое окно живых кадров
  private winCap: number;               // кадров в окне (= WIN_S * fps)
  private winLen = 0;                   // накоплено кадров
  private winPos = 0;                   // куда писать следующий
  private liveDbAvg = -100;

  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private matchTimer: ReturnType<typeof setInterval> | null = null;
  private ctrlTimer: ReturnType<typeof setInterval> | null = null;

  private state: SyncState = {
    mode: 'off', position: 0, confidence: 0, attachId: null,
    windowSec: 0, channels: 0, error: null,
  };
  private listeners = new Set<(s: SyncState) => void>();
  private missStreak = 0;
  private silentSince = 0;
  private lastPosition = 0;

  constructor() {
    const fps = 1000 / LIVE_PULL_MS;
    this.winCap = Math.ceil(WIN_S * fps) + 2;
    this.winBuf = new Float32Array(this.winCap * BANDS);
  }

  onChange(cb: (s: SyncState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getState(): SyncState { return { ...this.state }; }
  get attachId(): string | null { return this.state.attachId; }
  get duration(): number { return this.refDuration; }

  private notify() {
    const s = this.getState();
    this.listeners.forEach(cb => cb(s));
  }

  private set(patch: Partial<SyncState>) {
    Object.assign(this.state, patch);
    this.notify();
  }

  /** Эталонный отпечаток по url аудио (идемпотентно, с защитой от гонки). */
  private async ensureReference(url: string): Promise<void> {
    if (this.refUrl === url && this.ref) return;
    if (!this.refPromise || this.refUrl !== url) {
      this.refUrl = url;
      this.ref = null;
      this.refPromise = (async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await (res.arrayBuffer());
        // decodeAudioData — на временном контексте, затем ресемпл в 22050
        const tmp = new AudioContext();
        try {
          const decoded = await tmp.decodeAudioData(buf);
          const outLen = Math.ceil(decoded.duration * REF_SR);
          const off = new OfflineAudioContext(1, outLen, REF_SR);
          const src = off.createBufferSource();
          src.buffer = decoded;
          src.connect(off.destination);
          src.start(0);
          const rendered = await off.startRendering();
          const pcm = rendered.getChannelData(0);
          // Пока считали, юзер мог переключить трек
          if (this.refUrl !== url) return;
          const spec = await spectrogramFromPcm(pcm, REF_SR);
          if (this.refUrl !== url) return;
          this.ref = spec.data;
          this.refFrames = spec.frames;
          this.refDuration = spec.duration;
        } finally {
          tmp.close().catch(() => {});
        }
      })();
    }
    await this.refPromise;
    if (!this.ref || this.refUrl !== url) throw new Error('эталон не готов');
  }

  /**
   * Запуск синхры для ноды: эталон ← аудио ноды, захват ← выбранная карта,
   * транспорт ноды ведём мы. Повторный вызов с теми же параметрами — no-op.
   */
  async start(nodeId: string, audioUrl: string, deviceId?: string, chBase = 0): Promise<void> {
    if (typeof window === 'undefined') return;
    const running = this.state.attachId === nodeId && this.pullTimer !== null;
    if (running && this.refUrl === audioUrl) return;
    this.set({ mode: 'starting', attachId: nodeId, error: null, confidence: 0 });
    try {
      await this.ensureReference(audioUrl);
      if (this.state.attachId !== nodeId) return; // перехвачено другой нодой
      await this.startCapture(deviceId, chBase);
      if (this.state.attachId !== nodeId) return;
      this.winLen = 0; this.winPos = 0;
      this.missStreak = 0; this.silentSince = 0;
      this.startTimers();
      this.set({ mode: 'starting', error: null });
    } catch (e: any) {
      const msg = e?.name === 'NotAllowedError'
        ? 'нет доступа ко входу — разреши микрофон/линейный вход в браузере'
        : (e?.message || String(e));
      this.set({ mode: 'off', attachId: null, error: `синхрон не запустился: ${msg}` });
      this.stopCapture();
    }
  }

  /** Остановить всё. Если передан nodeId — останавливаем, только если ведём его. */
  stop(nodeId?: string) {
    if (nodeId && this.state.attachId !== nodeId) return;
    this.stopTimers();
    this.stopCapture();
    this.set({ mode: 'off', attachId: null, confidence: 0, windowSec: 0 });
  }

  private async startCapture(deviceId: string | undefined, chBase: number) {
    this.stopCapture();
    const constraints: MediaStreamConstraints = {
      audio: {
        // Музыке обработка вредит: АРУ/шумодав/эхоподавление портят отпечаток
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: Math.max(2, chBase + 2) } as any,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      } as any,
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = this.stream.getAudioTracks()[0];
    const settings: any = track?.getSettings?.() || {};
    const channels = settings.channelCount || 2;
    this.ctx = this.ctx || new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0; // отпечатку нужны живые кадры
    if (chBase === 0) {
      // Стерео 1/2 → даунмикс в моно самим анализатором
      this.analyser.channelCount = 1;
      this.analyser.channelCountMode = 'explicit';
      this.analyser.channelInterpretation = 'speakers';
      src.connect(this.analyser);
    } else {
      if (channels < chBase + 2) {
        this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
        throw new Error(`карта дала только ${channels} канала(ов) — вход 3/4 недоступен`);
      }
      // Каналы 3/4: сплиттер → два полу-гейна → моно
      const splitter = this.ctx.createChannelSplitter(channels);
      src.connect(splitter);
      const mix = this.ctx.createGain();
      for (const c of [chBase, chBase + 1]) {
        const g = this.ctx.createGain();
        g.gain.value = 0.5;
        splitter.connect(g, c);
        g.connect(mix);
      }
      mix.connect(this.analyser);
    }
    this.liveBins = bandBins(this.ctx.sampleRate, FFT_SIZE);
    this.freqBuf = new Float32Array(this.analyser.frequencyBinCount);
    this.set({ channels });
  }

  private startTimers() {
    this.stopTimers();
    this.pullTimer = setInterval(() => this.pullFrame(), LIVE_PULL_MS);
    this.matchTimer = setInterval(() => this.matchNow(), MATCH_MS);
    this.ctrlTimer = setInterval(() => this.controlTick(), CTRL_MS);
  }

  private stopTimers() {
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.matchTimer) clearInterval(this.matchTimer);
    if (this.ctrlTimer) clearInterval(this.ctrlTimer);
    this.pullTimer = this.matchTimer = this.ctrlTimer = null;
  }

  private stopCapture() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.analyser = null;
  }

  /** Кадр живого входа → 12 нормированных полос в кольцевое окно. */
  private pullFrame() {
    if (!this.analyser) return;
    this.analyser.getFloatFrequencyData(this.freqBuf);
    const off = this.winPos * BANDS;
    let dbSum = 0;
    for (let k = 0; k < BANDS; k++) {
      const [lo, hi] = this.liveBins[k];
      let acc = 0;
      for (let i = lo; i <= hi && i < this.freqBuf.length; i++) acc += this.freqBuf[i];
      const db = acc / (hi - lo + 1);
      this.winBuf[off + k] = db;
      dbSum += db;
    }
    // Нормировать надо кадр в окне — normalizeFrames работает на месте
    normalizeFrames(this.winBuf.subarray(off, off + BANDS), 1, BANDS);
    this.liveDbAvg = dbSum / BANDS;
    this.winPos = (this.winPos + 1) % this.winCap;
    if (this.winLen < this.winCap) this.winLen++;
  }

  /** Собрать окно в линейный массив (старые → новые) и найти позицию. */
  private matchNow() {
    if (!this.ref || this.winLen < MIN_WIN_S * (1000 / LIVE_PULL_MS)) {
      this.set({ windowSec: this.winLen * LIVE_PULL_MS / 1000 });
      return;
    }
    const n = Math.min(this.winLen, this.winCap);
    const win = new Float32Array(n * BANDS);
    const start = (this.winPos - n + this.winCap) % this.winCap;
    for (let t = 0; t < n; t++) {
      const srcOff = ((start + t) % this.winCap) * BANDS;
      win.set(this.winBuf.subarray(srcOff, srcOff + BANDS), t * BANDS);
    }
    const m = matchWindow(this.ref, this.refFrames, win, n);
    if (m.offset < 0) { this.set({ mode: 'coast' }); return; }
    const frameSec = HOP / REF_SR;
    const pos = (m.offset + n) * frameSec + SYNC_LOOKAHEAD;
    this.set({ confidence: Math.max(0, m.score), windowSec: n * LIVE_PULL_MS / 1000 });
    if (isLock(m.score, m.margin)) {
      this.missStreak = 0;
      this.lastPosition = pos;
      this.set({ mode: 'locked', position: pos });
    } else {
      this.missStreak++;
      if (this.missStreak > LOCK_HOLD_MISS) this.set({ mode: 'coast' });
    }
  }

  /** Ведение транспорта ноды: лок → поправка часов, тишина → пауза. */
  private controlTick() {
    const id = this.state.attachId;
    if (!id) return;
    const rt = midiTrackManager.get(id);
    if (!rt) return; // нода удалена — тикаем вхолостую, UI сам выключит
    const now = performance.now();
    if (this.liveDbAvg < SILENCE_DB) {
      if (!this.silentSince) this.silentSince = now;
      if ((now - this.silentSince) / 1000 > SILENCE_PAUSE_S) {
        if (midiTrackManager.isPlaying(id)) midiTrackManager.pause(id);
        if (this.state.mode !== 'silent') this.set({ mode: 'silent' });
        return;
      }
    } else {
      this.silentSince = 0;
    }
    // Сигнал есть — транспорт должен играть (muted, звук даёт пульт)
    if (!midiTrackManager.isPlaying(id)) midiTrackManager.play(id);
    if (this.state.mode === 'locked') {
      const drift = this.lastPosition - midiTrackManager.getTime(id);
      if (Math.abs(drift) > SEEK_DRIFT) {
        // seek() сам ресинхронизирует световые движки (engine/wash)
        midiTrackManager.seek(id, this.lastPosition);
      }
    }
  }
}

export const audioSyncFollower = new AudioSyncFollower();
