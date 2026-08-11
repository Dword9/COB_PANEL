/**
 * Компилятор и сэмплер партитуры (score) — фаза 4.0 «Режиссуры».
 *
 * compileScore: сортирует секции и cue (стабильно, по from затем id),
 * клипует модификаторы в пределы. Результат — неизменяемый план.
 *
 * samplePlan: чистая функция времени. Один и тот же (plan, t) всегда
 * даёт одинаковое состояние слоёв — детерминизм при seek/паузе/повторе.
 * Никакого состояния между вызовами, никаких случайных чисел.
 *
 * draftFromProfile: ДЕТЕРМИНИРОВАННЫЙ черновик из автопрофиля трека
 * (правила ниже). Это стартовая точка для ручных правок и будущего
 * ИИ-режиссёра — ИИ будет редактировать/дополнять такой же черновик,
 * а не писать с нуля в пустую партитуру.
 */

import type { TrackProfile, SectionKind } from './trackProfile';
import {
  LANE_IDS, MOD_LIMITS, AUTO_LIMITS, createScore,
  type LaneId, type LaneMods, type ScoreCue, type ScoreSection, type ScoreV1,
  type AutoTarget, type AutomationLane, type AutomationPoint,
} from './scoreModel';

/** Состояние слоя в момент времени после свёртки всех активных cue. */
export interface LaneState {
  brightnessMul: number;
  hueTrim: number;
  satTrim: number;
  tiltTrim: number;
  gate: boolean;
}

export const neutralLaneState = (): LaneState => ({
  brightnessMul: 1, hueTrim: 0, satTrim: 0, tiltTrim: 0, gate: true,
});

