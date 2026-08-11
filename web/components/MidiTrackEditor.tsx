/**
 * Модальный редактор ноды MIDI-трек (фаза 2 рефакторинга «Режиссуры»).
 *
 * На канвасе остаётся компактная нода (транспорт, превью, живые слайдеры,
 * пины входов). Сюда переехали детальные настройки: источник/медиатека,
 * режимы лучей, границы наклона, COB, кулисы, вывод. Редактор — ЧИСТАЯ
 * вьюха поверх контроллера useMidiTrack: тот же params, тот же setParam,
 * никакого второго состояния.
 *
 * Рендерится порталом из MidiTrackNode → контекст React Flow доступен,
 * при удалении ноды модалка исчезает вместе с ней.
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_LIGHT_PARAMS } from '../utils/lightEngine';
import { SECTION_LABEL } from '../utils/trackProfile';
import { midiTrackManager } from '../services/midiTrackManager';
import type { MidiTrackController } from '../nodes/useMidiTrack';
import {
  Slider, Segmented, fmtTime, tiltWord,
  PALETTES, LEVELS, POS_MODES,
} from '../nodes/midiTrackShared';

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
    <div className="text-[10px] uppercase tracking-wide text-zinc-400 font-bold">{title}</div>
    {children}
  </div>
);

/** Секция «Проекции»: режимы вывода /visual на дисплеи проекторов (28.07).
 *  В Electron-шелле — IPC к main.cjs (окна сами встанут на ОТМЕЧЕННЫЕ
 *  дисплеи, белый список в настройках шелла); в браузере — fallback:
 *  два popup-окна, которые тащишь руками. */
