/**
 * Тесты лимитера наклона (tiltGuard) — грабля «ограничители глючат», 26.07.
 * Запуск: npx tsx tools/test-tilt-guard.ts   (из папки web)
 *
 * Физика: 0 = луч в зал, ~середина = вверх, 255 = внутрь сцены.
 * Опасна только зона у нуля.
 */
import {
  applyTiltGuard, clampTilt, getTiltLimits, isHallAllowed, setHallAllowed,
  setTiltCalibration, setTiltLimitsManual, tiltChannelOffset,
} from '../utils/tiltGuard';

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} | got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!ok) failed++;
};

// --- Дефолты до калибровки: консервативный сектор -------------------------
setTiltCalibration(null);
const d = getTiltLimits();
check('без калибровки measured=false', d.measured, false);
check('без калибровки нижняя граница выше нуля', d.safeLo > 0, true);
check('без калибровки парковка внутри сектора', d.park >= d.safeLo && d.park <= d.safeHi, true);
check('ноль подтягивается до безопасного', clampTilt(0), d.safeLo);
check('серединa проходит как есть', clampTilt(128), 128);

// --- После калибровки ------------------------------------------------------
// hall=40 (луч ещё в зал), up=130 (вертикаль), stage=255, запас 8
const l = setTiltCalibration({ hall: 40, up: 130, stage: 255, margin: 8 });
check('measured=true', l.measured, true);
check('safeLo = hall + margin', l.safeLo, 48);
check('park = вертикаль', l.park, 130);
check('safeHi = предел сцены', l.safeHi, 255);
check('опасное 0 → safeLo', clampTilt(0), 48);
check('опасное 40 (ровно hall) → safeLo', clampTilt(40), 48);
check('47 (в запасе) → safeLo', clampTilt(47), 48);
check('48 проходит', clampTilt(48), 48);
check('внутрь сцены 255 разрешено', clampTilt(255), 255);
check('за 255 клипуется', clampTilt(300), 255);
check('отрицательное → safeLo', clampTilt(-50), 48);

// --- Канал наклона по типу прибора -----------------------------------------
check('расчёска: offset 0', tiltChannelOffset('comb_rgbw'), 0);
check('led_par_8ch: наклона нет', tiltChannelOffset('led_par_8ch'), null);
check('spider: не трогаем (своя геометрия)', tiltChannelOffset('spider'), null);
check('undefined: не трогаем', tiltChannelOffset(undefined), null);

// --- applyTiltGuard на кадре ----------------------------------------------
// Расчёски на 250 и 293 → каналы мотора 250 и 293
{
  const agg: Record<number, number> = { 250: 0, 251: 90, 293: 200, 294: 90, 200: 255 };
  applyTiltGuard(agg, [250, 293]);
  check('мотор из зала поднят в сектор', agg[250], 48);
  check('мотор внутри сектора не тронут', agg[293], 200);
  check('скорость мотора не тронута', agg[251], 90);
  check('чужой канал (COB) не тронут', agg[200], 255);
}
{
  // Канал мотора вообще никем не написан: прибор сам откалиброван в 0 = в зал,
  // поэтому лимитер обязан подставить парковку, а не оставить пусто.
  const agg: Record<number, number> = { 251: 90 };
  applyTiltGuard(agg, [250]);
  check('неуправляемый мотор → парковка', agg[250], 130);
}
{
  // Блэкаут-сценарий: все каналы в нуле, мотор обязан уйти в сектор
  const agg: Record<number, number> = {};
  for (let ch = 250; ch <= 292; ch++) agg[ch] = 0;
  applyTiltGuard(agg, [250]);
  check('блэкаут: мотор не в нуле', agg[250], 48);
  check('блэкаут: лучи погашены', agg[252], 0);
}
{
  // Канал вне вселенной не должен ломать проход
  const agg: Record<number, number> = { 500: 10 };
  applyTiltGuard(agg, [513, 0, -5]);
  check('каналы вне 1..512 игнорируются', agg[500], 10);
}

// --- Деградация при кривой калибровке -------------------------------------
check('калибровка без hall → дефолты', setTiltCalibration({ up: 100 } as any).measured, false);
{
  // hall выше stage (перепутаны отметки) — сектор не должен вывернуться
  const bad = setTiltCalibration({ hall: 250, up: 128, stage: 200, margin: 8 });
  check('safeHi не ниже safeLo', bad.safeHi >= bad.safeLo, true);
  check('парковка внутри сектора', bad.park >= bad.safeLo && bad.park <= bad.safeHi, true);
}

console.log();

// --- Ручная правка сектора из UI ------------------------------------------
{
  const m = setTiltLimitsManual({ safeLo: 70, safeHi: 240, park: 150 });
  check('ручной сектор применён', [m.safeLo, m.safeHi, m.park], [70, 240, 150]);
  check('ручной сектор клипует опасное', clampTilt(10), 70);
  check('ручной сектор клипует сверху', clampTilt(250), 240);
  // Перевёрнутые границы не должны вывернуть сектор
  const bad = setTiltLimitsManual({ safeLo: 200, safeHi: 100 });
  check('safeHi подтянут до safeLo', bad.safeHi >= bad.safeLo, true);
  check('парковка втянута в сектор', bad.park >= bad.safeLo && bad.park <= bad.safeHi, true);
  // Частичная правка не сбрасывает остальное
  setTiltLimitsManual({ safeLo: 60, safeHi: 250, park: 140 });
  const p = setTiltLimitsManual({ park: 200 });
  check('частичная правка сохраняет границы', [p.safeLo, p.safeHi, p.park], [60, 250, 200]);
}

// --- Режим «свет в зал разрешён» ------------------------------------------
{
  setTiltCalibration({ hall: 40, up: 130, stage: 255, margin: 8 });
  check('по умолчанию зал запрещён', isHallAllowed(), false);
  check('до снятия: 0 поднимается', clampTilt(0), 48);

  setHallAllowed(true);
  check('флаг взведён', isHallAllowed(), true);
  check('в режиме зала 0 проходит', clampTilt(0), 0);
  check('в режиме зала 20 проходит', clampTilt(20), 20);
  check('в режиме зала клип 0..255 остаётся', [clampTilt(-5), clampTilt(300)], [0, 255]);

  // Кадр: мотор в нуле должен доехать до прибора
  const agg: Record<number, number> = { 250: 0 };
  applyTiltGuard(agg, [250]);
  check('в режиме зала кадр не поднимает мотор', agg[250], 0);

  // Пустой канал в режиме зала НЕ трогаем: иначе нельзя держать луч в нуле
  const empty: Record<number, number> = {};
  applyTiltGuard(empty, [250]);
  check('в режиме зала пустой канал не подменяется', empty[250], undefined);

  setHallAllowed(false);
  check('после выключения защита вернулась', clampTilt(0), 48);
  const back: Record<number, number> = {};
  applyTiltGuard(back, [250]);
  check('после выключения пустой канал = парковка', back[250], 130);
}

console.log();
if (failed > 0) {
  console.log(`ПРОВАЛЕНО проверок: ${failed}`);
  process.exit(1);
}
console.log('Все проверки лимитера наклона прошли');
