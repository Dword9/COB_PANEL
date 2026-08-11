/**
 * Тесты частотных полос (жалоба юзера 27.07: «непонятные частоты»).
 * Запуск: npx tsx tools/test-audio-bands.ts   (из папки web)
 *
 * Что закрывается:
 *  1. LOW/MID/HIGH считаются в ГЕРЦАХ через sampleRate, а не линейным
 *     делением массива FFT (раньше LOW = 0-7.5 кГц, HIGH = 15.75-24 кГц).
 *  2. fftSize=2048: бас (20-250 Гц) — это ~10 бинов, а не один.
 *  3. DC-бин (индекс 0) не валит LOW своим постоянным уровнем.
 *  4. Спектр на ноде — логарифмический: бас виден в первых столбиках.
 *  5. DSP SPLITTER честно делит три полосы входа, а не размножает одну
 *     (раньше ребро из пина 'low' давало [low,low,low] на выходах).
 */
import { avgHzRange, splitThreeBands, logBands, SPECTRUM_BANDS } from '../utils/audioBands';
import { evaluateGraph } from '../utils/graphEngine';
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

// analyser.fftSize = 2048 → 1024 бина; при 48 кГц бин = 23.4375 Гц
const SR = 48000;
const BINS = 1024;
const BIN_HZ = SR / 2 / BINS; // 23.4375

/** Синтетический тон: несколько бинов вокруг частоты на уровне amp, остальное 0. */
const tone = (freq: number, amp = 200, halfWidth = 1): Uint8Array => {
  const data = new Uint8Array(BINS);
  const center = Math.round(freq / BIN_HZ);
  for (let i = center - halfWidth; i <= center + halfWidth; i++) {
    if (i >= 1 && i < BINS) data[i] = amp;
  }
  return data;
};

console.log('--- 1. Три полосы делятся в герцах, тон попадает в СВОЮ полосу ---');
{
  const bass = splitThreeBands(tone(100), SR);   // кик/бас
  const voice = splitThreeBands(tone(1000), SR); // вокал/снейр
  const hats = splitThreeBands(tone(10000), SR); // хэты/тарелки

  checkTrue('тон 100 Гц → LOW, в MID/HIGH тишина',
    bass.low > 0 && bass.mid === 0 && bass.high === 0,
    `low=${bass.low.toFixed(1)} mid=${bass.mid} high=${bass.high}`);
  checkTrue('тон 1 кГц → MID, в LOW/HIGH тишина',
    voice.mid > 0 && voice.low === 0 && voice.high === 0,
    `low=${voice.low} mid=${voice.mid.toFixed(1)} high=${voice.high}`);
  checkTrue('тон 10 кГц → HIGH, в LOW/MID тишина',
    hats.high > 0 && hats.low === 0 && hats.mid === 0,
    `low=${hats.low} mid=${hats.mid} high=${hats.high.toFixed(1)}`);
}

console.log('\n--- 2. Края полос: 200 Гц бас, 300 Гц середина, стык в обеих ---');
{
  // Бин = 23.4 Гц, поэтому «у границы» проверяем бинами, а не герцами в упор
  const l = splitThreeBands(tone(200, 200, 0), SR);  // бин 9 = ~211 Гц
  const m = splitThreeBands(tone(300, 200, 0), SR);  // бин 13 = ~305 Гц
  checkTrue('200 Гц чисто в LOW', l.low > 0 && l.mid === 0 && l.high === 0,
    `low=${l.low.toFixed(1)} mid=${l.mid}`);
  checkTrue('300 Гц чисто в MID', m.mid > 0 && m.low === 0 && m.high === 0,
    `low=${m.low} mid=${m.mid.toFixed(1)}`);
  // Бин 10 (~234-258 Гц) накрывает сам стык 250 Гц — учитывается в обеих
  // полосах, но в LOW его вес в 16 раз больше (узкая полоса)
  const edgeBin = splitThreeBands(tone(234, 200, 0), SR);
  checkTrue('энергия на стыке: LOW сильно доминирует',
    edgeBin.low > edgeBin.mid * 5 && edgeBin.mid > 0,
    `low=${edgeBin.low.toFixed(1)} mid=${edgeBin.mid.toFixed(1)}`);
}

console.log('\n--- 3. DC-бин не считается (бин 0 — постоянная составляющая) ---');
{
  const data = new Uint8Array(BINS);
  data[0] = 255; // DC на максимуме, музыки нет
  const r = splitThreeBands(data, SR);
  check('DC не валит LOW', r.low, 0);
}

