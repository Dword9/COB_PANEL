/**
 * Тесты ядра партитуры (score) — фаза 4.0 «Режиссуры трека»:
 *  1. validateScore: валидный проходит, битые — список ошибок.
 *  2. compileScore: сортировка (from, id), клип модификаторов.
 *  3. samplePlan: чистая функция времени — свёртка mul/trim/gate,
 *     границы [from, to), клипы, детерминизм.
 *  4. draftFromProfile: правила черновика, детерминированные id.
 *  5. scoreFingerprint: связка url+duration+notes.
 *  6. Движок: score есть, но анализ не загружен → модификаторы НЕ
 *     применяются (поведение прежнее, краша нет).
 *
 * Запуск: npx tsx tools/test-score.ts   (из папки web)
 */
import { evaluateGraph } from '../utils/graphEngine';
import { setTiltCalibration } from '../utils/tiltGuard';
import { scoreFingerprint, validateScore, createScore, type ScoreV1 } from '../utils/scoreModel';
import { compileScore, samplePlan, draftFromProfile, neutralLaneState, mergeDraftWithLocked, mergeAutomation, interpAutomation, sampleAutomation } from '../utils/scoreCompiler';
import { buildProfile } from '../utils/trackProfile';
import type { LuminaNode } from '../types';

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

const mkScore = (): ScoreV1 => ({
  version: 1,
  fingerprint: 'a.json|100.00|500',
  duration: 100,
  sections: [
    { id: 'sec-0-quiet', from: 0, to: 40, kind: 'quiet' },
    { id: 'sec-1-peak', from: 40, to: 100, kind: 'peak' },
  ],
  cues: [
    { id: 'c1', lane: 'rays', from: 10, to: 20, mods: { brightnessMul: 0.5, hueTrim: 0.1 } },
    { id: 'c2', lane: 'rays', from: 15, to: 25, mods: { brightnessMul: 0.5, satTrim: 0.3 } },
    { id: 'c3', lane: 'cob', from: 15, to: 50, mods: { gate: false } },
    { id: 'c4', lane: 'backstage', from: 0, to: 100, mods: { brightnessMul: 0.8 } },
    { id: 'c5', lane: 'motion', from: 5, to: 8, mods: { tiltTrim: 0.1 } },
  ],
});

console.log('--- 1. validateScore ---');
{
  check('валидный score: ошибок нет', validateScore(mkScore()), []);
  const bad1 = { ...mkScore(), version: 2 };
  checkTrue('version 2 → ошибка', validateScore(bad1).some(e => e.includes('version')));
  const bad2 = mkScore();
  bad2.cues.push({ id: 'c1', lane: 'rays', from: 1, to: 2, mods: {} });
  checkTrue('дубликат id → ошибка', validateScore(bad2).some(e => e.includes('дубликат')));
  const bad3 = mkScore();
  (bad3.cues[0] as any).lane = 'dimmers';
  checkTrue('чужой lane → ошибка', validateScore(bad3).some(e => e.includes('lane')));
  const bad4 = mkScore();
  bad4.cues[0].mods.brightnessMul = 99;
  checkTrue('mul вне пределов → ошибка', validateScore(bad4).some(e => e.includes('brightnessMul')));
  const bad5 = mkScore();
  bad5.cues[0].from = 50; bad5.cues[0].to = 40;
  checkTrue('from>to → ошибка', validateScore(bad5).some(e => e.includes('from/to')));
}

console.log('\n--- 2. compileScore: сортировка и клипы ---');
{
  const s = mkScore();
  // Перемешаем cue и добавим выход за пределы
  s.cues.reverse();
  s.cues[0].mods.brightnessMul = 10; // клип в 4
  const plan = compileScore(s);
  check('секции отсортированы', plan.sections.map(x => x.id), ['sec-0-quiet', 'sec-1-peak']);
  const raysFrom = plan.lanes.rays.map(c => c.from);
  check('cue лучей по from', raysFrom, [10, 15]);
  checkTrue('brightnessMul клипнут ≤ 4',
    (plan.lanes.rays[0].mods.brightnessMul ?? 1) <= 4
    && (plan.lanes.rays[1].mods.brightnessMul ?? 1) <= 4);
}