export interface ScorePlan {
  duration: number;
  sections: ScoreSection[];
  lanes: Record<LaneId, ScoreCue[]>;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const clampMods = (m: LaneMods): LaneMods => ({
  brightnessMul: m.brightnessMul === undefined ? undefined
    : clamp(m.brightnessMul, MOD_LIMITS.brightnessMul[0], MOD_LIMITS.brightnessMul[1]),
  hueTrim: m.hueTrim === undefined ? undefined
    : clamp(m.hueTrim, MOD_LIMITS.hueTrim[0], MOD_LIMITS.hueTrim[1]),
  satTrim: m.satTrim === undefined ? undefined
    : clamp(m.satTrim, MOD_LIMITS.satTrim[0], MOD_LIMITS.satTrim[1]),
  tiltTrim: m.tiltTrim === undefined ? undefined
    : clamp(m.tiltTrim, MOD_LIMITS.tiltTrim[0], MOD_LIMITS.tiltTrim[1]),
  gate: m.gate,
});

/**
 * Компиляция score в план. Сортировка (from, id) — стабильный приоритет
 * наложения внутри дорожки: при равном from позже по алфавиту id считается
 * позже в порядке наложения (важно для сумм/произведений порядок не важен,
 * а вот для будущих replace-семантик — важен).
 */
export const compileScore = (score: ScoreV1): ScorePlan => {
  const sections = [...score.sections]
    .map(s => ({ ...s }))
    .sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
  const lanes = Object.fromEntries(LANE_IDS.map(l => [l, [] as ScoreCue[]])) as Record<LaneId, ScoreCue[]>;
  for (const c of score.cues) {
    if (!lanes[c.lane]) continue;
    lanes[c.lane].push({ ...c, mods: clampMods(c.mods) });
  }
  for (const l of LANE_IDS) {
    lanes[l].sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
  }
  return { duration: score.duration, sections, lanes };
};

/** Активен ли cue в момент t: полуинтервал [from, to). */
const active = (c: ScoreCue, t: number) => t >= c.from && t < c.to;

/**
 * Состояние всех слоёв в момент t.
 * Свёртка по типу модификатора:
 *  - brightnessMul — произведение (мультипликативно);
 *  - hueTrim/satTrim/tiltTrim — сумма (аддитивно, wrap/clamp при применении);
 *  - gate — конъюнкция (любой выключающий cue гасит слой).
 */
export const samplePlan = (plan: ScorePlan, t: number): Record<LaneId, LaneState> => {
  const out = Object.fromEntries(LANE_IDS.map(l => [l, neutralLaneState()])) as Record<LaneId, LaneState>;
  for (const l of LANE_IDS) {
    const st = out[l];
    for (const c of plan.lanes[l]) {
      if (c.from > t) break; // отсортировано — дальше только будущие
      if (!active(c, t)) continue;
      const m = c.mods;
      if (m.brightnessMul !== undefined) st.brightnessMul *= m.brightnessMul;
      if (m.hueTrim !== undefined) st.hueTrim += m.hueTrim;
      if (m.satTrim !== undefined) st.satTrim += m.satTrim;
      if (m.tiltTrim !== undefined) st.tiltTrim += m.tiltTrim;
      if (m.gate !== undefined) st.gate = st.gate && m.gate;
    }
    st.brightnessMul = clamp(st.brightnessMul, 0, 4);
    st.hueTrim = clamp(st.hueTrim, -1, 1);
    st.satTrim = clamp(st.satTrim, -1, 1);
    st.tiltTrim = clamp(st.tiltTrim, -1, 1);
  }
  return out;
};

/** Секция профиля, активная в момент t (для подписи в UI). */
export const sectionAtPlan = (plan: ScorePlan, t: number): ScoreSection | null => {
  const ss = plan.sections;
  for (let i = ss.length - 1; i >= 0; i--) {
    if (t >= ss[i].from) return ss[i];
  }
  return ss[0] ?? null;
};

// --- Детерминированный черновик из автопрофиля ---------------------------

/**
 * Правила черновика: какой модификатор получает каждый характер участка.
 * Значения — стартовая точка (редактируются руками/ИИ); нейтральные
 * участки cue не получают вообще, чтобы партитура не была простынёй.
 */
const DRAFT_RULES: Record<SectionKind, Array<{ lane: LaneId; mods: LaneMods }>> = {
  quiet: [
    { lane: 'rays', mods: { brightnessMul: 0.6 } },
    { lane: 'cob', mods: { brightnessMul: 0.6, satTrim: -0.2 } },
    { lane: 'backstage', mods: { brightnessMul: 0.8 } },
  ],
  sustain: [
    { lane: 'rays', mods: { brightnessMul: 0.8 } },
    { lane: 'cob', mods: { brightnessMul: 0.9 } },
  ],
  groove: [],
  peak: [
    { lane: 'rays', mods: { brightnessMul: 1.2 } },
    { lane: 'cob', mods: { brightnessMul: 1.3 } },
    { lane: 'motion', mods: { tiltTrim: 0.05 } },
  ],
  dense: [
    { lane: 'rays', mods: { brightnessMul: 1.1, hueTrim: 0.03 } },
    { lane: 'cob', mods: { brightnessMul: 1.1 } },
  ],
};

/**
 * Черновик партитуры из автопрофиля. Детерминирован: один и тот же профиль
 * → одинаковые секции, cue и id. Каждый cue покрывает свою секцию и имеет
 * source 'auto' (ручные/ИИ правки помечаются иначе и переживают перегенерацию
 * при locked=true — политика фазы 4.1+).
 */
export const draftFromProfile = (profile: TrackProfile, fingerprint: string): ScoreV1 => {
  const sections: ScoreSection[] = sectionsFromProfile(profile);
  const score = createScore(fingerprint, profile.duration, sections);
  sections.forEach((sec) => {
    const kind = sec.kind as SectionKind;
    const rules = DRAFT_RULES[kind] || [];
    rules.forEach((r, ri) => {
      score.cues.push({
        id: `cue-${sec.id}-${r.lane}-${ri}`,
        lane: r.lane,
        from: sec.from,
        to: sec.to,
        mods: { ...r.mods },
        source: 'auto',
      });
    });
  });
  return score;
};

/**
 * Перегенерация черновика с сохранением ЗАЛОЧЕННЫХ cue (фаза 4.1):
 * locked cue переживают обновление, а свежий auto-cue с тем же id уступает
 * locked-копии (иначе дубликаты id валидацию не пройдут).
 */
export const mergeDraftWithLocked = (prev: ScoreV1 | null, draft: ScoreV1): ScoreV1 => {
  if (!prev) return draft;
  const locked = prev.cues.filter(c => c.locked);
  if (locked.length === 0) return draft;
  const lockedIds = new Set(locked.map(c => c.id));
  return {
    ...draft,
    cues: [...draft.cues.filter(c => !lockedIds.has(c.id)), ...locked],
  };
};

// --- Автоматизация (запись фейдеров, фаза 5) -------------------------------

/** Секции score из автопрофиля (общее для черновика и пустого каркаса). */
export const sectionsFromProfile = (profile: TrackProfile): ScoreSection[] =>
  profile.sections.map((s, i) => ({
    id: `sec-${i}-${s.kind}`,
    from: s.start,
    to: s.end,
    kind: s.kind,
  }));

/**
 * Линейная интерполяция кривой в момент t. Пустая — undefined; до первой
 * точки — значение первой; после последней — последней (удержание хвоста,
 * как у записанного фейдера). Точки обязаны быть отсортированы по t
 * (mergeAutomation это гарантирует).
 */
export const interpAutomation = (points: AutomationPoint[], t: number): number | undefined => {
  if (points.length === 0) return undefined;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  // Линейный проход: t монотонно растёт при воспроизведении, линейка короткая
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1], b = points[i];
      const dt = b.t - a.t;
      if (dt <= 0) return b.v;
      return a.v + (b.v - a.v) * ((t - a.t) / dt);
    }
  }
  return last.v;
};

