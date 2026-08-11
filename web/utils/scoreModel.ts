/**
 * Модель партитуры трека (score) — фаза 4.0 «Режиссуры трека»
 * (docs/track-director-architecture.md).
 *
 * Score — это СЕМАНТИЧЕСКИЕ модификаторы слоёв (лучи/COB/кулисы/движение)
 * на временной оси. Никаких DMX-каналов, адресов и нод: слой получает
 * мультипликатор яркости, сдвиг оттенка/насыщенности, trim наклона и
 * gate. Движок применяет их к уже вычисленным параметрам — поведение
 * без score (или при устаревшем отпечатке) ровно прежнее.
 *
 * Отпечаток (fingerprint) привязывает score к анализу: заменил трек —
 * партитура молча перестаёт действовать (в редакторе видно «устарела»),
 * а не играет чужие cue на новом треке.
 */

import type { SectionKind } from './trackProfile';

export type LaneId = 'rays' | 'cob' | 'backstage' | 'motion';
export const LANE_IDS: ReadonlyArray<LaneId> = ['rays', 'cob', 'backstage', 'motion'];

/** Семантические модификаторы слоя. Поле отсутствует = не меняет. */
export interface LaneMods {
  /** множитель яркости, 0..4 (1 = без изменений) */
  brightnessMul?: number;
  /** сдвиг оттенка по кругу, -1..1 (применяется wrap) */
  hueTrim?: number;
  /** сдвиг насыщенности, -1..1 (применяется clamp) */
  satTrim?: number;
  /** сдвиг положения наклона, -1..1 (только motion; clamp) */
  tiltTrim?: number;
  /** false = слой выключен на интервале cue */
  gate?: boolean;
}

export interface ScoreCue {
  id: string;
  lane: LaneId;
  /** начало интервала, сек (включительно) */
  from: number;
  /** конец интервала, сек (исключительно) */
  to: number;
  mods: LaneMods;
  /** не трогать при регенерации диапазона */
  locked?: boolean;
  source?: 'auto' | 'user' | 'ai';
}

export interface ScoreSection {
  id: string;
  from: number;
  to: number;
  kind: SectionKind;
}

export interface ScoreV1 {
  version: 1;
  /** привязка к анализу: scoreFingerprint(...) на момент создания */
  fingerprint: string;
  /** длительность трека, сек */
  duration: number;
  sections: ScoreSection[];
  cues: ScoreCue[];
  /** записанная фейдерами автоматизация (фаза 5): абсолютные кривые параметров */
  automation?: AutomationLane[];
}

// --- Автоматизация (запись фейдеров, фаза 5) ------------------------------

/**
 * Цель автоматизации = конкретный ПАРАМЕТР слоя (не модификатор!).
 * Кривая хранит АБСОЛЮЮЩее значение параметра и при воспроизведении
 * ЗАМЕЩАЕТ значение слайдера (как автоматизация фейдера в DAW). Подключённый
 * вход (bright-in и т.п.) по-прежнему старше автоматизации.
 */
export type AutoTarget =
  | 'rays.brightness' | 'rays.hueShift' | 'rays.saturation'
  | 'motion.tilt'
  | 'backstage.brightness' | 'backstage.hueShift' | 'backstage.saturation';

export const AUTO_TARGETS: ReadonlyArray<AutoTarget> = [
  'rays.brightness', 'rays.hueShift', 'rays.saturation',
  'motion.tilt',
  'backstage.brightness', 'backstage.hueShift', 'backstage.saturation',
];

/** Пределы значений по целям (совпадают со слайдерами UI). */
export const AUTO_LIMITS: Record<AutoTarget, readonly [number, number]> = {
  'rays.brightness': [0.3, 2.5],
  'rays.hueShift': [0, 1],
  'rays.saturation': [0, 1],
  'motion.tilt': [0, 1],
  'backstage.brightness': [0, 2],
  'backstage.hueShift': [0, 1],
  'backstage.saturation': [0, 1],
};

export interface AutomationPoint { t: number; v: number; }

export interface AutomationLane {
  id: string;
  target: AutoTarget;
  points: AutomationPoint[];
}

/**
 * Отпечаток анализа. НЕ криптохеш (его нет на клиенте), а практичная
 * связка: url + длительность + число нот. Ловит главный сценарий —
 * «заменил трек/анализ, а score от старого».
 */
export const scoreFingerprint = (
  analysisUrl: string | null,
  duration: number,
  notes: number,
): string => `${analysisUrl || 'no-analysis'}|${(duration || 0).toFixed(2)}|${notes}`;

export const createScore = (
  fingerprint: string,
  duration: number,
  sections: ScoreSection[],
): ScoreV1 => ({
  version: 1,
  fingerprint,
  duration,
  sections,
  cues: [],
});

