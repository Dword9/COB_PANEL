/**
 * Частотные полосы в ГЕРЦАХ — единое место, где решается, что такое
 * LOW / MID / HIGH и как выглядит спектр на ноде.
 *
 * До 27.07 полосы считались в inputAudioManager ЛИНЕЙНЫМ делением массива
 * FFT-бинов на три равные части — без учёта sampleRate. При fftSize=256 и
 * 48 кГц получалось: LOW = 0..7.5 кГц (т.е. «всё сразу»), MID = 7.5..15.75 кГц,
 * HIGH = 15.75..24 кГц (почти пусто для музыки). Отсюда жалоба юзера
 * «непонятные частоты»: LOW реагировал на вокал, HIGH не реагировал ни на что.
 *
 * Границы — музыкальные: бас до 250 Гц (кик/бас), середина 250 Гц..4 кГц
 * (вокал, снейр, гитара), верх 4..16 кГц (хэты, тарелки, воздух).
 * Выше 16 кГц в музыке почти ничего нет, а у микрофонов там шум.
 */

export const BAND_LOW_HZ: readonly [number, number] = [20, 250];
export const BAND_MID_HZ: readonly [number, number] = [250, 4000];
export const BAND_HIGH_HZ: readonly [number, number] = [4000, 16000];

/** Спектр-визуализатор на InputNode: логарифмическая шкала, как слышит ухо. */
export const SPECTRUM_MIN_HZ = 20;
export const SPECTRUM_MAX_HZ = 16000;
export const SPECTRUM_BANDS = 32;

/**
 * Средний уровень в диапазоне [fromHz, toHz) по массиву FFT-бинов.
 * Бин 0 — DC-составляющая (постоянный ток), в музыке её нет, пропускаем всегда.
 * Значения бинов — дБ-шкала 0..255 из getByteFrequencyData (minDecibels..maxDecibels);
 * для световой реактивности это УДОБНО: дБ ≈ то, как ухо слышит громкость,
 * тихие полосы не проваливаются в ноль, как было бы с линейной амплитудой.
 */
export const avgHzRange = (
  data: ArrayLike<number>,
  sampleRate: number,
  fromHz: number,
  toHz: number
): number => {
  if (!data.length || sampleRate <= 0) return 0;
  const binHz = sampleRate / 2 / data.length;
  const from = Math.max(1, Math.floor(fromHz / binHz)); // бин 0 = DC
  if (from >= data.length) return 0; // полоса выше частоты Найквиста
  // Узкая полоса (шире нуля, но меньше одного бина) — берём хотя бы один бин
  const to = Math.min(data.length, Math.max(from + 1, Math.ceil(toHz / binHz)));
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i] || 0;
  return sum / (to - from);
};

/** LOW / MID / HIGH в герцах. На вход — массив FFT-бинов из AnalyserNode. */
export const splitThreeBands = (
  data: ArrayLike<number>,
  sampleRate: number
): { low: number; mid: number; high: number } => ({
  low: avgHzRange(data, sampleRate, BAND_LOW_HZ[0], BAND_LOW_HZ[1]),
  mid: avgHzRange(data, sampleRate, BAND_MID_HZ[0], BAND_MID_HZ[1]),
  high: avgHzRange(data, sampleRate, BAND_HIGH_HZ[0], BAND_HIGH_HZ[1]),
});

/**
 * N полос для спектра на ноде, логарифмически от 20 Гц до 16 кГц.
 * Линейное деление отдавало басу 1-2 столбика из 32 — теперь басу ~10.
 */
export const logBands = (
  data: ArrayLike<number>,
  sampleRate: number,
  count: number = SPECTRUM_BANDS
): number[] => {
  const bands: number[] = [];
  const ratio = SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ;
  for (let i = 0; i < count; i++) {
    const f0 = SPECTRUM_MIN_HZ * Math.pow(ratio, i / count);
    const f1 = SPECTRUM_MIN_HZ * Math.pow(ratio, (i + 1) / count);
    bands.push(avgHzRange(data, sampleRate, f0, f1));
  }
  return bands;
};
