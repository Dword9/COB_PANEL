import React, { useEffect, useState } from 'react';
import { AlertTriangle, Ruler, X } from 'lucide-react';
import { HTTP_API_URL } from '../constants';
import {
  getTiltLimits, isHallAllowed, setHallAllowed, setTiltLimitsManual,
} from '../utils/tiltGuard';

/**
 * Настройка наклона расчёсок: сектор руками + осознанный «свет в зал».
 *
 * Физика (замерена на сцене): 0 = луч в зал, ~середина = вверх (вертикаль),
 * 255 = крайнее положение внутрь сцены. Полный ход 180°, опасна только зона
 * около нуля — приборы стоят на авансцене на уровне глаз сидящих людей.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Пересобрать кадр после правки: приборы держат последнее значение вечно */
  onApplied: () => void;
}

/** Куда физически смотрит луч при этом значении канала MotorY. */
const describe = (v: number, park: number): string => {
  if (v <= 8) return 'ПРЯМО В ЗАЛ, в глаза';
  if (v < park * 0.45) return 'в зал, низко';
  if (v < park * 0.8) return 'над головами зрителей';
  if (v < park * 1.2) return 'вертикаль, в потолок';
  if (v < park * 1.2 + (255 - park * 1.2) * 0.6) return 'вглубь сцены';
  return 'крайнее, в заднюю стену';
};

const TiltSettings: React.FC<Props> = ({ isOpen, onClose, onApplied }) => {
  const l = getTiltLimits();
  const [safeLo, setSafeLo] = useState(l.safeLo);
  const [safeHi, setSafeHi] = useState(l.safeHi);
  const [park, setPark] = useState(l.park);
  const [hall, setHall] = useState(isHallAllowed());
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errText, setErrText] = useState('');

  // Синхронизируем поля с актуальными лимитами при каждом открытии
  useEffect(() => {
    if (!isOpen) return;
    const cur = getTiltLimits();
    setSafeLo(cur.safeLo);
    setSafeHi(cur.safeHi);
    setPark(cur.park);
    setHall(isHallAllowed());
    setSaveState('idle');
    setErrText('');
  }, [isOpen]);

  if (!isOpen) return null;

  const applyLive = (next: { safeLo?: number; safeHi?: number; park?: number }) => {
    const upd = setTiltLimitsManual(next);
    setSafeLo(upd.safeLo);
    setSafeHi(upd.safeHi);
    setPark(upd.park);
    setSaveState('idle');
    onApplied();
  };

  const toggleHall = () => {
    const v = !hall;
    setHall(v);
    setHallAllowed(v);
    onApplied();
  };

  const persist = async () => {
    setSaveState('saving');
    try {
      const res = await fetch(`${HTTP_API_URL}/api/calibration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ safeLo, safeHi, park }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'ok') throw new Error(data.message || `HTTP ${res.status}`);
      setSaveState('saved');
    } catch (e: any) {
      setSaveState('error');
      setErrText(String(e?.message || e));
    }
  };

  const row = (
    label: string, value: number, set: (v: number) => void,
    commit: (v: number) => void, accent: string,
  ) => (
    <div className="space-y-1">
      <div className="flex justify-between items-baseline gap-3">
        <span className="text-[9px] font-bold text-zinc-300 uppercase tracking-wide">{label}</span>
        <span className="flex items-baseline gap-1.5 shrink-0">
          {/* Фиксированная колонка под число: иначе значения «прыгают» по ширине
              описания и их нельзя сравнить между строками взглядом */}
          <span className="text-[11px] font-mono font-bold text-zinc-100 w-8 text-right tabular-nums">{value}</span>
          <span className="text-[9px] text-zinc-400 w-[150px]">{describe(value, park)}</span>
        </span>
      </div>
      <input
        type="range" min={0} max={255} step={1} value={value}
        onChange={e => set(parseInt(e.target.value))}
        onPointerUp={e => commit(parseInt((e.target as HTMLInputElement).value))}
        onKeyUp={e => commit(parseInt((e.target as HTMLInputElement).value))}
        className={`w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer ${accent}`}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[520px] bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-1">
          <div className="flex items-center gap-2">
            <Ruler size={16} className="text-sky-500" />
            <span className="text-[11px] font-black text-zinc-200 uppercase tracking-widest">Наклон расчёсок</span>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors"><X size={16} /></button>
        </div>
        <div className="text-[10px] text-zinc-400 mb-5 leading-relaxed">
          Канал MotorY, ход 180°: <b className="text-zinc-200">0 = в зал</b> ·
          <b className="text-zinc-200"> ~{park} = вверх</b> ·
          <b className="text-zinc-200"> 255 = вглубь сцены</b>.
          Двигай ползунок и смотри на приборы — значение уходит в свет сразу.
        </div>

        <div className="space-y-4">
          {row('Нижняя граница (ниже не опустится)', safeLo, setSafeLo, v => applyLive({ safeLo: v }), 'accent-sky-500')}
          {row('Верхняя граница (предел внутрь сцены)', safeHi, setSafeHi, v => applyLive({ safeHi: v }), 'accent-sky-500')}
          {row('Парковка (угол в простое и при включении)', park, setPark, v => applyLive({ park: v }), 'accent-amber-500')}
        </div>

        <div className="mt-5 p-3 rounded-xl border border-zinc-800 bg-black/30">
          <button
            onClick={toggleHall}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-[10px] font-black transition-all active:scale-95 border-2 ${
              hall
                ? 'bg-red-500 border-red-400 text-white shadow-lg shadow-red-500/30 animate-pulse'
                : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-600'
            }`}
          >
            <AlertTriangle size={13} />
            {hall ? 'СВЕТ В ЗАЛ РАЗРЕШЁН — ВЫКЛЮЧИТЬ' : 'РАЗРЕШИТЬ СВЕТ В ЗАЛ'}
          </button>
          <div className="mt-2 text-[9px] text-zinc-400 leading-relaxed">
            {hall
              ? 'Ограничитель СНЯТ: мотор ходит по всем 0-255, включая направление в глаза зрителям. Режим НЕ сохраняется — после перезагрузки страницы снова включится защита.'
              : 'Разовое снятие ограничителя, когда лучи в зал нужны намеренно. Сбрасывается при перезагрузке страницы — специально, чтобы не забыть выключить.'}
          </div>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <button
            onClick={persist}
            disabled={saveState === 'saving'}
            className="flex-1 px-3 py-2.5 rounded-lg text-[9px] font-black bg-emerald-500 text-black hover:bg-emerald-400 transition-all active:scale-95 disabled:opacity-50"
          >
            {saveState === 'saving' ? 'СОХРАНЕНИЕ…' : 'ЗАПОМНИТЬ КАК КАЛИБРОВКУ'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-lg text-[9px] font-black bg-zinc-800 text-zinc-400 hover:text-white transition-all"
          >
            ЗАКРЫТЬ
          </button>
        </div>
        {saveState === 'saved' && (
          <div className="mt-2 text-[9px] text-emerald-500">
            Сохранено на сервере — теперь эти границы подхватятся при следующем запуске.
          </div>
        )}
        {saveState === 'error' && (
          <div className="mt-2 text-[9px] text-red-500">Не сохранилось: {errText}</div>
        )}
        <div className="mt-3 text-[9px] text-zinc-500 leading-relaxed">
          Точный замер по свету на приборах:
          <span className="font-mono text-zinc-400"> tools\wing\venv\Scripts\python.exe tools\calibrate_tilt.py</span>
          {' '}(пульт при этом закрыть).
        </div>
      </div>
    </div>
  );
};

export default TiltSettings;
