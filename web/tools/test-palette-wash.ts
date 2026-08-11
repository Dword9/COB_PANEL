/**
 * Тесты новых нод «Палитра COB» и «Трек» + входов цвета верхнего света
 * у midi-track (запросы юзера 27.07).
 * Запуск: npx tsx tools/test-palette-wash.ts   (из папки web)
 */
import { evaluateGraph, isWashFixture } from '../utils/graphEngine';
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

const palette = (id: string, params: Record<string, unknown>): LuminaNode => ({
  id, type: 'palette', position: { x: 0, y: 0 },
  data: { label: 'Палитра', type: 'palette', params: { hue: 0, saturation: 1, ...params } },
} as any);

const gen = (id: string, value: number): LuminaNode => ({
  id, type: 'generator', position: { x: 0, y: 0 },
  data: { label: id, type: 'generator', params: value >= 255
    ? { shape: 'square', speed: 0, discrete: false, _phase: 0, _lastTime: Date.now() }
    : { shape: 'saw', speed: 0, discrete: false,
        _phase: (Math.max(0, value) / 255) * 2 * Math.PI, _lastTime: Date.now() },
  },
} as any);

const midiTrack = (id: string, params: Record<string, unknown>): LuminaNode => ({
  id, type: 'midi-track', position: { x: 0, y: 0 },
  data: { label: 'MIDI-трек', type: 'midi-track', params: {
    stop: false, group: 0, hueShift: 0.25, saturation: 0.75, ...params } },
} as any);

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): LuminaEdge =>
  ({ id: `${source}->${target}:${targetHandle}`, source, sourceHandle, target, targetHandle } as any);

const run = (nodes: LuminaNode[], edges: LuminaEdge[] = []) =>
  evaluateGraph(nodes, edges, {}, {});

console.log('--- 1. Палитра: свои ползунки → выходы 0-255 ---');
{
  const pal = palette('pal', { hue: 0.5, saturation: 1 });
  const { nodeValues } = run([pal]);
  check('out-0 = сдвиг 0.5*255', nodeValues['pal'][0], 128);
  check('out-1 = насыщенность 100%', nodeValues['pal'][1], 255);
  const d = (pal.data.params as any)._driven;
  check('без входов ничто не driven', [d.hue, d.sat], [false, false]);
}

console.log('\n--- 2. Палитра: входы перебивают ползунки ---');
{
  const pal = palette('pal', { hue: 0.1, saturation: 0.2 });
  const { nodeValues } = run([pal, gen('gh', 255), gen('gs', 128)],
    [edge('gh', 'out-0', 'pal', 'hue-in'), edge('gs', 'out-0', 'pal', 'sat-in')]);
  check('hue-in=255 → out-0=255', nodeValues['pal'][0], 255);
  // Генератор speed=0 превращается в 120 BPM (0||120) и фаза дрейфует на
  // пару миллисекунд — поэтому окно, а не точное 128. Главное: НЕ 51
  // (ползунок 0.2*255), то есть вход реально перебил ползунок.
  checkTrue('sat-in=128 → out-1 ≈128, не 51 с ползунка',
    Math.abs(nodeValues['pal'][1] - 128) <= 4, `out-1=${nodeValues['pal'][1]}`);
  const p = pal.data.params as any;
  check('driven взведён', [p._driven.hue, p._driven.sat], [true, true]);
  check('_effHue = 1', p._effHue, 1);
  checkTrue('_effSat ≈ 0.5', Math.abs(p._effSat - 0.5) < 0.03, `sat=${p._effSat.toFixed(3)}`);
}

console.log('\n--- 3. midi-track: цвет COB от палитры через wash-hue/sat-in ---');
{
  const mt = midiTrack('mt', {});
  const pal = palette('pal', { hue: 0.8, saturation: 0.4 });
  run([mt, pal], [edge('pal', 'out-0', 'mt', 'wash-hue-in'), edge('pal', 'out-1', 'mt', 'wash-sat-in')]);
  const p = mt.data.params as any;
  check('_effWashHue от палитры (0.8)', Math.round(p._effWashHue * 100) / 100, 0.8);
  check('_effWashSat от палитры (0.4)', Math.round(p._effWashSat * 100) / 100, 0.4);
  check('driven.washHue/washSat', [p._driven.washHue, p._driven.washSat], [true, true]);
  // Цвет лучей при этом остаётся СВОИМ (не от палитры COB)
  check('лучи: свой hueShift 0.25', p._effHue, 0.25);
  check('лучи: свой saturation 0.75', p._effSat, 0.75);
}

