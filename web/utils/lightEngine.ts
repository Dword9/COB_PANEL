/**
 * Ядро реактивного света: ноты + время -> буфер лучей RGBW + угол наклона.
 *
 * Портирован рабочий движок вкладки «Свет» из `music 2 midi\web_ui.html`
 * (проверен на железе 24.07). Здесь он очищен от DOM: параметры приходят
 * объектом, наружу отдаётся только буфер. Всё, что связано с canvas и
 * WebSocket, вынесено за пределы модуля.
 *
 * Отличия от оригинала (сознательные, не рефакторинг ради рефакторинга):
 *  1. Пик-за-интервал. Оригинал сэмплировал состояние в момент t: нота,
 *     которая началась и умерла между двумя кадрами (25-33 мс), не давала
 *     ни одной вспышки — удары «проваливались». Теперь движок знает
 *     границы интервала [tPrev, t] и любая нота, стартовавшая внутри,
 *     обязана дать пик.
 *  2. Минимальная длительность вспышки (minFlashFrames). Беспроводной DMX
 *     теряет пакеты, прошивки китайских расчёсок сглаживают вход — вспышка
 *     в один кадр может не долететь. Пик удерживается N кадров.
 *     Значение подбирается на репетиции, 1 = поведение оригинала.
 */

import { buildProfile, TrackProfile } from './trackProfile';

// --- Данные ---

/** Нота в том виде, в каком её отдаёт analysis.json из music 2 midi. */
export interface LightNote {
  pitch: number;
  start: number;
  end: number;
  /** уровень RMS в окне атаки, 0..1 */
  lvl: number;
  /** спектральный уровень на f0 (+ 0.35 на 2f0), 0..1 */
  spec: number;
  /** индекс дорожки-источника, для будущей маршрутизации по инструментам */
  track?: number;
}

/** Дорожка из analysis.json (нужны только эти поля). */
export interface AnalysisTrack {
  id: number;
  name?: string;
  is_drum?: boolean;
  notes: Array<{ pitch: number; start: number; end: number; lvl?: number; spec?: number }>;
}

export interface AnalysisData {
  duration: number;
  tracks: AnalysisTrack[];
}

export type Palette = 'thermal' | 'rainbow' | 'mono';
export type LevelSource = 'spec' | 'rms';
export type PosMode = 'keys' | 'walk';
export type PitchRange = 'dense' | 'full';

export interface LightEngineParams {
  /** зеркалить картинку относительно центра линейки */
  symmetry: boolean;
  /** множитель ширины пятна, 1 = базовая */
  width: number;
  /** спад ноты после note-off, сек */
  release: number;
  /** множитель яркости, 1 = базовая */
  brightness: number;
  /**
   * Статичный наклон внутри диапазона, 0..1 (0 = tiltMin, 1 = tiltMax).
   * Раньше это был «размах встроенного LFO» — LFO убран (юзер 26.07), параметр
   * стал просто положением головы, которое можно крутить фейдером или
   * задавать LFO-нодой генератора снаружи.
   */
  tilt: number;
  /**
   * Диапазон хода мотора в шкале DMX: 0 = в зал, 128 = центр, 255 = вверх.
   * Качание НИКОГДА не выходит за эти границы. Центр вычисляется как середина
   * диапазона — отдельного «направления» нет намеренно: два независимых
   * параметра (центр + размах) юзер справедливо назвал непонятными, а в старой
   * ноде comb-controller работал именно диапазон (26.07).
   */
  tiltMin: number;
  tiltMax: number;
  /** какой уровень брать из ноты */
  levelSource: LevelSource;
  palette: Palette;
  /**
   * Сдвиг палитры по кругу, 0..1 (= 0..360°). Живой фейдер: 0 — как задумано
   * палитрой, 0.5 — противоположный край цветового круга. Позволяет увести
   * всю картинку в красный/зелёный/синий, не переключая палитру кнопкой.
   */
  hueShift: number;
  /**
   * Насыщенность, 0..1. На 0 картинка обесцвечивается в белый —
   * удобно для «вспышечных» кусков и для чистого COB-заливного.
   */
  saturation: number;
  /** pitch -> позиция или контурный «бегунок» */
  posMode: PosMode;
  /** нормировать pitch по p10..p90 (dense) или по min..max (full) */
  range: PitchRange;
  /**
   * Сколько кадров минимум держать пик ноты. 1 — как в оригинале,
   * 2-3 — надёжная вспышка через беспроводной DMX. Диапазон 1..4.
   */
  minFlashFrames: number;
}

