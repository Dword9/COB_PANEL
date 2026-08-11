
import React, { useState, useEffect, useRef } from 'react';
import { Handle, Position, useEdges } from '@xyflow/react';
import { MidiLearnEvent } from '../types';
import { renderRegistry } from '../utils/renderRegistry';

// Helper for loose name matching
const isSameDeviceName = (savedName: string, currentName: string) => {
    if (!savedName || !currentName) return false;
    const clean = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    const s = clean(savedName);
    const c = clean(currentName);
    return s === c || c.includes(s) || s.includes(c);
};

export const MidiNode = ({ data, id, selected }: any) => {
  const [isLearning, setIsLearning] = useState(false);
  const [devices, setDevices] = useState<{ id: string, name: string }[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isMidiSupported, setIsMidiSupported] = useState(true);
  const [permissionStatus, setPermissionStatus] = useState<string>("UNKNOWN");
  const [isMidiReady, setIsMidiReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [debugStatus, setDebugStatus] = useState("INIT...");
  const [lastMidiRaw, setLastMidiRaw] = useState<string>("---");
  
  // Ref for DOM updates
  const valBarRef = useRef<HTMLDivElement>(null);
  const valTextRef = useRef<HTMLSpanElement>(null);
  const lastValRef = useRef(0);
  const autoInitFailed = useRef(false);

  // Default params 
  const params = {
    channel: 1,
    type: 'cc',
    index: 1,
    mode: 'momentary',
    deviceId: 'ALL',
    deviceName: 'All Devices (Omni)',
    group: 0,
    ...data.params
  };

  // useEdges() — реактивная подписка (getEdges() в рендере давал бы устаревший снапшот)
  const edges = useEdges();
  const isConnectedToActivator = edges.some(e => e.source === id && e.target.startsWith('group-activator'));
  const [isActive, setIsActive] = useState(params.isActive ?? true);

  // Registry Update
  useEffect(() => {
    renderRegistry.register(id, (vals: number[]) => {
       const v = vals[0] || 0;
       lastValRef.current = v;
       if (valBarRef.current) {
           valBarRef.current.style.width = `${(v / 255) * 100}%`;
       }
       if (valTextRef.current) {
           valTextRef.current.innerText = String(v);
           valTextRef.current.className = `text-[9px] font-mono font-black ${v > 0 ? 'text-amber-500' : 'text-zinc-600'}`;
       }
    });
    return () => renderRegistry.unregister(id);
  }, [id]);

  // Registry Metadata Listener
  useEffect(() => {
    const handleMetadata = (meta: any) => {
        if (meta.isActive !== undefined) setIsActive(meta.isActive);
    };
    renderRegistry.registerMetadata(id, handleMetadata);
    return () => renderRegistry.unregisterMetadata(id);
  }, [id]);

  // Robust Device Recovery Logic
  useEffect(() => {
    // Check support
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
        setIsMidiSupported(false);
        setDebugStatus("НЕ ПОДДЕРЖИВАЕТСЯ");
    }

    // Check permissions if API exists
    if (typeof navigator !== 'undefined' && (navigator as any).permissions) {
        (navigator as any).permissions.query({ name: 'midi' }).then((status: any) => {
            setPermissionStatus(status.state.toUpperCase());
            status.onchange = () => setPermissionStatus(status.state.toUpperCase());
        }).catch(() => {});
    }

    const checkDevices = () => {
        const ready = !!window.luminaMidi?.isReady;
        setIsMidiReady(ready);

        if (window.luminaMidi?.getStatusString) {
             setDebugStatus(window.luminaMidi.getStatusString());
        } else {
             setDebugStatus(ready ? "READY" : "WAITING");
        }

        if (!ready) {
             // Не ддосим init() после отказа в правах — только по действию пользователя
             if (!autoInitFailed.current && window.luminaMidi && !window.luminaMidi.isReady) {
                 window.luminaMidi.init()
                     .then(ok => { if (!ok) autoInitFailed.current = true; })
                     .catch(() => { autoInitFailed.current = true; });
             }
             return;
        }
        autoInitFailed.current = false;

        const currentDevices = window.luminaMidi!.getDevices();
        
        setDevices(prev => {
            if (prev.length !== currentDevices.length) return currentDevices;
            if (prev.some((d, i) => d.id !== currentDevices[i].id)) return currentDevices;
            return prev;
        });

        if (params.deviceId !== 'ALL' && params.deviceName) {
           const currentIdExists = currentDevices.some(d => d.id === params.deviceId);
           
           if (!currentIdExists) {
              const match = currentDevices.find(d => isSameDeviceName(params.deviceName, d.name));
              if (match) {
                 console.log(`MIDI: Auto-recovered device "${match.name}"`);
                 data.onParamChange(id, 'deviceId', match.id);
                 data.onParamChange(id, 'deviceName', match.name);
                 setIsSearching(false);
              } else {
                 setIsSearching(false); 
              }
           } else {
              setIsSearching(false);
           }
        } else {
           setIsSearching(false);
        }
    };
    
    checkDevices();
    const interval = setInterval(checkDevices, 1500); 
    return () => clearInterval(interval);
  }, [params.deviceId, params.deviceName, id, data]);

  // Monitor Callback (троттлинг: энкодер даёт сотни сообщений в секунду)
  useEffect(() => {
    let lastUpdate = 0;
    const cb = (data: number[], _devId: string) => {
        const now = performance.now();
        if (now - lastUpdate < 100) return;
        lastUpdate = now;
        setLastMidiRaw(`${data.join(' ')}`);
    };
    if (window.luminaMidi) {
        window.luminaMidi.setMonitorCallback(cb);
    }
    return () => {
        window.luminaMidi?.clearMonitorCallback(cb);
    };
  }, []);

  // Learn Mode Handler
  useEffect(() => {
    if (isLearning && window.luminaMidi) {
      window.luminaMidi.setLearnMode((e) => {
        data.onParamChange(id, 'channel', e.channel);
        data.onParamChange(id, 'type', e.type);
        data.onParamChange(id, 'index', e.index);
        data.onParamChange(id, 'deviceId', e.deviceId);
        
        const devs = window.luminaMidi?.getDevices() || [];
        const devMatch = devs.find(d => d.id === e.deviceId);
        data.onParamChange(id, 'deviceName', devMatch?.name || 'Unknown Device');
        
        setIsLearning(false);
      });
    } else if (window.luminaMidi) {
      window.luminaMidi.setLearnMode(null);
    }
    
    return () => {
      if (window.luminaMidi) window.luminaMidi.setLearnMode(null);
    };
  }, [isLearning, id, data]);

  const handleRescan = async () => {
      if (window.luminaMidi) {
          console.log("Forcing manual MIDI rescan...");
          await window.luminaMidi.init();
      }
  };

  const toggleLearn = async () => {
    setErrorMsg(null);
    
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
        setErrorMsg("БРАУЗЕР НЕ ПОДДЕРЖИВАЕТ MIDI");
        setDebugStatus("ОШИБКА API");
        return;
    }

    if (!window.luminaMidi?.isReady) {
       setDebugStatus("ЗАПРОС ДОСТУПА...");
       try {
           const success = await window.luminaMidi?.init();
           if (!success) {
               setErrorMsg("НЕТ ПРАВ");
               setDebugStatus("ОШИБКА ДОСТУПА");
               
               if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
                   setErrorMsg("MIDI ТРЕБУЕТ HTTPS");
               } else {
                   setErrorMsg("ОТКРОЙТЕ В НОВОЙ ВКЛАДКЕ");
               }
               
               setTimeout(() => setErrorMsg(null), 5000);
               return;
           }
       } catch (e) {
           setErrorMsg("ОШИБКА");
           setDebugStatus("КРИТИЧЕСКАЯ ОШИБКА");
           return;
       }
    }
    
    if (window.luminaMidi) {
        setDevices(window.luminaMidi.getDevices());
    }
    
    setIsLearning(!isLearning);
  };

  const handleDeviceChange = (newId: string) => {
     const device = devices.find(d => d.id === newId);
     const name = device?.name || (newId === 'ALL' ? 'All Devices (Omni)' : 'Unknown');
     data.onParamChange(id, 'deviceId', newId);
     data.onParamChange(id, 'deviceName', name);
     setIsSearching(false);
  };

  const isDeviceMissing = isMidiReady && params.deviceId !== 'ALL' && !devices.some(d => d.id === params.deviceId);
  const deviceCount = devices.length;

  return (
    <div className={`bg-zinc-900 border-2 rounded-2xl p-4 w-56 shadow-2xl transition-all duration-300 ${selected ? 'border-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.3)]' : isLearning ? 'border-amber-500 animate-pulse' : isDeviceMissing ? 'border-red-500/50 shadow-red-500/10' : 'border-zinc-800'} ${!isActive ? 'opacity-40 grayscale filter' : ''}`}>
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isMidiReady ? (deviceCount > 0 ? 'bg-amber-500 shadow-[0_0_8px_#f59e0b]' : 'bg-amber-800') : 'bg-zinc-700'}`} />
            <div className="flex flex-col">
                <span className="text-[10px] font-black text-amber-400 uppercase tracking-widest leading-none">MIDI ВХОД</span>
                {!isConnectedToActivator && (
                    <span className="text-[7px] font-black text-zinc-600 uppercase tracking-[0.2em] mt-0.5">GROUP {params.group}</span>
                )}
            </div>
        </div>
        <div className="flex gap-1">
            {permissionStatus === 'PROMPT' && !isMidiReady && (
                <button 
                  onClick={() => window.luminaMidi?.init()}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="nodrag nopan px-2 py-1 rounded bg-amber-500/20 text-amber-500 text-[8px] font-black uppercase hover:bg-amber-500 hover:text-black transition-all"
                >
                  РАЗРЕШИТЬ
                </button>
            )}
            <button 
              onClick={toggleLearn}
              onPointerDown={(e) => e.stopPropagation()}
              className={`nodrag nopan px-3 py-1 rounded text-[8px] font-black uppercase transition-all ${isLearning ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-zinc-800 text-zinc-500 hover:text-white'}`}
            >
              {errorMsg ? errorMsg : (isLearning ? 'ОТМЕНА' : 'LEARN')}
            </button>
        </div>
      </div>

      <div className="space-y-3 mb-4">
        <div className="space-y-1">
            <div className="flex justify-between items-center">
                <label className="text-[7px] font-bold text-zinc-600 uppercase">Устройство</label>
                <div className="flex gap-2">
                    {isSearching && <span className="text-[7px] font-bold text-amber-500 uppercase animate-pulse">Поиск...</span>}
                    <button onClick={handleRescan} onPointerDown={(e) => e.stopPropagation()} className="nodrag nopan text-[9px] hover:text-amber-500 transition-colors" title="Обновить список устройств">⟳</button>
                </div>
            </div>
            <select
                value={params.deviceId}
                onChange={e => handleDeviceChange(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
                disabled={!isMidiReady}
                className={`nodrag nopan w-full bg-zinc-800 text-[9px] font-bold p-1.5 rounded border outline-none truncate transition-colors ${!isMidiReady ? 'border-zinc-800 text-zinc-600 cursor-not-allowed' : isDeviceMissing ? 'border-red-500/50 text-red-400' : 'border-zinc-700 text-amber-400 focus:border-amber-500'}`}
            >
                <option value="ALL">Все устройства (Omni)</option>
                {devices.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                ))}
                {isDeviceMissing && params.deviceName && (
                    <option value={params.deviceId} disabled>{params.deviceName} (Offline)</option>
                )}
            </select>
        </div>

        <div className="flex gap-2">
            <div className="flex-1 space-y-1">
                <label className="text-[7px] font-bold text-zinc-600 uppercase">КАНАЛ</label>
                <input 
                    type="number" min="1" max="16"
                    value={params.channel}
                    onChange={e => { const v = parseInt(e.target.value); data.onParamChange(id, 'channel', isNaN(v) ? 1 : Math.max(1, Math.min(16, v))); }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="nodrag nopan w-full bg-zinc-800 text-amber-400 text-[10px] font-bold p-1 rounded border border-zinc-700 focus:border-amber-500 outline-none"
                />
            </div>
            <div className="flex-1 space-y-1">
                <label className="text-[7px] font-bold text-zinc-600 uppercase">ТИП</label>
                <select
                    value={params.type}
                    onChange={e => data.onParamChange(id, 'type', e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="nodrag nopan w-full bg-zinc-800 text-amber-400 text-[10px] font-bold p-1 rounded border border-zinc-700 focus:border-amber-500 outline-none"
                >
                    <option value="cc">CC</option>
                    <option value="note">NOTE</option>
                    <option value="pitch">PITCH</option>
                </select>
            </div>
            <div className="flex-1 space-y-1">
                <label className="text-[7px] font-bold text-zinc-600 uppercase">ID</label>
                <input 
                    type="number" min="0" max="127"
                    value={params.index}
                    onChange={e => data.onParamChange(id, 'index', parseInt(e.target.value))}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="nodrag nopan w-full bg-zinc-800 text-amber-400 text-[10px] font-bold p-1 rounded border border-zinc-700 focus:border-amber-500 outline-none"
                />
            </div>
        </div>

        {!isConnectedToActivator && (
        <div className="flex items-center justify-between bg-zinc-800/50 p-1.5 rounded-lg border border-zinc-800">
            <span className="text-[8px] font-bold text-zinc-500 uppercase">Группа</span>
            <input 
                type="number" min="0" max="255"
                value={params.group}
                onChange={e => { const v = parseInt(e.target.value); data.onParamChange(id, 'group', isNaN(v) ? 0 : v); }}
                onPointerDown={(e) => e.stopPropagation()}
                title="0 — всегда активна"
                className="nodrag nopan w-12 bg-zinc-900/50 text-amber-400 text-[10px] font-mono font-black text-right p-0.5 rounded outline-none border border-transparent hover:border-zinc-700 focus:border-amber-500 transition-all"
            />
        </div>
        )}

        <div className="flex items-center justify-between bg-zinc-800/50 p-1.5 rounded-lg border border-zinc-800">
            <span className="text-[8px] font-bold text-zinc-500 uppercase">Режим Toggle</span>
            <div 
                onClick={() => data.onParamChange(id, 'mode', params.mode === 'toggle' ? 'momentary' : 'toggle')}
                onPointerDown={(e) => e.stopPropagation()}
                className={`nodrag nopan w-8 h-4 rounded-full p-0.5 cursor-pointer transition-colors ${params.mode === 'toggle' ? 'bg-amber-500' : 'bg-zinc-700'}`}
            >
                <div className={`w-3 h-3 rounded-full bg-white transition-transform ${params.mode === 'toggle' ? 'translate-x-4' : 'translate-x-0'}`} />
            </div>
        </div>
      </div>

      <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden mb-1">
          <div 
            ref={valBarRef}
            className="h-full bg-amber-500 transition-all duration-75 shadow-[0_0_8px_#f59e0b]"
            style={{ width: `${(0 / 255) * 100}%` }}
          />
      </div>
      <div className="flex justify-between items-center">
         <span className="text-[7px] text-zinc-600 font-mono truncate max-w-[120px]">
            {params.type.toUpperCase()} {params.index} @ CH {params.channel}
         </span>
         <span ref={valTextRef} className="text-[9px] font-mono font-black text-zinc-600">0</span>
      </div>
      
      {/* Diagnostic Footer */}
      <div className="mt-2 pt-2 border-t border-zinc-800/50 flex flex-col gap-1 text-[6px] font-mono text-zinc-600">
         <div className="flex justify-between">
            <span>СТАТУС: {debugStatus}</span>
            <span>API: {isMidiSupported ? 'OK' : 'НЕТ'}</span>
         </div>
         <div className="flex justify-between">
            <span>ПРАВА: {permissionStatus}</span>
            <span>УСТР: {deviceCount}</span>
         </div>
         <div className="flex justify-between text-amber-500/50">
            <span>RAW: {lastMidiRaw}</span>
         </div>
         <div className="flex justify-between text-emerald-500/50">
            <span>MATCH: {lastValRef.current}</span>
         </div>
      </div>

      <Handle type="source" position={Position.Right} id="out-0" className="!bg-amber-500 !-right-2 !w-4 !h-4 !border-[3px] !border-[#050507]" />
    </div>
  );
};