const VisualSection: React.FC<{ c: MidiTrackController }> = ({ c }) => {
  const { p, setParam } = c;
  const mode = p.visualMode || 'clone';
  const [info, setInfo] = useState<{ total: number; selected: string[]; open: number;
    displays: Array<{ key: string; label: string; bounds: { x: number; y: number; w: number; h: number }; primary: boolean; selected: boolean }> } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const desktop = (window as any).luminaDesktop;
  const refresh = async () => {
    if (!desktop?.visualDisplays) return;
    try { setInfo(await desktop.visualDisplays()); } catch { setInfo(null); }
  };
  useEffect(() => { refresh(); }, []);
  const toggleDisplay = async (key: string, on: boolean) => {
    if (!desktop?.visualSetDisplays || !info) return;
    const next = on ? [...new Set([...info.selected, key])] : info.selected.filter(k => k !== key);
    await desktop.visualSetDisplays(next);
    refresh();
  };
  const MODES: Array<{ id: string; label: string; hint: string }> = [
    { id: 'clone', label: 'Клон', hint: 'одно и то же на оба' },
    { id: 'mirror', label: 'Зеркало', hint: 'левый кадр отражён — симметрия' },
    { id: 'duet', label: 'Дуэт', hint: 'разные сцены L/R + энергия своей стороны' },
    { id: 'wide', label: 'Панорама', hint: 'одно окно на два дисплея — непрерывная картинка' },
  ];
  const open = async () => {
    setNote(null);
    if (desktop?.visualOpen) {
      const res = await desktop.visualOpen(mode);
      if (!res?.ok) setNote('не отмечено ни одного дисплея проектора (галочки выше)');
      refresh();
      return;
    }
    // Браузер: два окна — тащим на проекторы руками + F11
    window.open(`/visual?side=L&mode=${mode}`, '_blank');
    window.open(`/visual?side=R&mode=${mode}`, '_blank');
    setNote('открыты 2 окна — перетащи на проекторы и жми F11 в каждом');
  };
  return (
    <Section title="Проекции (/visual)">
      <div className="grid grid-cols-4 gap-1">
        {MODES.map(m => (
          <button key={m.id} onClick={() => setParam('visualMode', m.id)}
            title={m.hint}
            className={`text-[10px] py-1 rounded font-bold ${mode === m.id ? 'bg-emerald-500 text-black' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'}`}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="text-[9px] text-zinc-500 leading-tight">
        {MODES.find(m => m.id === mode)?.hint}. Сцена и энергия — от MIDI-трека,
        цвет — общий со светом. На паузе/стопе — плавный уход в темноту.
      </div>
      {/* Белый список дисплеев: окна встают ТОЛЬКО на отмеченные (28.07 —
          иначе окна лезли на рабочие мониторы ASUS/AOC и стену) */}
      {desktop && info && (
        <div className="space-y-0.5">
          {info.displays.map(d => (
            <label key={d.key} className={`flex items-center gap-1.5 text-[9px] px-1 py-0.5 rounded cursor-pointer
              ${d.primary ? 'opacity-45 pointer-events-none' : 'hover:bg-zinc-800/60'}`}>
              <input type="checkbox" className="accent-indigo-500" disabled={d.primary}
                checked={d.primary ? false : d.selected}
                onChange={e => toggleDisplay(d.key, e.target.checked)} />
              <span className={d.selected ? 'text-zinc-200' : 'text-zinc-500'}>
                {d.label} <span className="text-zinc-600">{d.bounds.w}×{d.bounds.h} @ {d.bounds.x},{d.bounds.y}</span>
              </span>
              {d.primary && <span className="text-zinc-600">(основной)</span>}
            </label>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <button onClick={open}
          className="flex-1 py-1.5 rounded bg-indigo-600/80 hover:bg-indigo-500 text-black text-[10px] font-bold">
          🖥 Вывести на проекторы
        </button>
        {desktop?.visualClose && (info?.open ?? 0) > 0 && (
          <button onClick={async () => { await desktop.visualClose(); refresh(); }}
            className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300">
            Закрыть
          </button>
        )}
      </div>
      <div className="text-[9px] leading-tight">
        {note && <span className="text-amber-400">{note}</span>}
        {!note && desktop && info && (
          <span className={info.selected.length > 0 ? 'text-emerald-500' : 'text-amber-400'}>
            {info.selected.length > 0
              ? `отмечено дисплеев: ${info.selected.length}${info.open > 0 ? ` · открыто окон: ${info.open}` : ''}`
              : 'отметь галочками дисплеи двух проекторов (они подключены — видны выше)'}
          </span>
        )}
        {!note && !desktop && (
          <span className="text-zinc-500">открыто в браузере — окна на проекторы тащатся руками</span>
        )}
      </div>
    </Section>
  );
};

export const MidiTrackEditor: React.FC<{
  nodeId: string;
  c: MidiTrackController;
  onClose: () => void;
}> = ({ nodeId, c, onClose }) => {
  const { p, setParam, mutate } = c;

  // Esc закрывает; клавиши внутри модалки не должны дёргать шорткаты канваса.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[700px] max-w-[92vw] max-h-[90vh] overflow-y-auto rounded-xl border border-zinc-700
                      bg-zinc-950 text-zinc-100 shadow-2xl"
        onKeyDown={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
          <span className="text-emerald-400">♪</span>
          <span className="font-bold text-sm flex-1">Редактор MIDI-трека</span>
          <span className="text-[10px] text-zinc-500 truncate max-w-[300px]">
            {c.trackNode ? `источник: ${c.trackLabel}` : (p.audioName || 'трек не выбран')}
          </span>
          <button onClick={onClose}
            className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">✕ Закрыть</button>
        </div>

        <div className="p-4 grid grid-cols-2 gap-3 items-start">
          {/* ================= ЛЕВАЯ КОЛОНКА ================= */}
          <div className="space-y-3">
            {/* --- Источник --- */}
            <Section title="Источник трека">
              {c.trackNode && (
                <div className="px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/30 text-[10px] leading-tight">
                  <span className="text-amber-400 font-bold">Источник: {c.trackLabel}</span>
                  {!c.trackParams.analysisUrl && c.trackParams.audioUrl &&
                    <div className="text-amber-500/80 mt-0.5">у трека ещё нет анализа — жди или загляни в его ноду</div>}
                  {!c.trackParams.audioUrl &&
                    <div className="text-amber-500/80 mt-0.5">трек-нода пустая — выбери в ней MP3</div>}
                </div>
              )}
              <div className={c.trackNode ? 'opacity-40 pointer-events-none' : ''}>
                <div className="grid grid-cols-2 gap-1">
                  <button onClick={() => c.pick('audio/*', 'audio')}
                    className="text-left text-xs px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 truncate"
                    title={p.audioName || 'выбрать аудиофайл'}>
                    {c.uploading === 'audio' ? '⏳ загрузка…' : `🎵 ${p.audioName || 'Выбрать MP3…'}`}
                  </button>
                  <button onClick={() => c.pick('application/json,.json', 'analysis')}
                    className="text-left text-xs px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 truncate"
                    title={p.analysisName || 'analysis.json из music 2 midi'}>
                    {c.uploading === 'analysis' ? '⏳ загрузка…' : `📊 ${p.analysisName || 'Анализ .json…'}`}
                  </button>
                </div>
                <button onClick={c.openLibrary}
                  className="w-full mt-1 text-left text-xs px-2 py-1.5 rounded bg-zinc-800/60 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200">
                  {c.libOpen ? '▾ Медиатека (закрыть)' : '▸ Медиатека — выбрать из загруженного…'}
                </button>
                {c.libOpen && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded border border-zinc-700 bg-zinc-950">
                    {c.libItems === null && !c.libError &&
                      <div className="px-2 py-1.5 text-[10px] text-zinc-500">загрузка списка…</div>}
                    {c.libError &&
                      <div className="px-2 py-1.5 text-[10px] text-red-400">{c.libError}</div>}
                    {c.libItems && c.libItems.length === 0 &&
                      <div className="px-2 py-1.5 text-[10px] text-zinc-600">пусто — загрузите аудио кнопкой выше</div>}
                    {c.libItems?.map((f: any) => (
                      <button key={f.storedName} onClick={() => c.pickFromLibrary(f)}
                        className="w-full text-left px-2 py-1.5 hover:bg-zinc-800 border-b border-zinc-900 last:border-0">
                        <div className="text-[10px] font-bold text-zinc-200 truncate">
                          {f.name || `без имени · ${f.storedName.slice(0, 12)}…`}
                        </div>
                        <div className="text-[8px] flex justify-between gap-2">
                          <span className="text-zinc-500">{(f.size / 1048576).toFixed(1)} МБ</span>
                          {f.analysis
                            ? <span className="text-emerald-500 truncate">📊 {f.analysis.name}</span>
                            : <span className="text-zinc-600">без анализа</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <div className="text-[9px] leading-tight min-h-[12px] mt-1">
                  {c.uploadError && <span className="text-red-400">{c.uploadError}</span>}
                  {!c.uploadError && c.status.error && <span className="text-red-400">{c.status.error}</span>}
                  {!c.uploadError && !c.status.error && c.autoNote && <span className="text-emerald-500">{c.autoNote}</span>}
                  {!c.uploadError && !c.status.error && !c.autoNote && c.status.loading && <span className="text-zinc-500">разбор анализа…</span>}
                  {!c.uploadError && !c.status.error && !c.autoNote && !c.status.loading && c.status.notes > 0 &&
                    <span className="text-zinc-500">{c.status.notes} нот · {fmtTime(c.duration)}</span>}
                </div>
                {/* Караоке-текст (28.07): белым на проекциях, в такт транспорту */}
                <div className="flex items-center gap-1.5 pt-1 border-t border-zinc-800/60">
                  <span className="text-[10px] text-zinc-400">🎤 Текст:</span>
                  {p.lyricsUrl ? (
                    <span className="text-[9px] text-emerald-500 flex-1 truncate" title={p.lyricsName}>
                      есть — {p.lyricsName || 'lyrics.json'} (показывается на проекциях)
                    </span>
                  ) : c.lyricsJob ? (
                    <span className="text-[9px] text-amber-400 flex-1 truncate">{c.lyricsJob.message}</span>
                  ) : (
                    <span className="text-[9px] text-zinc-600 flex-1">нет — караоке на проекциях не будет</span>
                  )}
                  {!c.lyricsJob && (
                    <button onClick={c.makeLyrics} disabled={!c.effAudioUrl}
                      title="Отделить голос и распознать текст с таймингами слов (music2midi на 4090, минуты; делается заранее). С вставленным текстом песни ниже — выравнивает точные слова"
                      className="px-2 py-1 rounded bg-fuchsia-600/80 hover:bg-fuchsia-500 text-black text-[10px] font-bold disabled:opacity-40 disabled:bg-zinc-800 disabled:text-zinc-500">
                      {p.lyricsUrl ? 'Переделать' : 'Сделать текст'}
                    </button>
                  )}
                </div>
                {/* Подсказка whisper'у: вставленный из интернета текст песни.
                    С ним whisper не угадывает, а выравнивает известные слова —
                    на плотном рэпе разница огромная (28.07). */}
                {!c.lyricsJob && (
                  <textarea
                    value={p.lyricsHint || ''}
                    onChange={e => setParam('lyricsHint', e.target.value)}
                    placeholder="Подсказка для распознавания (необязательно): вставь сюда текст песни — whisper выровняет её по таймингам"
                    rows={3}
                    className="nodrag nopan w-full text-[10px] px-2 py-1.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 placeholder-zinc-600 resize-y"
                  />
                )}
              </div>
            </Section>

            {/* --- Синхрон: устройство и пара каналов (кнопка — на ноде) --- */}
            <Section title="Синхрон со входом звукача">
              <div className="flex gap-1">
                <select value={p.syncDeviceId || 'default'}
                  onChange={e => setParam('syncDeviceId', e.target.value)}
                  title="Звуковая карта, в которую приходит пульт звукача"
                  className="nodrag nopan flex-1 min-w-0 bg-zinc-800 text-[10px] rounded px-1 py-1 text-zinc-300">
                  <option value="default">Вход по умолчанию</option>
                  {c.syncDevices.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
                <select value={p.syncPair || '0'}
                  onChange={e => setParam('syncPair', e.target.value)}
                  title="Пара каналов карты, куда заведён пульт звукача"
                  className="nodrag nopan bg-zinc-800 text-[10px] rounded px-1 py-1 text-zinc-300">
                  <option value="0">каналы 1/2</option>
                  <option value="2">каналы 3/4</option>
                </select>
              </div>
              <div className="text-[9px] text-zinc-500 leading-tight">
                Кнопка 🎧 — на ноде. Песню играет диджей с пульта, follower
                ищет позицию по спектру и ведёт транспорт; локальный звук muted.
              </div>
            </Section>

            {/* --- Партитура (score, фаза 4.0) --- */}
            <Section title="Партитура — семантический черновик трека">
              {(() => {
                const st = midiTrackManager.scoreStatus(nodeId);
                const secs = midiTrackManager.scoreSections(nodeId);
                const cueCount = Array.isArray(p.scoreV1?.cues) ? p.scoreV1.cues.length : 0;
                return (
                  <>
                    <div className="text-[9px] leading-tight">
                      {st === 'none' &&
                        <span className="text-zinc-500">партитуры нет — свет играет как настроено вручную</span>}
                      {st === 'ok' &&
                        <span className="text-emerald-400">партитура активна · cue: {cueCount} · секций: {secs.length}</span>}
                      {st === 'stale' &&
                        <span className="text-amber-400">партитура от ДРУГОГО трека/анализа — не применяется. Пересоздай черновик.</span>}
                      {st === 'invalid' &&
                        <span className="text-red-400">партитура битая (не прошла валидацию) — не применяется</span>}
                    </div>
                    {/* Лента секций: пропорциональные блоки по длительности;
                        без подписей внутри (узкие блоки = каша) — тултип на
                        блоке + легенда ниже. */}
                    {secs.length > 0 && (
                      <>
                      <div className="flex h-4 rounded overflow-hidden border border-zinc-800">
                        {secs.map((s: any) => {
                          const dur = Math.max(0.1, s.to - s.from);
                          const total = Math.max(1, secs[secs.length - 1].to);
                          const color = s.kind === 'quiet' ? 'bg-sky-900/70' : s.kind === 'sustain' ? 'bg-indigo-900/70'
                            : s.kind === 'groove' ? 'bg-emerald-900/70' : s.kind === 'peak' ? 'bg-amber-800/80' : 'bg-fuchsia-900/70';
                          return (
                            <div key={s.id} style={{ width: `${(dur / total) * 100}%` }}
                              title={`${SECTION_LABEL[s.kind as keyof typeof SECTION_LABEL] ?? s.kind} · ${fmtTime(s.from)}–${fmtTime(s.to)}`}
                              className={`${color} border-r border-zinc-950 last:border-0`} />
                          );
                        })}
                      </div>
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                        {[...new Set(secs.map((s: any) => s.kind as string))].map((k: string) => (
                          <span key={k} className="text-[8px] text-zinc-500 flex items-center gap-1">
                            <span className={`inline-block w-2 h-2 rounded-sm ${
                              k === 'quiet' ? 'bg-sky-900' : k === 'sustain' ? 'bg-indigo-900'
                              : k === 'groove' ? 'bg-emerald-900' : k === 'peak' ? 'bg-amber-800' : 'bg-fuchsia-900'}`} />
                            {SECTION_LABEL[k as keyof typeof SECTION_LABEL] ?? k}
                          </span>
                        ))}
                      </div>
                      </>
                    )}
                    {/* Список cue: lock переживает перегенерацию, удаление точечное */}
                    {cueCount > 0 && (
                      <div className="max-h-36 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/60 divide-y divide-zinc-900">
                        {(p.scoreV1.cues as any[]).map((cue: any) => {
                          const mods: string[] = [];
                          if (cue.mods?.brightnessMul !== undefined) mods.push(`×${cue.mods.brightnessMul}`);
                          if (cue.mods?.hueTrim) mods.push(`hue${cue.mods.hueTrim > 0 ? '+' : ''}${Math.round(cue.mods.hueTrim * 360)}°`);
                          if (cue.mods?.satTrim) mods.push(`sat${cue.mods.satTrim > 0 ? '+' : ''}${Math.round(cue.mods.satTrim * 100)}%`);
                          if (cue.mods?.tiltTrim) mods.push(`tilt${cue.mods.tiltTrim > 0 ? '+' : ''}${Math.round(cue.mods.tiltTrim * 100)}%`);
                          if (cue.mods?.gate === false) mods.push('ВЫКЛ');
                          const laneColor = cue.lane === 'rays' ? 'text-orange-400' : cue.lane === 'cob' ? 'text-pink-400'
                            : cue.lane === 'backstage' ? 'text-teal-400' : 'text-sky-400';
                          const laneName = cue.lane === 'rays' ? 'лучи' : cue.lane === 'cob' ? 'COB'
                            : cue.lane === 'backstage' ? 'кулисы' : 'движение';
                          return (
                            <div key={cue.id} className={`flex items-center gap-1.5 px-1.5 py-0.5 text-[9px] ${cue.locked ? 'bg-amber-500/5' : ''}`}>
                              <span className="text-zinc-500 tabular-nums whitespace-nowrap">{fmtTime(cue.from)}–{fmtTime(cue.to)}</span>
                              <span className={`font-bold ${laneColor}`}>{laneName}</span>
                              <span className="flex-1 text-zinc-400 truncate">{mods.join(' ') || '—'}</span>
                              <button onClick={() => c.toggleCueLock(cue.id)}
                                title={cue.locked ? 'Залочено: переживёт перегенерацию черновика' : 'Залочить, чтобы перегенерация не трогала'}
                                className={`px-1 rounded ${cue.locked ? 'text-amber-400' : 'text-zinc-600 hover:text-zinc-400'}`}>
                                {cue.locked ? '🔒' : '🔓'}
                              </button>
                              <button onClick={() => c.deleteCue(cue.id)}
                                title="Удалить cue"
                                className="px-1 rounded text-zinc-600 hover:text-red-400">✕</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {/* Автоматизация (записанные фейдером кривые, фаза 5) */}
                    {(() => {
                      const lanes = (p.scoreV1?.automation as any[]) ?? [];
                      if (lanes.length === 0) return null;
                      const pts = lanes.reduce((n, l) => n + (l.points?.length ?? 0), 0);
                      return (
                        <div className="flex items-center gap-1.5 text-[9px] px-1.5 py-1 rounded bg-red-500/10 border border-red-500/30">
                          <span className="text-red-300 flex-1">
                            автоматизация: {lanes.length} {lanes.length === 1 ? 'дорожка' : 'дорожек'} · {pts} точек
                            <span className="text-zinc-500"> — записанные кривые замещают слайдеры (входы старше)</span>
                          </span>
                          <button onClick={c.clearAutomation}
                            title="Удалить все записанные кривые (cue не трогает)"
                            className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">✕</button>
                        </div>
                      );
                    })()}
                    <div className="flex gap-1">
                      {st === 'none' ? (
                        <button onClick={c.draftScore} disabled={c.status.notes === 0}
                          title="Детерминированный черновик из автопрофиля: тихие места — приглушение, пики — подъём яркости и наклона. Потом правится руками."
                          className="flex-1 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 text-black text-[10px] font-bold disabled:opacity-40 disabled:bg-zinc-800 disabled:text-zinc-500">
                          ✦ Создать черновик из анализа
                        </button>
                      ) : (
                        <button onClick={c.redraftScore} disabled={c.status.notes === 0}
                          title="Пересоздать авто-cue из автопрофиля. Залоченные cue (🔒) сохранятся."
                          className="flex-1 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 text-black text-[10px] font-bold disabled:opacity-40 disabled:bg-zinc-800 disabled:text-zinc-500">
                          ✦ Пересоздать (🔒 сохранятся)
                        </button>
                      )}
                      {st !== 'none' && (
                        <button onClick={c.clearScore}
                          className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300">
                          Очистить
                        </button>
                      )}
                    </div>
                    <div className="text-[9px] text-zinc-500 leading-tight">
                      Партитура — не DMX, а смысловые модификаторы слоёв (яркость/оттенок/наклон/выкл)
                      на временной оси. Живые входы и фейдеры работают поверх неё. Привязана к анализу:
                      заменил трек — старая партитура молча перестаёт действовать.
                    </div>
                  </>
                );
              })()}
            </Section>

            {/* --- Лучи: картинка --- */}
            <Section title="Лучи — картинка">
              <Slider label={`Ширина луча ${Math.round(c.effWidth * 100)}%`} value={c.effWidth}
                min={0.1} max={3} step={0.05} driven={c.driven.width}
                onLive={v => { c.setLocWidth(v); mutate('width', v); }}
                onCommit={v => setParam('width', v)} />
              <Slider label={`Спад ноты ${Math.round(c.effRelease * 1000)} мс`} value={c.effRelease}
                min={0.08} max={0.8} step={0.01} driven={c.driven.release}
                onLive={v => { c.setLocRelease(v); mutate('release', v); }}
                onCommit={v => setParam('release', v)} />
              <Segmented label="Палитра" options={PALETTES}
                value={p.palette ?? DEFAULT_LIGHT_PARAMS.palette}
                onPick={v => setParam('palette', v)} />
              <Segmented label="Уровень" options={LEVELS}
                value={p.levelSource ?? DEFAULT_LIGHT_PARAMS.levelSource}
                onPick={v => setParam('levelSource', v)} />
              <Segmented label="Позиция" options={POS_MODES}
                value={p.posMode ?? DEFAULT_LIGHT_PARAMS.posMode}
                onPick={v => setParam('posMode', v)} />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Симметрия</span>
                <button onClick={() => setParam('symmetry', !(p.symmetry ?? true))}
                  className={`text-xs px-2 py-0.5 rounded ${(p.symmetry ?? true) ? 'bg-emerald-500 text-black font-bold' : 'bg-zinc-800 hover:bg-zinc-700'}`}>
                  {(p.symmetry ?? true) ? 'ДА' : 'НЕТ'}
                </button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Диапазон нот</span>
                <button onClick={() => setParam('range', (p.range ?? 'dense') === 'dense' ? 'full' : 'dense')}
                  className="text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700">
                  {(p.range ?? 'dense') === 'dense' ? 'плотный' : 'полный'}
                </button>
              </div>
              <Slider label={`Гамма DMX ${c.locGamma.toFixed(1)}`} value={c.locGamma}
                min={1} max={2.2} step={0.1} accent="accent-amber-500"
                onLive={v => { c.setLocGamma(v); mutate('gamma', v); }}
                onCommit={v => setParam('gamma', v)} />
              <Slider label={`Мин. вспышка ${Math.round(c.locFlash)} кадр(а)`} value={c.locFlash}
                min={1} max={4} step={1} accent="accent-amber-500"
                onLive={v => { c.setLocFlash(v); mutate('minFlashFrames', v); }}
                onCommit={v => setParam('minFlashFrames', v)} />
              <div className="text-[9px] text-zinc-400 leading-tight">
                Гамма &gt;1 прижимает хвосты — чище гашение. Мин. вспышка удерживает
                короткий удар несколько кадров, чтобы он не потерялся в беспроводном DMX.
              </div>
            </Section>

            {/* --- Лучи: движение --- */}
            <Section title="Лучи — движение (границы)">
              <Slider label={`Нижняя граница ${Math.round(c.locSecLo)} — ${tiltWord(c.locSecLo)}`} value={c.locSecLo}
                min={0} max={255} step={1} accent="accent-sky-500"
                onLive={v => { c.setLocSecLo(v); mutate('tiltMin', v); }}
                onCommit={v => setParam('tiltMin', v)} />
              <Slider label={`Верхняя граница ${Math.round(c.locSecHi)} — ${tiltWord(c.locSecHi)}`} value={c.locSecHi}
                min={0} max={255} step={1} accent="accent-sky-500"
                onLive={v => { c.setLocSecHi(v); mutate('tiltMax', v); }}
                onCommit={v => setParam('tiltMax', v)} />
              <div className="text-[9px] text-zinc-400 leading-tight">
                Ползунок «Наклон» на ноде ходит между границами. Границы могут
                только сузить безопасный сектор из калибровки (бейдж НАКЛОН
                в шапке). Качание вешай снаружи — LFO-нодой на вход tilt-in.
              </div>
            </Section>

            {/* --- Лучи: подключение --- */}
            <Section title="Лучи — подключение (расчёски)">
              {c.combFixtures.length === 0 && (
                <div className="text-[9px] px-2 py-1.5 rounded bg-red-500/15 border border-red-500/40 text-red-300 leading-tight space-y-1.5">
                  <div>
                    <b>Нет расчёсок</b> — не найдено ни одного прибора «Расчёска (comb RGBW)».
                    Лучи молчат.
                  </div>
                  <button onClick={c.askCombConnect}
                    className="w-full py-1 rounded bg-red-500/25 hover:bg-red-500/40 border border-red-500/50 text-red-200 font-bold text-[10px] transition-colors">
                    + Создать 4 расчёски и подключить
                  </button>
                </div>
              )}
              {c.combFixtures.length > 0 && c.wiredCombs.length === 0 && (
                <div className="text-[9px] px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/40 text-amber-300 leading-tight space-y-1.5">
                  <div>
                    Расчёски не подключены к выходу <b>ЛУЧИ</b> (оранжевый пин справа).
                    Сейчас играют все найденные ({c.combFixtures.length}) по старой схеме.
                  </div>
                  <button onClick={c.askCombConnect}
                    className="w-full py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-200 font-bold text-[10px] transition-colors">
                    Подключить {c.combFixtures.length === 1 ? 'расчёску' : `расчёски (${c.combFixtures.length})`} проводом
                  </button>
                </div>
              )}
              {c.wiredCombs.length > 0 && (
                <div className="text-[9px] text-zinc-500 leading-tight">
                  лучи по проводу: {c.wiredCombs.length} шт.
                  {c.wiredCombs.length < c.combFixtures.length &&
                    <span className="text-amber-500/80"> · ещё {c.combFixtures.length - c.wiredCombs.length} не подключены — стоят</span>}
                </div>
              )}
            </Section>
          </div>

          {/* ================= ПРАВАЯ КОЛОНКА ================= */}
          <div className="space-y-3">
            {/* --- COB --- */}
            <Section title="Верхний свет (COB)">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Слой</span>
                <button onClick={() => setParam('wash', p.wash === false ? true : false)}
                  className={`text-xs px-2 py-0.5 rounded ${p.wash === false ? 'bg-zinc-800 hover:bg-zinc-700' : 'bg-emerald-500 text-black font-bold'}`}>
                  {p.wash === false ? 'ВЫКЛ' : 'ВКЛ'}
                </button>
              </div>
              {p.wash !== false && c.washFixtures.length === 0 && (
                <div className="text-[9px] px-2 py-1.5 rounded bg-red-500/15 border border-red-500/40 text-red-300 leading-tight space-y-1.5">
                  <div>
                    <b>Нет приборов заливки</b> — не найдено ни одной ноды LED PAR (8ch).
                    Верхний свет не будет работать.
                  </div>
                  <button onClick={c.askWashConnect}
                    className="w-full py-1 rounded bg-red-500/25 hover:bg-red-500/40 border border-red-500/50 text-red-200 font-bold text-[10px] transition-colors">
                    + Создать COB-ноду и подключить
                  </button>
                </div>
              )}
              {p.wash !== false && c.washFixtures.length > 0 && c.wiredWash.length === 0 && (
                <div className="text-[9px] px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/40 text-amber-300 leading-tight space-y-1.5">
                  <div>
                    COB не подключены к выходу <b>wash</b> (розовый пин справа).
                    Сейчас заливаются все найденные ({c.washFixtures.length}) по старой схеме.
                  </div>
                  <button onClick={c.askWashConnect}
                    className="w-full py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-200 font-bold text-[10px] transition-colors">
                    Подключить {c.washFixtures.length === 1 ? 'прибор' : `приборы (${c.washFixtures.length})`} проводом
                  </button>
                </div>
              )}
              {p.wash !== false && c.wiredWash.length > 0 && (
                <div className="text-[9px] text-zinc-500 leading-tight">
                  заливка по проводу wash: {c.wiredWash.length} шт.
                  {c.wiredWash.length < c.washFixtures.length &&
                    <span className="text-amber-500/80"> · ещё {c.washFixtures.length - c.wiredWash.length} не подключены — стоят</span>}
                  {!c.playing && ' · манера считается на воспроизведении'}
                </div>
              )}
              <div className="text-[10px] px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-center">
                {c.washKind
                  ? <span className="text-emerald-400">{SECTION_LABEL[c.washKind]}</span>
                  : <span className="text-zinc-600">манера определится на воспроизведении</span>}
              </div>
              <Slider label={`Яркость COB ${Math.round(c.locWashBr * 100)}%`} value={c.locWashBr}
                min={0.2} max={2} step={0.05} accent="accent-pink-500"
                onLive={v => { c.setLocWashBr(v); mutate('washBrightness', v); }}
                onCommit={v => setParam('washBrightness', v)} />
              <Slider label={`Нижний порог ${Math.round(c.locWashFloor * 100)}%`} value={c.locWashFloor}
                min={0} max={0.9} step={0.05} accent="accent-pink-500"
                onLive={v => { c.setLocWashFloor(v); mutate('washFloor', v); }}
                onCommit={v => setParam('washFloor', v)} />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Строб на пиках</span>
                <button onClick={() => setParam('washStrobe', p.washStrobe === false ? true : false)}
                  className={`text-xs px-2 py-0.5 rounded ${p.washStrobe === false ? 'bg-zinc-800 hover:bg-zinc-700' : 'bg-amber-500 text-black font-bold'}`}>
                  {p.washStrobe === false ? 'НЕТ' : 'ДА'}
                </button>
              </div>
              <div className="text-[9px] text-zinc-400 leading-tight">
                Заливка идёт по характеру музыки, а не по громкости: тихо — дыхание,
                держаные — наплыв, ритм — удар в такт, пик — строб, навал — волна по приборам.
                Порог не даёт COB уйти в невидимую тусклость.
              </div>
            </Section>

            {/* --- Кулисы --- */}
            <Section title="Кулисы (плавный фон)">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Слой</span>
                <button onClick={() => setParam('backstage', p.backstage === false ? true : false)}
                  className={`text-xs px-2 py-0.5 rounded ${p.backstage === false ? 'bg-zinc-800 hover:bg-zinc-700' : 'bg-emerald-500 text-black font-bold'}`}>
                  {p.backstage === false ? 'ВЫКЛ' : 'ВКЛ'}
                </button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Режим</span>
                <div className="flex gap-1">
                  <button onClick={() => setParam('backstageMode', 'notes')}
                    title="Кулисы играют ноты: 6 зон буфера 40 лучей (Front L — левые лучи, Front R — правые)"
                    className={`text-[10px] px-2 py-0.5 rounded font-bold ${(p.backstageMode ?? 'notes') === 'notes' ? 'bg-emerald-500 text-black' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'}`}>
                    НОТЫ
                  </button>
                  <button onClick={() => setParam('backstageMode', 'comet')}
                    title="Амбиентная волна: яркая комета бегает туда-обратно по паркам"
                    className={`text-[10px] px-2 py-0.5 rounded font-bold ${(p.backstageMode ?? 'notes') === 'comet' ? 'bg-emerald-500 text-black' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'}`}>
                    ВОЛНА
                  </button>
                </div>
              </div>
              {p.backstage !== false && c.backstageFixtures.length === 0 && (
                <div className="text-[9px] px-2 py-1.5 rounded bg-red-500/15 border border-red-500/40 text-red-300 leading-tight space-y-1.5">
                  <div>
                    <b>Кулисных RGB-парок нет</b> — не найдено ни одного прибора
                    led_par (6ch) / mini_par. Плавный фон не зажжётся.
                  </div>
                  <button onClick={c.askBackstageConnect}
                    className="w-full py-1 rounded bg-red-500/25 hover:bg-red-500/40 border border-red-500/50 text-red-200 font-bold text-[10px] transition-colors">
                    + Создать 6 кулисных парок и подключить
                  </button>
                </div>
              )}
              {p.backstage !== false && c.backstageFixtures.length > 0 && c.wiredBackstage.length === 0 && (
                <div className="text-[9px] px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/40 text-amber-300 leading-tight space-y-1.5">
                  <div>
                    Кулисы не подключены к выходу <b>wash</b> — сейчас они на твоих
                    фейдерах, плавный фон не работает.
                  </div>
                  <button onClick={c.askBackstageConnect}
                    className="w-full py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-200 font-bold text-[10px] transition-colors">
                    Подключить {c.backstageFixtures.length === 1 ? 'кулису' : `кулисы (${c.backstageFixtures.length})`} проводом
                  </button>
                </div>
              )}
              {p.backstage !== false && c.wiredBackstage.length > 0 && (
                <div className="text-[9px] text-zinc-500 leading-tight">
                  фон по проводу: {c.wiredBackstage.length} из {c.backstageFixtures.length}
                  {' · '}{midiTrackManager.backstageDrums(nodeId)
                    ? 'в треке есть удары — пульс по кикам'
                    : 'ударных нет — только плавно'}
                  {c.wiredBackstage.length < c.backstageFixtures.length &&
                    <span className="text-amber-500/80"> · ещё {c.backstageFixtures.length - c.wiredBackstage.length} стоят</span>}
                </div>
              )}
              <Slider label={`Яркость кулис ${Math.round(c.effBackBright * 100)}%`} value={c.effBackBright}
                min={0.2} max={2} step={0.05} accent="accent-teal-500" driven={c.driven.backBright}
                onLive={v => { c.setLocBackBr(v); mutate('backstageBrightness', v); c.recPoint('backstage.brightness', v); }}
                onCommit={v => setParam('backstageBrightness', v)} />
              <Slider label={`Нижний порог кулис ${Math.round(c.locBackFloor * 100)}%`} value={c.locBackFloor}
                min={0} max={0.8} step={0.05} accent="accent-teal-500"
                onLive={v => { c.setLocBackFloor(v); mutate('backstageFloor', v); }}
                onCommit={v => setParam('backstageFloor', v)} />
              <Slider label={`Насыщенность кулис ${Math.round(c.effBackSat * 100)}%`} value={c.effBackSat}
                min={0.2} max={1} step={0.05} accent="accent-fuchsia-500" driven={c.driven.backSat}
                onLive={v => { c.setLocBackSat(v); mutate('backstageSaturation', v); c.recPoint('backstage.saturation', v); }}
                onCommit={v => setParam('backstageSaturation', v)} />
              <div className={(p.backstageMode ?? 'notes') === 'comet' ? '' : 'opacity-35 pointer-events-none'}
                title={(p.backstageMode ?? 'notes') === 'comet' ? '' : 'Работает в режиме ВОЛНА'}>
                <Slider label={`Скорость перелива ${c.locBackFlow.toFixed(1)}×`} value={c.locBackFlow}
                  min={0.3} max={2.5} step={0.1} accent="accent-teal-500"
                  onLive={v => { c.setLocBackFlow(v); mutate('backstageFlow', v); }}
                  onCommit={v => setParam('backstageFlow', v)} />
                <Slider label={`Динамика волны ${Math.round((1 - c.locBackWave) * 100)}%`} value={1 - c.locBackWave}
                  min={0.1} max={1} step={0.05} accent="accent-teal-500"
                  onLive={v => { c.setLocBackWave(1 - v); mutate('backstageWave', 1 - v); }}
                  onCommit={v => setParam('backstageWave', 1 - v)} />
                <Slider label={`Оттенок кулис ${c.driven.backHue ? `+${Math.round(c.effBackHue * 360)}°` : c.locBackHue === 0 ? 'как общий' : `+${Math.round(c.locBackHue * 360)}°`}`} value={c.effBackHue}
                  min={0} max={1} step={0.01} accent="accent-fuchsia-500" driven={c.driven.backHue}
                  onLive={v => { c.setLocBackHue(v); mutate('backstageHue', v); c.recPoint('backstage.hueShift', v); }}
                  onCommit={v => setParam('backstageHue', v)} />
              </div>
              <div className="text-[9px] text-zinc-400 leading-tight">
                {(p.backstageMode ?? 'notes') === 'comet'
                  ? '«Кометный» пробег света слева направо по физическому порядку парок (Front L → … → Front R): гребень ярче, впадины темные. Без строба; резкое — только пульс по ударам из анализа.'
                  : 'Кулисы играют ноты: 6 зон буфера 40 лучей (Front L — левые, Front R — правые). Уровень с панчем, цвет лучей сохраняется; «порог» — слабый фон под нотами. Без строба.'}
              </div>
            </Section>

            {/* --- Вывод --- */}
            <Section title="Вывод в приборы">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Захват каналов</span>
                <button onClick={() => setParam('override', !p.override)}
                  className={`text-xs px-2 py-0.5 rounded ${p.override ? 'bg-amber-500 text-black font-bold' : 'bg-zinc-800 hover:bg-zinc-700'}`}>
                  {p.override ? 'ДА' : 'НЕТ'}
                </button>
              </div>
              <div className="text-[9px] text-zinc-400 leading-tight">
                Полностью захватывает каналы генерируемых слоёв (лучи, COB,
                кулисы), игнорируя другие источники. Выключено — HTP max-merge.
              </div>
            </Section>

            {/* --- Проекции --- */}
            <VisualSection c={c} />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
