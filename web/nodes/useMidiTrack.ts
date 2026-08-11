/**
 * Хук-контроллер ноды MIDI-трек: ВСЯ логика ноды в одном месте, обе вьюхи
 * (компактная нода на канвасе и модальный редактор) — чистые рендереры
 * поверх этого контроллера (фаза 2 рефакторинга «Режиссуры трека»).
 *
 * Логика перенесена из nodes/MidiTrackNode.tsx дословно: источник трека,
 * транспортные статусы, синхрон со входом звукача, гейты приборов
 * (расчёски/COB/кулисы), загрузка/медиатека, локальные стейты слайдеров
 * и эффективные значения с входов.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useEdges, useNodes } from '@xyflow/react';
import { midiTrackManager } from '../services/midiTrackManager';
import { audioSyncFollower } from '../services/audioSyncFollower';
import { DEFAULT_LIGHT_PARAMS } from '../utils/lightEngine';
import { isWashFixture, isRgbWashFixture } from '../utils/graphEngine';
import { draftFromProfile, mergeDraftWithLocked, mergeAutomation, sectionsFromProfile } from '../utils/scoreCompiler';
import { createScore, type ScoreV1, type AutoTarget } from '../utils/scoreModel';
import type { LuminaNode } from '../types';

export const useMidiTrack = (id: string, data: LuminaNode['data']) => {
  const p = (data.params || {}) as any;
  const onParam = data.onParamChange || (() => {});
  const setParam = useCallback((key: string, val: any) => onParam(id, key, val), [id, onParam]);
  /** Live-мутация params без сериализации графа (драг слайдера). */
  const mutate = useCallback((key: string, val: any) => {
    if (data.params) (data.params as any)[key] = val;
  }, [data.params]);

  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender(v => v + 1), []);

  const [uploading, setUploading] = useState<'audio' | 'analysis' | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [libItems, setLibItems] = useState<any[] | null>(null);
  const [libError, setLibError] = useState<string | null>(null);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const stop = !!p.stop;
  const audioUrl: string | null = p.audioUrl || null;
  const analysisUrl: string | null = p.analysisUrl || null;

  // Локальные копии — чтобы слайдеры не сериализовали весь граф на каждый пиксель.
  const [locBright, setLocBright] = useState(p.brightness ?? DEFAULT_LIGHT_PARAMS.brightness);
  const [locWidth, setLocWidth] = useState(p.width ?? DEFAULT_LIGHT_PARAMS.width);
  const [locRelease, setLocRelease] = useState(p.release ?? DEFAULT_LIGHT_PARAMS.release);
  const [locTilt, setLocTilt] = useState(p.tilt ?? DEFAULT_LIGHT_PARAMS.tilt);
  const [locSecLo, setLocSecLo] = useState(p.tiltMin ?? DEFAULT_LIGHT_PARAMS.tiltMin);
  const [locSecHi, setLocSecHi] = useState(p.tiltMax ?? DEFAULT_LIGHT_PARAMS.tiltMax);
  const [locGamma, setLocGamma] = useState(p.gamma ?? 1.4);
  const [locFlash, setLocFlash] = useState(p.minFlashFrames ?? DEFAULT_LIGHT_PARAMS.minFlashFrames);
  const [locHue, setLocHue] = useState(p.hueShift ?? DEFAULT_LIGHT_PARAMS.hueShift);
  const [locSat, setLocSat] = useState(p.saturation ?? DEFAULT_LIGHT_PARAMS.saturation);
  const [locWashBr, setLocWashBr] = useState(p.washBrightness ?? 1);
  const [locWashFloor, setLocWashFloor] = useState(p.washFloor ?? 0.5);
  const [locBackBr, setLocBackBr] = useState(p.backstageBrightness ?? 1);
  const [locBackFlow, setLocBackFlow] = useState(p.backstageFlow ?? 1);
  const [locBackFloor, setLocBackFloor] = useState(p.backstageFloor ?? 0.35);
  const [locBackWave, setLocBackWave] = useState(p.backstageWave ?? 0.08);
  const [locBackHue, setLocBackHue] = useState(p.backstageHue ?? 0);
  const [locBackSat, setLocBackSat] = useState(p.backstageSaturation ?? 0.9);
  const [seekPos, setSeekPos] = useState<number | null>(null);

  useEffect(() => { setLocBright(p.brightness ?? DEFAULT_LIGHT_PARAMS.brightness); }, [p.brightness]);
  useEffect(() => { setLocWidth(p.width ?? DEFAULT_LIGHT_PARAMS.width); }, [p.width]);
  useEffect(() => { setLocRelease(p.release ?? DEFAULT_LIGHT_PARAMS.release); }, [p.release]);
  useEffect(() => { setLocTilt(p.tilt ?? DEFAULT_LIGHT_PARAMS.tilt); }, [p.tilt]);
  useEffect(() => { setLocSecLo(p.tiltMin ?? DEFAULT_LIGHT_PARAMS.tiltMin); }, [p.tiltMin]);
  useEffect(() => { setLocSecHi(p.tiltMax ?? DEFAULT_LIGHT_PARAMS.tiltMax); }, [p.tiltMax]);
  useEffect(() => { setLocGamma(p.gamma ?? 1.4); }, [p.gamma]);
  useEffect(() => { setLocFlash(p.minFlashFrames ?? DEFAULT_LIGHT_PARAMS.minFlashFrames); }, [p.minFlashFrames]);
  useEffect(() => { setLocHue(p.hueShift ?? DEFAULT_LIGHT_PARAMS.hueShift); }, [p.hueShift]);
  useEffect(() => { setLocSat(p.saturation ?? DEFAULT_LIGHT_PARAMS.saturation); }, [p.saturation]);
  useEffect(() => { setLocWashBr(p.washBrightness ?? 1); }, [p.washBrightness]);
  useEffect(() => { setLocWashFloor(p.washFloor ?? 0.5); }, [p.washFloor]);
  useEffect(() => { setLocBackBr(p.backstageBrightness ?? 1); }, [p.backstageBrightness]);
  useEffect(() => { setLocBackFlow(p.backstageFlow ?? 1); }, [p.backstageFlow]);
  useEffect(() => { setLocBackFloor(p.backstageFloor ?? 0.35); }, [p.backstageFloor]);
  useEffect(() => { setLocBackWave(p.backstageWave ?? 0.08); }, [p.backstageWave]);
  useEffect(() => { setLocBackHue(p.backstageHue ?? 0); }, [p.backstageHue]);
  useEffect(() => { setLocBackSat(p.backstageSaturation ?? 0.9); }, [p.backstageSaturation]);

  // Подписка на состояние транспорта
  useEffect(() => {
    midiTrackManager.onState(id, bump);
    return () => midiTrackManager.offState(id);
  }, [id, bump]);

  // --- Источник трека: ребро track-in от ноды «ТРЕК» перебивает встроенные ---
  const edges = useEdges();
  const flowNodes = useNodes();
  const trackEdge = edges.find(e => e.target === id && e.targetHandle === 'track-in');
  const trackNode = trackEdge ? flowNodes.find(n => n.id === trackEdge.source) : undefined;
  const trackParams: any = trackNode?.data?.params || {};
  const trackLabel: string = trackParams.audioName || trackNode?.data?.label || 'ТРЕК';
  const effAudioUrl = trackNode ? (trackParams.audioUrl ?? null) : audioUrl;
  const effAnalysisUrl = trackNode ? (trackParams.analysisUrl ?? null) : analysisUrl;

  // --- Гейты приборов: провода out-2/out-3 определяют, кого крутит нода ---
  const washFixtures = flowNodes.filter(n =>
    n.type === 'fixture' && isWashFixture((n.data as any)?.params));
  const washWiredIds = new Set(
    edges.filter(e => e.source === id && e.sourceHandle === 'out-2' && e.targetHandle === 'wash-in')
      .map(e => e.target));
  const wiredWash = washFixtures.filter(f => washWiredIds.has(f.id));
  const askWashConnect = useCallback(() => {
    window.dispatchEvent(new CustomEvent('lumina:wash-connect', { detail: { midiNodeId: id } }));
  }, [id]);

  const backstageFixtures = flowNodes.filter(n =>
    n.type === 'fixture' && isRgbWashFixture((n.data as any)?.params)
    && !isWashFixture((n.data as any)?.params));
  const wiredBackstage = backstageFixtures.filter(f => washWiredIds.has(f.id));
  const askBackstageConnect = useCallback(() => {
    window.dispatchEvent(new CustomEvent('lumina:backstage-connect', { detail: { midiNodeId: id } }));
  }, [id]);

  const combFixtures = flowNodes.filter(n =>
    n.type === 'fixture' && (n.data as any)?.params?.fixtureType === 'comb_rgbw');
  const combWiredIds = new Set(
    edges.filter(e => e.source === id && e.sourceHandle === 'out-3' && e.targetHandle === 'comb-in')
      .map(e => e.target));
  const wiredCombs = combFixtures.filter(f => combWiredIds.has(f.id));
  const askCombConnect = useCallback(() => {
    window.dispatchEvent(new CustomEvent('lumina:comb-connect', { detail: { midiNodeId: id } }));
  }, [id]);

  // --- Синхрон со входом звукача (28.07) ---
  const syncOn = !!p.syncOn;
  const [syncState, setSyncState] = useState(() => audioSyncFollower.getState());
  const [syncDevices, setSyncDevices] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => audioSyncFollower.onChange(setSyncState), []);
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices?.()
      .then(ds => setSyncDevices(ds
        .filter(d => d.kind === 'audioinput')
        .map(d => ({ id: d.deviceId, label: d.label || `Вход ${d.deviceId.slice(0, 6)}` }))))
      .catch(() => {});
  }, []);
  const startSync = useCallback(() => {
    if (!effAudioUrl) return;
    midiTrackManager.setMuted(id, true);
    midiTrackManager.play(id);
    audioSyncFollower.start(id, effAudioUrl,
      p.syncDeviceId && p.syncDeviceId !== 'default' ? p.syncDeviceId : undefined,
      p.syncPair === '2' ? 2 : 0);
  }, [id, effAudioUrl, p.syncDeviceId, p.syncPair]);
  const toggleSync = useCallback(() => {
    if (syncOn) {
      audioSyncFollower.stop(id);
      midiTrackManager.setMuted(id, false);
      setParam('syncOn', false);
      return;
    }
    if (!effAudioUrl) { setUploadError('сначала выбери трек — синхре нужен эталон'); return; }
    setParam('syncOn', true);
    startSync();
  }, [syncOn, id, effAudioUrl, setParam, startSync]);
  // Восстановление после перезагрузки страницы / смены трека при включённой синхре
  useEffect(() => {
    if (syncOn && effAudioUrl && audioSyncFollower.attachId !== id) startSync();
  }, [syncOn, effAudioUrl, id, startSync]);
  // Смена устройства/пары каналов на лету — мягкий перезапуск захвата
  useEffect(() => {
    if (syncOn && audioSyncFollower.attachId === id) startSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.syncDeviceId, p.syncPair]);
  // Нода удалена/размонтирована — захват не должен тикать вхолостую
  useEffect(() => () => { audioSyncFollower.stop(id); }, [id]);

  // Синхронизация ссылок на медиа (менеджер идемпотентен)
  useEffect(() => { midiTrackManager.setAudioUrl(id, effAudioUrl); }, [id, effAudioUrl]);
  useEffect(() => { midiTrackManager.setAnalysisUrl(id, effAnalysisUrl); }, [id, effAnalysisUrl]);

  // --- Партитура (score, фаза 4.0) -----------------------------------------
  // params.scoreV1 — авторские данные партитуры; менеджер держит
  // скомпилированный план и следит за отпечатком анализа.
  useEffect(() => {
    midiTrackManager.setScore(id, (p.scoreV1 ?? null) as any);
  }, [id, p.scoreV1]);
  /** Детерминированный черновик из автопрофиля трека (правила в scoreCompiler). */
  const draftScore = useCallback(() => {
    const profile = midiTrackManager.getProfile(id);
    const fp = midiTrackManager.scoreFingerprintNow(id);
    if (!profile || !fp) return;
    const score = draftFromProfile(profile, fp);
    // Синхронно в менеджер: иначе статус в UI отстаёт на один рендер
    // (эффект по params срабатывает после отрисовки — проверено на площадке).
    midiTrackManager.setScore(id, score);
    setParam('scoreV1', score); // персист в проект; эффект выше идемпотентен
    bump();
  }, [id, setParam, bump]);
  const clearScore = useCallback(() => {
    midiTrackManager.setScore(id, null);
    setParam('scoreV1', undefined);
    bump();
  }, [id, setParam, bump]);

  /** Точечная правка партитуры (фаза 4.1): синхронно в менеджер + персист. */
  const updateScore = useCallback((fn: (s: ScoreV1) => ScoreV1) => {
    const cur = p.scoreV1 as ScoreV1 | undefined;
    if (!cur) return;
    const next = fn(cur);
    midiTrackManager.setScore(id, next);
    setParam('scoreV1', next);
    bump();
  }, [id, p.scoreV1, setParam, bump]);
  const deleteCue = useCallback((cueId: string) => {
    updateScore(s => ({ ...s, cues: s.cues.filter(c => c.id !== cueId) }));
  }, [updateScore]);
  const toggleCueLock = useCallback((cueId: string) => {
    updateScore(s => ({
      ...s,
      cues: s.cues.map(c => c.id === cueId ? { ...c, locked: !c.locked } : c),
    }));
  }, [updateScore]);
  /** Пересоздать черновик из профиля: залоченные cue переживают обновление. */
  const redraftScore = useCallback(() => {
    const profile = midiTrackManager.getProfile(id);
    const fp = midiTrackManager.scoreFingerprintNow(id);
    if (!profile || !fp) return;
    const merged = mergeDraftWithLocked(p.scoreV1 ?? null, draftFromProfile(profile, fp));
    midiTrackManager.setScore(id, merged);
    setParam('scoreV1', merged);
    bump();
  }, [id, p.scoreV1, setParam, bump]);

  const status = midiTrackManager.getStatus(id);
  const duration = midiTrackManager.getDuration(id);
  const playing = midiTrackManager.isPlaying(id);
  const curTime = seekPos !== null ? seekPos : midiTrackManager.getTime(id);
  const washKind = midiTrackManager.washKind(id);
  // Что реально идёт в свет: подключённый вход перебивает ползунок.
  const driven = (p._driven || {}) as Record<string, boolean>;
  const effNum = (key: string, loc: number) =>
    typeof p[key] === 'number' ? p[key] as number : loc;
  const effBright = driven.bright ? effNum('_effBright', locBright) : locBright;
  const effWidth = driven.width ? effNum('_effWidth', locWidth) : locWidth;
  const effRelease = driven.release ? effNum('_effRelease', locRelease) : locRelease;
  const effHue = driven.hue ? effNum('_effHue', locHue) : locHue;
  const effSat = driven.sat ? effNum('_effSat', locSat) : locSat;
  const effTilt = driven.tilt ? effNum('_effTilt', locTilt) : locTilt;
  // Цвет верхнего света: может приходить от ноды «Палитра COB»
  const effWashHue = typeof p._effWashHue === 'number' ? p._effWashHue as number : effHue;
  const effWashSat = typeof p._effWashSat === 'number' ? p._effWashSat as number : effSat;
  // Модуляция кулис (входы backstage-*-in перебивают слайдеры секции)
  const effBackBright = typeof p._effBackBright === 'number' ? p._effBackBright as number : locBackBr;
  const effBackHue = typeof p._effBackHue === 'number' ? p._effBackHue as number : locBackHue;
  const effBackSat = typeof p._effBackSat === 'number' ? p._effBackSat as number : locBackSat;

  // --- Запись фейдеров в автоматизацию (фаза 5) ----------------------------
  // ● REC на ноде: пока играет трек, движения слайдеров пишутся кривыми;
  // стоп — overdub-мердж в score.automation (диапазон перезаписывается).
  const [recOn, setRecOn] = useState(false);
  const startRec = useCallback(() => {
    if (!midiTrackManager.isPlaying(id)) return;
    // Нет score — создаём пустой каркас из профиля (секции без cue)
    if (!p.scoreV1) {
      const profile = midiTrackManager.getProfile(id);
      const fp = midiTrackManager.scoreFingerprintNow(id);
      if (!profile || !fp) return;
      const empty = { ...createScore(fp, profile.duration, sectionsFromProfile(profile)), cues: [] };
      midiTrackManager.setScore(id, empty);
      setParam('scoreV1', empty);
    }
    if (midiTrackManager.startScoreRec(id)) setRecOn(true);
  }, [id, p.scoreV1, setParam]);
  const stopRec = useCallback(() => {
    const lanes = midiTrackManager.stopScoreRec(id);
    setRecOn(false);
    const cur = p.scoreV1 as ScoreV1 | undefined;
    if (!cur || lanes.length === 0) return;
    const merged = mergeAutomation(cur, lanes);
    midiTrackManager.setScore(id, merged);
    setParam('scoreV1', merged);
    bump();
  }, [id, p.scoreV1, setParam, bump]);
  const toggleRec = useCallback(() => {
    if (recOn) stopRec(); else startRec();
  }, [recOn, startRec, stopRec]);
  const recPoint = useCallback((target: AutoTarget, v: number) => {
    if (recOn) midiTrackManager.scoreRecPoint(id, target, v);
  }, [id, recOn]);
  // Транспорт встал — запись закрываем (как в DAW)
  useEffect(() => {
    if (recOn && !midiTrackManager.isPlaying(id)) stopRec();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recOn, playing]);
  /** Очистить всю автоматизацию (cue не трогаем). */
  const clearAutomation = useCallback(() => {
    updateScore(s => ({ ...s, automation: undefined }));
  }, [updateScore]);

  // --- Караоке-текст песни (28.07): music2midi -> <трек>.lyrics.json --------
  // Автоподхват из библиотеки (зеркало анализа). ВАЖНО: при СМЕНЕ трека
  // текст ПЕРЕподхватывается, а если к новому треку текста нет — СТИРАЕТСЯ
  // (грабля 28.07: залипший lyricsUrl от старого трека показывал
  // «есть — Бугу.lyrics.json» на Prodigy, файл уже удалён).
  useEffect(() => {
    if (!effAudioUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/stems/list');
        const payload = await res.json();
        const entry = (payload.files || []).find((f: any) => f.audio && f.url === effAudioUrl);
        if (cancelled) return;
        const lyr = entry?.lyrics;
        if (lyr?.url) {
          if (p.lyricsUrl !== lyr.url) {
            setParam('lyricsUrl', lyr.url);
            setParam('lyricsName', lyr.name);
          }
        } else if (p.lyricsUrl || p.lyricsName) {
          setParam('lyricsUrl', null);
          setParam('lyricsName', null);
        }
      } catch { /* библиотека молчит — текст просто не появится */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effAudioUrl]);

  const [lyricsJob, setLyricsJob] = useState<{ id: string; message: string } | null>(null);
  const makeLyrics = useCallback(async () => {
    const stored = (effAudioUrl || '').split('/').pop();
    if (!stored || lyricsJob) return;
    try {
      const hint = typeof p.lyricsHint === 'string' && p.lyricsHint.trim() ? p.lyricsHint.trim() : undefined;
      const res = await fetch('/api/tracks/lyrics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storedName: stored, ...(hint ? { hint } : {}) }),
      });
      const j = await res.json();
      if (!j.jobId) { setLyricsJob(null); setUploadError(j.message || 'lyrics: ошибка старта'); return; }
      setLyricsJob({ id: j.jobId, message: 'стартуем…' });
      const t0 = Date.now();
      const poll = async () => {
        try {
          const r = await fetch(`/api/tracks/lyrics/${j.jobId}`);
          const st = await r.json();
          if (st.status === 'done') {
            const res2 = st.result || {};
            setParam('lyricsUrl', res2.lyricsUrl || null);
            setParam('lyricsName', res2.lyricsName || null);
            setLyricsJob(null);
            bump();
            return;
          }
          if (st.status === 'error') {
            setLyricsJob(null);
            setUploadError(`текст: ${st.message}`);
            return;
          }
          setLyricsJob({ id: j.jobId, message: st.message || '…' });
          if (Date.now() - t0 < 30 * 60 * 1000) setTimeout(poll, 3000);
          else setLyricsJob(null);
        } catch { setTimeout(poll, 5000); }
      };
      setTimeout(poll, 3000);
    } catch (e: any) {
      setLyricsJob(null);
      setUploadError(`текст: ${e?.message || e}`);
    }
  }, [effAudioUrl, lyricsJob, p.lyricsHint, setParam, bump]);

  const upload = useCallback(async (file: File, kind: 'audio' | 'analysis') => {
    setUploading(kind);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Тот же эндпоинт, что и у стемов: дедупликация по sha256 и стабильный
      // url. Blob-URL здесь не годится — он не переживает перезагрузку.
      const res = await fetch('/api/stems/upload', { method: 'POST', body: fd });
      const payload = await res.json();
      if (!res.ok || payload.status !== 'ok') throw new Error(payload.message || 'ошибка загрузки');
      if (kind === 'audio') {
        setParam('audioUrl', payload.url);
        setParam('audioName', payload.fileName);
        // Сервер сам подобрал анализ по basename («Бугу.wav» → «Бугу-анализ.json»)
        if (payload.analysisUrl) {
          setParam('analysisUrl', payload.analysisUrl);
          setParam('analysisName', payload.analysisName);
          setAutoNote(`анализ подхвачен: ${payload.analysisName}`);
        } else {
          setAutoNote(null);
        }
      } else {
        setParam('analysisUrl', payload.url);
        setParam('analysisName', payload.fileName);
      }
    } catch (e: any) {
      setUploadError(e?.message || String(e));
    } finally {
      setUploading(null);
    }
  }, [setParam]);

  const pick = useCallback((accept: string, kind: 'audio' | 'analysis') => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) upload(f, kind);
    };
    input.click();
  }, [upload]);

  // --- Медиатека: настоящие имена вместо sha256, автоподхват анализа ---
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

  const pickFromLibrary = useCallback((f: any) => {
    setParam('audioUrl', f.url);
    setParam('audioName', f.name || f.storedName);
    if (f.analysis) {
      setParam('analysisUrl', f.analysis.url);
      setParam('analysisName', f.analysis.name);
      setAutoNote(`анализ подхвачен: ${f.analysis.name}`);
    } else {
      setAutoNote('к этому аудио анализ не найден — загрузите .json кнопкой выше');
    }
    setLibOpen(false);
    setUploadError(null);
  }, [setParam]);

  return {
    p, setParam, mutate, bump,
    stop, audioUrl, analysisUrl,
    // локальные стейты слайдеров
    locBright, setLocBright, locWidth, setLocWidth, locRelease, setLocRelease,
    locTilt, setLocTilt, locSecLo, setLocSecLo, locSecHi, setLocSecHi,
    locGamma, setLocGamma, locFlash, setLocFlash, locHue, setLocHue,
    locSat, setLocSat, locWashBr, setLocWashBr, locWashFloor, setLocWashFloor,
    locBackBr, setLocBackBr, locBackFlow, setLocBackFlow,
    locBackFloor, setLocBackFloor, locBackWave, setLocBackWave,
    locBackHue, setLocBackHue, locBackSat, setLocBackSat,
    seekPos, setSeekPos,
    // источник
    trackNode, trackLabel, trackParams, effAudioUrl, effAnalysisUrl,
    // приборы и гейты
    washFixtures, wiredWash, askWashConnect,
    backstageFixtures, wiredBackstage, askBackstageConnect,
    combFixtures, wiredCombs, askCombConnect,
    // синхрон
    syncOn, syncState, syncDevices, toggleSync,
    // транспорт/статусы
    status, duration, playing, curTime, washKind,
    // эффективные значения (вход перебивает ползунок)
    driven, effBright, effWidth, effRelease, effHue, effSat, effTilt,
    effWashHue, effWashSat, effBackBright, effBackHue, effBackSat,
    // загрузка/медиатека
    uploading, uploadError, autoNote, libOpen, libItems, libError,
    pick, openLibrary, pickFromLibrary,
    // партитура (score)
    draftScore, clearScore, deleteCue, toggleCueLock, redraftScore,
    recOn, toggleRec, recPoint, clearAutomation,
    // караоке-текст
    lyricsJob, makeLyrics,
    canvasRef,
  };
};

export type MidiTrackController = ReturnType<typeof useMidiTrack>;
