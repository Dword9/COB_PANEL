import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Power, Zap, RefreshCw, Settings2, Wifi, WifiOff, Plug } from 'lucide-react';
import { renderRegistry } from '../utils/renderRegistry';

const DEFAULT_URL = 'https://kkz-button.207.174.31.143.sslip.io:8445';
const DEFAULT_PIN = '3033';

// Входной пин (target) для управления с других нод. На строке-переключателе.
const CtrlIn: React.FC<{ id: string; label: string; top: string; active?: boolean }> = ({ id, label, top, active }) => (
  <Handle type="target" position={Position.Left} id={id} title={label}
    style={{ top, left: -14 }}
    className={active ? '!bg-fuchsia-400 shadow-[0_0_8px_#d946ef]' : '!bg-zinc-600'} />
);

interface KkzState {
  on: boolean;
  power_w?: number;
  voltage_v?: number;
  current_ma?: number;
}

export const KkzNode = ({ data, id, selected }: any) => {
  const params = {
    url: DEFAULT_URL,
    pin: DEFAULT_PIN,
    armed: [true, true],
    master: false,
    ...data.params,
  };

  const [url, setUrl] = useState<string>(params.url);
  const [pin, setPin] = useState<string>(params.pin);
  const [showConfig, setShowConfig] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const [states, setStates] = useState<KkzState[]>([]);
  const [armed, setArmed] = useState<boolean[]>(params.armed);
  const [master, setMaster] = useState<boolean>(!!params.master);
  const [flashActive, setFlashActive] = useState(false);
  const [flashTarget, setFlashTarget] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const masterRef = useRef(master);
  const armedRef = useRef(armed);
  const flashTargetRef = useRef<boolean | null>(null);
  const busyRef = useRef(false);
  const urlRef = useRef(url);
  const pinRef = useRef(pin);
  const flashActiveRef = useRef(false);

  masterRef.current = master;
  armedRef.current = armed;
  flashTargetRef.current = flashTarget;
  busyRef.current = busy;
  urlRef.current = url;
  pinRef.current = pin;
  flashActiveRef.current = flashActive;

  const persist = useCallback((key: string, val: any) => {
    data.onParamChange?.(id, key, val);
  }, [data, id]);

  const api = useCallback(async (path: string, opts: RequestInit = {}): Promise<any> => {
    const headers: Record<string, string> = { 'X-Pin': pinRef.current, ...(opts.headers as Record<string, string> || {}) };
    const res = await fetch(`${urlRef.current}${path}`, { ...opts, headers });
    if (res.status === 403) throw new Error('Неверный PIN');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, []);

  const batch = useCallback(async (devices: number[], on: boolean, source: string) => {
    await api('/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices, on, source }),
    });
  }, [api]);

  const armedIndices = useCallback(() =>
    armedRef.current.map((a, i) => (a ? i : -1)).filter(i => i >= 0), []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api('/api/status');
      setStates(Array.isArray(s) ? s : []);
      setConnected(true);
      setError(null);
    } catch (e: any) {
      setConnected(false);
      setError(e?.message || 'status error');
    }
  }, [api]);

  // Первичная загрузка устройств (имена) + статус
  useEffect(() => {
    let alive = true;
    const init = async () => {
      try {
        const cfg = await api('/api/config');
        if (alive) {
          setDevices(cfg.devices || []);
          setArmed(prev => {
            const n = (cfg.devices || []).length;
            if (prev.length === n) return prev;
            const next = new Array(n).fill(true);
            for (let i = 0; i < Math.min(n, prev.length); i++) next[i] = prev[i];
            persist('armed', next);
            return next;
          });
        }
      } catch (e: any) {
        if (alive) { setConnected(false); setError(e?.message || 'config error'); }
      }
      if (alive) loadStatus();
    };
    init();
    const t = setInterval(loadStatus, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [api, loadStatus, persist]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await fn(); } catch (e: any) {
      setConnected(false);
      setError(e?.message || 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const toggleDevice = useCallback(async (i: number) => {
    await run(async () => {
      const cur = armedRef.current;
      const next = [...cur];
      if (next[i]) {
        next[i] = false;
        setArmed(next);
        persist('armed', next);
        await batch([i], false, 'main');
      } else {
        next[i] = true;
        setArmed(next);
        persist('armed', next);
        await batch([i], masterRef.current, 'main');
      }
      loadStatus();
    });
  }, [run, batch, loadStatus, persist]);

  const setMasterState = useCallback(async (on: boolean) => {
    await run(async () => {
      setMaster(on);
      persist('master', on);
      const idx = armedIndices();
      if (idx.length) await batch(idx, on, 'main');
      loadStatus();
    });
  }, [run, batch, loadStatus, persist, armedIndices]);

  const flashPress = useCallback(() => {
    if (flashActiveRef.current) return;
    const idx = armedIndices();
    flashActiveRef.current = true;
    setFlashActive(true);
    if (!idx.length) return;
    const target = !masterRef.current;
    flashTargetRef.current = target;
    setFlashTarget(target);
    batch(idx, target, 'flash').catch(() => {});
  }, [batch, armedIndices]);

  const flashRelease = useCallback(() => {
    if (!flashActiveRef.current) return;
    flashActiveRef.current = false;
    setFlashActive(false);
    const idx = armedIndices();
    const target = flashTargetRef.current;
    flashTargetRef.current = null;
    setFlashTarget(null);
    if (!idx.length || target === null) return;
    batch(idx, !target, 'flash').catch(() => {});
    loadStatus();
  }, [batch, armedIndices, loadStatus]);

  // --- Входы управления с других нод (звук/таймер/LFO) -------------------
  // Движок шлёт [master, dev0, dev1] каждый кадр; тут сравниваем с прошлым
  // значением и шлём HTTP ТОЛЬКО по фронту 0↔1 (грабля: автоматы Tuya
  // работают секундами, молотить их каждым кадром нельзя).
  const [inActive, setInActive] = useState<[boolean, boolean, boolean]>([false, false, false]);
  const prevIn = useRef<[number, number, number]>([-1, -1, -1]);

  useEffect(() => {
    renderRegistry.register(id, (vals: any) => {
      const v: [number, number, number] = Array.isArray(vals) && vals.length >= 3
        ? [vals[0], vals[1], vals[2]]
        : [-1, -1, -1];
      const prev = prevIn.current;
      const next: [boolean, boolean, boolean] = [
        v[0] !== prev[0],
        v[1] !== prev[1],
        v[2] !== prev[2],
      ];
      prevIn.current = v;
      if (!next[0] && !next[1] && !next[2]) return;

      setInActive([v[0] >= 0, v[1] >= 0, v[2] >= 0]);

      const send = (devices: number[], on: boolean, src: string) => {
        if (!devices.length) return Promise.resolve();
        return batch(devices, on, src).catch(() => { setConnected(false); setError('in-command failed'); });
      };

      // Вход master-in: ВКЛ все armed / ВЫКЛ все armed (как кнопка мастера)
      if (next[0] && v[0] >= 0) {
        const on = v[0] > 127;
        setMaster(on);
        persist('master', on);
        send(armedRef.current.map((a, i) => (a ? i : -1)).filter(i => i >= 0), on, 'in');
      }
      // Входы dev-N-in: прямое вкл/выкл конкретного автомата
      if (next[1] && v[1] >= 0) send([0], v[1] > 127, 'in');
      if (next[2] && v[2] >= 0) send([1], v[2] > 127, 'in');
    });
    return () => renderRegistry.unregister(id);
  }, [id, batch, persist]);

  const applyConfig = () => {
    const u = url.trim().replace(/\/+$/, '');
    if (!u) return;
    persist('url', u);
    persist('pin', pin.trim());
    setUrl(u);
    setPin(pin.trim());
    setShowConfig(false);
    loadStatus();
  };

  return (
    <div className={`bg-zinc-900 border-2 rounded-2xl p-4 w-72 shadow-2xl transition-all duration-300 ${selected ? 'border-fuchsia-500 shadow-[0_0_25px_rgba(217,70,239,0.25)]' : 'border-zinc-800'}`}>
      <div className="flex justify-between items-start mb-3">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500 shadow-[0_0_8px_#10b981] animate-pulse' : 'bg-zinc-700'}`} />
          <span className="text-[10px] font-black text-fuchsia-400 uppercase tracking-widest leading-tight">KKZ ПУЛЬТ</span>
        </div>
        <div className="flex items-center gap-1">
          {connected ? <Wifi size={11} className="text-emerald-500" /> : <WifiOff size={11} className="text-red-500" />}
          <button
            onClick={(e) => { e.stopPropagation(); setShowConfig(!showConfig); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag nopan px-1.5 py-0.5 rounded text-[7px] font-black uppercase transition-all bg-zinc-800 text-zinc-500 hover:text-zinc-300"
            title="Настройки"
          >
            <Settings2 size={10} />
          </button>
        </div>
      </div>

      {showConfig && (
        <div className="mb-3 space-y-2 bg-zinc-950 border border-zinc-800 rounded-xl p-3">
          <div>
            <label className="text-[7px] font-bold text-zinc-600 uppercase block mb-1">URL сервера</label>
            <input
              type="text" value={url} onChange={e => setUrl(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag nopan w-full bg-zinc-800 text-fuchsia-300 text-[9px] font-bold p-1.5 rounded border border-zinc-700 focus:border-fuchsia-500 outline-none"
            />
          </div>
          <div>
            <label className="text-[7px] font-bold text-zinc-600 uppercase block mb-1">PIN (X-Pin)</label>
            <input
              type="password" value={pin} onChange={e => setPin(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag nopan w-full bg-zinc-800 text-fuchsia-300 text-[9px] font-bold p-1.5 rounded border border-zinc-700 focus:border-fuchsia-500 outline-none"
            />
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); applyConfig(); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag nopan w-full py-1.5 bg-fuchsia-500/20 hover:bg-fuchsia-500/30 text-fuchsia-300 rounded-lg text-[8px] font-black uppercase transition-all"
          >
            Подключить
          </button>
        </div>
      )}

      <div className="space-y-1.5 mb-3">
        {devices.length === 0 && !error && (
          <div className="text-[9px] text-zinc-600 font-bold text-center py-3">Загрузка устройств...</div>
        )}
        {devices.map((name, i) => {
          const st = states[i];
          const isOn = !!st?.on;
          const isArmed = armed[i] !== false;
          return (
            <div key={i} className={`flex items-center gap-2 p-2 rounded-xl border ${isArmed ? 'border-zinc-700' : 'border-zinc-800 opacity-60'} bg-zinc-950`}>
              <div
                onClick={() => toggleDevice(i)}
                onPointerDown={(e) => e.stopPropagation()}
                className={`nodrag nopan relative w-9 h-5 rounded-full transition-colors ${isArmed ? 'bg-fuchsia-500' : 'bg-zinc-700'}`}
                title={isArmed ? 'Включён в группу' : 'Отключён от группы'}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${isArmed ? 'left-4' : 'left-0.5'}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-[9px] font-bold truncate ${isOn ? 'text-emerald-400' : 'text-zinc-400'}`}>{name}</div>
                <div className="text-[8px] font-mono text-zinc-600">
                  {st ? `${st.on ? 'ВКЛ' : 'ВЫКЛ'} · ${st.power_w ?? '-'} Вт · ${st.current_ma ?? '-'} мА` : 'нет данных'}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setMasterState(!master)}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={busy}
          className={`nodrag nopan flex-1 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${master ? 'bg-emerald-500 text-black' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
          title="Мастер: включить/выключить включённые автоматы"
        >
          <Power size={11} className="inline mr-1" /> МАСТЕР {master ? 'ВКЛ' : 'ВЫКЛ'}
        </button>
      </div>

      <button
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); flashPress(); }}
        onPointerUp={(e) => { e.preventDefault(); e.stopPropagation(); flashRelease(); }}
        onPointerCancel={(e) => { e.preventDefault(); e.stopPropagation(); flashRelease(); }}
        onPointerLeave={(e) => { e.preventDefault(); e.stopPropagation(); flashRelease(); }}
        onContextMenu={(e) => e.preventDefault()}
        className={`nodrag nopan w-full py-3.5 rounded-xl text-[10px] font-black tracking-[0.15em] transition-all select-none touch-none ${flashActive ? 'bg-red-500 text-white scale-95 shadow-[0_0_30px_rgba(239,68,68,0.5)]' : 'bg-red-900/60 text-red-300 hover:bg-red-800/60'}`}
        title="ФЛЕШ: пока держишь — инверсия мастера для включённых автоматов"
      >
        <Zap size={12} className="inline mr-1" /> BANG! BANG! BANG!!!
      </button>

      <div className="mt-3 flex items-center justify-between">
        <span className={`text-[7px] font-bold uppercase ${error ? 'text-red-500' : connected ? 'text-zinc-600' : 'text-zinc-700'}`}>
          {error ? error : connected ? 'связь OK' : 'нет связи'}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); loadStatus(); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag nopan px-1.5 py-0.5 rounded text-[7px] font-black uppercase transition-all bg-zinc-800 text-zinc-500 hover:text-zinc-300"
          title="Обновить статус"
        >
          <RefreshCw size={9} />
        </button>
      </div>

      {/* Входы управления с других нод (звук/таймер/LFO): слева по краю.
          Значения 0-255, порог 128: >127 = ВКЛ, <=127 = ВЫКЛ. Команда
          уходит только при переходе. */}
      <div className="mt-3 pt-2 border-t border-zinc-800 flex items-center justify-between text-[8px] font-bold text-zinc-500">
        <span className="flex items-center gap-1">
          <Plug size={8} className={inActive[0] ? 'text-fuchsia-400' : 'text-zinc-700'} />
          УПР. ВХОДЫ
        </span>
        <div className="flex gap-2 text-zinc-600">
          <span className={inActive[1] ? 'text-fuchsia-400' : ''}>авт.1</span>
          <span className={inActive[2] ? 'text-fuchsia-400' : ''}>авт.2</span>
        </div>
      </div>
      <CtrlIn id="dev-0-in" label="Вход: автомат 1 — прямое вкл/выкл (0-255)" top="62%" active={inActive[1]} />
      <CtrlIn id="dev-1-in" label="Вход: автомат 2 — прямое вкл/выкл (0-255)" top="74%" active={inActive[2]} />
      <CtrlIn id="master-in" label="Вход: главный — ВКЛ/ВЫКЛ всех включённых автоматов (0-255)" top="86%" active={inActive[0]} />
    </div>
  );
};