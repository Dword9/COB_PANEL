/**
 * Транспорт ноды «MIDI-трек»: mp3 + анализ нот на одной временной оси.
 *
 * Один рантайм на ноду. Мастер-клок — `HTMLAudioElement.currentTime`
 * (как в проверенной вкладке «Свет» music 2 midi): аудио тянет за собой
 * свет, а не наоборот, поэтому картинка не уезжает от музыки на длинном
 * треке. Тик света берётся из общего цикла графа (62 Гц), собственного
 * requestAnimationFrame здесь нет намеренно — иначе свет замерзал бы при
 * сворачивании окна (грабля оригинала).
 */

import { LightEngine, LightEngineParams, LightFrame, AnalysisData } from '../utils/lightEngine';
import { WashEngine, WashFrame, WashParams } from '../utils/washEngine';
import { BackstageWash, BackstageParams } from '../utils/backstageWash';
import { SectionKind, TrackProfile } from '../utils/trackProfile';
import { ScoreV1, scoreFingerprint, validateScore, AUTO_LIMITS } from '../utils/scoreModel';
import type { AutoTarget, AutomationLane, AutomationPoint } from '../utils/scoreModel';
import { ScorePlan, LaneState, compileScore, samplePlan, sampleAutomation } from '../utils/scoreCompiler';

type TrackRuntime = {
  audio: HTMLAudioElement;
  engine: LightEngine;
  /** заливной свет (верхние COB) по характеру музыки, не по уровню */
  wash: WashEngine;
  /** плавный фон кулисных RGB-парок (без строба, пульс только по ударам) */
  backstage: BackstageWash;
  /** url, по которому уже загружен анализ — чтобы не тянуть повторно */
  analysisUrl: string | null;
  /** url, уже присвоенный элементу audio */
  audioUrl: string | null;
  loading: boolean;
  error: string | null;
  duration: number;
  /**
   * Явный СТОП (кнопка ■, 28.07): кадр обнуляется — граф перестаёт писать
   * каналы, App гасит их в ноль и паркует мотор. Пауза сюда НЕ входит:
   * пауза = заморозить картинку, стоп = погасить.
   */
  halted: boolean;
  lastFrame: LightFrame | null;
  lastWash: WashFrame[] | null;
  lastBackstage: WashFrame[] | null;
  lastRenderMs: number;
  /**
   * Партитура (score, фаза 4.0): сырые данные из params + скомпилированный
   * план. Применяется ТОЛЬКО когда отпечаток совпадает с загруженным
   * анализом — иначе score молча игнорируется (статус 'stale' в UI).
   */
  score: ScoreV1 | null;
  scorePlan: ScorePlan | null;
  scoreErrors: string[];
  /** Состояние записи автоматизации (фаза 5): накапливаемые точки по целям */
  recActive: boolean;
  recPoints: Partial<Record<AutoTarget, AutomationPoint[]>>;
  recLastAt: Partial<Record<AutoTarget, number>>;
};

class MidiTrackManager {
  private runtimes: Record<string, TrackRuntime> = {};
  private stateCallbacks: Record<string, () => void> = {};

  getOrCreate(nodeId: string): TrackRuntime {
    let rt = this.runtimes[nodeId];
    if (!rt) {
      const audio = new Audio();
      audio.preload = 'auto';
      rt = {
        audio,
        engine: new LightEngine(40),
        wash: new WashEngine(),
        backstage: new BackstageWash(),
        analysisUrl: null,
        audioUrl: null,
        loading: false,
        error: null,
        duration: 0,
        halted: false,
        lastFrame: null,
        lastWash: null,
        lastBackstage: null,
        lastRenderMs: 0,
        score: null,
        scorePlan: null,
        scoreErrors: [],
        recActive: false,
        recPoints: {},
        recLastAt: {},
      };
      audio.addEventListener('loadedmetadata', () => {
        rt!.duration = audio.duration || rt!.duration;
        this.notify(nodeId);
      });
      audio.addEventListener('ended', () => this.notify(nodeId));
      audio.addEventListener('play', () => this.notify(nodeId));
      audio.addEventListener('pause', () => this.notify(nodeId));
      this.runtimes[nodeId] = rt;
    }
    return rt;
  }

