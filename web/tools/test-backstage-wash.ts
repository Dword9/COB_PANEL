/**
 * Тесты плавного фона кулис (28.07): backstageWash + isRgbWashFixture + гейт.
 * Запрос юзера: «плавный перелив справа налево, без дёрганий; резкое —
 * только когда в треке прописаны удары». Это и проверяем.
 * Запуск: npx tsx tools/test-backstage-wash.ts   (из папки web)
 */
import { BackstageWash, backstageIndex, backstageOrderKey, zonesFromBeams, notesFrames } from '../utils/backstageWash';
import { evaluateGraph, isRgbWashFixture, isWashFixture } from '../utils/graphEngine';
import { buildProfile } from '../utils/trackProfile';
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

const PARAMS = {
  brightness: 1, hueShift: 0, saturation: 0.9, flow: 1,
  count: 6, floor: 0.35, energy: 0.5, waveLo: 0.08,
};

console.log('--- 1. Физический порядок по именам нод (карта рига) ---');
{
  check('Front L = 0', backstageIndex('Front L'), 0);
  check('Mid L = 1', backstageIndex('Mid L'), 1);
  check('Backdrop L = 2', backstageIndex('Backdrop L'), 2);
  check('Backdrop R = 3', backstageIndex('Backdrop R'), 3);
  check('Mid R = 4', backstageIndex('Mid R'), 4);
  check('Front R = 5', backstageIndex('Front R'), 5);
  check('чужое имя → null', backstageIndex('PAR Left - Red'), null);
  checkTrue('сортировка: Front L перед Mid R',
    backstageOrderKey('Front L', 113) < backstageOrderKey('Mid R', 65));
}

console.log('\n--- 2. Плавность: соседние кадры не скачут (тихий участок, без ударных) ---');
{
  const e = new BackstageWash();
  e.setProfile(buildProfile(60, [], [{ start: 1, lvl: 0.5 }]));
  // Разгон сглаживателя
  for (let t = 0; t <= 5; t += 0.05) e.render(t, PARAMS);
  const a = e.render(10.0, PARAMS);
  const b = e.render(10.05, PARAMS);
  let maxDelta = 0;
  for (let i = 0; i < 6; i++) {
    maxDelta = Math.max(maxDelta,
      Math.abs(a[i].master - b[i].master),
      Math.abs(a[i].r - b[i].r), Math.abs(a[i].g - b[i].g), Math.abs(a[i].b - b[i].b));
  }
  checkTrue('макс. скачок за 50 мс < 0.02 (плавно)', maxDelta < 0.02,
    `maxDelta=${maxDelta.toFixed(4)}`);
  check('приборов в кадре = 6', a.length, 6);
  // Бегущая «комета» (28.07, вторая редакция): яркая узкая волна, впадины
  // почти в ноль — «как пиксели лучей, только по 6 адресам».
  const masters = a.map(f => f.master);
  const mn = Math.min(...masters), mx = Math.max(...masters);
  checkTrue('впадины почти в ноль (< 0.1)', mn < 0.1, `min=${mn.toFixed(3)}`);
  checkTrue('гребень яркий (> 0.55)', mx > 0.55, `max=${mx.toFixed(3)}`);
  checkTrue('комета узкая: ярких ≤ 3 из 6',
    masters.filter(m => m > 0.5 * mx).length <= 3,
    `ярких=${masters.filter(m => m > 0.5 * mx).length}`);
  checkTrue('динамика: размах яркости по приборам > 0.4', mx - mn > 0.4,
    `размах=${(mx - mn).toFixed(3)}`);
}

console.log('\n--- 2б. Динамика зависит от waveLo: 0.8 = почти ровно, 0.1 = глубоко ---');
{
  const e = new BackstageWash();
  e.setProfile(buildProfile(60, [], [{ start: 1, lvl: 0.5 }]));
  for (let t = 0; t <= 5; t += 0.05) e.render(t, PARAMS);
  const flat = e.render(10, { ...PARAMS, waveLo: 0.8 });
  const deep = e.render(10.05, { ...PARAMS, waveLo: 0.1 });
  const span = (fs: { master: number }[]) =>
    Math.max(...fs.map(f => f.master)) - Math.min(...fs.map(f => f.master));
  checkTrue('waveLo 0.1 динамичнее, чем 0.8', span(deep) > span(flat),
    `deep=${span(deep).toFixed(3)} vs flat=${span(flat).toFixed(3)}`);
}