console.log('\n--- 4. Тишина и крайние случаи ---');
{
  const z = splitThreeBands(new Uint8Array(BINS), SR);
  check('тишина → все полосы 0', [z.low, z.mid, z.high], [0, 0, 0]);
  check('полоса выше Найквиста → 0', avgHzRange(tone(100), SR, 30000, 40000), 0);
  // Полоса уже одного бина: 30-40 Гц при бине 23.4 Гц → берётся 1 бин
  const narrow = new Uint8Array(BINS);
  narrow[1] = 100; // бин 1 = 23-47 Гц
  check('полоса уже бина берёт хотя бы один бин', avgHzRange(narrow, SR, 30, 40), 100);
}

console.log('\n--- 5. Спектр на ноде: логарифмический, бас в первых столбиках ---');
{
  const argmax = (arr: number[]) => arr.indexOf(Math.max(...arr));
  const bassBands = logBands(tone(100), SR, SPECTRUM_BANDS);
  const midBands = logBands(tone(1000), SR, SPECTRUM_BANDS);
  const highBands = logBands(tone(10000), SR, SPECTRUM_BANDS);
  check('всегда 32 столбика', bassBands.length, 32);
  checkTrue('бас 100 Гц виден в ПЕРВОЙ ТРЕТИ спектра',
    argmax(bassBands) < 11, `peak band=${argmax(bassBands)}`);
  checkTrue('тон 1 кГц — в середине спектра',
    argmax(midBands) >= 11 && argmax(midBands) <= 24, `peak band=${argmax(midBands)}`);
  checkTrue('тон 10 кГц — в конце спектра',
    argmax(highBands) > 24, `peak band=${argmax(highBands)}`);
  // Старый линейный спектр отдавал басу 1-2 столбика из 32
  const bassVisible = bassBands.slice(0, 11).filter(v => v > 0).length;
  checkTrue('бас занимает заметную часть спектра, не 1 столбик',
    bassVisible >= 2, `столбиков с басом: ${bassVisible}`);
}

console.log('\n--- 6. DSP SPLITTER: три полосы входа делятся честно ---');
{
  const inputNode: LuminaNode = {
    id: 'in', type: 'input', position: { x: 0, y: 0 },
    data: { label: 'Вход', type: 'input', params: {} },
  } as any;
  const dspNode = (): LuminaNode => ({
    id: 'dsp', type: 'audio', position: { x: 0, y: 0 },
    data: { label: 'DSP', type: 'audio', params: {
      gain: 1, gate: 0, attackSmoothing: 0, decaySmoothing: 0.9,
    } },
  } as any);
  const levels = { in: { low: 100, mid: 50, high: 25 } };

  const runDsp = (sourceHandle: string) => {
    const dsp = dspNode();
    const edge: LuminaEdge = {
      id: 'e1', source: 'in', sourceHandle, target: 'dsp', targetHandle: 'signal-in',
    } as any;
    const { nodeValues } = evaluateGraph([inputNode, dsp], [edge], levels, {});
    return nodeValues['dsp'];
  };

  // За какой бы пин ни подключили — вход всегда несёт все три полосы
  check('ребро из пина low → все три полосы', runDsp('low'), [100, 50, 25]);
  check('ребро из пина mid → все три полосы', runDsp('mid'), [100, 50, 25]);
  check('ребро из пина high → все три полосы', runDsp('high'), [100, 50, 25]);
}

console.log('\n--- 7. DSP: однозначный источник по-прежнему размножается ---');
{
  // LFO/MIDI несут ОДНО значение — делить нечего, оно идёт во все три
  // огибающие. Это осмысленное поведение, не путать с багом полос.
  const genNode: LuminaNode = {
    id: 'g', type: 'generator', position: { x: 0, y: 0 },
    data: { label: 'LFO', type: 'generator', params: {
      shape: 'saw', speed: 0, discrete: false,
      _phase: (77 / 255) * 2 * Math.PI, _lastTime: Date.now(),
    } },
  } as any;
  const dsp: LuminaNode = {
    id: 'dsp', type: 'audio', position: { x: 0, y: 0 },
    data: { label: 'DSP', type: 'audio', params: {
      gain: 1, gate: 0, attackSmoothing: 0, decaySmoothing: 0.9,
    } },
  } as any;
  const edge: LuminaEdge = {
    id: 'e1', source: 'g', sourceHandle: 'out-0', target: 'dsp', targetHandle: 'signal-in',
  } as any;
  const { nodeValues } = evaluateGraph([genNode, dsp], [edge], {}, {});
  check('LFO 77 → [77,77,77]', nodeValues['dsp'], [77, 77, 77]);
}

console.log();
if (failed > 0) {
  console.log(`ПРОВАЛЕНО проверок: ${failed}`);
  process.exit(1);
}
console.log('Частоты делятся в герцах, DSP делит честно');