/**
 * Абсолютные значения автоматизированных параметров в момент t.
 * Чистая функция времени (та же детерминированность, что у samplePlan).
 */
export const sampleAutomation = (
  lanes: AutomationLane[] | undefined,
  t: number,
): Partial<Record<AutoTarget, number>> => {
  const out: Partial<Record<AutoTarget, number>> = {};
  if (!lanes) return out;
  for (const l of lanes) {
    const v = interpAutomation(l.points, t);
    if (v !== undefined) out[l.target] = v;
  }
  return out;
};

/**
 * Overdub-запись: новые точки цели замещают старые ВНУТРИ записанного
 * диапазона [t0, t1], снаружи старая кривая сохраняется. Значения клипуются
 * в пределы цели, итог отсортирован по времени.
 */
export const mergeAutomation = (score: ScoreV1, lanes: AutomationLane[]): ScoreV1 => {
  const incoming = lanes.filter(l => l.points.length > 0);
  if (incoming.length === 0) return score;
  const auto = [...(score.automation ?? [])];
  for (const lane of incoming) {
    const lim = AUTO_LIMITS[lane.target];
    const pts = lane.points.map(p => ({ t: p.t, v: Math.max(lim[0], Math.min(lim[1], p.v)) }));
    const t0 = Math.min(...pts.map(p => p.t));
    const t1 = Math.max(...pts.map(p => p.t));
    const existing = auto.find(a => a.target === lane.target);
    const kept = existing ? existing.points.filter(p => p.t < t0 || p.t > t1) : [];
    const merged = [...kept, ...pts].sort((a, b) => a.t - b.t);
    const id = existing?.id ?? lane.id;
    const idx = auto.findIndex(a => a.target === lane.target);
    const nextLane: AutomationLane = { id, target: lane.target, points: merged };
    if (idx >= 0) auto[idx] = nextLane; else auto.push(nextLane);
  }
  return { ...score, automation: auto };
};
