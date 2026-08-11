import React, { memo, useState, useEffect } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { LuminaNode } from '../types';

const MODES = [
  { id: 'quiet', label: 'Тихо' },
  { id: 'medium', label: 'Средне' },
  { id: 'epic', label: 'Эпик' },
];

const COLORS = [
  { name: 'Белый', hue: 0, sat: 0 },
  { name: 'Красный', hue: 0, sat: 1 },
  { name: 'Зелёный', hue: 120, sat: 1 },
  { name: 'Синий', hue: 240, sat: 1 },
  { name: 'Розовый', hue: 320, sat: 1 },
  { name: 'Жёлтый', hue: 60, sat: 1 },
  { name: 'Радуга', hue: 0, sat: 1, rainbow: true },
];

// Входы для живого управления с фейдеров крыла (через MIDI-ноду).
// Разъём рисуется внутри своей строки параметра — иначе пины разъезжаются
// по высоте и непонятно, какой к чему относится.
const ParamIn: React.FC<{ id: string; label: string }> = ({ id, label }) => (
  <Handle type="target" position={Position.Left} id={id} title={label}
    style={{ top: '50%', left: -14 }} className="!bg-sky-400" />
);

/** Метка «этим параметром сейчас управляет вход» — иначе непонятно, почему
 *  ползунок не действует (жалоба 27.07: «где-то вообще не реагирует»). */
const DrivenTag: React.FC<{ on?: boolean }> = ({ on }) => on ? (
  <span className="ml-1 px-1 rounded bg-sky-500/20 text-sky-400 text-[8px] font-black align-middle"
    title="Параметром управляет подключённый вход: ползунок игнорируется, показано фактическое значение">
    ВХОД
  </span>
) : null;

