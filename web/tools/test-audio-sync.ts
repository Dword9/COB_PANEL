/**
 * Тесты синхры со входом звукача (28.07): нормировка кадров, спектрограмма
 * из PCM и нормированная кросс-корреляция matchWindow/isLock.
 * WebAudio здесь нет — проверяется чистая математика.
 * Запуск: npx tsx tools/test-audio-sync.ts   (из папки web)
 */
import {
  normalizeFrames, matchWindow, isLock, spectrogramFromPcm,
} from '../services/audioSyncFollower';

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} | got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!ok) failed++;
};
const checkTrue = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`);
  if (!cond) failed++;
};

// Детерминированный ГПСЧ (LCG) — тесты не должны мигать
const lcg = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};

const BANDS = 12;
const randRef = (frames: number, seed: number): Float32Array => {
  const rnd = lcg(seed);
  const d = new Float32Array(frames * BANDS);
  for (let i = 0; i < d.length; i++) d[i] = rnd();
  normalizeFrames(d, frames, BANDS);
  return d;
};
const slice = (d: Float32Array, fromFrame: number, count: number): Float32Array =>
  d.slice(fromFrame * BANDS, (fromFrame + count) * BANDS);

console.log('--- 1. normalizeFrames: среднее 0, σ 1, тишина → нули ---');
{
  const d = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  normalizeFrames(d, 1, BANDS);
  const mean = d.reduce((a, b) => a + b, 0) / BANDS;
  const std = Math.sqrt(d.reduce((a, b) => a + b * b, 0) / BANDS);
  checkTrue('среднее ≈ 0', Math.abs(mean) < 1e-6, `mean=${mean}`);
  checkTrue('σ ≈ 1', Math.abs(std - 1) < 1e-4, `std=${std}`);
  const sil = new Float32Array(BANDS).fill(-80);
  normalizeFrames(sil, 1, BANDS);
  check('тишина → нулевой кадр', Array.from(sil), new Array(BANDS).fill(0));
}

console.log('\n--- 2. matchWindow: срез эталона находится на своём месте ---');
{
  const ref = randRef(600, 42);
  // Окно = кадры 100..229 эталона + лёгкий шум (как живой сигнал)
  const win = slice(ref, 100, 130);
  const rnd = lcg(7);
  for (let i = 0; i < win.length; i++) win[i] += (rnd() - 0.5) * 0.15;
  normalizeFrames(win, 130, BANDS);
  const m = matchWindow(ref, 600, win, 130, BANDS);
  check('позиция найдена точно (offset=100)', m.offset, 100);
  checkTrue('score высокий', m.score > 0.9, `score=${m.score.toFixed(3)}`);
  checkTrue('лок уверенный', isLock(m.score, m.margin), `margin=${m.margin.toFixed(3)}`);
}

console.log('\n--- 3. Перемотка диджея: срез из другого места → другая позиция ---');
{
  const ref = randRef(600, 43);
  const win = slice(ref, 400, 130);
  normalizeFrames(win, 130, BANDS);
  const m = matchWindow(ref, 600, win, 130, BANDS);
  check('перелок на offset=400', m.offset, 400);
  checkTrue('лок уверенный', isLock(m.score, m.margin), `score=${m.score.toFixed(3)}`);
}

console.log('\n--- 4. Чужой трек (шум) → лока нет ---');
{
  const ref = randRef(600, 44);
  const win = randRef(130, 99); // совсем другой «сигнал»
  const m = matchWindow(ref, 600, win, 130, BANDS);
  checkTrue('score низкий', m.score < 0.5, `score=${m.score.toFixed(3)}`);
  check('лок отклонён', isLock(m.score, m.margin), false);
}

console.log('\n--- 5. Повторяющийся участок: score высокий, но margin мал → не лок ---');
{
  // Периодичный эталон (один и тот же блок 4 раза) — классический случай
  // ложной синхры на репетитивной музыке; margin должен спасать.
  const block = randRef(80, 5);
  const ref = new Float32Array(320 * BANDS);
  for (let r = 0; r < 4; r++) ref.set(block, r * 80 * BANDS);
  const win = slice(ref, 0, 80);
  const m = matchWindow(ref, 320, win, 80, BANDS);
  checkTrue('score высокий (повторы совпадают)', m.score > 0.9, `score=${m.score.toFixed(3)}`);
  checkTrue('margin ≈ 0 → лок отклонён', m.margin < 0.02 && !isLock(m.score, m.margin),
    `margin=${m.margin.toFixed(4)}`);
}

console.log('\n--- 6. Спектрограмма из PCM: синус 440 Гц попадает в свою полосу ---');
(async () => {
  const SR = 22050;
  const sec = 2;
  const pcm = new Float32Array(SR * sec);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(2 * Math.PI * 440 * i / SR) * 0.8;
  const spec = await spectrogramFromPcm(pcm, SR);
  checkTrue('кадры посчитаны', spec.frames >= 15, `frames=${spec.frames}`);
  // 440 Гц → полоса k: k = 12·ln(440/30)/ln(8000/30) ≈ 5.8 → ждём пик в 5 или 6
  const votes: Record<number, number> = {};
  for (let f = 0; f < spec.frames; f++) {
    let best = 0, bestV = -Infinity;
    for (let b = 0; b < BANDS; b++) {
      const v = spec.data[f * BANDS + b];
      if (v > bestV) { bestV = v; best = b; }
    }
    votes[best] = (votes[best] || 0) + 1;
  }
  const topBand = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  checkTrue('доминирует полоса 440 Гц (5 или 6)', topBand === '5' || topBand === '6',
    `topBand=${topBand} votes=${JSON.stringify(votes)}`);

  console.log();
  if (failed > 0) {
    console.log(`ПРОВАЛЕНО проверок: ${failed}`);
    process.exit(1);
  }
  console.log('Математика синхры со входом работает');
})();