/**
 * Безопасный сектор наклона расчёсок — единственный лимитер в проекте.
 *
 * ФИЗИКА ПРИБОРА (со слов юзера 26.07, проверять калибровкой, НЕ выдумывать).
 * Рейка с 10 светодиодами качается вбок на 180°, канал MotorY (offset 0):
 *
 *      0            ~128           255
 *   в зал  →  ВВЕРХ (вертикаль)  →  внутрь сцены (крайнее)
 *
 * Опасна ТОЛЬКО зона около нуля: приборы стоят на авансцене на уровне глаз
 * сидящих людей, и на нуле луч бьёт прямо в зал. Сторона «внутрь сцены»
 * безопасна — луч уходит над сценой.
 *
 * ВАЖНО: старые комментарии в коде утверждали «255 = вверх» и предлагали
 * «безопасный сектор = верхняя половина 128..255». Это неверно: 255 — это
 * задняя стена, а не потолок; такой «сектор» выбрасывал половину хода и
 * не описывал опасную зону у нуля.
 *
 * Приборы при включении сами калибруются в 0 — то есть ДО первого нашего
 * кадра они уже смотрят в зал. Поэтому мотор нельзя оставлять без
 * управления: канал держим активно (см. applyTiltGuard).
 *
 * Значения берутся из tools/wing/tilt_calibration.json через GET
 * /api/calibration (замер на железе, tools/calibrate_tilt.py). Пока замера
 * нет — консервативные дефолты ниже.
 */

export interface TiltLimits {
  /** Ниже этого мотор не опускается никогда: зона «в зал». */
  safeLo: number;
  /** Верхний предел хода (сторона сцены безопасна, поэтому обычно 255). */
  safeHi: number;
  /** Угол парковки: вертикаль, «в потолок». */
  park: number;
  /** true — числа измерены на железе, false — консервативные дефолты. */
  measured: boolean;
}

/**
 * Дефолты до калибровки. Ход 180° на 255 единиц = 0.7° на единицу.
 * safeLo = 64 — это ~45° выше горизонта, заведомо над головами зрителей.
 * park = 128 — вертикаль. Намеренно с большим запасом: до замера лучше
 * потерять часть хода, чем ударить в глаза.
 */
const DEFAULT_LIMITS: TiltLimits = {
  safeLo: 64,
  safeHi: 255,
  park: 128,
  measured: false,
};

let limits: TiltLimits = { ...DEFAULT_LIMITS };

/**
 * Осознанный обход лимита: «сейчас мне НУЖНО светить в зал».
 * Сознательно НЕ сохраняется в файл и не переживает перезагрузку страницы:
 * такой режим должен требовать явного включения каждый раз, иначе однажды
 * забудешь его выключить и получишь лучи в глаза на следующем концерте.
 */
let allowHall = false;

export const getTiltLimits = (): TiltLimits => limits;
export const isHallAllowed = (): boolean => allowHall;
export const setHallAllowed = (v: boolean): void => { allowHall = v; };

/** Ручная правка сектора из UI (без калибровщика). */
export const setTiltLimitsManual = (next: Partial<TiltLimits>): TiltLimits => {
  const safeLo = clamp255(next.safeLo ?? limits.safeLo);
  const safeHi = Math.max(safeLo, clamp255(next.safeHi ?? limits.safeHi));
  const park = Math.min(safeHi, Math.max(safeLo, clamp255(next.park ?? limits.park)));
  limits = { safeLo, safeHi, park, measured: next.measured ?? limits.measured };
  return limits;
};

/**
 * Пересчёт сектора из отметок калибровщика.
 * hall — где луч ещё бьёт в зал, up — вертикаль, stage — предел внутрь сцены.
 * От hall отступаем margin вверх: между «уже не в глаза» и «безопасно» нужен
 * запас на провис траверсы, наклон пола и разброс приборов.
 */
export const setTiltCalibration = (marks: Record<string, number> | null | undefined): TiltLimits => {
  if (!marks || typeof marks.hall !== 'number') {
    limits = { ...DEFAULT_LIMITS };
    return limits;
  }
  const margin = typeof marks.margin === 'number' ? marks.margin : 8;
  const hall = clamp255(marks.hall);
  const up = typeof marks.up === 'number' ? clamp255(marks.up)
           : typeof marks.horizon === 'number' ? clamp255(marks.horizon)
           : 128;
  const stage = typeof marks.stage === 'number' ? clamp255(marks.stage) : 255;
  const safeLo = clamp255(hall + margin);
  const safeHi = Math.max(safeLo, stage);
  const park = Math.min(safeHi, Math.max(safeLo, typeof marks.park === 'number' ? clamp255(marks.park) : up));
  limits = { safeLo, safeHi, park, measured: true };
  return limits;
};

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** Загрузить калибровку с сервера. Молча остаётся на дефолтах при ошибке. */
export const loadTiltCalibration = async (httpApiUrl: string): Promise<TiltLimits> => {
  try {
    const res = await fetch(`${httpApiUrl}/api/calibration`);
    if (!res.ok) return limits;
    const data = await res.json();
    // Ручная правка из UI (limits) имеет приоритет над замером по свету (marks)
    if (data?.limits && typeof data.limits.safeLo === 'number') {
      return setTiltLimitsManual({ ...data.limits, measured: true });
    }
    return setTiltCalibration(data?.marks);
  } catch {
    return limits;
  }
};

/** Загнать угол в безопасный сектор. При включённом «разрешить зал» — только 0..255. */
export const clampTilt = (v: number): number =>
  allowHall
    ? clamp255(v)
    : Math.max(limits.safeLo, Math.min(limits.safeHi, clamp255(v)));

/**
 * Канал наклона у прибора. Пока только расчёски: их сектор измерен, а у
 * паучков/лазера свои оси и своя геометрия — гадать за них нельзя.
 * comb_rgbw: offset 0 = MotorY (см. FIXTURE_LAYOUTS в constants.ts).
 */
export const tiltChannelOffset = (fixtureType: string | undefined): number | null =>
  fixtureType === 'comb_rgbw' ? 0 : null;

/**
 * Финальный клип кадра. Вызывать ОДИН раз на готовом агрегаторе, после всех
 * нод: только здесь лимит не обойти — ни ручным фейдером прибора, ни
 * генератором на входе, ни выключенной нодой, ни блэкаутом.
 *
 * Если канал мотора вообще никем не написан, ставим парковку: прибор держит
 * последнее значение вечно, а сам по себе он откалиброван в 0 = в зал.
 * Исключение — режим «разрешить зал»: там пустой канал не трогаем вовсе,
 * иначе нельзя было бы держать луч в нуле ручным фейдером.
 */
export const applyTiltGuard = (
  aggregator: Record<number, number>,
  tiltChannels: number[],
): void => {
  for (const ch of tiltChannels) {
    if (ch < 1 || ch > 512) continue;
    const cur = aggregator[ch];
    if (cur === undefined) {
      if (!allowHall) aggregator[ch] = limits.park;
      continue;
    }
    aggregator[ch] = clampTilt(cur);
  }
};