console.log('\n--- 3. samplePlan: свёртка по времени ---');
{
  const plan = compileScore(mkScore());
  // t=5: активны c4 (backstage 0.8) и c5 (motion tilt 0.1)
  const s5 = samplePlan(plan, 5);
  check('t=5: rays нейтральны', s5.rays, neutralLaneState());
  check('t=5: backstage mul 0.8', s5.backstage.brightnessMul, 0.8);
  check('t=5: motion tiltTrim 0.1', s5.motion.tiltTrim, 0.1);
  // t=17: c1+c2 (rays) + c3 (cob gate=false) + c4
  const s17 = samplePlan(plan, 17);
  check('t=17: rays mul = 0.5*0.5', s17.rays.brightnessMul, 0.25);
  check('t=17: rays hueTrim 0.1', s17.rays.hueTrim, 0.1);
  check('t=17: rays satTrim 0.3', s17.rays.satTrim, 0.3);
  check('t=17: cob gate=false', s17.cob.gate, false);
  check('t=17: backstage gate жив', s17.backstage.gate, true);
  // Граница [from, to): t=20 — c1 умер, c2 жив
  const s20 = samplePlan(plan, 20);
  check('t=20: rays mul только c2', s20.rays.brightnessMul, 0.5);
  check('t=20: hueTrim c1 ушёл', s20.rays.hueTrim, 0);
  // t=10 ровно — c1 включился
  check('t=10: c1 активен', samplePlan(plan, 10).rays.brightnessMul, 0.5);
  // Детерминизм: повторные вызовы идентичны
  check('детерминизм samplePlan', samplePlan(plan, 17), s17);
  // Клип суммы trim'ов: два cue по 0.8 → 1.0
  const s2 = mkScore();
  s2.cues = [
    { id: 'a', lane: 'rays', from: 0, to: 10, mods: { hueTrim: 0.8 } },
    { id: 'b', lane: 'rays', from: 0, to: 10, mods: { hueTrim: 0.8 } },
  ];
  check('hueTrim клип в 1', samplePlan(compileScore(s2), 5).rays.hueTrim, 1);
}

console.log('\n--- 4. draftFromProfile: правила и детерминизм ---');
{
  // Профиль: тихий участок 0..8, пик 8..16 (ударные есть)
  const prof = buildProfile(16, [{ start: 9, lvl: 1 }, { start: 10, lvl: 1 }, { start: 11, lvl: 1 }, { start: 12, lvl: 1 }],
    [{ start: 1, lvl: 0.1 }, { start: 9, lvl: 1 }, { start: 10, lvl: 1 }, { start: 11, lvl: 1 }]);
  const fp = 'x.json|16.00|4';
  const d1 = draftFromProfile(prof, fp);
  const d2 = draftFromProfile(prof, fp);
  check('детерминизм черновика', d2, d1);
  check('отпечаток вшит', d1.fingerprint, fp);
  check('длительность из профиля', d1.duration, 16);
  checkTrue('секции перенесены', d1.sections.length >= 2, `sections=${d1.sections.length}`);
  check('валидация черновика чиста', validateScore(d1), []);
  // Все cue покрывают свою секцию и помечены auto
  checkTrue('все cue source=auto', d1.cues.every(c => c.source === 'auto'));
  checkTrue('cue в пределах своей секции', d1.cues.every(c =>
    d1.sections.some(s => s.from === c.from && s.to === c.to)));
  // Пиковая секция дала cue с mul > 1 (подъём), тихая — с mul < 1
  const plan = compileScore(d1);
  const kinds = d1.sections.map(s => s.kind);
  if (kinds.includes('quiet') && d1.sections[0].to > 0.5) {
    const tQ = (d1.sections.find(s => s.kind === 'quiet')!.from + 0.2);
    checkTrue('в тихой секции лучи приглушены',
      samplePlan(plan, tQ).rays.brightnessMul < 1,
      `mul=${samplePlan(plan, tQ).rays.brightnessMul}`);
  }
  if (kinds.includes('peak')) {
    const sec = d1.sections.find(s => s.kind === 'peak')!;
    const tP = (sec.from + sec.to) / 2;
    checkTrue('на пике лучи ярче базы',
      samplePlan(plan, tP).rays.brightnessMul > 1,
      `mul=${samplePlan(plan, tP).rays.brightnessMul}`);
    checkTrue('на пике движение получило trim',
      samplePlan(plan, tP).motion.tiltTrim > 0);
  }
}