export const DEFAULT_LIGHT_PARAMS: LightEngineParams = {
  symmetry: true,
  width: 1,
  release: 0.28,
  brightness: 1,
  tilt: 0.6,
  tiltMin: 150,
  tiltMax: 255,
  levelSource: 'spec',
  palette: 'thermal',
  hueShift: 0,
  saturation: 0.95,
  posMode: 'keys',
  range: 'dense',
  minFlashFrames: 2,
};

export interface LightFrame {
  /** RGBW по лучам, длина pixelCount*4, «линейные» 0..1.5 */
  px: Float32Array;
  /** готовое значение канала мотора, 0..255 (уже с учётом границ сектора) */
  motor: number;
  /** суммарная энергия кадра (для индикации/реакции) */
  energy: number;
}

// --- Константы движка (были захардкожены в оригинале) ---

/** длительность атаки ноты, сек */
const ATTACK = 0.02;
/** уровень, ниже которого нота не рисуется */
const LEVEL_EPS = 0.004;
/** потолок накопления в буфере (клипуется при выводе в DMX) */
const PX_CLIP = 1.5;

// --- Цвет ---

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2rgb(h + 1 / 3), hue2rgb(h), hue2rgb(h - 1 / 3)];
}

/**
 * Цвет луча по нормированной высоте тона.
 * Возвращает RGBW. Верхний край диапазона подмешивает белый —
 * высокие ноты «выбеливаются», это и даёт читаемые акценты.
 *
 * `hueShift` крутит всю палитру по кругу (живой фейдер с крыла),
 * `sat` управляет насыщенностью: 0 = белая картинка.
 */
function pitchColor(
  xn: number,
  level: number,
  palette: Palette,
  hueShift = 0,
  sat = 0.95,
): [number, number, number, number] {
  let h: number;
  if (palette === 'mono') h = 0.6;
  else if (palette === 'rainbow') h = xn * 0.83;
  // thermal: янтарь -> красный -> пурпур -> синий, в обход зелёного
  else h = (0.1 - xn * 0.55 + 1) % 1;

  h = (h + hueShift + 1) % 1;

  const white = Math.min(1, Math.max(0, (xn - 0.78) * 4.2)) * level;
  const [r, g, b] = hslToRgb(h, Math.min(1, Math.max(0, sat)), 0.6);
  // Синий намеренно не приглушается белым: так верхний край уходит
  // в холодный, а не в серый. Поведение оригинала, проверено на железе.
  return [r * (1 - white * 0.4), g * (1 - white * 0.4), b, white * 0.85];
}

// --- Движок ---

export class LightEngine {
  readonly pixelCount: number;

  private notes: LightNote[] = [];
  private cursor = 0;
  private active: ActiveNote[] = [];

  private pitchMin = 127;
  private pitchMax = 0;
  private pLo = 0;
  private pHi = 127;

  private profile: TrackProfile | null = null;
  private lastTime = 0;

  // состояние «бегунка»
  private walkX: number;
  private walkLastPitch: number | null = null;
  private walkLastDir = 1;
  private walkLastT = -10;

  private px: Float32Array;

  constructor(pixelCount = 40) {
    this.pixelCount = pixelCount;
    this.px = new Float32Array(pixelCount * 4);
    this.walkX = (pixelCount - 1) / 2;
  }

  /** Загрузить анализ трека. Ударные (is_drum) в свет расчёсок не идут,
   *  но сохраняются отдельно: они дают РИТМ для профиля заливного света. */
  load(data: AnalysisData): void {
    const notes: LightNote[] = [];
    const pitches: number[] = [];
    const drums: Array<{ start: number; lvl?: number }> = [];
    this.pitchMin = 127;
    this.pitchMax = 0;

    for (const tr of data.tracks) {
      if (tr.is_drum) {
        for (const n of tr.notes) drums.push({ start: n.start, lvl: n.lvl });
        continue;
      }
      for (const n of tr.notes) {
        notes.push({
          pitch: n.pitch,
          start: n.start,
          end: n.end,
          lvl: n.lvl ?? 0,
          spec: n.spec ?? n.lvl ?? 0,
          track: tr.id,
        });
        pitches.push(n.pitch);
        if (n.pitch < this.pitchMin) this.pitchMin = n.pitch;
        if (n.pitch > this.pitchMax) this.pitchMax = n.pitch;
      }
    }

    notes.sort((a, b) => a.start - b.start);
    pitches.sort((a, b) => a - b);

    // «Плотный» диапазон p10..p90: одинокая басовая или визгливая нота
    // не должна сжимать всю мелодию в середину линейки.
    this.pLo = pitches.length ? pitches[Math.floor(pitches.length * 0.1)] : this.pitchMin;
    this.pHi = pitches.length
      ? pitches[Math.min(pitches.length - 1, Math.floor(pitches.length * 0.9))]
      : this.pitchMax;

    this.notes = notes;
    // Профиль трека: разбиение на участки по характеру (тихо / ритм / навал /
    // пик / держаные). Нужен заливному свету, чтобы не долбить «под уровень».
    this.profile = buildProfile(data.duration || (notes.length ? notes[notes.length - 1].end : 0), drums, notes);
    this.reset();
  }

