/**
 * Профиль трека: разбиение на участки по характеру музыки и «манера» заливного
 * света (верхние COB) для каждого.
 *
 * Зачем: расчёски рисуют ноты — этого достаточно для картинки, но заливной свет,
 * повторяющий ту же энергию, выглядит как «тынь-тынь-тынь под уровень»
 * (замечание юзера 26.07). Человек-художник по свету слушает СТРУКТУРУ:
 * во вступлении дышит, на чистом ритме бьёт в такт, на навале ведёт плавную
 * волну, на пике ритма даёт строб.
 *
 * Классификация чисто по данным анализа — ударные (is_drum, движок расчёсок их
 * выбрасывает) дают ритм, тональные дорожки дают плотность мелодии.
 */

/** Характер участка трека. */
export type SectionKind =
  /** ударных нет, тихо — медленное дыхание */
  | 'quiet'
  /** мало нот, но громкие — плавный наплыв */
  | 'sustain'
  /** ударов много, мелодии мало — удар в такт */
  | 'groove'
  /** пик ударных — строб */
  | 'peak'
  /** густо всё — плавная волна цвета */
  | 'dense';

export interface TrackSection {
  start: number;
  end: number;
  kind: SectionKind;
  /** плотность ударов, удар/сек */
  hits: number;
  /** плотность тональных нот, нота/сек */
  notes: number;
  /** средний уровень тональных нот 0..1 */
  level: number;
}

/** Один удар ударных: время + сила. Для попадания заливки точно в такт. */
export interface DrumHit {
  t: number;
  lvl: number;
}

export interface TrackProfile {
  duration: number;
  sections: TrackSection[];
  hits: DrumHit[];
  /** максимальная плотность ударов по треку — база для нормировки */
  maxHitRate: number;
}

const WIN = 4; // окно анализа, сек — на глаз различимая «фраза»

/**
 * Строит профиль. Порог `peak` берётся относительно самого трека, а не
 * абсолютных чисел: у тихой этники и у транса «много ударов» — разные величины.
 */
export function buildProfile(
  duration: number,
  drumNotes: Array<{ start: number; lvl?: number }>,
  tonalNotes: Array<{ start: number; lvl?: number }>,
): TrackProfile {
  const n = Math.max(1, Math.ceil(duration / WIN));
  const dr = new Array(n).fill(0);
  const to = new Array(n).fill(0);
  const lv = new Array(n).fill(0);

  for (const d of drumNotes) {
    const b = Math.min(n - 1, Math.floor(d.start / WIN));
    dr[b]++;
  }
  for (const t of tonalNotes) {
    const b = Math.min(n - 1, Math.floor(t.start / WIN));
    to[b]++;
    lv[b] += t.lvl ?? 0;
  }

  const hitRates = dr.map(c => c / WIN);
  const maxHitRate = Math.max(0.001, ...hitRates);

  const raw: TrackSection[] = [];
  for (let i = 0; i < n; i++) {
    const hits = hitRates[i];
    const notes = to[i] / WIN;
    const level = to[i] ? lv[i] / to[i] : 0;
    const hitN = hits / maxHitRate;      // 0..1 относительно трека
    const noteN = Math.min(1, notes / 12); // 12 нот/сек = «густо»

    let kind: SectionKind;
    if (hits < 0.3 && level < 0.45) kind = 'quiet';
    else if (hitN > 0.85 && noteN < 0.55) kind = 'peak';
    else if (hitN > 0.45 && noteN < 0.5) kind = 'groove';
    // Держаные: ударов почти нет, нот мало, но они ГРОМКИЕ. Порог notes<1 был
    // слишком строгим — участок 0:12-0:40 «Бугу» (0.86 удара/с, 3 нот/с,
    // уровень 0.91) уезжал в «навал», хотя это классический наплыв (26.07).
    else if (hits < 1.2 && notes < 3.5 && level > 0.8) kind = 'sustain';
    else if (noteN > 0.55 || (hitN > 0.4 && noteN > 0.4)) kind = 'dense';
    else kind = 'dense';

    raw.push({ start: i * WIN, end: Math.min(duration, (i + 1) * WIN), kind, hits, notes, level });
  }

  // Склеиваем соседние окна одного характера: иначе манера дёргается каждые
  // 4 секунды и выглядит нервно.
  const sections: TrackSection[] = [];
  for (const s of raw) {
    const prev = sections[sections.length - 1];
    if (prev && prev.kind === s.kind) {
      prev.end = s.end;
      prev.hits = (prev.hits + s.hits) / 2;
      prev.notes = (prev.notes + s.notes) / 2;
      prev.level = (prev.level + s.level) / 2;
    } else {
      sections.push({ ...s });
    }
  }

  const hits: DrumHit[] = drumNotes
    .map(d => ({ t: d.start, lvl: d.lvl ?? 0.8 }))
    .sort((a, b) => a.t - b.t);

  return { duration, sections, hits, maxHitRate };
}

export function sectionAt(profile: TrackProfile, t: number): TrackSection | null {
  const ss = profile.sections;
  // Линейный поиск с конца обычно попадает за 1-2 шага (t растёт монотонно).
  for (let i = ss.length - 1; i >= 0; i--) {
    if (t >= ss[i].start) return ss[i];
  }
  return ss[0] ?? null;
}

/** Человекочитаемое имя участка — для подписи в UI. */
export const SECTION_LABEL: Record<SectionKind, string> = {
  quiet: 'тихо — дыхание',
  sustain: 'держаные — наплыв',
  groove: 'ритм — удар в такт',
  peak: 'пик ритма — строб',
  dense: 'навал — волна',
};