console.log('\n--- 4. midi-track: без палитры COB делит цвет с лучами ---');
{
  const mt = midiTrack('mt', {});
  run([mt]);
  const p = mt.data.params as any;
  check('_effWashHue = hueShift лучей', p._effWashHue, 0.25);
  check('_effWashSat = saturation лучей', p._effWashSat, 0.75);
  check('driven сброшены', [p._driven.washHue, p._driven.washSat], [false, false]);
}

console.log('\n--- 5. Нода «Трек»: выход = готовность ---');
{
  const empty: LuminaNode = {
    id: 'tr', type: 'music-track', position: { x: 0, y: 0 },
    data: { label: 'Трек', type: 'music-track', params: {} },
  } as any;
  check('пустая → 0', run([empty]).nodeValues['tr'], [0]);
  const onlyAudio: LuminaNode = {
    id: 'tr', type: 'music-track', position: { x: 0, y: 0 },
    data: { label: 'Трек', type: 'music-track', params: { audioUrl: '/media/stems/a.wav' } },
  } as any;
  check('только аудио → 0', run([onlyAudio]).nodeValues['tr'], [0]);
  const readyTr: LuminaNode = {
    id: 'tr', type: 'music-track', position: { x: 0, y: 0 },
    data: { label: 'Трек', type: 'music-track', params: {
      audioUrl: '/media/stems/a.wav', analysisUrl: '/media/stems/a.json' } },
  } as any;
  check('аудио+анализ → 255', run([readyTr]).nodeValues['tr'], [255]);
}

console.log('\n--- 6. Прибор заливки: led_par_8ch и кастом с его раскладкой ---');
{
  check('тип led_par_8ch принят', isWashFixture({ fixtureType: 'led_par_8ch' }), true);
  check('типа custom без раскладки НЕ принят', isWashFixture({ fixtureType: 'custom' }), false);
  // Кастом из конструктора с раскладкой 1-в-1 как led_par_8ch (баг 27.07:
  // «LED PAR есть, а нода пишет что нет»)
  const customLayout = [
    { type: 'master' }, { type: 'red' }, { type: 'green' }, { type: 'blue' },
    { type: 'white' }, { type: 'strobe' }, { type: 'fx' }, { type: 'speed' },
  ];
  check('кастом с раскладкой 8ch принят', isWashFixture({ fixtureType: 'custom', customLayout }), true);
  const wrongLayout = [
    { type: 'red' }, { type: 'green' }, { type: 'blue' }, { type: 'white' },
  ];
  check('кастом с ДРУГОЙ раскладкой НЕ принят',
    isWashFixture({ fixtureType: 'custom', customLayout: wrongLayout }), false);
  check('обычный dimmer НЕ принят', isWashFixture({ fixtureType: 'dimmer' }), false);
  check('пустые params не падают', isWashFixture(undefined), false);
}

