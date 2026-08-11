
import React, { useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { renderRegistry } from '../utils/renderRegistry';

export const MathNode = ({ data, id, selected }: any) => {
  const [isEditing, setIsEditing] = useState(false);
  const accentColor = data.color || '#10b981';
  
  const valRef = useRef<HTMLDivElement>(null);
  const params = {
    scale: 1,
    offset: 0,
    mixing: 'max', // max, sum, avg, mult, min
    ...data.params
  };

  const [localScale, setLocalScale] = useState(params.scale);
  const [localOffset, setLocalOffset] = useState(params.offset);

  useEffect(() => {
    setLocalScale(params.scale);
  }, [params.scale]);

  useEffect(() => {
    setLocalOffset(params.offset);
  }, [params.offset]);

  useEffect(() => {
    renderRegistry.register(id, (vals: number[]) => {
      if (valRef.current) {
        const v = Math.round(vals[0] || 0);
        valRef.current.innerText = String(v);
        // Visual feedback based on value
        const opacity = 0.2 + (v / 255) * 0.8;
        valRef.current.style.opacity = String(opacity);
      }
    });
    return () => renderRegistry.unregister(id);
  }, [id]);

  const functions = [
    { id: 'max', label: 'MAX', desc: 'Highest input' },
    { id: 'sum', label: 'SUM', desc: 'Add all inputs' },
    { id: 'mult', label: 'MULT', desc: 'Multiply all' },
    { id: 'avg', label: 'AVG', desc: 'Average' },
    { id: 'sub', label: 'SUB', desc: 'Subtract from first' },
    { id: 'div', label: 'DIV', desc: 'Divide first by others' },
    { id: 'min', label: 'MIN', desc: 'Lowest input' },
  ];
  
  return (
    <div className={`bg-zinc-900 border-2 rounded-2xl p-4 w-48 shadow-2xl transition-all duration-300 ${selected ? 'border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.3)]' : 'border-zinc-800'}`} style={{ borderColor: selected ? undefined : `${accentColor}44` }}>
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2 group flex-1">
          {isEditing ? (
            <input 
                autoFocus
                type="text" 
                value={data.label} 
                onChange={(e) => data.onParamChange(id, 'label', e.target.value)}
                onBlur={() => setIsEditing(false)}
                onKeyDown={(e) => e.key === 'Enter' && setIsEditing(false)}
                onPointerDown={(e) => e.stopPropagation()}
                className="nodrag nopan bg-zinc-800 text-[10px] font-black uppercase tracking-widest outline-none border border-emerald-500/50 rounded px-1 w-full"
                style={{ color: accentColor }}
            />
          ) : (
            <span className="text-[10px] font-black uppercase tracking-widest truncate" style={{ color: accentColor }}>
                {data.label}
            </span>
          )}
          <button 
                onClick={() => setIsEditing(!isEditing)}
                onPointerDown={(e) => e.stopPropagation()}
                className="nodrag nopan opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-white transition-opacity"
            >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
            </button>
        </div>
        <input 
             type="color" 
             value={accentColor} 
             onChange={(e) => data.onParamChange(id, 'color', e.target.value)}
             onPointerDown={(e) => e.stopPropagation()}
             className="nodrag nopan w-3 h-3 rounded-full border-none bg-transparent cursor-pointer ml-2"
        />
      </div>
      
      <div className="relative mb-4">
        <Handle type="target" position={Position.Left} id="in-0" className="!bg-emerald-500 !-left-6 !w-4 !h-4 !border-[3px] !border-[#050507]" />
        <div 
            ref={valRef}
            className="text-center py-4 bg-zinc-950 rounded-xl font-mono text-3xl font-black transition-all" 
            style={{ color: accentColor, textShadow: `0 0 10px ${accentColor}44` }}
        >
          0
        </div>
        <Handle type="source" position={Position.Right} id="out-0" className="!bg-emerald-500 !-right-6 !w-4 !h-4 !border-[3px] !border-[#050507]" />
      </div>

      <div className="space-y-4">
        {/* Function Selector */}
        <div className="grid grid-cols-4 gap-1">
            {functions.map(f => (
                <button
                    key={f.id}
                    onClick={() => data.onParamChange(id, 'mixing', f.id)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={`nodrag nopan px-1 py-1 rounded text-[7px] font-black transition-all ${params.mixing === f.id ? 'bg-emerald-500 text-black shadow-[0_0_8px_#10b98144]' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
                    title={f.desc}
                >
                    {f.label}
                </button>
            ))}
        </div>

        <div className="space-y-2">
            <div className="flex justify-between text-[8px] font-bold text-zinc-600 uppercase">
                <span>STRENGTH (SCALE)</span>
                <span className="text-emerald-400">x{localScale.toFixed(2)}</span>
            </div>
            <input 
                type="range" min="0" max="10" step="0.1" 
                value={localScale} 
                onChange={e => {
                    const val = parseFloat(e.target.value);
                    setLocalScale(val);
                    if (data.params) data.params.scale = val;
                }}
                onPointerUp={() => data.onParamChange(id, 'scale', localScale)}
                onPointerDown={(e) => e.stopPropagation()}
                className="nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-emerald-500"
            />
        </div>

        <div className="space-y-2">
            <div className="flex justify-between text-[8px] font-bold text-zinc-600 uppercase">
                <span>SHIFT (OFFSET)</span>
                <span className="text-emerald-400">{localOffset > 0 ? '+' : ''}{Math.round(localOffset)}</span>
            </div>
            <input 
                type="range" min="-255" max="255" step="1" 
                value={localOffset} 
                onChange={e => {
                    const val = parseFloat(e.target.value);
                    setLocalOffset(val);
                    if (data.params) data.params.offset = val;
                }}
                onPointerUp={() => data.onParamChange(id, 'offset', localOffset)}
                onPointerDown={(e) => e.stopPropagation()}
                className="nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-emerald-500"
            />
        </div>
      </div>
    </div>
  );
};
