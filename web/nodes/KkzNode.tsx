import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Power, Zap, RefreshCw, Settings2, Wifi, WifiOff, Plug } from 'lucide-react';
import { renderRegistry } from '../utils/renderRegistry';
import { kkzFetch, KKZ_URL, KKZ_PIN } from '../electron/kkz-client.mjs';

// Вход управления с другой ноды: строка с пином слева по краю (как на
// MIDI-треке/палитре). Подпись привязана к строке — не «висит в воздухе».
const CtrlRow: React.FC<{
  id: string; label: string; active?: boolean;
  pinClass?: string; glow?: string; activeText?: string;
}> = ({ id, label, active, pinClass = '!bg-sky-400', glow = '#38bdf8', activeText = 'text-fuchsia-400' }) => (
  <div className="relative flex items-center gap-2 py-0.5">
    <Handle type="target" position={Position.Left} id={id} title={label}
      style={{ top: '50%', left: -14, boxShadow: active ? `0 0 8px ${glow}` : undefined }}
      className={pinClass} />
    <span className={`text-[9px] truncate flex-1 ${active ? activeText : 'text-zinc-500'}`}>{label}</span>
  </div>
);

interface KkzState {
  on: boolean;
  power_w?: number;
  voltage_v?: number;
  current_ma?: number;
}

