/**
 * Тесты семантики СТОП/ПАУЗА и живых входов (жалобы 28.07):
 *  - стоп = обнулить сигнал (не заморозка — заморозка это пауза);
 *  - пауза = время заморожено (dt=0), hold-вспышка НЕ стареет, кадр идентичен;
 *  - внешние входы (tilt) пересчитываются и при dt=0 — фейдер жив на паузе.
 * Уровень движка (LightEngine чистый, без DOM). Транспортную часть
 * (halted в midiTrackManager) покрывают эти же инварианты через render().
 * Запуск: npx tsx tools/test-stop-pause.ts   (из папки web)
 */
import { LightEngine, DEFAULT_LIGHT_PARAMS, AnalysisData } from '../utils/lightEngine';

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

const ANALYSIS: AnalysisData = {
  duration: 10,
  tracks: [
    { id: 0, notes: [{ pitch: 60, start: 0.5, end: 0.51, lvl: 0.8, spec: 0.9 }] },
    { id: 1, notes: [{ pitch: 72, start: 0.52, end: 0.55, lvl: 0.6, spec: 0.7 }] },
  ],
};

const PARAMS = { ...DEFAULT_LIGHT_PARAMS, release: 0.05, minFlashFrames: 2 };

const maxPx = (px: Float32Array) => Math.max(...Array.from(px));
const mkEngine = () => {
  const e = new LightEngine(40);
  e.load(ANALYSIS);
  return e;
};

console.log('--- 1. Пауза (dt=0): вспышка заморожена, кадр не стареет ---');
{
  const e = mkEngine();
  // Разгоняем вспышку: обе ноты стартовали, hold=2→1
  e.render(0.53, PARAMS, 0.016);
  // Пауза в момент 0.62: по release ноты мертвы (env=0), держит только hold.
  // dt=0 → hold не стареет → кадр обязан остаться идентичным и ярким.
  const fa = e.render(0.62, PARAMS, 0);
  const fb = e.render(0.62, PARAMS, 0);
  const fc = e.render(0.62, PARAMS, 0);
  checkTrue('первый кадр паузы яркий (hold жив)', maxPx(fa.px) > 0.05,
    `maxPx=${maxPx(fa.px).toFixed(3)}`);
  checkTrue('третий кадр паузы НЕ погас (hold не старел)', maxPx(fc.px) > 0.05,
    `maxPx=${maxPx(fc.px).toFixed(3)}`);
  check('кадры паузы идентичны', Array.from(fb.px), Array.from(fc.px));
}

console.log('\n--- 2. Контроль: dt>0 вспышка стареет и гаснет ---');
{
  const e = mkEngine();
  e.render(0.53, PARAMS, 0.016);   // hold=1
  e.render(0.62, PARAMS, 0.016);   // hold 1→0, env=1 по hold
  const f = e.render(0.64, PARAMS, 0.016); // hold=0, env=0 → темно
  check('после старения hold кадр погас', maxPx(f.px), 0);
}

console.log('\n--- 3. Живые входы на паузе: tilt пересчитывается при dt=0 ---');
{
  const e = mkEngine();
  e.render(0.53, PARAMS, 0.016);
  const lo = { ...PARAMS, tilt: 0 };
  const hi = { ...PARAMS, tilt: 1 };
  const mLo = e.render(0.62, lo, 0).motor;
  const mHi = e.render(0.62, hi, 0).motor;
  check('tilt=0 → мотор на нижней границе', mLo, Math.round(Math.min(PARAMS.tiltMin, PARAMS.tiltMax)));
  check('tilt=1 → мотор на верхней границе', mHi, Math.round(Math.max(PARAMS.tiltMin, PARAMS.tiltMax)));
  checkTrue('на паузе фейдер наклона ДВИГАЕТ мотор', mHi > mLo, `${mLo} → ${mHi}`);
}

console.log();
if (failed > 0) {
  console.log(`ПРОВАЛЕНО проверок: ${failed}`);
  process.exit(1);
}
console.log('Семантика стоп/пауза и живые входы на паузе работают');
