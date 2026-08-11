/**
 * Тесты сценариев из жалоб юзера 26.07 — проверяем на настоящем evaluateGraph.
 * Запуск: npx tsx tools/test-graph-scenarios.ts   (из папки web)
 *
 * Жалобы, которые тут закрываются:
 *  1. «Подключил качателем фейдер, двигаю — головы не двигаются.
 *      Только от миди-ноды двигаются. А миди-нода-то выключена!»
 *  2. «Комбо-нода в проекте вообще не работает, не стартует, ничем не управляет».
 *  3. «Ограничители глючат» — угол задавала не та нода, чьи границы крутили.
 *  4. Блэкаут не должен разворачивать расчёски в зал (0 = в глаза).
 */
import { evaluateGraph } from '../utils/graphEngine';
import { setTiltCalibration, getTiltLimits } from '../utils/tiltGuard';
import type { LuminaNode, LuminaEdge } from '../types';

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

// Калибровка как на реальной сцене: hall=40, вертикаль=130, предел 255
const L = setTiltCalibration({ hall: 40, up: 130, stage: 255, margin: 8 });
const MOTOR_CH = 250; // расчёска 1, offset 0

const comb = (id: string, startChannel: number): LuminaNode => ({
  id, type: 'fixture', position: { x: 0, y: 0 },
  data: {
    label: id, type: 'fixture',
    params: {
      fixtureType: 'comb_rgbw', startChannel, group: 0,
      manualValues: Array(43).fill(0), mutes: Array(43).fill(false),
      currentValues: Array(43).fill(0),
    },
  },
} as any);

const run = (nodes: LuminaNode[], edges: LuminaEdge[] = []) => {
  const { dmxUpdates } = evaluateGraph(nodes, edges, {}, {});
  const byCh: Record<number, number> = {};
  dmxUpdates.forEach(u => { byCh[u.ch] = u.val; });
  return byCh;
};

console.log('--- 1. Ручной фейдер MotorY против ВЫКЛЮЧЕННОЙ midi-track ---');
{
  // Юзер поставил фейдер наклона на 200 (внутрь сцены), midi-track выключен.
  const fixture = comb('comb1', 250);
  fixture.data.params!.manualValues[0] = 200;
  const midiTrack: LuminaNode = {
    id: 'mt', type: 'midi-track', position: { x: 0, y: 0 },
    data: { label: 'MIDI-трек', type: 'midi-track', params: {
      stop: true, group: 0, tiltMin: 35, tiltMax: 204,  // как в проекте юзера
    } },
  } as any;

  const byCh = run([fixture, midiTrack]);
  check('фейдер 200 доезжает до прибора', byCh[MOTOR_CH], 200);
  checkTrue('выключенный midi-track НЕ подменяет угол своим 204',
    byCh[MOTOR_CH] !== 204, `motor=${byCh[MOTOR_CH]}`);
  // Раньше выключенная нода писала нули по всем 43 каналам мимо merge
  check('выключенная нода не гасит цветовые каналы прибора', byCh[252], 0);
}

console.log('\n--- 2. Комбо-нода работает при выключенной midi-track ---');
{
  const fixture = comb('comb1', 250);
  const combCtl: LuminaNode = {
    id: 'cc', type: 'comb-controller', position: { x: 0, y: 0 },
    data: { label: 'Расчёски', type: 'comb-controller', params: {
      mode: 'epic', brightness: 1, colorMode: 'rainbow', saturation: 1,
      stop: false, group: 0,
      // Парковка уже прошла: иначе яркость держится в нуле
      _activeSince: Date.now() - 60_000, parkMs: 1500, fadeInMs: 600,
      tiltMin: 137, tiltMax: 175, parkTilt: 149,   // границы юзера
    } },
  } as any;
  const midiTrack: LuminaNode = {
    id: 'mt', type: 'midi-track', position: { x: 0, y: 0 },
    data: { label: 'MIDI-трек', type: 'midi-track', params: {
      stop: true, group: 0, tiltMin: 35, tiltMax: 204,
    } },
  } as any;

  const byCh = run([fixture, combCtl, midiTrack]);
  // Без входа tilt-in комбо ставит центр своего диапазона: (137+175)/2 = 156
  check('комбо задаёт угол из СВОИХ границ', byCh[MOTOR_CH], 156);
  const lit = [252, 253, 254, 256, 257, 258].some(ch => (byCh[ch] ?? 0) > 0);
  checkTrue('комбо реально светит (выключенная midi-track не гасит)', lit,
    `ch252..258 = ${[252, 253, 254, 256, 257, 258].map(c => byCh[c] ?? 0).join(',')}`);
}

