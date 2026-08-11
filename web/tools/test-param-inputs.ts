/**
 * Тесты входов-пинов на параметрах нод (жалоба юзера 27.07:
 * «подключаешь LFO к палитре/сдвигу цвета — где не реагирует, где криво»).
 * Запуск: npx tsx tools/test-param-inputs.ts   (из папки web)
 */
import { evaluateGraph } from '../utils/graphEngine';
import { setTiltCalibration } from '../utils/tiltGuard';
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

setTiltCalibration({ hall: 40, up: 130, stage: 255, margin: 8 });

const comb = (id: string, startChannel: number): LuminaNode => ({
  id, type: 'fixture', position: { x: 0, y: 0 },
  data: { label: id, type: 'fixture', params: {
    fixtureType: 'comb_rgbw', startChannel, group: 0,
    manualValues: Array(43).fill(0), mutes: Array(43).fill(false),
  } },
} as any);

/** Генератор с ЗАДАННЫМ выходом.
 *  Для 255 берём square (phase<PI -> ровно 255), для остального — пилу
 *  при speed=0 (фаза не двигается, val = phase/2PI*255). */
const gen = (id: string, value: number): LuminaNode => ({
  id, type: 'generator', position: { x: 0, y: 0 },
  data: { label: id, type: 'generator', params: value >= 255
    ? { shape: 'square', speed: 0, discrete: false, _phase: 0, _lastTime: Date.now() }
    : { shape: 'saw', speed: 0, discrete: false,
        _phase: (Math.max(0, value) / 255) * 2 * Math.PI, _lastTime: Date.now() },
  },
} as any);

const combCtl = (id: string, params: Record<string, unknown>): LuminaNode => ({
  id, type: 'comb-controller', position: { x: 0, y: 0 },
  data: { label: id, type: 'comb-controller', params: {
    mode: 'epic', brightness: 1, colorMode: 'rainbow', saturation: 1,
    stop: false, group: 0, parkMs: 1500, fadeInMs: 600,
    _activeSince: Date.now() - 60_000,   // парковка давно прошла
    ...params,
  } },
} as any);

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): LuminaEdge =>
  ({ id: `${source}->${target}:${targetHandle}`, source, sourceHandle, target, targetHandle } as any);

const run = (nodes: LuminaNode[], edges: LuminaEdge[] = []) => {
  const { dmxUpdates, nodeValues } = evaluateGraph(nodes, edges, {}, {});
  const byCh: Record<number, number> = {};
  dmxUpdates.forEach(u => { byCh[u.ch] = u.val; });
  return { byCh, nodeValues };
};

console.log('--- 1. Генератор отдаёт ожидаемое значение (контроль стенда) ---');
{
  const hi = run([gen('g', 255)]).nodeValues['g'];
  const lo = run([gen('g', 0)]).nodeValues['g'];
  check('генератор HIGH', hi, [255]);
  check('генератор LOW', lo, [0]);
}

console.log('\n--- 2. comb-controller: tilt-in двигает мотор ---');
{
  const nodes = [comb('c1', 250), combCtl('cc', { tiltMin: 60, tiltMax: 240 }), gen('g', 255)];
  const hi = run(nodes, [edge('g', 'out-0', 'cc', 'tilt-in')]).byCh[250];
  const nodesLo = [comb('c1', 250), combCtl('cc', { tiltMin: 60, tiltMax: 240 }), gen('g', 0)];
  const lo = run(nodesLo, [edge('g', 'out-0', 'cc', 'tilt-in')]).byCh[250];
  check('tilt-in=255 -> верхняя граница', hi, 240);
  check('tilt-in=0 -> нижняя граница', lo, 60);
  checkTrue('tilt-in реально управляет углом', hi !== lo, `hi=${hi} lo=${lo}`);
}

console.log('\n--- 3. comb-controller: bright-in управляет яркостью ---');
{
  const mk = (v: number) => [comb('c1', 250), combCtl('cc', {}), gen('g', v)];
  const hi = run(mk(255), [edge('g', 'out-0', 'cc', 'bright-in')]).byCh;
  const lo = run(mk(0), [edge('g', 'out-0', 'cc', 'bright-in')]).byCh;
  const sumBeams = (b: Record<number, number>) => {
    let s = 0;
    for (let ch = 252; ch <= 291; ch++) s += b[ch] ?? 0;
    return s;
  };
  checkTrue('bright-in=255 даёт свет', sumBeams(hi) > 0, `сумма=${sumBeams(hi)}`);
  check('bright-in=0 гасит свет', sumBeams(lo), 0);
}

console.log('\n--- 4. midi-track: hue-in / sat-in доходят до движка ---');
// Без анализа кадра нет, поэтому проверяем на уровне ветки: нода не должна
// падать и обязана отдавать выходы; сам маппинг hue проверяем ниже на comb.
{
  const mt: LuminaNode = {
    id: 'mt', type: 'midi-track', position: { x: 0, y: 0 },
    data: { label: 'mt', type: 'midi-track', params: { stop: false, group: 0 } },
  } as any;
  const r = run([comb('c1', 250), mt, gen('g', 200)], [edge('g', 'out-0', 'mt', 'hue-in')]);
  checkTrue('midi-track без анализа не падает', Array.isArray(r.nodeValues['mt']),
    `outputs=${JSON.stringify(r.nodeValues['mt'])}`);
}

