import React, { memo, useState, useEffect, useCallback, useRef } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { LuminaNode } from '../types';

const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

/**
 * ТРЕК — один проанализированный музыкальный трек для ноды MIDI-трек.
 *
 * Закинул MP3 → сервер сам сохраняет его в библиотеку и гоняет через
 * music2midi headless (POST /api/tracks/prepare), а сюда возвращаются
 * аудио + analysis.json + статистика. Дублируешь ноду, жмёшь «Заменить» —
 * новый трек анализируется так же.
 *
 * Подключение: выход out-0 → вход track-in ноды MIDI-трек (источник и
 * транспорт читает она; эта нода только хранит трек).
 */
export const MusicTrackNode: React.FC<NodeProps<LuminaNode>> = ({ id, data, selected }) => {
  const p = (data.params || {}) as any;
  const onParam = data.onParamChange || (() => {});
  const setParam = useCallback((key: string, val: any) => onParam(id, key, val), [id, onParam]);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; msg: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [libItems, setLibItems] = useState<any[] | null>(null);
  const [libError, setLibError] = useState<string | null>(null);
  // Нейросеть анализа: cold (выгружена) / starting (грузится) / warm (готова).
  // Живёт на RTX 4090, час простоя — и сервер сам её выгружает (юзер 27.07).
  const [engine, setEngine] = useState<'cold' | 'starting' | 'warm'>('cold');
  const pollRef = useRef(0); // поколение опроса: смена трека гасит старый poll

  const pollEngine = useCallback(async () => {
    try {
      const r = await fetch('/api/tracks/engine');
      const j = await r.json();
      if (j.status === 'ok') setEngine(j.state);
    } catch { /* сервер недоступен — оставляем как есть */ }
  }, []);

  useEffect(() => {
    pollEngine();
    const t = setInterval(pollEngine, engine === 'starting' ? 3000 : 15000);
    return () => clearInterval(t);
  }, [engine, pollEngine]);

  const warmUp = useCallback(async () => {
    setEngine('starting');
    try {
      await fetch('/api/tracks/engine/warm', { method: 'POST' });
    } catch { /* полл покажет фактическое состояние */ }
    pollEngine();
  }, [pollEngine]);

  const ready = !!(p.audioUrl && p.analysisUrl);

  const applyResult = useCallback((res: any) => {
    setParam('audioUrl', res.audioUrl);
    setParam('audioName', res.audioName);
    setParam('analysisUrl', res.analysisUrl);
    setParam('analysisName', res.analysisName);
    setParam('notes', res.notes || 0);
    setParam('duration', res.duration || 0);
  }, [setParam]);

  const pollJob = useCallback(async (jobId: string) => {
    const gen = ++pollRef.current;
    try {
      for (;;) {
        await new Promise(r => setTimeout(r, 2000));
        if (pollRef.current !== gen) return; // отменён новой загрузкой
        const res = await fetch(`/api/tracks/prepare/${jobId}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.message || 'статус недоступен');
        if (j.status === 'done') { applyResult(j.result); return; }
        if (j.status === 'error') throw new Error(j.message || 'ошибка анализа');
        setProgress({ pct: j.percent || 0, msg: j.message || '' });
      }
    } catch (e: any) {
      if (pollRef.current === gen) setError(e?.message || String(e));
    } finally {
      if (pollRef.current === gen) { setBusy(false); setProgress(null); }
    }
  }, [applyResult]);

  const uploadAndPrepare = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setProgress({ pct: 0, msg: 'Загрузка файла…' });
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/tracks/prepare', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok || j.status !== 'ok') throw new Error(j.message || 'ошибка загрузки');
      // Аудио доступно сразу, анализ догрузится по ходу задачи
      setParam('audioUrl', j.audioUrl);
      setParam('audioName', j.audioName);
      setParam('analysisUrl', null);
      setParam('analysisName', null);
      setParam('notes', 0);
      setParam('duration', 0);
      pollJob(j.jobId);
    } catch (e: any) {
      setError(e?.message || String(e));
      setBusy(false);
      setProgress(null);
    }
  }, [setParam, pollJob]);

  const prepareFromLibrary = useCallback(async (storedName: string) => {
    setBusy(true);
    setError(null);
    setLibOpen(false);
    setProgress({ pct: 0, msg: 'Проверяю анализ…' });
    try {
      const res = await fetch('/api/tracks/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storedName }),
      });
      const j = await res.json();
      if (!res.ok || j.status !== 'ok') throw new Error(j.message || 'ошибка');
      setParam('audioUrl', j.audioUrl);
      setParam('audioName', j.audioName);
      setParam('analysisUrl', null);
      setParam('analysisName', null);
      setParam('notes', 0);
      setParam('duration', 0);
      pollJob(j.jobId);
    } catch (e: any) {
      setError(e?.message || String(e));
      setBusy(false);
      setProgress(null);
    }
  }, [setParam, pollJob]);

  const pickFile = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) uploadAndPrepare(f);
    };
    input.click();
  }, [uploadAndPrepare]);

  const openLibrary = useCallback(async () => {
    if (libOpen) { setLibOpen(false); return; }
    setLibOpen(true);
    setLibItems(null);
    setLibError(null);
    try {
      const res = await fetch('/api/stems/list');
      const payload = await res.json();
      if (!res.ok || payload.status !== 'ok') throw new Error(payload.message || 'ошибка');
      setLibItems((payload.files || []).filter((f: any) => f.audio));
    } catch (e: any) {
      setLibError(e?.message || String(e));
    }
  }, [libOpen]);

  // Статистика для трека, выбранного из медиатеки с готовым анализом:
  // один раз дочитываем json и считаем ноты/длительность
  useEffect(() => {
    if (!p.analysisUrl || (p.notes && p.duration)) return;
    let cancelled = false;
    fetch(p.analysisUrl)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        const notes = (j.tracks || []).reduce((a: number, t: any) => a + (t.notes?.length || 0), 0);
        setParam('notes', notes);
        setParam('duration', j.duration || 0);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [p.analysisUrl, p.notes, p.duration, setParam]);

  return (
    <div className={`bg-[#121214] border-2 rounded-2xl w-60 shadow-2xl flex flex-col transition-all duration-300
      ${selected ? 'border-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.3)]' : 'border-zinc-800'}`}>

      <div className="bg-zinc-900/50 p-3 border-b border-zinc-800 flex items-center gap-2 rounded-t-xl">
        <div className={`w-2 h-2 rounded-full ${ready ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : busy ? 'bg-amber-500 animate-pulse' : 'bg-zinc-600'}`} />
        <span className="text-[10px] font-black text-amber-400 uppercase tracking-widest flex-1">Трек</span>
      </div>

      <div className="p-3 space-y-2 rounded-b-xl">
        {/* Имя трека + статистика */}
        <div className="px-2 py-1.5 rounded bg-zinc-950 border border-zinc-800">
          <div className="text-[11px] font-bold text-zinc-100 truncate" title={p.audioName || ''}>
            {p.audioName ? `♪ ${p.audioName}` : 'Трек не выбран'}
          </div>
          <div className="text-[9px] text-zinc-500 min-h-[12px]">
            {ready && (p.notes || p.duration)
              ? <span className="text-emerald-500">{p.notes} нот · {fmtTime(p.duration)}</span>
              : busy
                ? <span className="text-amber-500">анализируется…</span>
                : p.audioUrl
                  ? <span className="text-zinc-500">анализа нет</span>
                  : <span className="text-zinc-500">mp3/wav → автоанализ</span>}
          </div>
        </div>

        <button onClick={warmUp} disabled={engine !== 'cold'}
          title={engine === 'warm'
            ? 'Модель загружена на RTX 4090; час простоя — и выгрузится сама'
            : engine === 'starting'
              ? 'Модель грузится на RTX 4090 — первый раз это минуты'
              : 'Поднять music2midi заранее: пока выбираешь трек, модель прогреется'}
          className={`nodrag nopan w-full text-left text-xs px-2 py-1.5 rounded transition-colors disabled:cursor-default
            ${engine === 'warm'
              ? 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-400'
              : engine === 'starting'
                ? 'bg-amber-500/10 border border-amber-500/40 text-amber-400 animate-pulse'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200'}`}>
          {engine === 'warm' ? '🧠 нейросеть готова'
            : engine === 'starting' ? '🧠 грузится на 4090…'
              : '🧠 разогреть нейросеть (4090)'}
        </button>

        <button onClick={pickFile} disabled={busy}
          className="nodrag nopan w-full text-left text-xs px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 truncate disabled:opacity-50">
          {busy ? '⏳ идёт анализ…' : `🎵 ${p.audioName ? 'Заменить трек…' : 'Выбрать MP3…'}`}
        </button>
        <button onClick={openLibrary} disabled={busy}
          className="nodrag nopan w-full text-left text-xs px-2 py-1.5 rounded bg-zinc-800/60 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 disabled:opacity-50">
          {libOpen ? '▾ Медиатека (закрыть)' : '▸ Медиатека…'}
        </button>
        {libOpen && (
          <div className="max-h-36 overflow-y-auto rounded border border-zinc-700 bg-zinc-950">
            {libItems === null && !libError &&
              <div className="px-2 py-1.5 text-[10px] text-zinc-500">загрузка списка…</div>}
            {libError &&
              <div className="px-2 py-1.5 text-[10px] text-red-400">{libError}</div>}
            {libItems && libItems.length === 0 &&
              <div className="px-2 py-1.5 text-[10px] text-zinc-600">пусто — загрузите трек кнопкой выше</div>}
            {libItems?.map((f: any) => (
              <button key={f.storedName} onClick={() => prepareFromLibrary(f.storedName)}
                className="w-full text-left px-2 py-1.5 hover:bg-zinc-800 border-b border-zinc-900 last:border-0">
                <div className="text-[10px] font-bold text-zinc-200 truncate">
                  {f.name || `без имени · ${f.storedName.slice(0, 12)}…`}
                </div>
                <div className="text-[8px] flex justify-between gap-2">
                  <span className="text-zinc-500">{(f.size / 1048576).toFixed(1)} МБ</span>
                  {f.analysis
                    ? <span className="text-emerald-500 truncate">📊 готов</span>
                    : <span className="text-amber-500">→ анализировать</span>}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Прогресс пайплайна music2midi */}
        {progress && (
          <div className="space-y-1">
            <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div className="h-full bg-amber-500 transition-all duration-500" style={{ width: `${progress.pct}%` }} />
            </div>
            <div className="text-[9px] text-amber-400/90 leading-tight">{progress.msg}</div>
          </div>
        )}
        {error && <div className="text-[9px] text-red-400 leading-tight">{error}</div>}

        <div className="text-[8px] text-zinc-500 leading-tight">
          Выход справа → во вход «трек» ноды MIDI-трек. Пуск/пауза — там.
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="out-0" title="Трек → MIDI-трек (готовность)"
        style={{ top: '50%' }} className="!bg-amber-400" />
    </div>
  );
};

export default memo(MusicTrackNode);