console.log('\n--- 3. Лимитер: опасный угол не проходит ни одним путём ---');
{
  // Фейдер прибора выкручен в 0 = прямо в зал
  const fixture = comb('comb1', 250);
  fixture.data.params!.manualValues[0] = 0;
  const byCh = run([fixture]);
  check('фейдер в нуле поднят до safeLo', byCh[MOTOR_CH], L.safeLo);
}
{
  // Комбо с границами, залезающими в опасную зону: 10..255
  const fixture = comb('comb1', 250);
  const combCtl: LuminaNode = {
    id: 'cc', type: 'comb-controller', position: { x: 0, y: 0 },
    data: { label: 'Расчёски', type: 'comb-controller', params: {
      mode: 'quiet', stop: false, group: 0,
      _activeSince: Date.now() - 60_000, parkMs: 1500, fadeInMs: 600,
      tiltMin: 10, tiltMax: 20, parkTilt: 5,   // всё в зале
    } },
  } as any;
  const byCh = run([fixture, combCtl]);
  checkTrue('границы ноды не могут опустить мотор в зал',
    byCh[MOTOR_CH] >= L.safeLo, `motor=${byCh[MOTOR_CH]} safeLo=${L.safeLo}`);
}
{
  // Прибор без единой управляющей ноды: канал мотора никем не написан.
  // Прибор сам откалиброван в 0 = в зал, поэтому обязана встать парковка.
  const byCh = run([comb('comb1', 250)]);
  checkTrue('неуправляемый мотор уведён из зала',
    byCh[MOTOR_CH] >= L.safeLo, `motor=${byCh[MOTOR_CH]}`);
}

console.log('\n--- 4. Парковка при включении комбо-ноды ---');
{
  const fixture = comb('comb1', 250);
  const combCtl: LuminaNode = {
    id: 'cc', type: 'comb-controller', position: { x: 0, y: 0 },
    data: { label: 'Расчёски', type: 'comb-controller', params: {
      mode: 'epic', brightness: 1, stop: false, group: 0,
      parkMs: 1500, fadeInMs: 600,   // _activeSince не задан → только что включили
    } },
  } as any;
  const byCh = run([fixture, combCtl]);
  check('на парковке мотор в вертикали', byCh[MOTOR_CH], L.park);
  const beams = [252, 253, 254, 255, 256, 257, 258, 259];
  check('на парковке лучи погашены', beams.map(c => byCh[c] ?? 0), beams.map(() => 0));
}

console.log('\n--- 5. Несколько расчёсок: у каждой свой канал мотора ---');
{
  const byCh = run([comb('c1', 250), comb('c2', 293), comb('c3', 336), comb('c4', 379)]);
  [250, 293, 336, 379].forEach((ch, i) => {
    checkTrue(`расчёска ${i + 1}: мотор в безопасном секторе`,
      byCh[ch] >= L.safeLo && byCh[ch] <= L.safeHi, `ch${ch}=${byCh[ch]}`);
  });
}

console.log('\n--- 6. Прибор без наклона лимитер не трогает ---');
{
  const cob: LuminaNode = {
    id: 'cob', type: 'fixture', position: { x: 0, y: 0 },
    data: { label: 'COB', type: 'fixture', params: {
      fixtureType: 'led_par_8ch', startChannel: 200, group: 0,
      manualValues: [0, 0, 0, 0, 0, 0, 0, 0], mutes: Array(8).fill(false),
    } },
  } as any;
  const byCh = run([cob]);
  check('мастер COB остаётся нулём', byCh[200], 0);
}

console.log();
if (failed > 0) {
  console.log(`ПРОВАЛЕНО проверок: ${failed}`);
  process.exit(1);
}
console.log('Все сценарии из жалоб закрыты');