console.log('\n--- 3. Строб жёстко в нуле ВСЕГДА ---');
{
  const e = new BackstageWash();
  // Профиль С ударными и пиковой секцией — всё равно ноль
  e.setProfile(buildProfile(60,
    Array.from({ length: 200 }, (_, i) => ({ start: i * 0.25, lvl: 1 })),
    [{ start: 1, lvl: 0.5 }]));
  for (let t = 0; t < 30; t += 0.1) {
    const frames = e.render(t, PARAMS);
    checkTrue(`t=${t.toFixed(1)}: strobe=0 у всех`, frames.every(f => f.strobe === 0));
  }
}

console.log('\n--- 4. Пульс ТОЛЬКО когда в треке есть ударные ---');
{
  // Два движка, одинаковый разогрев → разница кадров изолирует пульс.
  const noDrums = new BackstageWash();
  noDrums.setProfile(buildProfile(60, [], [{ start: 1, lvl: 0.5 }]));
  const drums = new BackstageWash();
  drums.setProfile(buildProfile(60, [{ start: 9.9, lvl: 1 }], [{ start: 1, lvl: 0.5 }]));
  for (let t = 0; t <= 5; t += 0.05) { noDrums.render(t, PARAMS); drums.render(t, PARAMS); }
  const ndHit = noDrums.render(9.95, PARAMS);
  const dHit = drums.render(9.95, PARAMS);
  const ndFar = noDrums.render(10.55, PARAMS);
  const dFar = drums.render(10.55, PARAMS);
  const hitDiff = dHit[0].master - ndHit[0].master;
  const farDiff = dFar[0].master - ndFar[0].master;
  checkTrue('на хите: с ударными заметно ярче (пульс)', hitDiff > 0.15,
    `diff=${hitDiff.toFixed(3)}`);
  checkTrue('в стороне от хита: разницы нет (без ударных пульса нет)', Math.abs(farDiff) < 0.05,
    `diff=${farDiff.toFixed(3)}`);
}

console.log('\n--- 5. isRgbWashFixture: RGB-парки да, моторы/диммеры нет ---');
{
  check('led_par 6ch принят', isRgbWashFixture({ fixtureType: 'led_par' }), true);
  check('mini_par 7ch принят', isRgbWashFixture({ fixtureType: 'mini_par' }), true);
  check('led_par_8ch принят (RGB)', isRgbWashFixture({ fixtureType: 'led_par_8ch' }), true);
  check('comb_rgbw НЕ принят (мотор)', isRgbWashFixture({ fixtureType: 'comb_rgbw' }), false);
  check('spider НЕ принят (tilt)', isRgbWashFixture({ fixtureType: 'spider' }), false);
  check('dimmer НЕ принят', isRgbWashFixture({ fixtureType: 'dimmer' }), false);
  check('laser НЕ принят', isRgbWashFixture({ fixtureType: 'laser' }), false);
  check('пустые params не падают', isRgbWashFixture(undefined), false);
}

console.log('\n--- 6. Гейт: кулисы едут ТОЛЬКО по проводу, COB — как раньше ---');
const mkFix = (id: string, type: string, ch: number, label = id, extra: any = {}): LuminaNode => {
  const len = type === 'led_par_8ch' ? 8 : type === 'led_par' ? 6 : 43;
  return {
    id, type: 'fixture', position: { x: 0, y: 0 },
    data: { label, type: 'fixture', params: {
      fixtureType: type, startChannel: ch,
      manualValues: new Array(len).fill(0), mutes: new Array(len).fill(false),
      ...extra } },
  } as any;
};
const mkTrack = (id: string): LuminaNode => ({
  id, type: 'midi-track', position: { x: 0, y: 0 },
  data: { label: 'MIDI-трек', type: 'midi-track', params: { stop: false, group: 0 } },
} as any);
const edge = (s: string, sh: string, t: string, th: string): LuminaEdge =>
  ({ id: `${s}->${t}`, source: s, sourceHandle: sh, target: t, targetHandle: th } as any);
const run = (nodes: LuminaNode[], edges: LuminaEdge[] = []) => evaluateGraph(nodes, edges, {}, {});
{
  // 6.1 Без проводов: COB в legacy (count=1), кулисы НЕ едут (count=0)
  const mt = mkTrack('mt');
  run([mt, mkFix('w1', 'led_par_8ch', 200), mkFix('bl', 'led_par', 33, 'Backdrop L')]);
  const p = mt.data.params as any;
  check('COB: старая схема жива', p._washCount, 1);
  check('кулисы без провода стоят', p._backstageCount, 0);
  check('кулисных всего видно 1', p._backstageTotal, 1);
}
{
  // 6.2 Провод на кулису: она едет, COB без провода ушёл в гейт
  const mt = mkTrack('mt');
  run([mt, mkFix('w1', 'led_par_8ch', 200), mkFix('bl', 'led_par', 33, 'Backdrop L')],
    [edge('mt', 'out-2', 'bl', 'wash-in')]);
  const p = mt.data.params as any;
  check('кулиса по проводу едет', p._backstageCount, 1);
  check('COB без своего провода теперь стоит (гейт)', p._washCount, 0);
}
{
  // 6.3 Кулисы выключены тумблером в ноде
  const mt = mkTrack('mt');
  (mt.data.params as any).backstage = false;
  run([mt, mkFix('bl', 'led_par', 33, 'Backdrop L')], [edge('mt', 'out-2', 'bl', 'wash-in')]);
  const p = mt.data.params as any;
  check('backstage=off → count null', p._backstageCount, null);
}