  get(nodeId: string): TrackRuntime | undefined {
    return this.runtimes[nodeId];
  }

  onState(nodeId: string, cb: () => void) {
    this.stateCallbacks[nodeId] = cb;
  }

  offState(nodeId: string) {
    delete this.stateCallbacks[nodeId];
  }

  private notify(nodeId: string) {
    this.stateCallbacks[nodeId]?.();
  }

  destroy(nodeId: string) {
    const rt = this.runtimes[nodeId];
    if (!rt) return;
    try {
      rt.audio.pause();
      rt.audio.removeAttribute('src');
      rt.audio.load();
    } catch {}
    delete this.runtimes[nodeId];
    delete this.stateCallbacks[nodeId];
  }

  /** Подцепить аудио по url (идемпотентно). */
  setAudioUrl(nodeId: string, url: string | null) {
    const rt = this.getOrCreate(nodeId);
    if (rt.audioUrl === url) return;
    rt.audioUrl = url;
    if (!url) {
      try {
        rt.audio.pause();
        rt.audio.removeAttribute('src');
        rt.audio.load();
      } catch {}
      rt.duration = 0;
      this.notify(nodeId);
      return;
    }
    rt.audio.src = url;
    rt.audio.load();
  }

  /** Загрузить analysis.json по url (идемпотентно, с защитой от гонки). */
  async setAnalysisUrl(nodeId: string, url: string | null) {
    const rt = this.getOrCreate(nodeId);
    if (rt.analysisUrl === url) return;
    rt.analysisUrl = url;
    rt.engine.reset();
    if (!url) {
      rt.error = null;
      this.notify(nodeId);
      return;
    }
    rt.loading = true;
    rt.error = null;
    this.notify(nodeId);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: AnalysisData = await res.json();
      // Пока ждали сеть, юзер мог сменить файл — результат устарел.
      if (this.runtimes[nodeId] !== rt || rt.analysisUrl !== url) return;
      if (!data || !Array.isArray(data.tracks)) throw new Error('в файле нет tracks[]');
      rt.engine.load(data);
      rt.wash.setProfile(rt.engine.trackProfile);
      rt.backstage.setProfile(rt.engine.trackProfile);
      if (data.duration) rt.duration = Math.max(rt.duration, data.duration);
      rt.error = null;
    } catch (e: any) {
      if (this.runtimes[nodeId] !== rt || rt.analysisUrl !== url) return;
      rt.error = `анализ не загружен: ${e?.message || e}`;
      rt.engine.reset();
      rt.wash.setProfile(null);
      rt.backstage.setProfile(null);
    } finally {
      if (this.runtimes[nodeId] === rt && rt.analysisUrl === url) {
        rt.loading = false;
        this.notify(nodeId);
      }
    }
  }

  // --- Транспорт ---

  play(nodeId: string) {
    const rt = this.getOrCreate(nodeId);
    if (!rt.audioUrl) return;
    // Повторный Play в самом конце — с начала, а не «в никуда».
    if (rt.duration > 0 && rt.audio.currentTime >= rt.duration - 0.05) {
      this.seek(nodeId, 0);
    }
    // Выход из режима СТОП: рендер снова разрешён (пауза его не ставит).
    rt.halted = false;
    rt.audio.play().catch(() => {});
  }

  pause(nodeId: string) {
    this.runtimes[nodeId]?.audio.pause();
  }

  toggle(nodeId: string) {
    const rt = this.getOrCreate(nodeId);
    if (rt.audio.paused) this.play(nodeId);
    else this.pause(nodeId);
  }

  /**
   * СТОП: обнулить сигнал (просьба 28.07: «стоп пусть обнуляет, а не
   * замораживает — заморозка это пауза»). halted → render/renderWash
   * отдают null → граф перестаёт писать каналы → App гасит их в ноль и
   * паркует мотор. Позиция сбрасывается в 0 для следующего пуска.
   */
  stop(nodeId: string) {
    const rt = this.runtimes[nodeId];
    if (!rt) return;
    rt.audio.pause();
    rt.halted = true;
    this.seek(nodeId, 0);
    rt.lastFrame = null;
    rt.lastWash = null;
    rt.lastBackstage = null;
    rt.wash.reset();
    rt.backstage.reset();
    rt.lastRenderMs = 0;
    this.notify(nodeId);
  }

  seek(nodeId: string, t: number, release = 0.28) {
    const rt = this.runtimes[nodeId];
    if (!rt) return;
    const clamped = Math.max(0, rt.duration > 0 ? Math.min(t, rt.duration) : t);
    try {
      rt.audio.currentTime = clamped;
    } catch {}
    rt.engine.seek(clamped, release);
    rt.wash.seek(clamped);
    rt.backstage.seek(clamped);
    rt.lastRenderMs = 0;
    this.notify(nodeId);
  }

  setVolume(nodeId: string, v: number) {
    const rt = this.getOrCreate(nodeId);
    rt.audio.volume = Math.max(0, Math.min(1, v));
  }

  /**
   * Локальный звук вкл/выкл без трогания громкости. Режим «СИНХРОН» (28.07):
   * песню играет пульт звукача, наш элемент крутится muted — его currentTime
   * остаётся мастер-клоком света, а audioSyncFollower его подправляет.
   */
  setMuted(nodeId: string, muted: boolean) {
    const rt = this.getOrCreate(nodeId);
    rt.audio.muted = muted;
  }

  getTime(nodeId: string): number {
    return this.runtimes[nodeId]?.audio.currentTime ?? 0;
  }

  getDuration(nodeId: string): number {
    const rt = this.runtimes[nodeId];
    if (!rt) return 0;
    return rt.duration || rt.audio.duration || 0;
  }

  isPlaying(nodeId: string): boolean {
    const rt = this.runtimes[nodeId];
    return !!rt && !rt.audio.paused && !rt.audio.ended;
  }

  isLoaded(nodeId: string): boolean {
    return !!this.runtimes[nodeId]?.engine.isLoaded;
  }

  getStatus(nodeId: string): { loading: boolean; error: string | null; notes: number } {
    const rt = this.runtimes[nodeId];
    return {
      loading: !!rt?.loading,
      error: rt?.error ?? null,
      notes: rt?.engine.noteCount ?? 0,
    };
  }

  /**
   * Посчитать световой кадр. Вызывается из тика графа.
   * СТОП (halted) — null: каналы перестают писаться и гаснут в ноль.
   * ПАУЗА — время заморожено (dt=0, музыкальная картинка стоит), но кадр
   * ПЕРЕСЧИТЫВАЕТСЯ: внешние фейдеры (наклон/цвет/яркость) обязаны жить
   * на стоящем треке, как на любом пульте (жалоба 28.07: «вход наклона
   * не работает» — он был жив только во время воспроизведения).
   * Пауза до первого пуска — null (нечего показывать, не зажигаемся сами).
   */
  render(nodeId: string, params: LightEngineParams, force = false): LightFrame | null {
    const rt = this.runtimes[nodeId];
    if (!rt || !rt.engine.isLoaded) return null;

    const playing = this.isPlaying(nodeId);
    if (rt.halted) return null;
    if (!playing && !force && !rt.lastFrame) return null;

    const now = performance.now();
    // Первый кадр после старта/перемотки: интервал неизвестен, берём
    // номинальный шаг тика, иначе dt=огромный и движок уйдёт в ресинк.
    const dt = rt.lastRenderMs === 0 ? 0.016 : Math.max(0, (now - rt.lastRenderMs) / 1000);
    rt.lastRenderMs = now;

    rt.lastFrame = rt.engine.render(rt.audio.currentTime, params, playing ? dt : 0);
    return rt.lastFrame;
  }

  /**
   * Кадр заливного света (верхние COB). Считается ПОСЛЕ render(), потому что
   * использует энергию расчёсок как модулятор внутри манеры участка.
   * Те же правила: стоп → null, пауза → замороженное время, живые входы.
   */
  renderWash(nodeId: string, params: WashParams, force = false): WashFrame[] | null {
    const rt = this.runtimes[nodeId];
    if (!rt || !rt.engine.isLoaded) return null;
    const playing = this.isPlaying(nodeId);
    if (rt.halted) return null;
    if (!playing && !force && !rt.lastFrame) return rt.lastWash;
    const energy = rt.lastFrame?.energy ?? 0;
    rt.lastWash = rt.wash.render(rt.audio.currentTime, energy, params);
    return rt.lastWash;
  }

  /** Текущая манера заливки — для подписи в UI. */
  washKind(nodeId: string): SectionKind | null {
    const rt = this.runtimes[nodeId];
    if (!rt || !rt.engine.isLoaded || rt.halted) return null;
    return rt.wash.kindAt(rt.audio.currentTime);
  }

  /**
   * Плавный фон кулисных RGB-парок. Те же правила: стоп → null, пауза →
   * замороженное время (кадр синусоидальный от t — идентичен), входы живы.
   */
  renderBackstage(nodeId: string, params: BackstageParams, force = false): WashFrame[] | null {
    const rt = this.runtimes[nodeId];
    if (!rt || !rt.engine.isLoaded) return null;
    const playing = this.isPlaying(nodeId);
    if (rt.halted) return null;
    if (!playing && !force && !rt.lastFrame) return rt.lastBackstage;
    rt.lastBackstage = rt.backstage.render(rt.audio.currentTime, params);
    return rt.lastBackstage;
  }

  /** Есть ли ударные в анализе — для подписи в UI («пульс по кикам»). */
  backstageDrums(nodeId: string): boolean {
    const rt = this.runtimes[nodeId];
    return !!rt && rt.backstage.drumsPresent;
  }

  /** Индекс текущей секции профиля (для ротации сцен проекции, 28.07). */
  sectionIndex(nodeId: string): number {
    const rt = this.runtimes[nodeId];
    const prof = rt?.engine.trackProfile;
    if (!rt || !prof) return 0;
    const t = rt.audio.currentTime;
    const ss = prof.sections;
    for (let i = ss.length - 1; i >= 0; i--) {
      if (t >= ss[i].start) return i;
    }
    return 0;
  }

  /** Сбросить накопленный кадр (используется при выключении ноды). */
  clearFrame(nodeId: string) {
    const rt = this.runtimes[nodeId];
    if (!rt) return;
    rt.lastFrame = null;
    rt.lastWash = null;
    rt.lastBackstage = null;
    rt.wash.reset();
    rt.backstage.reset();
    rt.lastRenderMs = 0;
  }

  // --- Партитура (score, фаза 4.0) ----------------------------------------

  /** Установить/сменить score ноды (вызывается из useMidiTrack по params). */
  setScore(nodeId: string, score: ScoreV1 | null) {
    const rt = this.runtimes[nodeId];
    if (!rt) return;
    rt.score = score;
    if (!score) {
      rt.scorePlan = null;
      rt.scoreErrors = [];
      return;
    }
    rt.scoreErrors = validateScore(score);
    rt.scorePlan = rt.scoreErrors.length === 0 ? compileScore(score) : null;
  }

  /** Автопрофиль трека (для генерации черновика в редакторе). */
  getProfile(nodeId: string): TrackProfile | null {
    return this.runtimes[nodeId]?.engine.trackProfile ?? null;
  }

  /** Отпечаток ЗАГРУЖЕННОГО анализа (null — анализа нет). */
  scoreFingerprintNow(nodeId: string): string | null {
    const rt = this.runtimes[nodeId];
    if (!rt?.engine.isLoaded) return null;
    const prof = rt.engine.trackProfile;
    return scoreFingerprint(rt.analysisUrl, prof?.duration ?? rt.duration, rt.engine.noteCount);
  }

  /** Статус партитуры для UI: нет / валидна / устарела (другой трек) / битая. */
  scoreStatus(nodeId: string): 'none' | 'ok' | 'stale' | 'invalid' {
    const rt = this.runtimes[nodeId];
    if (!rt?.score) return 'none';
    if (rt.scoreErrors.length > 0) return 'invalid';
    const fp = this.scoreFingerprintNow(nodeId);
    if (fp === null) return 'ok'; // анализ ещё не загружен — не ругаемся
    return rt.score!.fingerprint === fp ? 'ok' : 'stale';
  }

  /** Секции скомпилированной партитуры (лента в редакторе). */
  scoreSections(nodeId: string) {
    return this.runtimes[nodeId]?.scorePlan?.sections ?? [];
  }

  /**
   * Семантические модификаторы слоёв на текущее время транспорта.
   * null — score нет/битый/отпечаток устарел/анализ не загружен: движок
   * работает ровно как раньше. Чистая функция времени — seek/пауза
   * детерминированы, состояния между вызовами нет.
   */
  scoreMods(nodeId: string): Record<string, LaneState> | null {
    const rt = this.runtimes[nodeId];
    if (!rt?.scorePlan || !rt.engine.isLoaded) return null;
    const fp = this.scoreFingerprintNow(nodeId);
    if (fp === null || rt.score!.fingerprint !== fp) return null;
    return samplePlan(rt.scorePlan, rt.audio.currentTime);
  }

  // --- Запись автоматизации (фаза 5) ---------------------------------------

  /**
   * Абсолютные значения автоматизированных параметров на текущее время.
   * Та же гейт-логика, что у scoreMods: без score/анализа/при устаревшем
   * отпечатке — null (движок работает по слайдерам, как раньше).
   */
  scoreAutomation(nodeId: string): Partial<Record<AutoTarget, number>> | null {
    const rt = this.runtimes[nodeId];
    if (!rt?.scorePlan || !rt.engine.isLoaded) return null;
    const fp = this.scoreFingerprintNow(nodeId);
    if (fp === null || rt.score!.fingerprint !== fp) return null;
    return sampleAutomation(rt.score!.automation, rt.audio.currentTime);
  }

  isRecording(nodeId: string): boolean {
    return !!this.runtimes[nodeId]?.recActive;
  }

  /** Начать запись. false — нет score (хук сначала создаёт пустой каркас). */
  startScoreRec(nodeId: string): boolean {
    const rt = this.runtimes[nodeId];
    if (!rt?.score) return false;
    rt.recActive = true;
    rt.recPoints = {};
    rt.recLastAt = {};
    return true;
  }

  /**
   * Точка записи: троттлинг ~10 Гц на цель + порог изменения, чтобы не
   * копить мусор. На паузе (t заморожено) точка с тем же t перезаписывается.
   */
  scoreRecPoint(nodeId: string, target: AutoTarget, v: number) {
    const rt = this.runtimes[nodeId];
    if (!rt?.recActive) return;
    const lim = AUTO_LIMITS[target];
    const vv = Math.max(lim[0], Math.min(lim[1], v));
    const t = rt.audio.currentTime;
    const lastAt = rt.recLastAt[target] ?? -1;
    if (t - lastAt < 0.1) return;
    const pts = (rt.recPoints[target] ??= []);
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.t - t) < 0.001) { last.v = vv; return; }
    if (last && Math.abs(last.v - vv) < 0.004 && t - lastAt < 0.5) return;
    pts.push({ t, v: vv });
    rt.recLastAt[target] = t;
  }

  /** Стоп записи: собранные дорожки (overdub-мердж делает mergeAutomation). */
  stopScoreRec(nodeId: string): AutomationLane[] {
    const rt = this.runtimes[nodeId];
    if (!rt) return [];
    rt.recActive = false;
    const lanes: AutomationLane[] = Object.entries(rt.recPoints)
      .filter(([, pts]) => (pts?.length ?? 0) > 0)
      .map(([target, pts]) => ({
        id: `auto-${target}-${Date.now()}`,
        target: target as AutoTarget,
        points: pts!.slice(),
      }));
    rt.recPoints = {};
    rt.recLastAt = {};
    return lanes;
  }
}

export const midiTrackManager = new MidiTrackManager();