console.log('\n--- 7. Выход COB wash: провод out-2 → wash-in = гейт (27.07) ---');
const washFix = (id: string, ch: number): LuminaNode => ({
  id, type: 'fixture', position: { x: 0, y: 0 },
  data: { label: id, type: 'fixture', params: {
    fixtureType: 'led_par_8ch', startChannel: ch,
    manualValues: new Array(8).fill(0), mutes: new Array(8).fill(false) } },
} as any);
{
  // 7.1 Совместимость: проводов нет — заливаются ВСЕ найденные приборы
  const mt = midiTrack('mt', {});
  run([mt, washFix('w1', 200), washFix('w2', 220)]);
  const p = mt.data.params as any;
  check('без проводов: _washCount = все (2)', p._washCount, 2);
  check('без проводов: _washWired = 0', p._washWired, 0);
  check('без проводов: _washTotal = 2', p._washTotal, 2);
}
{
  // 7.2 Гейт: один прибор подключен — заливается ТОЛЬКО он
  const mt = midiTrack('mt', {});
  run([mt, washFix('w1', 200), washFix('w2', 220)],
    [edge('mt', 'out-2', 'w1', 'wash-in')]);
  const p = mt.data.params as any;
  check('один провод: _washCount = 1 (только подключённый)', p._washCount, 1);
  check('один провод: _washWired = 1', p._washWired, 1);
  check('один провод: _washTotal = 2', p._washTotal, 2);
}
{
  // 7.3 Провод на НЕ-wash ноду гейт не включает (значение можно тянуть куда угодно)
  const mt = midiTrack('mt', {});
  const dim: LuminaNode = {
    id: 'd1', type: 'fixture', position: { x: 0, y: 0 },
    data: { label: 'd1', type: 'fixture', params: {
      fixtureType: 'dimmer', startChannel: 5, manualValues: [0], mutes: [false] } },
  } as any;
  run([mt, washFix('w1', 200), dim], [edge('mt', 'out-2', 'd1', 'in-0')]);
  const p = mt.data.params as any;
  check('провод на dimmer: wash-гейт не сработал, старая схема (1)', p._washCount, 1);
  check('провод на dimmer: _washWired = 0', p._washWired, 0);
}
{
  // 7.4 Заливка выключена в ноде: _washCount = null, структура видна
  const mt = midiTrack('mt', { wash: false });
  run([mt, washFix('w1', 200)], [edge('mt', 'out-2', 'w1', 'wash-in')]);
  const p = mt.data.params as any;
  check('wash=off: _washCount = null', p._washCount, null);
  check('wash=off: структура всё равно видна', [p._washWired, p._washTotal], [1, 1]);
}
{
  // 7.5 Выходов теперь четыре: энергия, мотор, мастер заливки, лучи
  const mt = midiTrack('mt', {});
  const { nodeValues } = run([mt, washFix('w1', 200)]);
  check('нет аудио → [0, 128, 0, 0]', nodeValues['mt'], [0, 128, 0, 0]);
  const mtOff = midiTrack('mt', { stop: true });
  const res2 = run([mtOff]);
  checkTrue('выключенная нода: четыре выхода, нули', res2.nodeValues['mt'].length === 4
    && res2.nodeValues['mt'][0] === 0 && res2.nodeValues['mt'][2] === 0
    && res2.nodeValues['mt'][3] === 0,
    `got=${JSON.stringify(res2.nodeValues['mt'])}`);
}

console.log('\n--- 8. Выход ЛУЧИ: провод out-3 → comb-in = гейт расчёсок (28.07) ---');
const combFix = (id: string, ch: number): LuminaNode => ({
  id, type: 'fixture', position: { x: 0, y: 0 },
  data: { label: id, type: 'fixture', params: {
    fixtureType: 'comb_rgbw', startChannel: ch,
    manualValues: new Array(43).fill(0), mutes: new Array(43).fill(false) } },
} as any);
{
  // 8.1 Совместимость: проводов нет — играют ВСЕ найденные расчёски
  const mt = midiTrack('mt', {});
  run([mt, combFix('c2', 293), combFix('c1', 250)]);
  const p = mt.data.params as any;
  check('без проводов: _combCount = все (2)', p._combCount, 2);
  check('без проводов: _combWired = 0', p._combWired, 0);
  check('без проводов: _combTotal = 2', p._combTotal, 2);
}
{
  // 8.2 Гейт: одна расчёска подключена — играет ТОЛЬКО она
  const mt = midiTrack('mt', {});
  run([mt, combFix('c1', 250), combFix('c2', 293)],
    [edge('mt', 'out-3', 'c1', 'comb-in')]);
  const p = mt.data.params as any;
  check('один провод: _combCount = 1', p._combCount, 1);
  check('один провод: _combWired = 1', p._combWired, 1);
  check('один провод: _combTotal = 2', p._combTotal, 2);
}
{
  // 8.3 Провода wash и comb не путаются: out-2 → wash-in не включает comb-гейт
  const mt = midiTrack('mt', {});
  run([mt, combFix('c1', 250), washFix('w1', 200)],
    [edge('mt', 'out-2', 'w1', 'wash-in')]);
  const p = mt.data.params as any;
  check('wash-провод: comb-гейт НЕ сработал', [p._combWired, p._combCount], [0, 1]);
  check('wash-провод: wash-гейт сработал', [p._washWired, p._washCount], [1, 1]);
}

console.log();
if (failed > 0) {
  console.log(`ПРОВАЛЕНО проверок: ${failed}`);
  process.exit(1);
}
console.log('Палитра, трек-нода и входы цвета COB работают');