  /** Профиль трека или null, если анализ не загружен. */
  get trackProfile(): TrackProfile | null {
    return this.profile;
  }

  get noteCount(): number {
    return this.notes.length;
  }

  get isLoaded(): boolean {
    return this.notes.length > 0;
  }

  /** Сбросить курсор и всё живое состояние (стоп/выгрузка трека). */
  reset(): void {
    this.cursor = 0;
    this.active = [];
    this.lastTime = 0;
    this.walkX = (this.pixelCount - 1) / 2;
    this.walkLastPitch = null;
    this.walkLastDir = 1;
    this.walkLastT = -10;
    this.px.fill(0);
  }

  /** Перемотка: восстановить курсор и живые ноты на момент t. */
  seek(t: number, release: number): void {
    this.cursor = 0;
    this.active = [];
    this.walkLastPitch = null;
    this.walkLastT = -10;
    while (this.cursor < this.notes.length && this.notes[this.cursor].start <= t) {
      const n = this.notes[this.cursor];
      const walkPos = this.assignWalk(n);
      // Ноту, у которой ещё не кончился release, поднимаем без вспышки:
      // после перемотки не должно быть залпа из всего, что «пропустили».
      if (n.end + release > t) this.active.push({ note: n, hold: 0, walkPos });
      this.cursor++;
    }
    this.lastTime = t;
  }

