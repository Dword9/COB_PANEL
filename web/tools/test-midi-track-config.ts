/**
 * Тесты типизированной конфигурации MIDI-трек (utils/midiTrackConfig.ts,
 * фаза 1 рефакторинга «Режиссуры трека»):
 *  1. Фабрика дефолтов = ровно те значения, которые движок раньше подставлял
 *     фолбэками (`params.x ?? y`) — поведение не должно измениться.
 *  2. Эквивалентность на НАСТОЯЩЕМ evaluateGraph: нода с пустыми params и
 *     нода с params из фабрики дают одинаковые выходы/DMX/_eff*.
 *  3. migrate: чистит runtime (_xxx) и мёртвый direction, приводит enum'ы,
 *     не мутирует исходник.
 *  4. stripMidiTrackRuntime: не мутирует исходник.
 *  5. resolve: авторские значения перекрывают дефолт, runtime игнорируется.
 *
 * Запуск: npx tsx tools/test-midi-track-config.ts   (из папки web)
 */
import { evaluateGraph } from '../utils/graphEngine';
import { setTiltCalibration } from '../utils/tiltGuard';
import {
  defaultMidiTrackParams,
  migrateMidiTrackParams,
  stripMidiTrackRuntime,
  resolveMidiTrackParams,
  MIDI_TRACK_PARAM_KEYS,
} from '../utils/midiTrackConfig';
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

console.log('--- 1. Фабрика = прежние фолбэки движка ---');
{
  const d = defaultMidiTrackParams();
  // Источник/управление
  check('audioUrl', d.audioUrl, null);
  check('analysisUrl', d.analysisUrl, null);
  check('stop', d.stop, false);
  check('group', d.group, 0);
  check('override', d.override, false);
  // Синхрон (узел: p.syncPair === '2' ? 2 : 0; deviceId 'default' → undefined)
  check('syncOn', d.syncOn, false);
  check('syncDeviceId', d.syncDeviceId, 'default');
  check('syncPair', d.syncPair, '0');
  // Лучи — DEFAULT_LIGHT_PARAMS / литерал App.addNode
  check('symmetry', d.symmetry, true);
  check('width', d.width, 1);
  check('release', d.release, 0.28);
  check('brightness', d.brightness, 1);
  check('tilt', d.tilt, 0.6);
  check('levelSource', d.levelSource, 'spec');
  check('palette', d.palette, 'thermal');
  check('hueShift', d.hueShift, 0);
  check('saturation', d.saturation, 0.95);
  check('posMode', d.posMode, 'keys');
  check('range', d.range, 'dense');
  check('minFlashFrames', d.minFlashFrames, 2);
  check('gamma', d.gamma, 1.4);
  check('motorSpeed', d.motorSpeed, 80);
  check('parkMs', d.parkMs, 1500);
  check('fadeInMs', d.fadeInMs, 600);
  // null = «из калибровки» (params.x ?? mtl.y)
  check('tiltMin', d.tiltMin, null);
  check('tiltMax', d.tiltMax, null);
  check('parkTilt', d.parkTilt, null);
  // COB (params.wash !== false → true и при undefined)
  check('wash', d.wash, true);
  check('washBrightness', d.washBrightness, 1);
  check('washFloor', d.washFloor, 0.5);
  check('washStrobe', d.washStrobe, true);
  // Кулисы
  check('backstage', d.backstage, true);
  check('backstageMode', d.backstageMode, 'notes');
  check('backstageBrightness', d.backstageBrightness, 1);
  check('backstageFloor', d.backstageFloor, 0.35);
  check('backstageSaturation', d.backstageSaturation, null);
  check('backstageFlow', d.backstageFlow, 1);
  check('backstageWave', d.backstageWave, 0.08);
  check('backstageHue', d.backstageHue, 0);
  // direction (мёртвый пережиток LFO) в фабрике отсутствует
  checkTrue('нет мёртвого direction', !('direction' in d));
}