console.log('\n--- 5. scoreFingerprint ---');
{
  check('связка полей', scoreFingerprint('a.json', 100, 500), 'a.json|100.00|500');
  check('без url', scoreFingerprint(null, 1.5, 3), 'no-analysis|1.50|3');
  checkTrue('смена нот меняет отпечаток',
    scoreFingerprint('a.json', 100, 501) !== scoreFingerprint('a.json', 100, 500));
}

console.log('\n--- 6. Движок: score без анализа НЕ применяется ---');
{
  // В рантайме tsx анализ не загружен → scoreMods=null → поведение прежнее.
  const mt: LuminaNode = {
    id: 'mt', type: 'midi-track', position: { x: 0, y: 0 },
    data: {
      label: 'MIDI-трек', type: 'midi-track',
      params: { stop: false, group: 0, hueShift: 0.3, scoreV1: mkScore() },
    },
  } as any;
  const { nodeValues } = evaluateGraph([mt], [], {}, {});
  const p = mt.data.params as any;
  check('_effHue без партитуры (анализа нет)', p._effHue, 0.3);
  check('выходы как у пустого трека', nodeValues['mt'], [0, 128, 0, 0]);
}

console.log('\n--- 7. mergeDraftWithLocked: залоченные переживают перегенерацию ---');
{
  // Старая партитура: cue 'cue-x' залочен (юзер подправил), 'cue-y' нет
  const prev = mkScore();
  prev.cues = [
    { id: 'cue-x', lane: 'rays', from: 0, to: 10, mods: { brightnessMul: 0.77 }, locked: true, source: 'auto' },
    { id: 'cue-y', lane: 'cob', from: 0, to: 10, mods: { brightnessMul: 0.5 } },
  ];
  // Свежий черновик: те же id (auto перегенерированы) + новый cue-z
  const draft = mkScore();
  draft.cues = [
    { id: 'cue-x', lane: 'rays', from: 0, to: 10, mods: { brightnessMul: 0.6 }, source: 'auto' },
    { id: 'cue-y', lane: 'cob', from: 0, to: 10, mods: { brightnessMul: 0.5 }, source: 'auto' },
    { id: 'cue-z', lane: 'motion', from: 5, to: 9, mods: { tiltTrim: 0.1 }, source: 'auto' },
  ];
  const merged = mergeDraftWithLocked(prev, draft);
  const x = merged.cues.find(c => c.id === 'cue-x')!;
  check('locked cue-x сохранил СВОЁ значение 0.77', x.mods.brightnessMul, 0.77);
  check('locked cue-x остался locked', x.locked, true);
  check('cue-y перегенерирован (0.5)', merged.cues.find(c => c.id === 'cue-y')!.mods.brightnessMul, 0.5);
  check('новый cue-z появился', merged.cues.some(c => c.id === 'cue-z'), true);
  check('без дубликатов id', new Set(merged.cues.map(c => c.id)).size, merged.cues.length);
  check('валидация мерджа чиста', validateScore(merged), []);
  check('prev=null → draft как есть', mergeDraftWithLocked(null, draft), draft);
  const noLocks = mkScore();
  check('без locked → draft как есть', mergeDraftWithLocked(noLocks, draft), draft);
}

