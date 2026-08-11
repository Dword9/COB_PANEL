/**
 * Кулисные LED-парки (Euro DJ 6ch и подобные RGB): ПЛАВНЫЙ фон (28.07).
 *
 * Запрос юзера дословно: «плавно всё переливалось справа налево, чтоб не
 * дергали резко свет — расчёски у нас резко дергают, контрастно, а это
 * должен быть плавный красивый фон; резко дергать можно только когда в
 * инструментах прописаны удары (кики)».
 *
 * Отличия от washEngine (верхние COB):
 *  - НИКОГДА нет строба (каналы strobe/fx/speed — всегда 0);
 *  - цвет и яркость непрерывны: оттенок — бегущая синусоидальная волна по
 *    физическому порядку приборов (Front L→Mid L→Backdrop L→Backdrop R→
 *    Mid R→Front R), энергия — экспоненциально сглажена (атака ~0.35 с,
 *    спад ~1.5 с), плюс медленная яркостная рябь;
 *  - «резкое» — только пульс по ударам из анализа, и только если ударные в
 *    треке вообще есть (hasDrums), с экспоненциальным спадом ~0.22 с.
 *
 * Пауза/стоп: движок чисто функция времени t — на замороженном t кадр
 * заморожен (внешние фейдеры пересчитываются, как у остальных, 28.07).
 */

import { DrumHit, SectionKind, TrackProfile, sectionAt } from './trackProfile';
import { WashFrame } from './washEngine';

export interface BackstageParams {
  /** общий множитель яркости, 0..2 */
  brightness: number;
  /** базовый оттенок 0..1 (как у COB — от палитры/лучей, плюс своя крутилка) */
  hueShift: number;
  /** насыщенность 0..1 */
  saturation: number;
  /** скорость перелива, множитель (0.3..2.5), 1 = базовая */
  flow: number;
  /** приборов в физическом порядке */
  count: number;
  /** нижний порог общего уровня фона, 0..1 — кулисы живут всегда */
  floor: number;
  /** энергия кадра расчёсок 0..1 (сглаживается внутри) */
  energy: number;
  /**
   * Глубина яркостной волны: уровень ВПАДИНЫ (фон между «кометами»), доля
   * общего уровня, 0..0.9. 0.05 = почти в ноль (запрос 28.07: «какие-то
   * прям в ноль уходили, волна как пиксели лучей, только 6 адресов»).
   */
  waveLo: number;
}

/** Период волны оттенка по характеру участка (с, до множителя flow). */
const KIND_PERIOD: Record<SectionKind, number> = {
  quiet: 14,
  sustain: 11,
  groove: 8,
  peak: 7,
  dense: 9,
};

/** Базовый оттенок участка: тихо — холодный, ритм — тёплый. */
const KIND_HUE: Record<SectionKind, number> = {
  quiet: 0.60, sustain: 0.07, groove: 0.04, peak: 0.02, dense: 0.10,
};

/** Размах волны оттенка вокруг базы (±0.11 ≈ ±40°). */
const HUE_SPAN = 0.11;

/**
 * Физический индекс прибора на сцене по имени ноды: волна L→R идёт
 * Front L(0) → Mid L(1) → Backdrop L(2) → Backdrop R(3) → Mid R(4) →
 * Front R(5). Имена из проекта: «Backdrop L», «Mid R», «Front L»…
 * Не распарсилось — null (сортировка упадёт на адрес).
 */
export const backstageIndex = (label: string): number | null => {
  const l = (label || '').toLowerCase();
  const isL = /(?:^|[\s-])l(?:[\s-]|$)|left/.test(l);
  const isR = /(?:^|[\s-])r(?:[\s-]|$)|right/.test(l);
  const depth = l.includes('front') ? 0 : l.includes('mid') ? 1
    : (l.includes('backdrop') || l.includes('back')) ? 2 : null;
  if ((!isL && !isR) || depth === null) return null;
  return isL ? depth : 5 - depth;
};

/** Ключ сортировки: сначала распарсенные по схеме, потом по адресу. */
export const backstageOrderKey = (label: string, startChannel: number): number => {
  const idx = backstageIndex(label);
  return idx !== null ? idx : 100 + startChannel / 1000;
};

/** HSV(0..1) → RGB(0..1), локальная (не тащим из graphEngine). */
const hsv01 = (h: number, s: number, v: number): [number, number, number] => {
  const hh = (((h % 1) + 1) % 1) * 6;
  const c = v * s, x = c * (1 - Math.abs((hh % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (hh < 1) { r = c; g = x; } else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; } else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; } else { r = c; b = x; }
  return [r + m, g + m, b + m];
};

// ---------------------------------------------------------------------------
// РЕЖИМ «НОТЫ» (28.07, третья редакция): кулисы играют ноты, как лучи —
// только в разрешении 6 пикселей. Периодическая «комета» юзер назвал
// механичной («стрёмно смотрится, надо ноты»). Источник — ТОТ ЖЕ буфер
// 40 лучей (lightEngine): левые ~7 лучей → Front L, правые → Front R.
// Движение/музыкальность приходят даром: ноты танцуют по лучам — зоны
// дышат в такт, без единого нового параметра маппинга.
// ---------------------------------------------------------------------------

/** Сжать буфер лучей (40×RGBA) в count зон по максимуму каналов. */
export const zonesFromBeams = (
  px: Float32Array, count: number,
): Array<[number, number, number, number]> => {
  const beams = Math.max(1, Math.floor(px.length / 4));
  const zones: Array<[number, number, number, number]> = [];
  for (let z = 0; z < count; z++) {
    const from = Math.floor((z * beams) / count);
    const to = Math.max(from + 1, Math.floor(((z + 1) * beams) / count));
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = from; i < to && i < beams; i++) {
      const o = i * 4;
      if (px[o] > r) r = px[o];
      if (px[o + 1] > g) g = px[o + 1];
      if (px[o + 2] > b) b = px[o + 2];
      if (px[o + 3] > w) w = px[o + 3];
    }
    zones.push([r, g, b, w]);
  }
  return zones;
};

