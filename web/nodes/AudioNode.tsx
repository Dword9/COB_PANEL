
import React, { useRef, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import { renderRegistry } from '../utils/renderRegistry';
import { arraysEqual } from '../utils/helpers';

export const AudioNode = ({ data, id, selected }: any) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valuesRef = useRef<number[]>(data.values || [0, 0, 0]);

  const draw = (vals: number[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = 220;
    const height = 45; 
    
    ctx.clearRect(0, 0, width, height);

    const bands = ['LOW', 'MID', 'HIGH'];
    const colors = ['#10b981', '#3b82f6', '#eab308'];

    bands.forEach((band, i) => {
        const val = vals[i] || 0;
        const y = i * 15;
        const barH = 8;
        const pct = Math.min(1, Math.max(0, val / 255));
        
        ctx.fillStyle = '#18181b';
        ctx.fillRect(0, y, 30, barH);
        
        ctx.fillStyle = '#27272a';
        ctx.beginPath();
        ctx.roundRect(35, y, width - 35, barH, 2);
        ctx.fill();

        if (pct > 0) {
            ctx.fillStyle = colors[i];
            ctx.shadowColor = colors[i];
            ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.roundRect(35, y, (width - 35) * pct, barH, 2);
            ctx.fill();
            ctx.shadowBlur = 0;
        }

        ctx.fillStyle = '#71717a';
        ctx.font = '900 7px sans-serif';
        ctx.fillText(band, 0, y + 7);
    });
  };
  
  // Initial Canvas Setup
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const width = 220;
        const height = 45;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const ctx = canvas.getContext('2d');
        if(ctx) ctx.scale(dpr, dpr);
        draw(valuesRef.current);
    }
  }, []);

  // Registry Update
  useEffect(() => {
    const update = (newVals: number[]) => {
        if (arraysEqual(newVals, valuesRef.current)) return;
        valuesRef.current = newVals;
        draw(newVals);
    };
    renderRegistry.register(id, update);
    return () => renderRegistry.unregister(id);
  }, [id]);

  return (
    <div className={`bg-[#121214] border-2 rounded-2xl w-64 shadow-2xl flex flex-col transition-all duration-300 ${selected ? 'border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.3)]' : 'border-zinc-800'}`}>
      
      {/* HEADER */}
      <div className="overflow-hidden rounded-t-xl">
        <div className="bg-zinc-900/50 p-3 border-b border-zinc-800 flex justify-between items-center relative">
            <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]" />
            <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">DSP SPLITTER</span>
            </div>
            <Handle 
                type="target" 
                position={Position.Left} 
                id="signal-in" 
                className="!bg-zinc-500 !w-4 !h-4 !border-[3px] !border-[#050507] !-left-2" 
            />
        </div>
      </div>

      <div className="p-4 space-y-5 rounded-b-xl overflow-hidden">
        
        {/* PRIMARY CONTROLS: GAIN & GATE */}
        <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
                <div className="flex justify-between items-end">
                    <label className="text-[9px] font-bold text-zinc-500 uppercase tracking-wider">Boost</label>
                    <span className="text-[10px] font-mono font-bold text-emerald-400">{(data.params?.gain || 1).toFixed(1)}x</span>
                </div>
                <input 
                    type="range" min="0" max="10" step="0.1"
                    value={data.params?.gain || 1}
                    onChange={e => data.onParamChange(id, 'gain', parseFloat(e.target.value))}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="nodrag nopan w-full h-1 bg-zinc-800 rounded-full appearance-none accent-emerald-500 cursor-pointer"
                />
            </div>
            <div className="space-y-1">
                <div className="flex justify-between items-end">
                    <label className="text-[9px] font-bold text-zinc-500 uppercase tracking-wider">Floor</label>
                    <span className="text-[10px] font-mono font-bold text-emerald-400">{data.params?.gate || 0}</span>
                </div>
                <input 
                    type="range" min="0" max="255" step="1"
                    value={data.params?.gate || 0}
                    onChange={e => data.onParamChange(id, 'gate', parseInt(e.target.value))}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="nodrag nopan w-full h-1 bg-zinc-800 rounded-full appearance-none accent-emerald-500 cursor-pointer"
                />
            </div>
        </div>

        {/* SECONDARY CONTROLS: ATTACK & DROP SMOOTHING */}
        <div className="space-y-4 p-3 bg-zinc-950 rounded-xl border border-zinc-800">
            <div className="space-y-1">
                 <div className="flex justify-between items-center">
                    <span className="text-[8px] font-black text-zinc-600 uppercase">Attack Smoothing</span>
                    <span className="text-[10px] font-mono font-black text-emerald-400">{( (data.params?.attackSmoothing ?? 0) * 100).toFixed(0)}%</span>
                </div>
                <input 
                    type="range" min="0" max="0.99" step="0.01"
                    value={data.params?.attackSmoothing ?? 0}
                    onChange={e => data.onParamChange(id, 'attackSmoothing', parseFloat(e.target.value))}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="nodrag nopan w-full h-1.5 bg-zinc-900 rounded-full appearance-none accent-emerald-500 cursor-pointer"
                />
            </div>

            <div className="space-y-1">
                 <div className="flex justify-between items-center">
                    <span className="text-[8px] font-black text-zinc-600 uppercase">Drop Smoothing</span>
                    <span className="text-[10px] font-mono font-black text-emerald-400">{( (data.params?.decaySmoothing ?? 0.9) * 100).toFixed(0)}%</span>
                </div>
                <input 
                    type="range" min="0" max="0.999" step="0.001"
                    value={data.params?.decaySmoothing ?? 0.9}
                    onChange={e => data.onParamChange(id, 'decaySmoothing', parseFloat(e.target.value))}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="nodrag nopan w-full h-1.5 bg-zinc-900 rounded-full appearance-none accent-emerald-500 cursor-pointer"
                />
            </div>
        </div>

        {/* OUTPUT VISUALIZERS - CANVAS BASED */}
        <div className="relative pt-1">
            <canvas ref={canvasRef} className="pointer-events-none" />

            {/* Handles overlay positioned to match canvas rows */}
            <Handle type="source" position={Position.Right} id="out-0" className="!bg-zinc-400 group-hover:!bg-emerald-400 !w-4 !h-4 !border-[3px] !border-[#050507] !-right-2 !top-[7px]" />
            <Handle type="source" position={Position.Right} id="out-1" className="!bg-zinc-400 group-hover:!bg-emerald-400 !w-4 !h-4 !border-[3px] !border-[#050507] !-right-2 !top-[22px]" />
            <Handle type="source" position={Position.Right} id="out-2" className="!bg-zinc-400 group-hover:!bg-emerald-400 !w-4 !h-4 !border-[3px] !border-[#050507] !-right-2 !top-[37px]" />
        </div>

        {/* Границы полос в герцах — чтобы LOW/MID/HIGH не были «непонятными частотами» */}
        <div className="flex justify-between text-[7px] font-black tracking-tight -mt-1">
            <span className="text-emerald-500">20–250 Гц</span>
            <span className="text-blue-400">250–4к</span>
            <span className="text-yellow-500">4–16 кГц</span>
        </div>
      </div>
    </div>
  );
};