console.log('\n--- 8. Автоматизация: интерполяция, мердж-overdub, валидация ---');
{
  // 8.1 interpAutomation
  const pts = [{ t: 1, v: 0.2 }, { t: 3, v: 0.8 }];
  check('пустая кривая → undefined', interpAutomation([], 1), undefined);
  check('до первой точки → первая', interpAutomation(pts, 0.5), 0.2);
  check('после последней → последняя (хвост держится)', interpAutomation(pts, 9), 0.8);
  check('середина → линейно', interpAutomation(pts, 2), 0.5);
  check('точно в точке', interpAutomation(pts, 3), 0.8);

  // 8.2 sampleAutomation
  const lanes = [
    { id: 'a1', target: 'rays.brightness' as const, points: [{ t: 0, v: 1 }, { t: 4, v: 2 }] },
    { id: 'a2', target: 'motion.tilt' as const, points: [{ t: 2, v: 0.7 }] },
  ];
  const sa = sampleAutomation(lanes, 2);
  check('brightness в t=2 → 1.5', sa['rays.brightness'], 1.5);
  check('tilt в t=2 → 0.7', sa['motion.tilt'], 0.7);
  check('нет дорожки hue → undefined', sa['rays.hueShift'], undefined);
  check('без automation → пусто', sampleAutomation(undefined, 1), {});

  // 8.3 mergeAutomation overdub: диапазон перезаписан, снаружи сохранено
  const s = mkScore();
  s.automation = [{
    id: 'a1', target: 'rays.brightness',
    points: [{ t: 0, v: 1 }, { t: 10, v: 1.5 }, { t: 20, v: 1 }, { t: 30, v: 0.9 }],
  }];
  const rec = [{
    id: 'new', target: 'rays.brightness' as const,
    points: [{ t: 12, v: 2.0 }, { t: 18, v: 2.2 }],
  }];
  const m = mergeAutomation(s, rec);
  const got = m.automation![0].points;
  check('точки вне диапазона 12..18 сохранены', got.filter(p => p.t < 12 || p.t > 18),
    [{ t: 0, v: 1 }, { t: 10, v: 1.5 }, { t: 20, v: 1 }, { t: 30, v: 0.9 }]);
  check('старые точки внутри диапазона удалены', got.some(p => p.t > 12 && p.t < 18 && p.v === 1), false);
  check('новые точки на месте', got.filter(p => p.v >= 2).map(p => p.t), [12, 18]);
  check('отсортировано по t', got.map(p => p.t), [0, 10, 12, 18, 20, 30]);
  check('id дорожки сохранён', m.automation![0].id, 'a1');
  // Клип значений при мердже
  const over = mergeAutomation(mkScore(), [{
    id: 'x', target: 'rays.brightness', points: [{ t: 1, v: 99 }],
  }]);
  check('значение клипнуто в 2.5', over.automation![0].points[0].v, 2.5);
  // Пустая запись — score не меняется
  check('пустые дорожки игнорятся', mergeAutomation(s, []), s);

  // 8.4 validateScore: ошибки автоматизации ловятся
  const bad = mkScore();
  bad.automation = [{ id: 'a', target: 'dimmers.1' as any, points: [{ t: 0, v: 1 }] }];
  checkTrue('чужая цель → ошибка', validateScore(bad).some(e => e.includes('target')));
  const bad2 = mkScore();
  bad2.automation = [{ id: 'a', target: 'rays.brightness', points: [{ t: 0, v: 99 }] }];
  checkTrue('v вне пределов → ошибка', validateScore(bad2).some(e => e.includes('points')));
  const good = mkScore();
  good.automation = [{ id: 'a', target: 'motion.tilt', points: [{ t: 0, v: 0.5 }, { t: 2, v: 0.8 }] }];
  check('валидная автоматизация проходит', validateScore(good), []);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