  /**
   * Посчитать кадр.
   * @param t текущее время трека, сек
   * @param p параметры
   * @param dt длительность интервала, сек. Если не задан — берётся
   *           разница с прошлым кадром. Именно интервал даёт пик-за-интервал.
   */
  render(t: number, p: LightEngineParams, dt?: number): LightFrame {
    const step = dt !== undefined ? dt : t - this.lastTime;
    // Скачок назад или огромная дыра (вкладка была свёрнута) — ресинк.
    if (step < 0 || step > 1) {
      this.seek(t, p.release);
    }
    const tPrev = Math.max(0, t - Math.max(0, Math.min(step, 1)));
    this.lastTime = t;

    const minFlash = Math.max(1, Math.min(4, Math.round(p.minFlashFrames)));

    // Забираем ВСЕ ноты, стартовавшие в интервале (tPrev, t] — включая те,
    // что уже успели закончиться. Каждой ставим hold: гарантия вспышки.
    while (this.cursor < this.notes.length && this.notes[this.cursor].start <= t) {
      const n = this.notes[this.cursor];
      const walkPos = this.assignWalk(n);
      this.active.push({ note: n, hold: minFlash, walkPos });
      this.cursor++;
    }

    // Снимаем отзвучавшие. Нота с непогашенным hold живёт до конца вспышки.
    const rel = p.release;
    const stillAlive: ActiveNote[] = [];
    for (const a of this.active) {
      if (t <= a.note.end + rel || a.hold > 0) stillAlive.push(a);
    }
    this.active = stillAlive;

    const px = this.px;
    px.fill(0);

    const lo = p.range === 'dense' ? this.pLo : this.pitchMin;
    const hi = p.range === 'dense' ? this.pHi : this.pitchMax;
    const span = Math.max(1, hi - lo);
    const last = this.pixelCount - 1;
    const walk = p.posMode === 'walk';

    let energy = 0;

    for (const a of this.active) {
      const n = a.note;

      // Огибающая в момент t.
      let env: number;
      if (t < n.start + ATTACK) env = Math.max(0, (t - n.start) / ATTACK);
      else if (t <= n.end) env = 1;
      else env = Math.max(0, 1 - (t - n.end) / rel);

      // Пик-за-интервал: пока держится hold, нота звучит на полную,
      // даже если формально уже умерла между кадрами.
      // dt=0 (транспорт на паузе, кадр пересчитывается ради живых фейдеров,
      // 28.07): hold НЕ стареет — кадр обязан остаться замороженным.
      if (a.hold > 0) {
        env = 1;
        if (step > 0) a.hold--;
      }

      const raw = p.levelSource === 'spec' ? n.spec : n.lvl;
      const level = raw * env * p.brightness;
      if (level <= LEVEL_EPS) continue;
      energy += level;

      const xn = Math.min(1, Math.max(0, (n.pitch - lo) / span));
      const x = walk && a.walkPos !== undefined ? a.walkPos : xn * last;
      // Басы шире, верх острее: низ «заливает», верх «колет».
      const sigma = (0.55 + (1 - xn) * 1.9) * p.width;
      const col = pitchColor(xn, level, p.palette, p.hueShift ?? 0, p.saturation ?? 0.95);

      this.splat(x, sigma, level, col);
      if (p.symmetry) this.splat(last - x, sigma, level * 0.9, col);
    }

    // --- Мотор: ЖЁСТКО по центру диапазона ----------------------------------
    // Встроенный LFO убран (юзер 26.07: «что за ЛФО, я такого не просил»).
    // Качание приходит ИЗВНЕ — вход tilt-in с фейдера крыла или LFO-ноды
    // генератора; здесь ничего само не двигается. Диапазон остался как
    // ограничитель: внешний сигнал всегда проходит через него, за границы
    // прибор не выйдет.
    const secLo = Math.max(0, Math.min(255, Math.min(p.tiltMin, p.tiltMax)));
    const secHi = Math.max(0, Math.min(255, Math.max(p.tiltMin, p.tiltMax)));
    // tilt=0 -> нижняя граница, tilt=1 -> верхняя, без колебаний
    const pos = secLo + (secHi - secLo) * Math.max(0, Math.min(1, p.tilt));

    return {
      px,
      motor: Math.round(Math.max(secLo, Math.min(secHi, pos))),
      energy,
    };
  }

  /** Гауссово пятно в буфер. */
  private splat(x: number, sigma: number, gain: number, col: [number, number, number, number]): void {
    const px = this.px;
    const last = this.pixelCount - 1;
    const i0 = Math.max(0, Math.floor(x - sigma * 3));
    const i1 = Math.min(last, Math.ceil(x + sigma * 3));
    for (let i = i0; i <= i1; i++) {
      const d = (i - x) / sigma;
      const g = Math.exp(-0.5 * d * d) * gain;
      if (g < LEVEL_EPS) continue;
      const o = i * 4;
      px[o] = Math.min(PX_CLIP, px[o] + col[0] * g);
      px[o + 1] = Math.min(PX_CLIP, px[o + 1] + col[1] * g);
      px[o + 2] = Math.min(PX_CLIP, px[o + 2] + col[2] * g);
      px[o + 3] = Math.min(PX_CLIP, px[o + 3] + col[3] * g);
    }
  }

  /**
   * Режим «бегунок»: позиция не от высоты тона, а от контура мелодии.
   * Выше предыдущей — шаг вправо, ниже — влево. Аккорд (дельта < 30 мс)
   * ложится в одну точку, повтор той же ноты — маленький шаг в ту же сторону.
   * Возвращает позицию для этой ноты.
   */
  private assignWalk(n: LightNote): number {
    const last = this.pixelCount - 1;
    if (this.walkLastPitch !== null && n.start - this.walkLastT > 0.03) {
      const interval = n.pitch - this.walkLastPitch;
      if (interval !== 0) this.walkLastDir = Math.sign(interval);
      const stepSize = interval === 0 ? 1.2 : Math.min(7, Math.max(1.5, Math.abs(interval) / 2));
      this.walkX += this.walkLastDir * stepSize;
      if (this.walkX > last) this.walkX -= last;
      if (this.walkX < 0) this.walkX += last;
    }
    this.walkLastPitch = n.pitch;
    this.walkLastT = n.start;
    return this.walkX;
  }
}

interface ActiveNote {
  note: LightNote;
  /** сколько кадров ещё держать гарантированный пик */
  hold: number;
  walkPos?: number;
}
