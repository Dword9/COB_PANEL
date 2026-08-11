
import React, { useRef, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import { renderRegistry } from '../utils/renderRegistry';

export const GroupActivatorNode = ({ data, id, selected }: any) => {
  const params = {
    targetGroup: 1,
    solo: false,
    ...data.params
  };

  const valBarRef = useRef<HTMLDivElement>(null);
  const valTextRef = useRef<HTMLSpanElement>(null);
  const ledRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    renderRegistry.register(id, (vals: number[]) => {
      const v = vals[0] || 0;

      if (valBarRef.current) {
        valBarRef.current.style.width = `${(v / 255) * 100}%`;
      }
      if (valTextRef.current) {
        valTextRef.current.innerText = String(v);
        valTextRef.current.className = `text-[10px] font-black font-mono ${v > 127 ? 'text-emerald-500' : 'text-zinc-600'}`;
      }
      // LED обновляем императивно — чтение innerText во время рендера давало вечно устаревшую точку
      if (ledRef.current) {
        ledRef.current.className = `w-2 h-2 rounded-full ${v > 127 ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-zinc-700'}`;
      }
    });
    return () => renderRegistry.unregister(id);
  }, [id]);

  const handleGroupChange = (val: number) => {
    data.onParamChange(id, 'targetGroup', val);
  };

  return (
    <div className={`bg-zinc-900 border-2 rounded-2xl p-4 w-48 shadow-2xl transition-all duration-300 ${selected ? 'border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.3)]' : 'border-zinc-800'}`}>
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-2">
            <div ref={ledRef} className="w-2 h-2 rounded-full bg-zinc-700" />
            <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest leading-tight">АКТИВАТОР ГРУППЫ</span>
        </div>
        <button 
          onClick={() => data.onParamChange(id, 'solo', !params.solo)}
          onPointerDown={(e) => e.stopPropagation()}
          className={`nodrag nopan px-1.5 py-0.5 rounded text-[7px] font-black uppercase transition-all ${params.solo ? 'bg-emerald-500 text-black' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
          title="Exclusive mode: only the latest activated group wins"
        >
          SOLO
        </button>
      </div>

      <div className="space-y-3 mb-4">
        <div className="space-y-1">
          <label className="text-[7px] font-bold text-zinc-600 uppercase">ГРУППА ДЛЯ АКТИВАЦИИ</label>
          <div className="flex gap-1 items-center">
            <input 
              type="number" 
              min="1" max="255"
              value={params.targetGroup}
              onChange={e => handleGroupChange(parseInt(e.target.value) || 1)}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag nopan w-full bg-zinc-800 text-emerald-400 text-[11px] font-bold p-1.5 rounded border border-zinc-700 focus:border-emerald-500 outline-none"
            />
          </div>
        </div>

        <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div 
            ref={valBarRef}
            className="h-full bg-emerald-500 transition-all duration-75 shadow-[0_0_8px_#10b981]"
            style={{ width: '0%' }}
          />
        </div>
        
        <div className="flex justify-between items-center">
          <span className="text-[7px] text-zinc-600 font-bold uppercase">ВХОДНОЙ СИГНАЛ</span>
          <span ref={valTextRef} className="text-[10px] font-black font-mono text-zinc-600">0</span>
        </div>
      </div>

      <Handle type="target" position={Position.Left} id="signal-in" className="!bg-emerald-500 !-left-2 !w-4 !h-4 !border-[3px] !border-[#050507]" />
    </div>
  );
};
