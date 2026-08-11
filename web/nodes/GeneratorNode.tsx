import React, { useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { renderRegistry } from '../utils/renderRegistry';
import { Activity, Zap, Play } from 'lucide-react';

export const GeneratorNode = ({ data, id, selected }: any) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tapTimesRef = useRef<number[]>([]);
  const tapIndicatorRef = useRef<HTMLDivElement>(null);

  const params = {
    shape: 'sine',
    speed: 120, // BPM
    discrete: false,
    ...data.params,
  };

  const [localSpeed, setLocalSpeed] = useState(params.speed);
  useEffect(() => {
    setLocalSpeed(params.speed);
  }, [params.speed]);

  // Registry listener for real-time oscilloscope
  useEffect(() => {
    const history: number[] = [];
    const maxHistory = 60;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = 208; // width of node container content area
    const ch = 48;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const handleUpdate = (vals: number[]) => {
      const v = vals[0] || 0;
      history.push(v);
      if (history.length > maxHistory) history.shift();

      ctx.clearRect(0, 0, cw, ch);

      // Draw Grid Line
      ctx.strokeStyle = '#27272a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ch / 2);
      ctx.lineTo(cw, ch / 2);
      ctx.stroke();

      // Draw Waveform Line
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      
      ctx.beginPath();
      for (let i = 0; i < history.length; i++) {
        const x = (i / (maxHistory - 1)) * cw;
        const y = ch - 2 - ((history[i] / 255) * (ch - 4));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      // Emulate glow via fast multi-pass strokes (hardware accelerated) instead of expensive shadowBlur
      ctx.strokeStyle = '#a855f722';
      ctx.lineWidth = 6;
      ctx.stroke();

      ctx.strokeStyle = '#a855f744';
      ctx.lineWidth = 4;
      ctx.stroke();

      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 2;
      ctx.stroke();
    };

    renderRegistry.register(id, handleUpdate);
    return () => renderRegistry.unregister(id);
  }, [id]);

  // Tap Tempo logic
  const handleTap = (e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Quick button tap flash animation
    if (tapIndicatorRef.current) {
        tapIndicatorRef.current.classList.remove('bg-zinc-800');
        tapIndicatorRef.current.classList.add('bg-purple-500');
        setTimeout(() => {
            tapIndicatorRef.current?.classList.remove('bg-purple-500');
            tapIndicatorRef.current?.classList.add('bg-zinc-800');
        }, 100);
    }

    const now = Date.now();
    let times = [...tapTimesRef.current];

    // Reset history if gap is more than 2.5 seconds
    if (times.length > 0 && now - times[times.length - 1] > 2500) {
      times = [];
    }

    times.push(now);
    if (times.length > 5) times.shift();
    tapTimesRef.current = times;

    if (times.length > 1) {
      let sum = 0;
      for (let i = 1; i < times.length; i++) {
        sum += times[i] - times[i - 1];
      }
      const avgMs = sum / (times.length - 1);
      if (avgMs >= 100 && avgMs <= 3000) {
        // Кламп в диапазон слайдера, иначе быстрый тап угоняет BPM за его пределы
        const bpm = Math.max(10, Math.min(480, Math.round(60000 / avgMs)));
        data.onParamChange(id, 'speed', bpm);
      }
    }
  };

  const handleShapeChange = (shape: string) => {
    data.onParamChange(id, 'shape', shape);
  };

  const handleSpeedSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    setLocalSpeed(val);
    if (data.params) {
      data.params.speed = val;
    }
  };

  const handleDiscreteToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    data.onParamChange(id, 'discrete', e.target.checked);
  };

  return (
    <div className={`bg-zinc-900 border-2 rounded-2xl p-4 w-60 shadow-2xl transition-all duration-300 ${selected ? 'border-purple-500 shadow-[0_0_24px_rgba(168,85,247,0.2)]' : 'border-zinc-800'}`}>
      
      {/* Title / Header */}
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-purple-400" />
          <span className="text-[11px] font-black text-purple-400 uppercase tracking-widest">LFO Генератор</span>
        </div>
        <span className="text-[9px] font-mono text-zinc-500">{localSpeed} BPM</span>
      </div>

      {/* Shapes Selector */}
      <div className="grid grid-cols-5 gap-1 mb-4">
        {[
          { id: 'sine', label: 'Sin', path: 'M 2 8 Q 6 1, 10 8 T 18 8' },
          { id: 'triangle', label: 'Tri', path: 'M 2 14 L 10 2 L 18 14' },
          { id: 'saw', label: 'Saw', path: 'M 2 14 L 18 2 L 18 14' },
          { id: 'square', label: 'Sqr', path: 'M 2 14 L 2 2 L 10 2 L 10 14 L 18 14' },
          { id: 'noise', label: 'Rnd', path: 'M 2 8 L 5 13 L 8 3 L 11 11 L 14 5 L 18 10' }
        ].map((s) => (
          <button
            key={s.id}
            onClick={() => handleShapeChange(s.id)}
            onPointerDown={e => e.stopPropagation()}
            className={`nodrag nopan flex flex-col items-center justify-center p-2 rounded-lg border text-[8px] font-black uppercase transition-all duration-200 hover:scale-105 active:scale-95 ${
              params.shape === s.id
                ? 'bg-purple-950/40 border-purple-500 text-purple-300 shadow-[0_0_8px_rgba(168,85,247,0.2)]'
                : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900/50'
            }`}
            title={s.id.toUpperCase()}
          >
            <svg className="w-5 h-4 mb-0.5 stroke-current fill-none" viewBox="0 0 20 16" strokeWidth="2">
              <path d={s.path} />
            </svg>
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      {/* Oscilloscope Graph Preview */}
      <div className="bg-zinc-950 p-2 rounded-xl border border-zinc-800 mb-4 flex items-center justify-center overflow-hidden">
        <canvas ref={canvasRef} className="rounded" />
      </div>

      {/* Speed Slider */}
      <div className="space-y-1 mb-4 p-3 bg-zinc-950 rounded-xl border border-zinc-800">
        <div className="flex justify-between text-[8px] font-bold text-zinc-500 uppercase">
          <span>Частота (Скорость)</span>
          <span className="text-purple-400">{(localSpeed / 60).toFixed(2)} Hz</span>
        </div>
        <input
          type="range"
          min="10"
          max="480"
          value={localSpeed}
          onChange={handleSpeedSliderChange}
          onPointerUp={() => {
            data.onParamChange(id, 'speed', localSpeed);
          }}
          onPointerDown={e => e.stopPropagation()}
          className="nodrag nopan w-full h-3 bg-zinc-900 rounded-full appearance-none accent-purple-500 cursor-pointer"
        />
      </div>

      {/* Tap Tempo & Discrete toggle */}
      <div className="flex gap-2 mb-4">
        {/* Tap Tempo Button */}
        <div
          ref={tapIndicatorRef}
          onClick={handleTap}
          onPointerDown={e => e.stopPropagation()}
          className="nodrag nopan flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-200 rounded-xl border border-zinc-700 cursor-pointer select-none transition-all"
        >
          <Play size={12} className="fill-current text-purple-400" />
          <span className="text-[10px] font-black uppercase tracking-wider">TAP TEMPO</span>
        </div>
      </div>

      {/* Discrete Mode */}
      <div className="flex items-center justify-between p-2.5 bg-zinc-950 rounded-xl border border-zinc-800 relative">
        <div className="flex items-center gap-2">
          <Zap size={14} className={params.discrete ? 'text-amber-500' : 'text-zinc-500'} />
          <span className="text-[9px] font-bold text-zinc-400 uppercase">Дискретный (0 / 255)</span>
        </div>
        <input
          type="checkbox"
          checked={params.discrete}
          onChange={handleDiscreteToggle}
          onPointerDown={e => e.stopPropagation()}
          className="nodrag nopan w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-purple-500 focus:ring-purple-500 focus:ring-offset-zinc-950 cursor-pointer"
        />
      </div>

      {/* Output Handle */}
      <div className="mt-4 relative">
        <Handle
          type="source"
          position={Position.Right}
          id="out-0"
          className="!bg-purple-500 !-right-6 !w-4 !h-4 !border-[3px] !border-[#050507]"
        />
      </div>
    </div>
  );
};