/**
 * Кадры кулис из буфера лучей (режим «НОТЫ»). Уровень зоны — её яркость
 * с панчем (zone^1.2), цвет — направление зоны (палитра лучей сохраняется),
 * насыщенность кулис тянет к белому, «порог» — слабый фон (floor·0.3),
 * строб жёстко в нуле. Чистая функция — в тестах без браузера.
 */
export const notesFrames = (
  px: Float32Array, count: number, p: BackstageParams,
): WashFrame[] => {
  const zones = zonesFromBeams(px, count);
  const sat = Math.max(0, Math.min(1, p.saturation));
  return zones.map(([r, g, b, w]) => {
    // Белый луч светит «в цвет» зоны (тепло), потом нормируем в направление.
    const wl = w * 0.6;
    const rr = Math.min(1, r + wl), gg = Math.min(1, g + wl), bb = Math.min(1, b + wl);
    const zone = Math.max(rr, gg, bb);
    const ir = zone > 1e-3 ? rr / zone : 1;
    const ig = zone > 1e-3 ? gg / zone : 1;
    const ib = zone > 1e-3 ? bb / zone : 1;
    // Насыщенность: к белому (sat=1 — родной цвет лучей, sat=0 — белый).
    const cr = 1 - (1 - ir) * sat;
    const cg = 1 - (1 - ig) * sat;
    const cb = 1 - (1 - ib) * sat;
    let master = Math.max(0, Math.min(1, p.floor * 0.3 + Math.pow(zone, 1.2) * 1.2));
    master = Math.max(0, Math.min(1, master * p.brightness));
    return { master, r: cr, g: cg, b: cb, w: 0, strobe: 0 };
  });
};

export class BackstageWash {
  private profile: TrackProfile | null = null;
  private hits: DrumHit[] = [];
  private hasDrums = false;
  private smoothE = 0;
  private lastT: number | null = null;

  setProfile(profile: TrackProfile | null) {
    this.profile = profile;
    this.hits = profile?.hits ?? [];
    this.hasDrums = this.hits.length > 0;
    this.smoothE = 0;
    this.lastT = null;
  }

  seek(t: number) { this.lastT = t; }

  reset() {
    this.smoothE = 0;
    this.lastT = null;
  }

  /** Есть ли вообще ударные в треке — для подписи в UI. */
  get drumsPresent(): boolean { return this.hasDrums; }

  render(t: number, p: BackstageParams): WashFrame[] {
    const count = Math.max(1, p.count);
    const kind: SectionKind = (this.profile ? sectionAt(this.profile, t)?.kind : null) ?? 'quiet';

    // Энергия — сильно сглажена: атака ~0.35 с, спад ~1.5 с. dt=0 (пауза)
    // — сглаживание заморожено, кадр идентичен прошлому.
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const rate = p.energy > this.smoothE ? 3.0 : 0.65;
    this.smoothE += (p.energy - this.smoothE) * Math.min(1, rate * dt);

    // Пульс по ударам — ТОЛЬКО если в анализе есть ударные (правило юзера).
    let pulse = 0;
    if (this.hasDrums) {
      for (const h of this.hits) {
        const d = t - h.t;
        if (d >= 0 && d < 0.6) {
          const v = (h.lvl ?? 0.5) * Math.exp(-d / 0.22);
          if (v > pulse) pulse = v;
        }
      }
      pulse = Math.min(1, pulse);
    }

    const period = KIND_PERIOD[kind] / Math.max(0.1, p.flow);
    const hueBase = KIND_HUE[kind] + p.hueShift;
    const levelBase = p.floor + (1 - p.floor) * this.smoothE;
    const waveLo = Math.max(0, Math.min(0.9, p.waveLo ?? 0.08));

    // Бегущая «комета»: пинг-понг позиция 0..count-1 (туда-обратно — без
    // телепорта с края, по сцене ходит физически). Гауссов гребень узкий —
    // в каждый момент ярка ОДНА-две парки, остальные во впадине (запрос
    // 28.07: «как пиксели лучей, только по 6 адресам, впадины прям в ноль»).
    const cycle = (t / period) % 2;
    const travel = cycle < 1 ? cycle : 2 - cycle; // 0→1→0 за 2 периода
    const pos = travel * (count - 1);
    const SIGMA = 0.9; // ширина гребня в приборах

    const out: WashFrame[] = [];
    for (let i = 0; i < count; i++) {
      // Оттенок — своя бегущая волна (синус), как и была.
      const huePhase = (t / period - i / count) * 2 * Math.PI;
      const hue = hueBase + HUE_SPAN * Math.sin(huePhase);
      const d = i - pos;
      const bump = Math.exp(-0.5 * (d / SIGMA) * (d / SIGMA));
      // гребень ×1.3 от уровня, впадина = waveLo доли
      let master = levelBase * (waveLo + (1.3 - waveLo) * bump);
      master += 0.35 * pulse;
      master = Math.max(0, Math.min(1, master * p.brightness));
      const [r, g, b] = hsv01(hue, p.saturation, 1);
      // Строб/эффекты — жёсткий ноль ВСЕГДА: это фон, он не дергается.
      out.push({ master, r, g, b, w: 0, strobe: 0 });
    }
    return out;
  }
}
