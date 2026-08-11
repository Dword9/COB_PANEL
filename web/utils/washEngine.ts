/**
 * Заливной свет (верхние COB) по характеру музыки, а НЕ по мгновенному уровню.
 *
 * Проблема, которую решает файл (жалоба юзера 26.07): если гнать на COB энергию
 * кадра, получается «тынь-тынь-тынь под уровень» — свет повторяет расчёски и
 * ничего не добавляет. Художник по свету слушает структуру: во вступлении
 * дышит, на чистом ритме бьёт в такт бочке, на навале ведёт плавную волну
 * цвета, на пике ритма даёт строб.
 *
 * Манеры (см. trackProfile.ts за классификацией участков):
 *   quiet   — медленное дыхание, холодный глубокий цвет, низкая яркость
 *   sustain — плавный наплыв вслед за энергией, насыщенный цвет
 *   groove  — резкий удар по каждой ноте ударных, тёплый, быстрый спад
 *   peak    — то же + строб на приборе
 *   dense   — волна цвета, бегущая по четырём COB, + мягкие акценты
 *
 * Возвращает по одному кадру на каждый COB: приборы стоят слева-направо, и
 * волна/чейс идут по ним физически.
 */

import { DrumHit, SectionKind, TrackProfile, sectionAt } from './trackProfile';

export interface WashFrame {
  /** 0..1 на прибор */
  master: number;
  r: number;
  g: number;
  b: number;
  w: number;
  /** 0..255, канал строба прибора */
  strobe: number;
}

export interface WashParams {
  /** общий множитель яркости, 0..2 */
  brightness: number;
  /** сдвиг палитры по кругу, 0..1 — тот же фейдер, что у расчёсок */
  hueShift: number;
  /** насыщенность 0..1 */
  saturation: number;
  /** разрешить строб на пиках ритма */
  allowStrobe: boolean;
  /** сколько приборов в линии */
  count: number;
  /**
   * Нижний порог яркости прибора, 0..1. Ниже него COB видно плохо — заливка
   * пропадает из картины (требование юзера 26.07: «меньше 50% не делай»).
   * Применяется к master и к цветным каналам после всех расчётов.
   */
  floor: number;
}

export const DEFAULT_WASH_PARAMS: WashParams = {
  brightness: 1,
  hueShift: 0,
  saturation: 0.9,
  allowStrobe: true,
  count: 4,
  floor: 0.5,
};

/** Базовый оттенок манеры: холод для тишины, тепло для ритма. */
const KIND_HUE: Record<SectionKind, number> = {
  quiet: 0.58,   // холодный синий
  sustain: 0.05, // янтарь
  groove: 0.02,  // тёплый красный
  peak: 0.0,     // чистый красный
  dense: 0.08,   // тёплый оранжевый
};

/** Базовый уровень манеры. Это ДОБАВКА над floor, а не абсолютная яркость:
 *  итог = floor + base + модуляция, всё нормируется в остаток до 1. */
const KIND_BASE: Record<SectionKind, number> = {
  quiet: 0.10,
  sustain: 0.22,
  groove: 0.04,
  peak: 0.02,
  dense: 0.28,
};