export const CombControllerNode: React.FC<NodeProps<LuminaNode>> = ({ id, data, selected }) => {
  const p = (data.params || {}) as any;
  const onParam = data.onParamChange || (() => {});
  const setParam = (key: string, val: any) => onParam(id, key, val);
  const mode = p.mode || 'quiet';
  const colorMode = p.colorMode || 'rainbow';
  const strobe = p.strobe ?? 0;
  const stop = !!p.stop;
  const randomize = p.randomize ?? 0;
  const driven = (p._driven || {}) as Record<string, boolean>;

  const [localBrightness, setLocalBrightness] = useState(p.brightness ?? 1);
  const [localSpeed, setLocalSpeed] = useState(p.speed ?? 1);
  const [localRandomize, setLocalRandomize] = useState(randomize);
  const [localStrobe, setLocalStrobe] = useState(strobe);
  const [localTilt, setLocalTilt] = useState(p.tilt ?? 0.5);
  const [localTiltMin, setLocalTiltMin] = useState(p.tiltMin ?? 128);
  const [localTiltMax, setLocalTiltMax] = useState(p.tiltMax ?? 255);
  const [localParkTilt, setLocalParkTilt] = useState(p.parkTilt ?? 255);

  useEffect(() => { setLocalBrightness(p.brightness ?? 1); }, [p.brightness]);
  useEffect(() => { setLocalSpeed(p.speed ?? 1); }, [p.speed]);
  useEffect(() => { setLocalRandomize(randomize); }, [randomize]);
  useEffect(() => { setLocalStrobe(strobe); }, [strobe]);
  useEffect(() => { setLocalTilt(p.tilt ?? 0.5); }, [p.tilt]);
  useEffect(() => { setLocalTiltMin(p.tiltMin ?? 128); }, [p.tiltMin]);
  useEffect(() => { setLocalTiltMax(p.tiltMax ?? 255); }, [p.tiltMax]);
  useEffect(() => { setLocalParkTilt(p.parkTilt ?? 255); }, [p.parkTilt]);

  // Физика (замер на сцене): 0 = луч в зал, ~середина = вверх (вертикаль),
  // 255 = крайнее положение внутрь сцены. Опасна только зона у нуля.
  const tiltLabel = (v: number) => (
    v <= 8 ? 'в глаза' : v < 58 ? 'в зал' : v < 104 ? 'над головами'
    : v < 156 ? 'вверх' : v < 210 ? 'вглубь сцены' : 'в заднюю стену'
  );
  // Фактический угол: вход перебивает ползунок
  const effTilt = driven.tilt && typeof p._effTilt === 'number' ? p._effTilt : localTilt;
  const tiltDmx = Math.round(
    Math.min(localTiltMin, localTiltMax) +
    effTilt * Math.abs(localTiltMax - localTiltMin));

  return (
    // Выключенная нода блекнет целиком — сразу видно, что она не участвует
    // в картине (запрос юзера 26.07). Раньше единственным индикатором была
    // красная кнопка, и было неочевидно, кто из двух источников управляет
    // расчёсками.
    <div className={`rounded-xl border bg-zinc-900 text-zinc-100 shadow-lg w-60 transition-all
      ${selected ? 'border-emerald-400' : stop ? 'border-zinc-800' : 'border-zinc-700'}
      ${stop ? 'opacity-45 saturate-0' : ''}`}>
      <div className="px-3 py-2 border-b border-zinc-700 font-bold text-sm flex items-center gap-2">
        <span className={stop ? 'text-zinc-500' : 'text-emerald-400'}>✦</span>
        <span className="flex-1">Расчёски (4)</span>
        {/* Главный выключатель: ВЫКЛ = нода не пишет в DMX ни одного байта */}
        <button onClick={() => setParam('stop', !stop)}
          title={stop ? 'Нода выключена — не управляет расчёсками' : 'Нода включена — управляет расчёсками'}
          className={`px-2 py-0.5 rounded text-[10px] font-black tracking-wide transition-colors
            ${stop ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600' : 'bg-emerald-500 text-black hover:bg-emerald-400'}`}>
          {stop ? 'ВЫКЛ' : 'ВКЛ'}
        </button>
      </div>

      <div className="px-4 py-3 space-y-3">
        <button onClick={() => setParam('stop', !stop)}
          className={`w-full py-2 rounded font-black text-sm tracking-wide ${stop ? 'bg-red-600 text-white' : 'bg-red-500/20 border border-red-500/50 text-red-400 hover:bg-red-500/30'}`}>
          {stop ? '■ НОДА ВЫКЛЮЧЕНА — нажмите, чтобы включить' : '⏻ Выключить ноду'}
        </button>

        <div>
          <div className="text-[10px] uppercase text-zinc-500 mb-1">Режим</div>
          <div className="grid grid-cols-3 gap-1">
            {MODES.map(m => (
              <button key={m.id} onClick={() => setParam('mode', m.id)}
                className={`text-xs py-1 rounded ${mode === m.id ? 'bg-emerald-500 text-black font-bold' : 'bg-zinc-800 hover:bg-zinc-700'}`}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase text-zinc-500 mb-1 flex items-center justify-between">
            <span>Цвет</span>
            {driven.hue && (
              <span className="px-1 rounded bg-sky-500/20 text-sky-400 text-[8px] font-black"
                title="Оттенок крутит подключённый вход поверх выбранного цвета">
                ВХОД СДВИГАЕТ
              </span>
            )}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {COLORS.map(c => {
              const isActive = c.rainbow
                ? colorMode === 'rainbow'
                : (colorMode === 'fixed' && (p.hueBase ?? 0) === c.hue && (p.saturation ?? 1) === c.sat);
              const bg = c.rainbow
                ? 'linear-gradient(90deg,red,orange,yellow,green,cyan,blue,violet)'
                : `hsl(${c.hue},${c.sat * 100}%,${c.sat === 0 ? 90 : 50}%)`;
              return (
                <button key={c.name} title={c.name} onClick={() => {
                  if (c.rainbow) setParam('colorMode', 'rainbow');
                  else { setParam('colorMode', 'fixed'); setParam('hueBase', c.hue); setParam('saturation', c.sat); }
                }} style={{ background: bg }}
                className={`h-9 rounded border ${isActive ? 'border-emerald-400' : 'border-zinc-600'} hover:scale-105 transition-transform`} />
              );
            })}
          </div>
          {/* Живой оттенок от входа: раньше вход на цвет отсутствовал вовсе,
              подключить LFO к палитре расчёсок было некуда (жалоба 27.07). */}
          <div className="relative mt-2">
            <ParamIn id="hue-in" label="Вход: сдвиг оттенка по кругу (0-255)" />
            <div className="h-2 rounded-full border border-zinc-700" style={{
              background: driven.hue && typeof p._effHue === 'number'
                ? `hsl(${Math.round(((p.hueBase ?? 0) + p._effHue * 360) % 360)},${Math.round((p._effSat ?? 1) * 100)}%,55%)`
                : (colorMode === 'rainbow'
                    ? 'linear-gradient(90deg,red,orange,yellow,green,cyan,blue,violet)'
                    : `hsl(${p.hueBase ?? 0},${Math.round((p.saturation ?? 1) * 100)}%,55%)`),
            }} title="Текущий цвет с учётом входа сдвига оттенка" />
          </div>
          <div className="relative mt-1">
            <ParamIn id="sat-in" label="Вход: насыщенность (0-255)" />
            <div className="text-[9px] text-zinc-600 pl-1">
              вход сдвига оттенка · вход насыщенности
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="relative">
            <ParamIn id="bright-in" label="Вход: яркость (0-255)" />
            <label className="block text-[10px] uppercase text-zinc-500">
              Яркость {Math.round((driven.bright && typeof p._effBright === 'number' ? p._effBright : localBrightness) * 100)}%
              <DrivenTag on={driven.bright} />
            </label>
            <input type="range" min={0} max={2} step={0.05}
              value={driven.bright && typeof p._effBright === 'number' ? p._effBright : localBrightness}
              disabled={driven.bright}
              onChange={e => {
                  const val = parseFloat(e.target.value);
                  setLocalBrightness(val);
                  if (data.params) data.params.brightness = val;
              }}
              onPointerUp={() => setParam('brightness', localBrightness)}
              onPointerDown={e => e.stopPropagation()}
              className={`nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-emerald-500 ${driven.bright ? 'opacity-50' : ''}`} />
          </div>

          <div className="relative">
            <ParamIn id="speed-in" label="Вход: скорость (0-255)" />
            <label className="block text-[10px] uppercase text-zinc-500">
              Скорость {Math.round((driven.speed && typeof p._effSpeed === 'number' ? p._effSpeed : localSpeed) * 100)}%
              <DrivenTag on={driven.speed} />
            </label>
            <input type="range" min={0.1} max={3} step={0.05}
              value={driven.speed && typeof p._effSpeed === 'number' ? p._effSpeed : localSpeed}
              disabled={driven.speed}
              onChange={e => {
                  const val = parseFloat(e.target.value);
                  setLocalSpeed(val);
                  if (data.params) data.params.speed = val;
              }}
              onPointerUp={() => setParam('speed', localSpeed)}
              onPointerDown={e => e.stopPropagation()}
              className={`nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-emerald-500 ${driven.speed ? 'opacity-50' : ''}`} />
          </div>

          <div>
            <label className="block text-[10px] uppercase text-zinc-500">Рандом (рассинхрон) {Math.round(localRandomize * 100)}%</label>
            <input type="range" min={0} max={1} step={0.05} value={localRandomize}
              onChange={e => {
                  const val = parseFloat(e.target.value);
                  setLocalRandomize(val);
                  if (data.params) data.params.randomize = val;
              }}
              onPointerUp={() => setParam('randomize', localRandomize)}
              onPointerDown={e => e.stopPropagation()}
              className="nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-emerald-500" />
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t border-zinc-800">
          <div className="text-[10px] uppercase text-zinc-500">Наклон реек</div>

          {/* ГЛАВНЫЙ ползунок: куда смотрят головы прямо сейчас.
              Раньше его не было вовсе — без входа мотор жёстко стоял в центре
              диапазона и подвинуть его из UI было нечем (жалоба 27.07). */}
          <div className="relative">
            <ParamIn id="tilt-in" label="Вход: угол внутри диапазона (0-255)" />
            <label className="block text-[10px] text-zinc-300">
              Угол {tiltDmx} — {tiltLabel(tiltDmx)}
              <DrivenTag on={driven.tilt} />
            </label>
            <input type="range" min={0} max={1} step={0.01}
              value={effTilt}
              disabled={driven.tilt}
              onChange={e => {
                  const val = parseFloat(e.target.value);
                  setLocalTilt(val);
                  if (data.params) data.params.tilt = val;
              }}
              onPointerUp={() => setParam('tilt', localTilt)}
              onPointerDown={e => e.stopPropagation()}
              className={`nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-sky-400 ${driven.tilt ? 'opacity-50' : ''}`} />
          </div>

          <div className="text-[9px] text-zinc-500 -mt-1">
            Границы хода (ползунок «Угол» ходит между ними):
          </div>
          <div>
            <label className="block text-[10px] text-zinc-400">Нижняя граница {localTiltMin} ({tiltLabel(localTiltMin)})</label>
            <input type="range" min={0} max={255} step={1} value={localTiltMin}
              onChange={e => {
                  const val = parseInt(e.target.value);
                  setLocalTiltMin(val);
                  if (data.params) data.params.tiltMin = val;
              }}
              onPointerUp={() => setParam('tiltMin', localTiltMin)}
              onPointerDown={e => e.stopPropagation()}
              className="nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-sky-500" />
          </div>

          <div>
            <label className="block text-[10px] text-zinc-400">Верхняя граница {localTiltMax} ({tiltLabel(localTiltMax)})</label>
            <input type="range" min={0} max={255} step={1} value={localTiltMax}
              onChange={e => {
                  const val = parseInt(e.target.value);
                  setLocalTiltMax(val);
                  if (data.params) data.params.tiltMax = val;
              }}
              onPointerUp={() => setParam('tiltMax', localTiltMax)}
              onPointerDown={e => e.stopPropagation()}
              className="nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-sky-500" />
          </div>

          <div>
            <label className="block text-[10px] text-zinc-400">Парковка при включении {localParkTilt} ({tiltLabel(localParkTilt)})</label>
            <input type="range" min={0} max={255} step={1} value={localParkTilt}
              onChange={e => {
                  const val = parseInt(e.target.value);
                  setLocalParkTilt(val);
                  if (data.params) data.params.parkTilt = val;
              }}
              onPointerUp={() => setParam('parkTilt', localParkTilt)}
              onPointerDown={e => e.stopPropagation()}
              className="nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-amber-500" />
          </div>
          <div className="text-[9px] text-zinc-500 leading-tight">
            Приборы держат последний угол. При включении сначала едут в парковку (~1,5 с), яркость вводится плавно — чтобы не бить в глаза зрителю.
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase text-zinc-500">Override</span>
            <button onClick={() => setParam('override', !p.override)}
              className={`text-xs px-2 py-0.5 rounded ${p.override ? 'bg-amber-500 text-black font-bold' : 'bg-zinc-800 hover:bg-zinc-700'}`}>
              {p.override ? 'ДА' : 'НЕТ'}
            </button>
          </div>
          <div className="text-[9px] text-zinc-500 leading-tight">Полностью захватывает расчёски (игнорит другие источники)</div>
        </div>

        <div className="relative">
          <ParamIn id="strobe-in" label="Вход: строб (0-255)" />
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase text-zinc-500">Строб {Math.round(localStrobe * 100)}%</span>
            <button onClick={() => { const v = strobe > 0 ? 0 : 0.6; setLocalStrobe(v); setParam('strobe', v); }}
              className={`text-xs px-2 py-0.5 rounded ${strobe > 0 ? 'bg-red-500 text-white font-bold' : 'bg-zinc-800 hover:bg-zinc-700'}`}>
              {strobe > 0 ? 'ВКЛ' : 'ВЫКЛ'}
            </button>
          </div>
          <input type="range" min={0} max={1} step={0.05} value={localStrobe}
            onChange={e => {
                const val = parseFloat(e.target.value);
                setLocalStrobe(val);
                if (data.params) data.params.strobe = val;
            }}
            onPointerUp={() => setParam('strobe', localStrobe)}
            onPointerDown={e => e.stopPropagation()}
            className="nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-emerald-500" />
        </div>
      </div>

      {[0, 1, 2, 3].map(i => (
        <Handle key={i} type="source" position={Position.Right} id={`comb-${i}`}
          style={{ top: `${20 + i * 18}%` }} className="!bg-emerald-400" />
      ))}
    </div>
  );
};

export default memo(CombControllerNode);