console.log('\n--- 7. ГРАБЛЯ 28.07: текстовая group из старого проекта не глушит прибор ---');
{
  // В старом БАЗА.json group='LED'/'WASH'/'TOP' (текст): activeGroups — числа,
  // строка туда не попадала → прибор молчал везде («сигнал не доходит»).
  const f = mkFix('bl', 'led_par', 33, 'Backdrop L', {
    group: 'LED', manualValues: [200, 0, 0, 0, 0, 0],
  });
  const { dmxUpdates } = run([f]);
  const ch33 = dmxUpdates.find(u => u.ch === 33);
  check('group="LED" → прибор АКТИВЕН, ручник пишется', ch33?.val, 200);
  // И числовая группа 1 без активатора по-прежнему стоит (семантика не сломана)
  const f2 = mkFix('bl2', 'led_par', 33, 'Mid L', {
    group: 1, manualValues: [200, 0, 0, 0, 0, 0],
  });
  const res2 = run([f2]);
  const ch33b = res2.dmxUpdates.find(u => u.ch === 33);
  check('group=1 без активатора → молчит (0)', ch33b?.val, 0);
}

console.log('\n--- 8. Режим НОТЫ: зоны буфера лучей играют на кулисы ---');
{
  // 8.1 Зоны: луч 0 (левый) → зона 0, луч 39 (правый) → зона 5, по максимуму
  const px = new Float32Array(40 * 4);
  px[0] = 0.8;              // луч 0 красный
  px[39 * 4 + 2] = 0.6;     // луч 39 синий
  px[20 * 4 + 1] = 0.4;     // луч 20 зелёный
  const zones = zonesFromBeams(px, 6);
  check('зон 6', zones.length, 6);
  check('зона 0 красная (левый луч)', [zones[0][0] > 0.7, zones[0][2] === 0], [true, true]);
  check('зона 5 синяя (правый луч)', [zones[5][2] > 0.5, zones[5][0] === 0], [true, true]);
  check('зона 3 держит зелёный луч 20', zones[3][1] > 0.3, true);
  check('тихие зоны в нуле', [zones[1][0], zones[2][1], zones[4][2]], [0, 0, 0]);
}
{
  // 8.2 notesFrames: уровень с панчем, цвет-направление, строб = 0
  const px = new Float32Array(40 * 4);
  px[0] = 1.0;              // луч 0 красный полный
  const frames = notesFrames(px, 6, { ...PARAMS, floor: 0.3 });
  const z0 = frames[0], z1 = frames[1];
  checkTrue('яркая зона: мастер высокий', z0.master > 0.85, `master=${z0.master.toFixed(3)}`);
  check('яркая зона: цвет = красное направление', [z0.r, z0.g < 0.2, z0.b < 0.2], [1, true, true]);
  check('тихая зона: только слабый фон (floor·0.3)', Math.round(z1.master * 100) / 100, 0.09);
  check('строб = 0 у всех', frames.every(f => f.strobe === 0), true);
  // 8.3 Насыщенность 0.2 → направление тянется к белому
  const pale = notesFrames(px, 6, { ...PARAMS, floor: 0.3, saturation: 0.2 });
  checkTrue('sat=0.2: зелёный/синий подняты к белому',
    pale[0].g > 0.6 && pale[0].b > 0.6,
    `g=${pale[0].g.toFixed(2)} b=${pale[0].b.toFixed(2)}`);
  // 8.4 Белый луч светит «в цвет» зоны
  const px2 = new Float32Array(40 * 4);
  px2[39 * 4 + 3] = 0.9;    // белый луч справа
  const wf = notesFrames(px2, 6, { ...PARAMS, floor: 0 });
  checkTrue('белый → тёплый белый, не синий',
    wf[5].r > 0.5 && wf[5].b > 0.5 && wf[5].r >= wf[5].b - 0.01,
    `r=${wf[5].r.toFixed(2)} b=${wf[5].b.toFixed(2)}`);
}