function hsl(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

export class WashEngine {
  private profile: TrackProfile | null = null;
  /** индекс в массиве ударов — курсор по времени */
  private hitCursor = 0;
  /** затухающие импульсы на каждый прибор */
  private pulse: number[] = [];
  /** сглаженная энергия, чтобы «дыхание» было плавным */
  private smooth = 0;
  private lastT = 0;

  setProfile(p: TrackProfile | null): void {
    this.profile = p;
    this.reset();
  }

  reset(): void {
    this.hitCursor = 0;
    this.pulse = [];
    this.smooth = 0;
    this.lastT = 0;
  }

  /** Пересинхронизация курсора удара после seek. */
  seek(t: number): void {
    this.hitCursor = 0;
    if (this.profile) {
      const hs = this.profile.hits;
      while (this.hitCursor < hs.length && hs[this.hitCursor].t < t) this.hitCursor++;
    }
    this.pulse = [];
    this.smooth = 0;
    this.lastT = t;
  }

  /**
   * Кадр заливки. `energy` — энергия расчёсок (та же, что раньше шла напрямую),
   * используется только как модулятор внутри манеры.
   */
  render(t: number, energy: number, p: WashParams): WashFrame[] {
    const n = Math.max(1, p.count);
    if (this.pulse.length !== n) this.pulse = new Array(n).fill(0);

    let step = t - this.lastT;
    if (step < 0 || step > 1) { this.seek(t); step = 0.016; }
    this.lastT = t;

    const sec = this.profile ? sectionAt(this.profile, t) : null;
    const kind: SectionKind = sec?.kind ?? 'dense';

    // Энергия сглаженная: атака быстрая, спад медленный — как у глаза.
    const eRaw = Math.min(1, energy / 6);
    this.smooth += (eRaw - this.smooth) * (eRaw > this.smooth ? 0.25 : 0.05);

    // Собираем удары, попавшие в интервал. На groove/peak каждый удар — импульс
    // на СВОЙ прибор по кругу: получается бег огня по линии, а не синхронная
    // вспышка всех четырёх.
    let hitNow = 0;
    if (this.profile) {
      const hs = this.profile.hits;
      while (this.hitCursor < hs.length && hs[this.hitCursor].t <= t) {
        const h: DrumHit = hs[this.hitCursor];
        hitNow++;
        const idx = (this.hitCursor % n);
        const gain = 0.55 + 0.45 * Math.min(1, h.lvl);
        if (kind === 'groove' || kind === 'peak') {
          this.pulse[idx] = Math.max(this.pulse[idx], gain);
        } else if (kind === 'dense') {
          // На навале удары лишь подталкивают волну, не режут её.
          for (let i = 0; i < n; i++) this.pulse[i] = Math.max(this.pulse[i], gain * 0.35);
        }
        this.hitCursor++;
      }
    }

    // Спад импульсов: на ритме короткий (чтобы читался удар), на навале длинный.
    const decay = kind === 'peak' ? 0.72 : kind === 'groove' ? 0.82 : 0.9;
    for (let i = 0; i < n; i++) this.pulse[i] *= decay;

    const out: WashFrame[] = [];
    const baseHue = (KIND_HUE[kind] + p.hueShift + 1) % 1;
    const base = KIND_BASE[kind];

    for (let i = 0; i < n; i++) {
      const xi = n > 1 ? i / (n - 1) : 0;
      let level = 0;
      let hue = baseHue;
      let sat = p.saturation;
      let white = 0;

      switch (kind) {
        case 'quiet': {
          // Дыхание: медленная синусоида, приборы в противофазе парами.
          const breath = 0.5 + 0.5 * Math.sin(t * 0.55 + xi * Math.PI);
          level = base + breath * 0.22 + this.smooth * 0.12;
          hue = (baseHue + breath * 0.06) % 1;
          sat = Math.min(1, p.saturation * 1.05);
          break;
        }
        case 'sustain': {
          // Наплыв: яркость идёт за сглаженной энергией, цвет чуть плывёт.
          level = base + this.smooth * 0.55;
          hue = (baseHue + Math.sin(t * 0.3) * 0.04 + 1) % 1;
          white = this.smooth * 0.18;
          break;
        }
        case 'groove': {
          // Удар в такт: почти чёрный фон, резкие импульсы по приборам.
          level = base + this.pulse[i] * 0.95;
          white = this.pulse[i] * 0.45;
          sat = p.saturation * (1 - this.pulse[i] * 0.35);
          break;
        }
        case 'peak': {
          level = base + this.pulse[i] * 1.0;
          white = this.pulse[i] * 0.65;
          sat = p.saturation * (1 - this.pulse[i] * 0.5);
          break;
        }
        case 'dense': {
          // Волна цвета, бегущая по линии + подталкивание ударами.
          const wave = 0.5 + 0.5 * Math.sin(t * 1.1 - xi * 2.2);
          level = base + wave * 0.3 + this.smooth * 0.3 + this.pulse[i] * 0.25;
          hue = (baseHue + xi * 0.1 + t * 0.02) % 1;
          break;
        }
      }

      level = Math.max(0, Math.min(1, level * p.brightness));
      // Пол яркости: COB тусклее ~50% в зале не читается, поэтому вся
      // динамика манеры укладывается в остаток ОТ порога до единицы
      // (требование юзера 26.07). floor=0.5 -> реальный ход 0.5..1.0.
      const floor = Math.max(0, Math.min(0.95, p.floor));
      level = floor + level * (1 - floor);
      const [r, g, b] = hsl(hue, Math.max(0, Math.min(1, sat)), 0.55);
      const strobeOn = p.allowStrobe && kind === 'peak' && this.pulse[i] > 0.35;

      out.push({
        master: level,
        r: r * level,
        g: g * level,
        b: b * level,
        w: Math.min(1, white) * level,
        // Строб-канал COB: 0 = выключен, дальше скорость. 200 — быстро, но
        // не «эпилепсия»; включаем только на пиках и только под импульс.
        strobe: strobeOn ? 200 : 0,
      });
    }

    return out;
  }

  /** Текущая манера — для подписи в UI. */
  kindAt(t: number): SectionKind | null {
    if (!this.profile) return null;
    return sectionAt(this.profile, t)?.kind ?? null;
  }
}