export const KkzNode = ({ data, id, selected }: any) => {
  const params = {
    url: KKZ_URL,
    pin: KKZ_PIN,
    master: false,
    ...data.params,
  };

  const [url, setUrl] = useState<string>(params.url);
  const [pin, setPin] = useState<string>(params.pin);
  const [showConfig, setShowConfig] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const [states, setStates] = useState<KkzState[]>([]);
  const [master, setMaster] = useState<boolean>(!!params.master);
  const [flashActive, setFlashActive] = useState(false);
  const [flashTarget, setFlashTarget] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const masterRef = useRef(master);
  const devicesRef = useRef<string[]>([]);
  const statesRef = useRef<KkzState[]>([]);
  const flashTargetRef = useRef<boolean | null>(null);
  const busyRef = useRef(false);
  const urlRef = useRef(url);
  const pinRef = useRef(pin);
  const flashActiveRef = useRef(false);

  masterRef.current = master;
  devicesRef.current = devices;
  statesRef.current = states;
  flashTargetRef.current = flashTarget;
  busyRef.current = busy;
  urlRef.current = url;
  pinRef.current = pin;
  flashActiveRef.current = flashActive;

  const persist = useCallback((key: string, val: any) => {
    data.onParamChange?.(id, key, val);
  }, [data, id]);

  // HTTP-клиент общий с треем — kkz-client.mjs (таймаут 4с, 403 → «Неверный
  // PIN»). URL/PIN берём из текущего состояния ноды (можно менять в настройках).
  const api = useCallback(async (path: string, opts: RequestInit = {}): Promise<any> => {
    const body = opts.body !== undefined
      ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body)
      : undefined;
    return kkzFetch(urlRef.current, path, {
      method: opts.method || 'GET',
      pin: pinRef.current,
      body,
      headers: opts.headers as Record<string, string> | undefined,
    });
  }, []);

  const batch = useCallback(async (devices: number[], on: boolean, source: string) => {
    await api('/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices, on, source }),
    });
  }, [api]);

  // Все реле пульта (для master/off — «свет зала» целиком; стабильный таргет
  // для паттернов-миганий, не зависит от текущей физики).
  const allIndices = useCallback(() =>
    devicesRef.current.map((_, i) => i), []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api('/api/status');
      const arr = Array.isArray(s) ? s : [];
      setStates(arr);
      statesRef.current = arr;
      setConnected(true);
      setError(null);
      // Тумблеры рисуются прямо из states (факт) — локальной памяти нет.
    } catch (e: any) {
      setConnected(false);
      setError(e?.message || 'status error');
    }
  }, [api]);

  // Физически горящие реле (из последнего опроса) — для ФЛЕШ (инверсия того,
  // что горит) и одиночных команд.
  const physOnIndices = useCallback(() =>
    statesRef.current.map((st, i) => (st?.on ? i : -1)).filter(i => i >= 0), []);

  // Первичная загрузка устройств (имена) + статус
  useEffect(() => {
    let alive = true;
    const init = async () => {
      try {
        const cfg = await api('/api/config');
        if (alive) setDevices(cfg.devices || []);
      } catch (e: any) {
        if (alive) { setConnected(false); setError(e?.message || 'config error'); }
      }
      if (alive) loadStatus();
    };
    init();
    const t = setInterval(loadStatus, 5000);
    // Chromium throttles background timers to ~1/min when the window is
    // hidden in the tray; poll immediately when the window becomes visible.
    const onVis = () => { if (document.visibilityState === 'visible') loadStatus(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [api, loadStatus]);

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
      // Тумблер = ФАКТ из последнего опроса. Клик = прямая команда реле.
      const st = statesRef.current[i];
      const on = !(st?.on ?? false);
      await batch([i], on, 'main');
      loadStatus();
    });
  }, [run, batch, loadStatus]);

  const setMasterState = useCallback(async (on: boolean) => {
    await run(async () => {
      setMaster(on);
      persist('master', on);
      // ГП = «свет зала» целиком: ВКЛ/ВЫКЛ ВСЕХ реле. Стабильный таргет —
      // паттерны-мигания с него работают независимо от текущей физики,
      // а внешнее включение (телефон) тоже гасится (баг 16.08).
      const idx = allIndices();
      if (idx.length) await batch(idx, on, 'main');
      loadStatus();
    });
  }, [run, batch, loadStatus, persist, allIndices]);

  const flashPress = useCallback(() => {
    if (flashActiveRef.current) return;
    const idx = physOnIndices();
    flashActiveRef.current = true;
    setFlashActive(true);
    if (!idx.length) return;
    const target = !masterRef.current;
    flashTargetRef.current = target;
    setFlashTarget(target);
    batch(idx, target, 'flash').catch(() => {});
  }, [batch, physOnIndices]);

  const flashRelease = useCallback(() => {
    if (!flashActiveRef.current) return;
    flashActiveRef.current = false;
    setFlashActive(false);
    const idx = physOnIndices();
    const target = flashTargetRef.current;
    flashTargetRef.current = null;
    setFlashTarget(null);
    if (!idx.length || target === null) return;
    batch(idx, !target, 'flash').catch(() => {});
    loadStatus();
  }, [batch, physOnIndices, loadStatus]);

  // --- Входы управления с других нод (звук/таймер/LFO) -------------------
  // Движок шлёт [master, dev0, dev1] каждый кадр; тут сравниваем с прошлым
  // значением и шлём HTTP ТОЛЬКО по фронту 0↔1 (грабля: автоматы Tuya
  // работают секундами, молотить их каждым кадром нельзя).
  const [inActive, setInActive] = useState<[boolean, boolean, boolean, boolean]>([false, false, false, false]);
  const prevIn = useRef<[number, number, number, number]>([-1, -1, -1, -1]);

  useEffect(() => {
    renderRegistry.register(id, (vals: any) => {
      const a = Array.isArray(vals) ? vals : [];
      const v: [number, number, number, number] = a.length >= 4
        ? [a[0], a[1], a[2], a[3]]
        : a.length >= 3
          ? [a[0], a[1], a[2], -1]
          : [-1, -1, -1, -1];
      const prev = prevIn.current;
      const next: [boolean, boolean, boolean, boolean] = [
        v[0] !== prev[0],
        v[1] !== prev[1],
        v[2] !== prev[2],
        v[3] !== prev[3],
      ];
      prevIn.current = v;
      if (!next[0] && !next[1] && !next[2] && !next[3]) return;

      setInActive([v[0] >= 0, v[1] >= 0, v[2] >= 0, v[3] >= 0]);

      const send = (devices: number[], on: boolean, src: string) => {
        if (!devices.length) return Promise.resolve();
        return batch(devices, on, src).catch(() => { setConnected(false); setError('in-command failed'); });
      };

      // Вход master-in: ВКЛ/ВЫКЛ всех реле (свет зала; паттерн-мигание — по
      // каждому фронту: >127 = ВКЛ, ≤127 = ВЫКЛ)
      if (next[0] && v[0] >= 0) {
        const on = v[0] > 127;
        setMaster(on);
        persist('master', on);
        send(allIndices(), on, 'in');
      }
      // Входы dev-N-in: прямое вкл/выкл конкретного автомата
      if (next[1] && v[1] >= 0) send([0], v[1] > 127, 'in');
      if (next[2] && v[2] >= 0) send([1], v[2] > 127, 'in');
      // Вход off-in: фронт 0→255 = выключить все реле (конец трека, 16.08).
      // Падает обратно в 0 (трек закончился) — повторной команды нет.
      if (next[3] && v[3] > 127) {
        setMaster(false);
        persist('master', false);
        send(allIndices(), false, 'in');
      }
    });
    return () => renderRegistry.unregister(id);
  }, [id, batch, persist, allIndices]);

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
    <div className={`bg-zinc-900 border-2 rounded-2xl p-4 w-48 shadow-2xl transition-all duration-300 ${selected ? 'border-fuchsia-500 shadow-[0_0_25px_rgba(217,70,239,0.25)]' : 'border-zinc-800'}`}>
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
          return (
            <div key={i} className={`flex items-center gap-2 p-2 rounded-xl border ${isOn ? 'border-zinc-700' : 'border-zinc-800 opacity-60'} bg-zinc-950`}>
              <div
                onClick={() => toggleDevice(i)}
                onPointerDown={(e) => e.stopPropagation()}
                className={`nodrag nopan relative w-9 h-5 rounded-full transition-colors ${isOn ? 'bg-fuchsia-500' : 'bg-zinc-700'}`}
                title={isOn ? 'Включён — нажми, чтобы выключить' : 'Выключен — нажми, чтобы включить'}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${isOn ? 'left-4' : 'left-0.5'}`} />
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

      {/* Входы управления с других нод (звук/таймер/LFO): строки с пинами
          слева по краю — как у MIDI-трека/палитры. Значения 0-255, порог
          128: >127 = ВКЛ, <=127 = ВЫКЛ. Команда уходит только при переходе. */}
      <div className="mt-3 pt-2 border-t border-zinc-800 space-y-0.5">
        <div className="flex items-center gap-2 text-[8px] font-bold text-zinc-500 pb-1">
          <Plug size={8} className={inActive[0] ? 'text-fuchsia-400' : 'text-zinc-700'} />
          УПР. ВХОДЫ
        </div>
        <CtrlRow id="dev-0-in" label="автомат 1: вкл/выкл" active={inActive[1]}
          pinClass="!bg-sky-400" glow="#38bdf8" activeText="text-sky-400" />
        <CtrlRow id="dev-1-in" label="автомат 2: вкл/выкл" active={inActive[2]}
          pinClass="!bg-sky-400" glow="#38bdf8" activeText="text-sky-400" />
        <CtrlRow id="master-in" label="главный: вкл/выкл" active={inActive[0]}
          pinClass="!bg-fuchsia-400" glow="#d946ef" activeText="text-fuchsia-400" />
        <CtrlRow id="off-in" label="ВЫКЛ всех (фронт 0→255)" active={inActive[3]}
          pinClass="!bg-red-400" glow="#f87171" activeText="text-red-400" />
      </div>
    </div>
  );
};