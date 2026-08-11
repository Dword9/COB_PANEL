import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Mic, Music, Play, Pause, Square, ChevronDown, Activity, Volume2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { inputAudioManager } from '../services/inputAudioManager';

export const InputNode = ({ data, id, selected }: any) => {
  const [mode, setMode] = useState<'file' | 'live'>(data.params?.mode || 'file');
  const [isPlaying, setIsPlaying] = useState(false);
  const [fileName, setFileName] = useState<string>(data.params?.fileName || '');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(data.params?.deviceId || 'default');
  const [showDeviceList, setShowDeviceList] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [signal, setSignal] = useState(0);
  const [gain, setGainState] = useState<number>(data.params?.gain ?? 1);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const blobUrlRef = useRef<string | null>(null);
  const lastTimeTickRef = useRef(0);
  const currentBands = useRef<number[]>(new Array(32).fill(0));
  const glRef = useRef<{gl: WebGLRenderingContext, prog: WebGLProgram, cLoc: WebGLUniformLocation, pLoc: number, buf: WebGLBuffer} | null>(null);
  
  const gainRef = useRef<number>(data.params?.gain ?? 1);
  const setGain = (v: number) => {
    setGainState(v);
    gainRef.current = v;
    data.onParamChange(id, 'gain', v);
  };

  const onAudioLevelsUpdateRef = useRef(data.onAudioLevelsUpdate);
  useEffect(() => { onAudioLevelsUpdateRef.current = data.onAudioLevelsUpdate; }, [data.onAudioLevelsUpdate]);

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    inputAudioManager.onLevels(id, (levels) => {
      // Индикатор на самой ноде показывает уровень, который реально уйдёт на подсветку крыла
      const g = gainRef.current;
      setSignal(Math.round(Math.min(255, Math.max(levels.low, levels.mid, levels.high) * g)));
      // В граф уходят СЫРЫЕ уровни — LED Level влияет только на подсветку крыла (см. App.handleAudioLevelsUpdate)
      onAudioLevelsUpdateRef.current?.(id, levels);
    });

    inputAudioManager.onBands(id, (bands) => {
        currentBands.current = bands;
    });

    return () => {
      inputAudioManager.offLevels(id);
      inputAudioManager.offBands(id);
    };
  }, [id]);

  useEffect(() => {
    let active = true;
    if (mode === 'live') {
      setStatus('loading');
      inputAudioManager.setupLive(id, selectedDeviceId).then(success => {
        if (!active) return;
        if (success) {
            setStatus('ready');
            setError(null);
        } else {
            setError("Mic Access Denied");
            setMode('file');
        }
      });
    } else if (audioRef.current && audioRef.current.src) {
        inputAudioManager.setupFile(id, audioRef.current);
        setStatus('ready');
    } else {
        // Микрофон недоступен и файла нет — не зависаем в "loading"
        setStatus('idle');
    }
    return () => { active = false; };
  }, [mode, selectedDeviceId, id, fileName]);

  const initWebGL = () => {
    if (!canvasRef.current || glRef.current) return;
    const gl = canvasRef.current.getContext('webgl', { alpha: true });
    if (!gl) return;

    const createShader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };

    const vs = createShader(gl.VERTEX_SHADER, `attribute vec2 p; void main(){gl_Position=vec4(p,0,1);}`);
    const fs = createShader(gl.FRAGMENT_SHADER, `precision lowp float; uniform vec3 c; void main(){gl_FragColor=vec4(c,1);}`);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);

    glRef.current = {
      gl, prog,
      cLoc: gl.getUniformLocation(prog, "c")!,
      pLoc: gl.getAttribLocation(prog, "p"),
      buf: gl.createBuffer()!
    };
  };

  useEffect(() => {
    let raf: number;
    const draw = () => {
      initWebGL();
      const g = glRef.current;
      if (g) {
        const bands = currentBands.current;
        const pts: number[] = [];
        const bw = 2 / 32;
        bands.forEach((val, i) => {
          const h = (val / 255) * 2;
          const x = -1 + i * bw;
          pts.push(x, -1, x+bw*0.8, -1, x, -1+h, x, -1+h, x+bw*0.8, -1, x+bw*0.8, -1+h);
        });

        g.gl.viewport(0, 0, g.gl.canvas.width, g.gl.canvas.height);
        g.gl.clearColor(0,0,0,0);
        g.gl.clear(g.gl.COLOR_BUFFER_BIT);
        
        g.gl.useProgram(g.prog);
        const c = mode === 'live' ? [0.06, 0.72, 0.5] : [0.55, 0.36, 0.96]; // emerald vs violet
        g.gl.uniform3f(g.cLoc, c[0], c[1], c[2]);
        
        g.gl.bindBuffer(g.gl.ARRAY_BUFFER, g.buf);
        g.gl.bufferData(g.gl.ARRAY_BUFFER, new Float32Array(pts), g.gl.DYNAMIC_DRAW);
        g.gl.enableVertexAttribArray(g.pLoc);
        g.gl.vertexAttribPointer(g.pLoc, 2, g.gl.FLOAT, false, 0, 0);
        
        g.gl.drawArrays(g.gl.TRIANGLES, 0, 32 * 6);
      }
      
      if (audioRef.current && isPlaying) {
          // Троттлинг до ~5 Гц: setState на каждом кадре rAF ре-рендерил ноду 60 раз/сек
          const t = audioRef.current.currentTime;
          if (Math.floor(t * 5) !== Math.floor(lastTimeTickRef.current * 5)) {
              lastTimeTickRef.current = t;
              setCurrentTime(t);
          }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode, isPlaying]);

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices()
      .then(d => setDevices(d.filter(x => x.kind === 'audioinput')))
      .catch(() => {});
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && audioRef.current) {
      // Освобождаем предыдущий blob-URL, иначе каждая смена файла утекает в память
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const url = URL.createObjectURL(file);
      blobUrlRef.current = url;
      audioRef.current.src = url;
      setFileName(file.name);
      data.onParamChange(id, 'fileName', file.name);
      setStatus('loading');
      setError(null);
      setIsPlaying(false);
      
      // Auto-play after load
      audioRef.current.oncanplay = () => {
          setStatus('ready');
          audioRef.current?.play().then(() => setIsPlaying(true)).catch(console.error);
      };
    }
  };

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (audioRef.current.paused) {
      audioRef.current.play().then(() => {
          setIsPlaying(true);
          inputAudioManager.initAudio(id).ctx.resume();
      }).catch(e => {
          setError(`Play Blocked: Check Browser Settings`);
          console.error(e);
      });
    } else {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  };

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!audioRef.current) return;
    const time = parseFloat(e.target.value);
    audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  return (
    <div className={`bg-zinc-900 border-2 rounded-2xl p-4 w-72 transition-all duration-300 ${selected ? (mode === 'live' ? 'border-emerald-500 shadow-[0_0_25px_rgba(16,185,129,0.3)]' : 'border-violet-500 shadow-[0_0_25px_rgba(139,92,246,0.3)]') : 'border-zinc-800'}`} onClick={() => inputAudioManager.initAudio(id).ctx.resume()}>
      <audio 
        ref={audioRef} 
        onPlay={() => setIsPlaying(true)} 
        onPause={() => setIsPlaying(false)} 
        onEnded={() => setIsPlaying(false)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
        onCanPlay={() => setStatus('ready')}
        onError={(e) => setError(`File Error: ${(e.target as any).error.code}`)}
        style={{ position: 'absolute', top: 0, left: 0, width: '1px', height: '1px', opacity: 0.01, pointerEvents: 'none' }}
      />
      
      <div className="flex justify-between items-center mb-4">
        <div className="flex gap-1 bg-zinc-950 p-1 rounded-lg border border-zinc-800">
          <button onClick={(e) => { e.stopPropagation(); setMode('file'); data.onParamChange(id, 'mode', 'file'); }} className={`px-3 py-1 rounded-md text-[9px] font-black uppercase transition-all ${mode === 'file' ? 'bg-violet-500 text-black' : 'text-zinc-600'}`}>FILE</button>
          <button onClick={(e) => { e.stopPropagation(); setMode('live'); data.onParamChange(id, 'mode', 'live'); }} className={`px-3 py-1 rounded-md text-[9px] font-black uppercase transition-all ${mode === 'live' ? 'bg-emerald-500 text-black' : 'text-zinc-600'}`}>LIVE</button>
        </div>
        <div className={`px-2 py-1 rounded-lg text-[8px] font-bold border flex items-center gap-1.5 ${mode === 'live' ? 'border-emerald-500/30 text-emerald-500' : 'border-violet-500/30 text-violet-500'}`}>
          {mode === 'live' ? <Mic size={10} /> : <Music size={10} />} {mode.toUpperCase()}
        </div>
      </div>

      <div className="h-24 bg-black rounded-xl border border-zinc-800 mb-4 overflow-hidden relative">
        <canvas ref={canvasRef} width={280} height={96} className="w-full h-full opacity-80" />
        <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 bg-black/50 backdrop-blur-md rounded text-[7px] font-black text-zinc-500 uppercase tracking-tighter">FFT Visualizer</div>
        {error && <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-red-500 text-[8px] font-black uppercase p-4 text-center gap-2"><AlertCircle size={14} />{error}</div>}
      </div>

      <div className="space-y-3">
        {mode === 'file' ? (
          <>
            <button onClick={(e) => { e.stopPropagation(); document.getElementById(`file-${id}`)?.click(); }} className="nodrag nopan w-full py-2 bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 rounded-xl text-[9px] font-black text-zinc-400 hover:text-violet-400 flex items-center justify-center gap-2 transition-all">
              <Music size={12} /> {fileName ? 'CHANGE FILE' : 'SELECT AUDIO'}
            </button>
            <input id={`file-${id}`} type="file" accept="audio/*" onChange={onFileChange} className="hidden" />
            
            {fileName && (
              <div className="bg-zinc-950 p-3 rounded-xl border border-zinc-800 space-y-3">
                <div className="text-[10px] font-bold text-zinc-300 truncate px-1 text-center" title={fileName}>{fileName}</div>
                
                <div className="flex justify-between items-center text-[9px] font-mono text-zinc-500 font-bold px-1">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                </div>
                
                <input 
                    type="range" min={0} max={duration || 1} step={0.1} value={currentTime}
                    onChange={onSeek}
                    onPointerDown={e => e.stopPropagation()}
                    className="nodrag nopan w-full h-2 bg-zinc-800 rounded-full appearance-none accent-violet-500 cursor-pointer"
                />

                <div className="flex gap-2">
                  <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className={`nodrag nopan flex-1 py-2 bg-violet-500 hover:bg-violet-400 text-black rounded-lg flex items-center justify-center active:scale-95 transition-all ${status !== 'ready' ? 'opacity-50' : ''}`}>
                    {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); if(audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; setIsPlaying(false); } }} className="nodrag nopan px-4 py-2 bg-zinc-900 text-zinc-400 hover:text-white rounded-lg transition-all active:scale-95">
                    <Square size={14} fill="currentColor" />
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-2">
            <label className="text-[8px] font-black text-zinc-500 uppercase px-1">Audio Device</label>
            <div className="relative">
              <button 
                onClick={(e) => { e.stopPropagation(); setShowDeviceList(!showDeviceList); }}
                className="nodrag nopan w-full flex items-center justify-between p-3 bg-zinc-950 border border-zinc-800 rounded-xl text-[10px] font-bold text-zinc-300 hover:border-emerald-500/50 transition-colors"
              >
                <span className="truncate pr-4">
                  {selectedDeviceId === 'default' ? 'Default Microphone' : devices.find(d => d.deviceId === selectedDeviceId)?.label || 'Select Device...'}
                </span>
                <ChevronDown size={14} className={`text-zinc-500 transition-transform ${showDeviceList ? 'rotate-180' : ''}`} />
              </button>
              
              {showDeviceList && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden z-50 shadow-2xl max-h-48 overflow-y-auto">
                  <button 
                    onClick={(e) => { e.stopPropagation(); setSelectedDeviceId('default'); data.onParamChange(id, 'deviceId', 'default'); setShowDeviceList(false); }}
                    className={`w-full text-left px-3 py-2 text-[10px] font-bold hover:bg-zinc-800 transition-colors flex items-center justify-between ${selectedDeviceId === 'default' ? 'text-emerald-400 bg-emerald-500/10' : 'text-zinc-400'}`}
                  >
                    Default Microphone
                    {selectedDeviceId === 'default' && <CheckCircle2 size={12} />}
                  </button>
                  {devices.map(d => (
                    <button 
                      key={d.deviceId}
                      onClick={(e) => { e.stopPropagation(); setSelectedDeviceId(d.deviceId); data.onParamChange(id, 'deviceId', d.deviceId); setShowDeviceList(false); }}
                      className={`w-full text-left px-3 py-2 text-[10px] font-bold hover:bg-zinc-800 transition-colors flex items-center justify-between ${selectedDeviceId === d.deviceId ? 'text-emerald-400 bg-emerald-500/10' : 'text-zinc-400'}`}
                    >
                      <span className="truncate pr-2">{d.label || `Device ${d.deviceId.slice(0,5)}`}</span>
                      {selectedDeviceId === d.deviceId && <CheckCircle2 size={12} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            
            <div className="flex items-center gap-2 px-1 pt-2">
                {status === 'loading' ? (
                    <div className="w-2 h-2 rounded-full border-2 border-zinc-600 border-t-emerald-500 animate-spin" />
                ) : status === 'ready' ? (
                    <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981] animate-pulse" />
                ) : (
                    <div className="w-2 h-2 rounded-full bg-zinc-600" />
                )}
                <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">
                    {status === 'loading' ? 'Connecting...' : status === 'ready' ? 'Live Stream Active' : 'Idle'}
                </span>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 px-1">
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[8px] font-black text-zinc-500 uppercase tracking-widest">LED Level</label>
          <span className="text-[9px] font-mono font-bold text-amber-400">x{gain.toFixed(1)}</span>
        </div>
        <input
          type="range" min={0.1} max={10} step={0.1} value={gain}
          onChange={(e) => setGain(parseFloat(e.target.value))}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag nopan w-full h-1.5 bg-zinc-800 rounded-full appearance-none accent-amber-500 cursor-pointer"
        />
      </div>

      <div className="mt-4 pt-4 border-t border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={14} className={signal > 20 ? (mode === 'live' ? 'text-emerald-500' : 'text-violet-500') : 'text-zinc-600'} />
          <div className="w-32 h-1.5 bg-zinc-950 rounded-full overflow-hidden">
            <div 
                className={`h-full transition-all duration-75 ${mode === 'live' ? 'bg-emerald-500' : 'bg-violet-500'}`} 
                style={{ width: `${(signal / 255) * 100}%` }} 
            />
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="low" title="LOW · бас · 20–250 Гц" className={`!w-4 !h-4 !border-[3px] !border-[#050507] !-right-2 !top-[15%] ${mode === 'live' ? '!bg-emerald-500' : '!bg-violet-500'}`} />
      <Handle type="source" position={Position.Right} id="mid" title="MID · середина · 250 Гц – 4 кГц" className={`!w-4 !h-4 !border-[3px] !border-[#050507] !-right-2 !top-[50%] ${mode === 'live' ? '!bg-emerald-500' : '!bg-violet-500'}`} />
      <Handle type="source" position={Position.Right} id="high" title="HIGH · верх · 4–16 кГц" className={`!w-4 !h-4 !border-[3px] !border-[#050507] !-right-2 !top-[85%] ${mode === 'live' ? '!bg-emerald-500' : '!bg-violet-500'}`} />
    </div>
  );
};