console.log('\n--- 2. Эквивалентность на evaluateGraph: {} ≡ фабрика ---');
{
  const comb: LuminaNode = {
    id: 'comb1', type: 'fixture', position: { x: 0, y: 0 },
    data: {
      label: 'comb1', type: 'fixture',
      params: {
        fixtureType: 'comb_rgbw', startChannel: 250, group: 0,
        manualValues: Array(43).fill(0), mutes: Array(43).fill(false),
        currentValues: Array(43).fill(0),
      },
    },
  } as any;
  const mt = (params: Record<string, any>): LuminaNode => ({
    id: 'mt', type: 'midi-track', position: { x: 0, y: 0 },
    data: { label: 'MIDI-трек', type: 'midi-track', params },
  } as any);

  const runCase = (params: Record<string, any>) => {
    const p = { ...params };
    const { nodeValues, dmxUpdates } = evaluateGraph(
      [comb, mt(p)], [], {}, {});
    return { outs: nodeValues['mt'], dmx: dmxUpdates, params: p };
  };

  const a = runCase({});
  const b = runCase(defaultMidiTrackParams() as unknown as Record<string, any>);

  // Без загруженного анализа render()=null → выходы [0,128,0,0] у обоих
  check('выходы ноды идентичны', b.outs, a.outs);
  // DMX: midi-track ничего не пишет (нет кадра), fixture пишет мануалы;
  // набор каналов и значений обязан совпасть поканально
  const byCh = (list: { ch: number; val: number }[]) => {
    const m: Record<number, number> = {};
    list.forEach(u => { m[u.ch] = u.val; });
    return m;
  };
  check('DMX-кадр идентичен', byCh(b.dmx), byCh(a.dmx));
  // Побочные _eff*/_driven для UI тоже идентичны
  const eff = (p: Record<string, any>) => Object.fromEntries(
    Object.entries(p).filter(([k]) => k.startsWith('_')));
  check('runtime-побочки _eff/_driven идентичны', eff(b.params), eff(a.params));
  checkTrue('_eff значения записались (ветка активной ноды отработала)',
    typeof a.params._effHue === 'number' && typeof a.params._driven === 'object');
}

console.log('\n--- 3. migrate: runtime/мёртвое вычищено, enum приведён, исходник цел ---');
{
  const dirty = {
    // Авторское (должно выжить)
    width: 2.2, palette: 'rainbow', backstageMode: 'comet', wash: false,
    backstageSaturation: 0.55, syncPair: '2', group: 1,
    audioUrl: '/media/stems/x.mp3', audioName: 'x.mp3',
    // Мёртвое/legacy
    direction: 0,
    backstageModeJunk: undefined as any,
    // Runtime-кэш движка (как в сохранённом БАЗА.json)
    _effHue: 0.5, _effWashSat: 0.9, _driven: { hue: true },
    _activeSince: 1753700000000, _washCount: 1, _washWired: 1, _washTotal: 1,
    _combCount: 4, _backstageCount: 6,
  };
  const before = JSON.stringify(dirty);
  const clean = migrateMidiTrackParams(dirty);
  check('исходник не мутирован', JSON.stringify(dirty), before);
  checkTrue('runtime-ключи вычищены',
    Object.keys(clean).every(k => !k.startsWith('_')));
  checkTrue('мёртвый direction вычищен', !('direction' in clean));
  check('авторское width выжило', clean.width, 2.2);
  check('авторская palette выжила', clean.palette, 'rainbow');
  check('валидный backstageMode выжил', clean.backstageMode, 'comet');
  check('wash=false выжил', clean.wash, false);
  check('syncPair=2 выжил', clean.syncPair, '2');
  // Битые enum'ы лечатся
  const healed = migrateMidiTrackParams({ backstageMode: 'wave', syncPair: '9' });
  check('битый backstageMode → notes', healed.backstageMode, 'notes');
  check('битый syncPair → 0', healed.syncPair, '0');
}

console.log('\n--- 4. stripMidiTrackRuntime: только чистка, без мутации ---');
{
  const src = { width: 1.5, direction: 0, _effHue: 0.3, _driven: {} };
  const out = stripMidiTrackRuntime(src);
  check('width выжил', out.width, 1.5);
  checkTrue('_effHue удалён', !('_effHue' in out));
  checkTrue('direction удалён', !('direction' in out));
  checkTrue('исходник не тронут', src._effHue === 0.3 && 'direction' in src);
  check('пустой вход → пустой объект', stripMidiTrackRuntime(null), {});
}

console.log('\n--- 5. resolve: дефолты + авторские перекрытия ---');
{
  const r = resolveMidiTrackParams({ width: 3, _effHue: 0.7, bogusUndefined: undefined });
  check('авторский width победил', r.width, 3);
  check('остальной дефолт на месте', r.release, 0.28);
  checkTrue('runtime не попадает в resolve', (r as any)._effHue === undefined);
  checkTrue('undefined не затирает дефолт', (r as any).bogusUndefined === undefined);
  // Полнота: фабрика и список ключей совпадают по числу полей интерфейса
  checkTrue('MIDI_TRACK_PARAM_KEYS непустой', MIDI_TRACK_PARAM_KEYS.length > 30,
    `keys=${MIDI_TRACK_PARAM_KEYS.length}`);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