/** Пределы полей модификаторов (единые для валидации и компиляции). */
export const MOD_LIMITS = {
  brightnessMul: [0, 4],
  hueTrim: [-1, 1],
  satTrim: [-1, 1],
  tiltTrim: [-1, 1],
} as const;

/**
 * Валидация score. Возвращает список ошибок (пустой = валиден).
 * Ничего не чинит — битый score отвергается целиком, чтобы не играть
 * половину чужого замысла.
 */
export const validateScore = (s: any): string[] => {
  const errs: string[] = [];
  if (!s || typeof s !== 'object') return ['score: не объект'];
  if (s.version !== 1) errs.push(`version: ожидается 1, получено ${JSON.stringify(s.version)}`);
  if (typeof s.fingerprint !== 'string' || !s.fingerprint) errs.push('fingerprint: пустой/не строка');
  if (typeof s.duration !== 'number' || !(s.duration > 0)) errs.push('duration: не положительное число');
  const dur = typeof s.duration === 'number' ? s.duration : 0;
  if (!Array.isArray(s.sections)) errs.push('sections: не массив');
  else {
    s.sections.forEach((sec: any, i: number) => {
      if (!sec || typeof sec !== 'object') { errs.push(`sections[${i}]: не объект`); return; }
      if (typeof sec.id !== 'string' || !sec.id) errs.push(`sections[${i}].id: пустой`);
      if (typeof sec.from !== 'number' || typeof sec.to !== 'number' || !(sec.from < sec.to)) {
        errs.push(`sections[${i}]: from/to кривые (${sec.from}..${sec.to})`);
      }
      if (typeof sec.kind !== 'string') errs.push(`sections[${i}].kind: не строка`);
    });
  }
  if (!Array.isArray(s.cues)) errs.push('cues: не массив');
  else {
    const ids = new Set<string>();
    s.cues.forEach((c: any, i: number) => {
      if (!c || typeof c !== 'object') { errs.push(`cues[${i}]: не объект`); return; }
      if (typeof c.id !== 'string' || !c.id) errs.push(`cues[${i}].id: пустой`);
      else if (ids.has(c.id)) errs.push(`cues[${i}].id: дубликат "${c.id}"`);
      else ids.add(c.id);
      if (!LANE_IDS.includes(c.lane)) errs.push(`cues[${i}].lane: неизвестный "${c.lane}"`);
      if (typeof c.from !== 'number' || typeof c.to !== 'number' || !(c.from < c.to)) {
        errs.push(`cues[${i}]: from/to кривые (${c.from}..${c.to})`);
      } else if (dur > 0 && (c.from < -0.001 || c.to > dur + 1)) {
        errs.push(`cues[${i}]: вне трека (${c.from}..${c.to} при ${dur})`);
      }
      const m = c.mods;
      if (!m || typeof m !== 'object') { errs.push(`cues[${i}].mods: не объект`); return; }
      (['brightnessMul', 'hueTrim', 'satTrim', 'tiltTrim'] as const).forEach(k => {
        if (m[k] === undefined) return;
        const [lo, hi] = MOD_LIMITS[k];
        if (typeof m[k] !== 'number' || m[k] < lo || m[k] > hi) {
          errs.push(`cues[${i}].mods.${k}: ${m[k]} вне ${lo}..${hi}`);
        }
      });
      if (m.gate !== undefined && typeof m.gate !== 'boolean') {
        errs.push(`cues[${i}].mods.gate: не boolean`);
      }
    });
  }
  // Автоматизация (опционально): цели известны, значения в пределах слайдеров
  if (s.automation !== undefined) {
    if (!Array.isArray(s.automation)) errs.push('automation: не массив');
    else {
      const aIds = new Set<string>();
      s.automation.forEach((a: any, i: number) => {
        if (!a || typeof a !== 'object') { errs.push(`automation[${i}]: не объект`); return; }
        if (typeof a.id !== 'string' || !a.id) errs.push(`automation[${i}].id: пустой`);
        else if (aIds.has(a.id)) errs.push(`automation[${i}].id: дубликат "${a.id}"`);
        else aIds.add(a.id);
        if (!AUTO_TARGETS.includes(a.target)) errs.push(`automation[${i}].target: неизвестный "${a.target}"`);
        if (!Array.isArray(a.points)) { errs.push(`automation[${i}].points: не массив`); return; }
        const lim = AUTO_LIMITS[a.target as AutoTarget];
        a.points.forEach((pt: any, j: number) => {
          if (!pt || typeof pt.t !== 'number' || typeof pt.v !== 'number') {
            errs.push(`automation[${i}].points[${j}]: кривая точка`);
          } else if (lim && (pt.v < lim[0] || pt.v > lim[1])) {
            errs.push(`automation[${i}].points[${j}].v: ${pt.v} вне ${lim[0]}..${lim[1]}`);
          }
        });
      });
    }
  }
  return errs;
};