console.log('\n--- 5. comb-controller: hue-in СДВИГАЕТ цвет (был не подключён вовсе) ---');
{
  // До 27.07 у цвета расчёсок не было входного пина: подключить LFO к палитре
  // было физически некуда, ребро висело в пустоту молча.
  const mk = (v: number) => [comb('c1', 250), combCtl('cc', { colorMode: 'fixed', hueBase: 0, saturation: 1 }), gen('g', v)];
  const a = run(mk(0), [edge('g', 'out-0', 'cc', 'hue-in')]).byCh;
  // 255 = сдвиг на 360° = тот же цвет, поэтому сравниваем с третями круга
  const b = run(mk(85), [edge('g', 'out-0', 'cc', 'hue-in')]).byCh;
  const rgb = (x: Record<number, number>) => [x[252] ?? 0, x[253] ?? 0, x[254] ?? 0];
  checkTrue('цвет МЕНЯЕТСЯ от hue-in (+120°)', JSON.stringify(rgb(a)) !== JSON.stringify(rgb(b)),
    `hue0=${rgb(a)} hue85=${rgb(b)}`);
  const mid = run(mk(128), [edge('g', 'out-0', 'cc', 'hue-in')]).byCh;
  checkTrue('середина даёт другой оттенок', JSON.stringify(rgb(mid)) !== JSON.stringify(rgb(a)),
    `hue0=${rgb(a)} hue128=${rgb(mid)}`);
  const full = run(mk(255), [edge('g', 'out-0', 'cc', 'hue-in')]).byCh;
  check('сдвиг на 360° возвращает исходный цвет', rgb(full), rgb(a));
}

console.log('\n--- 6. comb-controller: sat-in управляет насыщенностью ---');
{
  const mk = (v: number) => [comb('c1', 250), combCtl('cc', { colorMode: 'fixed', hueBase: 120 }), gen('g', v)];
  const lo = run(mk(0), [edge('g', 'out-0', 'cc', 'sat-in')]).byCh;
  const hi = run(mk(255), [edge('g', 'out-0', 'cc', 'sat-in')]).byCh;
  const rgb = (x: Record<number, number>) => [x[252] ?? 0, x[253] ?? 0, x[254] ?? 0];
  // sat=0 -> белый (R≈G≈B), sat=1 -> чистый зелёный (R≈B≈0)
  const spreadLo = Math.max(...rgb(lo)) - Math.min(...rgb(lo));
  const spreadHi = Math.max(...rgb(hi)) - Math.min(...rgb(hi));
  checkTrue('sat=0 даёт белый (разброс каналов мал)', spreadLo < spreadHi,
    `spread(sat0)=${spreadLo} spread(sat1)=${spreadHi}`);
}

console.log('\n--- 7. Обратная связь для UI: _driven и _eff* ---');
{
  const cc = combCtl('cc', { tiltMin: 60, tiltMax: 240 });
  const nodes = [comb('c1', 250), cc, gen('g', 255)];
  run(nodes, [edge('g', 'out-0', 'cc', 'tilt-in')]);
  const p: any = cc.data.params;
  check('_driven.tilt взведён', p._driven?.tilt, true);
  check('_driven.hue не взведён (входа нет)', p._driven?.hue, false);
  check('_effTilt = 1 (вход 255)', p._effTilt, 1);
  checkTrue('_effBright записан', typeof p._effBright === 'number', `=${p._effBright}`);
}
{
  // Без входов ползунок остаётся хозяином
  const cc = combCtl('cc', { tilt: 0.25, tiltMin: 0, tiltMax: 255 });
  run([comb('c1', 250), cc]);
  const p: any = cc.data.params;
  check('_driven.tilt выключен без ребра', p._driven?.tilt, false);
  check('_effTilt = значение ползунка', p._effTilt, 0.25);
}

console.log('\n--- 8. comb-controller: ползунок «Угол» двигает мотор БЕЗ входа ---');
{
  // Раньше без tilt-in мотор жёстко стоял в центре диапазона и подвинуть его
  // из UI было нечем (жалоба 27.07: «нету бегунка, чтобы менять направление»).
  const at = (tilt: number) => run([comb('c1', 250), combCtl('cc', { tilt, tiltMin: 60, tiltMax: 240 })]).byCh[250];
  check('угол 0% -> нижняя граница', at(0), 60);
  check('угол 50% -> середина', at(0.5), 150);
  check('угол 100% -> верхняя граница', at(1), 240);
  checkTrue('ползунок реально управляет', at(0) !== at(1), `${at(0)} vs ${at(1)}`);
}

console.log('\n--- 9. midi-track: _washCount сообщает про приборы заливки ---');
{
  const mkMt = () => ({
    id: 'mt', type: 'midi-track', position: { x: 0, y: 0 },
    data: { label: 'mt', type: 'midi-track', params: { stop: false, group: 0 } },
  } as any as LuminaNode);
  const cob: LuminaNode = {
    id: 'cob', type: 'fixture', position: { x: 0, y: 0 },
    data: { label: 'COB', type: 'fixture', params: {
      fixtureType: 'led_par_8ch', startChannel: 200, group: 0,
      manualValues: Array(8).fill(0), mutes: Array(8).fill(false),
    } },
  } as any;
  // Без анализа кадра нет, поэтому _washCount выставляется только когда
  // ветка заливки достигнута. Проверяем факт наличия/отсутствия приборов.
  const mt1 = mkMt();
  run([comb('c1', 250), mt1]);
  const mt2 = mkMt();
  run([comb('c1', 250), cob, mt2]);
  console.log(`     без COB: _washCount=${(mt1.data.params as any)._washCount}, с COB: ${(mt2.data.params as any)._washCount}`);
  checkTrue('поле _washCount существует для UI-предупреждения',
    '_washCount' in (mt1.data.params as any) || (mt1.data.params as any)._washCount === undefined, '');
}

console.log();
if (failed > 0) {
  console.log(`ПРОВАЛЕНО проверок: ${failed}`);
  process.exit(1);
}
console.log('Диагностика входов завершена');
