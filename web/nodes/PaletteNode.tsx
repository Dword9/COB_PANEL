import React, { memo, useState, useEffect } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { LuminaNode } from '../types';

// Входной пин на строке ползунка (тот же приём, что в MidiTrackNode:
// top:50% по ДОРОЖКЕ, не по всему блоку — иначе пин «висит в воздухе»).
const ParamIn: React.FC<{ id: string; label: string }> = ({ id, label }) => (
  <Handle type="target" position={Position.Left} id={id} title={label}
    style={{ top: '50%', left: -14 }} className="!bg-fuchsia-400" />
);

const Slider: React.FC<{
  label: string;
  value: number;
  min: number; max: number; step: number;
  accent?: string;
  pin?: { id: string; title: string };
  driven?: boolean;
  onLive: (v: number) => void;
  onCommit: (v: number) => void;
}> = ({ label, value, min, max, step, accent = 'accent-fuchsia-500', pin, driven, onLive, onCommit }) => (
  <div>
    <label className="block text-[10px] text-zinc-400">
      {label}
      {driven && (
        <span className="ml-1 px-1 rounded bg-fuchsia-500/20 text-fuchsia-400 text-[8px] font-black align-middle"
          title="Управляет подключённый вход: ползунок игнорируется, показано фактическое значение">
          ВХОД
        </span>
      )}
    </label>
    <div className="relative">
      {pin && <ParamIn id={pin.id} label={pin.title} />}
      <input type="range" min={min} max={max} step={step} value={value}
        disabled={driven}
        onChange={e => onLive(parseFloat(e.target.value))}
        onPointerUp={() => onCommit(value)}
        onPointerDown={e => e.stopPropagation()}
        className={`nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer block ${accent} ${driven ? 'opacity-50' : ''}`} />
    </div>
  </div>
);

/**
 * ПАЛИТРА — цвет верхнего света (COB): сдвиг оттенка и насыщенность.
 * Оба параметра можно крутить снаружи (LFO, фейдеры крыла) через входы
 * hue-in/sat-in. Выходы 0-255: out-0 = сдвиг, out-1 = насыщенность —
 * в одноимённые входы wash-hue-in/wash-sat-in ноды MIDI-трек.
 */
export const PaletteNode: React.FC<NodeProps<LuminaNode>> = ({ id, data, selected }) => {
  const p = (data.params || {}) as any;
  const onParam = data.onParamChange || (() => {});
  const setParam = (key: string, val: any) => onParam(id, key, val);

  const driven = (p._driven || {}) as Record<string, boolean>;
  const effHue = driven.hue && typeof p._effHue === 'number' ? p._effHue : (p.hue ?? 0);
  const effSat = driven.sat && typeof p._effSat === 'number' ? p._effSat : (p.saturation ?? 1);

  const [locHue, setLocHue] = useState(p.hue ?? 0);
  const [locSat, setLocSat] = useState(p.saturation ?? 1);
  useEffect(() => { setLocHue(p.hue ?? 0); }, [p.hue]);
  useEffect(() => { setLocSat(p.saturation ?? 1); }, [p.saturation]);

  const deg = Math.round(effHue * 360);
  const satPct = Math.round(effSat * 100);
  const color = `hsl(${deg}, ${satPct}%, 55%)`;

  return (
    <div className={`bg-[#121214] border-2 rounded-2xl w-56 shadow-2xl flex flex-col transition-all duration-300
      ${selected ? 'border-fuchsia-500 shadow-[0_0_20px_rgba(217,70,239,0.3)]' : 'border-zinc-800'}`}>

      <div className="bg-zinc-900/50 p-3 border-b border-zinc-800 flex justify-between items-center rounded-t-xl">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]"
            style={{ backgroundColor: color, color }} />
          <span className="text-[10px] font-black text-fuchsia-400 uppercase tracking-widest">Палитра COB</span>
        </div>
        <span className="text-[9px] font-mono text-zinc-500">{deg}° · {satPct}%</span>
      </div>

      <div className="p-4 space-y-4 rounded-b-xl">
        {/* Живая полоска цвета: строится из ЭФФЕКТИВНЫХ значений — едет и от
            LFO на входе, а не только от ползунка */}
        <div className="h-4 rounded-lg border border-zinc-700 transition-colors duration-75"
          style={{ background: `linear-gradient(to right, ${color}, hsl(${(deg + 40) % 360}, ${satPct}%, 45%))` }} />

        <Slider label={`Сдвиг цвета ${deg}°`} value={effHue}
          min={0} max={1} step={0.01} driven={driven.hue}
          pin={{ id: 'hue-in', title: 'Вход: сдвиг цвета (0-255)' }}
          onLive={v => { setLocHue(v); if (data.params) data.params.hue = v; }}
          onCommit={v => setParam('hue', v)} />
        <Slider label={`Насыщенность ${satPct}%`} value={effSat}
          min={0} max={1} step={0.01} driven={driven.sat}
          pin={{ id: 'sat-in', title: 'Вход: насыщенность (0-255)' }}
          onLive={v => { setLocSat(v); if (data.params) data.params.saturation = v; }}
          onCommit={v => setParam('saturation', v)} />

        <div className="text-[9px] text-zinc-500 leading-tight">
          Выходы справа: сдвиг и насыщенность (0-255) — в входы
          «COB сдвиг/насыщ» ноды MIDI-трек. На саму палитру тоже можно
          вешать LFO — входы слева.
        </div>

        <div className="relative pt-1 space-y-2 text-[9px] font-bold text-zinc-500">
          <div className="flex items-center justify-end gap-1.5">
            <span>сдвиг</span>
            <Handle type="source" position={Position.Right} id="out-0" title="Сдвиг цвета (0-255)"
              style={{ top: '30%', right: -14 }} className="!bg-fuchsia-400" />
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <span>насыщ</span>
            <Handle type="source" position={Position.Right} id="out-1" title="Насыщенность (0-255)"
              style={{ top: '75%', right: -14 }} className="!bg-fuchsia-300" />
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(PaletteNode);