console.log('\n--- 9. Входы модуляции кулис backstage-*-in (запрос 28.07) ---');
{
  // Источник: fixture-dimmer с ручным значением — его out-0 идёт на входы
  // ноды. _driven/_eff пишутся до проверки кадра, поэтому кадр не нужен.
  const src = (id: string, val: number): LuminaNode => ({
    id, type: 'fixture', position: { x: 0, y: 0 },
    data: {
      label: id, type: 'fixture',
      params: {
        fixtureType: 'dimmer', startChannel: 400, group: 0,
        manualValues: [val], mutes: [false], currentValues: [0],
      },
    },
  } as any);

  // 9.1 Без проводов на входы — driven=false, значения из слайдеров
  const mt1 = mkTrack('mt');
  (mt1.data.params as any).backstageBrightness = 0.7;
  (mt1.data.params as any).backstageHue = 0.2;
  (mt1.data.params as any).backstageSaturation = 0.6;
  (mt1.data.params as any).backstageMode = 'comet';
  run([mt1, mkFix('bl', 'led_par', 33, 'Backdrop L')], [edge('mt', 'out-2', 'bl', 'wash-in')]);
  const p1 = mt1.data.params as any;
  check('без входов: driven.backHue=false', p1._driven.backHue, false);
  check('без входов: driven.backBright=false', p1._driven.backBright, false);
  check('без входов: driven.backSat=false', p1._driven.backSat, false);
  check('яркость из слайдера', p1._effBackBright, 0.7);
  check('оттенок из слайдера (comet)', p1._effBackHue, 0.2);
  check('насыщенность из слайдера', p1._effBackSat, 0.6);

  // 9.2 Вход оттенка 128 → hue 128/255 перебивает слайдер (comet)
  const mt2 = mkTrack('mt');
  (mt2.data.params as any).backstageMode = 'comet';
  (mt2.data.params as any).backstageHue = 0.9; // слайдер обязан проиграть
  run([mt2, src('lf', 128), mkFix('bl', 'led_par', 33, 'Backdrop L')],
    [edge('mt', 'out-2', 'bl', 'wash-in'), edge('lf', 'out-0', 'mt', 'backstage-hue-in')]);
  const p2 = mt2.data.params as any;
  check('вход hue driven', p2._driven.backHue, true);
  check('hue = 128/255, не слайдер 0.9', Math.round((p2._effBackHue as number) * 1000) / 1000,
    Math.round((128 / 255) * 1000) / 1000);

  // 9.3 Вход яркости 255 → 2.0; 0 → гасит фон полностью (как LFO в нуле)
  const mt3 = mkTrack('mt');
  run([mt3, src('lb', 255), mkFix('bl', 'led_par', 33, 'Backdrop L')],
    [edge('mt', 'out-2', 'bl', 'wash-in'), edge('lb', 'out-0', 'mt', 'backstage-bright-in')]);
  check('яркость: 255 → 2.0', (mt3.data.params as any)._effBackBright, 2);
  const mt4 = mkTrack('mt');
  run([mt4, src('lb', 0), mkFix('bl', 'led_par', 33, 'Backdrop L')],
    [edge('mt', 'out-2', 'bl', 'wash-in'), edge('lb', 'out-0', 'mt', 'backstage-bright-in')]);
  check('яркость: 0 → 0 (LFO может погасить)', (mt4.data.params as any)._effBackBright, 0);

  // 9.4 Режим НОТЫ: вход насыщенности перебивает дефолт 0.9,
  //     слайдер оттенка НЕ участвует (он для ВОЛНЫ), вход оттенка крутит зоны
  const mt5 = mkTrack('mt');
  (mt5.data.params as any).backstageMode = 'notes';
  (mt5.data.params as any).backstageHue = 0.7; // не должен попасть в НОТЫ
  run([mt5, src('ls', 64), mkFix('bl', 'led_par', 33, 'Backdrop L')],
    [edge('mt', 'out-2', 'bl', 'wash-in'), edge('ls', 'out-0', 'mt', 'backstage-sat-in')]);
  const p5 = mt5.data.params as any;
  check('НОТЫ: sat из входа 64/255', Math.round((p5._effBackSat as number) * 1000) / 1000,
    Math.round((64 / 255) * 1000) / 1000);
  check('НОТЫ: слайдер оттенка игнорирован (hue=0)', p5._effBackHue, 0);
}

console.log();
if (failed > 0) {
  console.log(`ПРОВАЛЕНО проверок: ${failed}`);
  process.exit(1);
}
console.log('Плавный фон кулис работает: порядок, плавность, строб=0, пульс по ударам, гейт, входы модуляции');
