/**
 * Общие UI-примитивы и хелперы ноды MIDI-трек: используются и компактной
 * нодой, и модальным редактором (components/MidiTrackEditor.tsx).
 * Извлечено из nodes/MidiTrackNode.tsx без изменения логики (фаза 2
 * рефакторинга «Режиссуры трека»: одна нода + отдельный редактор).
 */
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { LightEngineParams } from '../utils/lightEngine';
import { SyncMode } from '../services/audioSyncFollower';

export const PALETTES: Array<{ id: LightEngineParams['palette']; label: string }> = [
  { id: 'thermal', label: 'Тепло' },
  { id: 'rainbow', label: 'Радуга' },
  { id: 'mono', label: 'Моно' },
];

export const LEVELS: Array<{ id: LightEngineParams['levelSource']; label: string }> = [
  { id: 'spec', label: 'Спектр' },
  { id: 'rms', label: 'RMS' },
];

export const POS_MODES: Array<{ id: LightEngineParams['posMode']; label: string }> = [
  { id: 'keys', label: 'Клавиши' },
  { id: 'walk', label: 'Бегунок' },
];

// Вход для живого управления с фейдеров крыла (через MIDI-ноду).
// ВАЖНО: пин обязан висеть на СТРОКЕ ПОЛЗУНКА, а не на всём блоке параметра.
// Если обернуть `relative` вокруг Slider целиком (подпись + input), то top:50%
// попадает в зазор между подписью и дорожкой — визуально пин «висит в воздухе»
// и непонятно, к чему он относится (дефект 26.07). Поэтому Slider сам рисует
// пин внутри relative-обёртки ТОЛЬКО вокруг input.
export const ParamIn: React.FC<{ id: string; label: string }> = ({ id, label }) => (
  <Handle type="target" position={Position.Left} id={id} title={label}
    style={{ top: '50%', left: -14 }} className="!bg-sky-400" />
);

/** Подписанный вход без ползунка (трек-источник, цвет COB): пин на левом
 *  краю ноды + текст. Правило 27.07: ВСЕ входы слева, выходы справа. */
export const PinRow: React.FC<{
  pinId: string; label: string; valueText?: string; driven?: boolean; pinClass?: string;
}> = ({ pinId, label, valueText, driven, pinClass = '!bg-sky-400' }) => (
  <div className="relative flex items-center gap-2 py-0.5">
    <Handle type="target" position={Position.Left} id={pinId} title={label}
      style={{ top: '50%', left: -14 }} className={pinClass} />
    <span className="text-[10px] text-zinc-400 flex-1 truncate">{label}</span>
    {driven && (
      <span className="px-1 rounded bg-sky-500/20 text-sky-400 text-[8px] font-black"
        title="Подключён вход — значение приходит снаружи">ВХОД</span>
    )}
    {valueText && <span className="text-[10px] font-mono text-zinc-500">{valueText}</span>}
  </div>
);

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

// Подписи режимов синхры со входом звукача (audioSyncFollower).
export const SYNC_MODE_TEXT: Record<SyncMode, string> = {
  off: 'выключен',
  starting: '🟡 слушаю вход… окно',
  locked: '🟢 синхра',
  coast: '🟡 поиск — едем по своим часам',
  silent: '⏸ тишина у источника — пауза',
};

/** Слайдер с локальным стейтом: коммит в граф только по отпусканию мыши.
 *  `pin` — id входного хендла; рисуется по центру ДОРОЖКИ, не всего блока.
 *  `driven` — параметром управляет подключённый вход: ползунок блокируется и
 *  показывает ФАКТИЧЕСКОЕ значение, иначе нода врёт (жалоба 27.07). */
export const Slider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  accent?: string;
  pin?: { id: string; title: string };
  driven?: boolean;
  onLive: (v: number) => void;
  onCommit: (v: number) => void;
}> = ({ label, value, min, max, step, accent = 'accent-emerald-500', pin, driven, onLive, onCommit }) => (
  <div>
    <label className="block text-[10px] text-zinc-400">
      {label}
      {driven && (
        <span className="ml-1 px-1 rounded bg-sky-500/20 text-sky-400 text-[8px] font-black align-middle"
          title="Управляет подключённый вход: ползунок игнорируется, показано фактическое значение">
          ВХОД
        </span>
      )}
    </label>
    <div className="relative">
      {pin && <ParamIn id={pin.id} label={pin.title} />}
      <input type="range" min={min} max={max} step={step} value={value}
        disabled={driven}
        onChange={e => onLive(parseFloat(e.target.value))}
        onPointerUp={() => onCommit(value)}
        onPointerDown={e => e.stopPropagation()}
        className={`nodrag nopan w-full h-3 bg-zinc-800 rounded-full appearance-none cursor-pointer block ${accent} ${driven ? 'opacity-50' : ''}`} />
    </div>
  </div>
);

/** Компактный переключатель вариантов. */
export function Segmented<T extends string>({ label, options, value, onPick }: {
  label: string;
  options: Array<{ id: T; label: string }>;
  value: T;
  onPick: (v: T) => void;
}) {
  return (
    <div>
      <div className="text-[10px] text-zinc-400 mb-0.5">{label}</div>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map(o => (
          <button key={o.id} onClick={() => onPick(o.id)}
            className={`text-[11px] py-1 rounded ${value === o.id ? 'bg-emerald-500 text-black font-bold' : 'bg-zinc-800 hover:bg-zinc-700'}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Куда смотрят лучи при таком значении канала мотора. */
export function tiltWord(v: number): string {
  if (v >= 225) return 'вверх';
  if (v >= 175) return 'выше центра';
  if (v >= 140) return 'слегка вверх';
  if (v >= 115) return 'ЦЕНТР (в глаза)';
  if (v >= 60) return 'ниже центра';
  return 'в зал';
}

/** Стопы градиента для полоски-превью цвета: та же формула, что в движке,
 *  только в CSS — видно, во что превратится картинка при текущем сдвиге. */
export function hueBarStops(palette: string, hueShift: number, sat: number): string {
  const stops: string[] = [];
  for (let i = 0; i <= 8; i++) {
    const xn = i / 8;
    let h: number;
    if (palette === 'mono') h = 0.6;
    else if (palette === 'rainbow') h = xn * 0.83;
    else h = (0.1 - xn * 0.55 + 1) % 1;
    h = (h + hueShift + 1) % 1;
    stops.push(`hsl(${Math.round(h * 360)} ${Math.round(sat * 100)}% 60%)`);
  }
  return stops.join(', ');
}

/** Превью 40 лучей: одна полоска, слева направо. */
export function drawPreview(cv: HTMLCanvasElement, px: Float32Array) {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const n = px.length / 4;
  const w = cv.width / n;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const white = px[o + 3];
    const r = Math.min(255, Math.round(255 * Math.min(1, px[o] + white)));
    const g = Math.min(255, Math.round(255 * Math.min(1, px[o + 1] + white)));
    const b = Math.min(255, Math.round(255 * Math.min(1, px[o + 2] + white)));
    if (r + g + b < 6) continue;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(i * w, 0, Math.ceil(w), cv.height);
  }
}
