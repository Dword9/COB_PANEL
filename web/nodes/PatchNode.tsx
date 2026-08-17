
import React, { useMemo, useState, useCallback, useRef } from 'react';
import { useStore, useReactFlow } from '@xyflow/react';
import { MAX_CHANNELS, FIXTURE_LAYOUTS } from '../constants';
import { loadFixtureBank, saveFixtureProfile, removeFixtureProfile, FixtureProfile } from '../utils/fixtureBank';

// ---------------------------------------------------------------------------
// Патч-нода: визуальный диспетчер DMX-адресов (модель «A» — правит существующие
// fixture-ноды через data.onParamChange(fid, ...)). Полотно = пианоролл по
// адресам 1..512: адреса горизонтальны (прибор занимает ширину своих каналов),
// линейка-рулер сверху, шахматная подложка, полосы-приборы раскрашены по типам
// каналов. Два полотна: Юниверс 1 (основная линия) и Юниверс 2 (зеркало U1).
// ---------------------------------------------------------------------------

const CELL_W = 8;
const STRIP_H = 46;
const BAR_H = 13;
const BAR_TOP = [3, 18, 32];
const CANVAS_W = MAX_CHANNELS * CELL_W;

const CH_COLORS: Record<string, string> = {
  intensity: '#f59e0b', master: '#a78bfa', red: '#ef4444', green: '#10b981',
  blue: '#3b82f6', white: '#e5e7eb', amber: '#f59e0b', uv: '#c084fc',
  strobe: '#f472b6', fx: '#64748b', speed: '#22d3ee', pan: '#fbbf24', tilt: '#60a5fa',
};

const TYPE_ACCENT: Record<string, string> = {
  dimmer: '#f59e0b', led_par: '#ef4444', led_par_8ch: '#a78bfa', spider: '#22d3ee',
  spark: '#fb923c', laser: '#f43f5e', comb_rgbw: '#10b981', mini_par: '#f472b6',
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

interface PatchFixture {
  id: string;
  name: string;
  type: string;
  start: number;
  group: number;
  len: number;
  color: string;
  hasConflict?: boolean;
  layout: { offset: number; label: string; type: string }[];
}

const toFixture = (n: any): PatchFixture | null => {
  const p = n.data?.params || {};
  const type = p.fixtureType || 'dimmer';
  const layout = p.customLayout || FIXTURE_LAYOUTS[type as keyof typeof FIXTURE_LAYOUTS] || FIXTURE_LAYOUTS.dimmer;
  return {
    id: n.id,
    name: n.data?.label || 'FIXTURE',
    type,
    start: p.startChannel || 1,
    group: p.group ?? 0,
    len: layout.length,
    color: n.data?.color || TYPE_ACCENT[type as keyof typeof TYPE_ACCENT] || '#10b981',
    hasConflict: !!p.hasConflict,
    layout: layout as { offset: number; label: string; type: string }[],
  };
};

const isBuiltinType = (id: string) => Object.prototype.hasOwnProperty.call(FIXTURE_LAYOUTS, id);

const UniversePane: React.FC<{
  title: string;
  subtitle: string;
  fixtures: PatchFixture[];
  readonly?: boolean;
  sel: Set<string>;
  focusGroup: number | null;
  stacked: Set<string>;
  onBarPointerDown: (e: React.PointerEvent, f: PatchFixture) => void;
  onBarClick: (e: React.MouseEvent, f: PatchFixture) => void;
  onDropProfile: (profileId: string, ch: number) => void;
}> = ({ title, subtitle, fixtures, readonly, sel, focusGroup, stacked, onBarPointerDown, onBarClick, onDropProfile }) => {
  const stripRef = useRef<HTMLDivElement>(null);
  const [dropCh, setDropCh] = useState<number | null>(null);

  // Смещение перекрывающихся полос по вертикали, чтобы все были видны
  const offsets = useMemo(() => {
    const map: Record<string, number> = {};
    const sorted = [...fixtures].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    sorted.forEach((f, i) => {
      const prev = sorted.slice(0, i).filter(o =>
        o.id !== f.id && f.start < o.start + o.len && o.start < f.start + f.len);
      map[f.id] = Math.min(prev.length, BAR_TOP.length - 1);
    });
    return map;
  }, [fixtures]);

  const zebra = `repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0, rgba(255,255,255,0.04) ${CELL_W}px, transparent ${CELL_W}px, transparent ${CELL_W * 2}px)`;

  const onDragOver = (e: React.DragEvent) => {
    if (readonly) return;
    const el = stripRef.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const ch = clamp(Math.floor((e.clientX - rect.left + el.scrollLeft) / CELL_W) + 1, 1, MAX_CHANNELS);
    setDropCh(ch);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (readonly) return;
    const profileId = e.dataTransfer.getData('text/plain');
    if (!profileId) return;
    const ch = dropCh || 1;
    setDropCh(null);
    onDropProfile(profileId, ch);
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-baseline justify-between mb-0.5 px-0.5">
        <span className="text-[9px] font-black uppercase tracking-wider" style={{ color: readonly ? '#3f3f46' : '#10b981' }}>{title}</span>
        <span className="text-[8px] text-zinc-600">{subtitle}</span>
      </div>
      <div className="nodrag nopan overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950"
        style={{ maxWidth: '100%' }}
        onDragOver={onDragOver} onDragLeave={() => setDropCh(null)} onDrop={onDrop}>
        {/* Рулер */}
        <div className="relative border-b border-zinc-800" style={{ width: CANVAS_W, height: 16 }}>
          {Array.from({ length: 512 / 20 + 1 }, (_, i) => {
            const n = i * 20 + 1;
            return (
              <span key={n} className="absolute top-0 text-[8px] text-zinc-400 font-mono whitespace-nowrap"
                style={{ left: (n - 1) * CELL_W + 1 }}>
                {n}
              </span>
            );
          })}
          {Array.from({ length: 512 / 10 }, (_, i) => (
            <div key={i} className="absolute top-0 w-px h-1.5 bg-zinc-800" style={{ left: (i + 1) * 10 * CELL_W }} />
          ))}
        </div>
        {/* Полоса юниверса */}
        <div ref={stripRef} className="relative" style={{ width: CANVAS_W, height: STRIP_H, background: zebra }}>
          {Array.from({ length: 512 / 10 - 1 }, (_, i) => (
            <div key={i} className="absolute top-0 bottom-0 w-px bg-zinc-800/40" style={{ left: (i + 1) * 10 * CELL_W }} />
          ))}
          {dropCh !== null && !readonly && (
            <div className="absolute top-0 bottom-0 w-[2px] bg-cyan-400 z-20" style={{ left: (dropCh - 1) * CELL_W }} />
          )}
          {fixtures.map(f => {
            const selected = sel.has(f.id);
            const inStack = stacked.has(f.id);
            const focused = focusGroup !== null && f.group === focusGroup;
            const isConflict = f.hasConflict && !inStack;
            return (
              <div key={f.id}
                className={`absolute nodrag nopan ${readonly ? '' : 'cursor-grab'} group`}
                data-fid={f.id}
                data-conflict={isConflict ? '1' : '0'}
                style={{
                  left: (f.start - 1) * CELL_W,
                  top: BAR_TOP[offsets[f.id]],
                  height: BAR_H,
                  width: f.len * CELL_W,
                  display: 'flex',
                  overflow: 'hidden',
                  borderRadius: 3,
                  background: `${f.color}26`,
                  border: `1px solid ${isConflict ? '#ef4444' : selected ? '#22d3ee' : `${f.color}88`}`,
                  boxShadow: isConflict ? '0 0 8px rgba(239,68,68,.5)' : focused ? '0 0 6px #ef4444aa' : undefined,
                  zIndex: selected ? 15 : focused ? 10 : 5,
                }}
                onPointerDown={readonly ? undefined : (e) => onBarPointerDown(e, f)}
                onClick={readonly ? undefined : (e) => onBarClick(e, f)}
                title={`${f.name} — CH ${f.start}..${f.start + f.len - 1}, группа ${f.group}${isConflict ? ' (конфликт!)' : ''}`}
              >
                {f.layout.map(c => (
                  <div key={c.offset} style={{
                    width: CELL_W,
                    minWidth: CELL_W,
                    height: '100%',
                    backgroundColor: CH_COLORS[c.type] || '#64748b',
                    opacity: 0.45,
                    borderRight: '1px solid rgba(0,0,0,.4)',
                  }} />
                ))}
                <span className="absolute left-0.5 top-0 text-[7px] font-black text-white leading-none truncate rounded-sm px-0.5"
                  style={{ background: 'rgba(0,0,0,.65)', pointerEvents: 'none' }}>
                  {inStack ? '⧉ ' : ''}{f.name}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const PatchNode = ({ data, id, selected }: any) => {
  const params = data?.params || {};
  const expanded = !!params.expanded;
  const stacks: string[][] = Array.isArray(params.stacks) ? params.stacks : [];
  const explicitGroups: number[] = Array.isArray(params.groups) ? params.groups : [];

  const graphNodes = useStore((s: any) => s.nodes);
  const { getNode } = useReactFlow();

  const [bank, setBank] = useState<FixtureProfile[]>(() => loadFixtureBank());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [focusGroup, setFocusGroup] = useState<number | null>(null);
  const [newGroup, setNewGroup] = useState('');
  const dragRef = useRef<{ fid: string; origStart: number; startX: number; len: number; last: number } | null>(null);
  const movedRef = useRef(false);

  const fixtures = useMemo<PatchFixture[]>(() =>
    (graphNodes || []).filter((n: any) => n.type === 'fixture').map(toFixture).filter(Boolean),
    [graphNodes]
  );

  const stacked = useMemo(() => {
    const s = new Set<string>();
    stacks.forEach(group => group.forEach(gid => s.add(gid)));
    return s;
  }, [stacks]);

  const usedChannels = fixtures.reduce((a, f) => a + f.len, 0);
  const conflictCount = fixtures.filter(f => f.hasConflict && !stacked.has(f.id)).length;

  // Группы-маркеры: явные из params.groups + производные от приборов
  const groupMarkers = useMemo(() => {
    const derived = new Map<number, number>();
    fixtures.forEach(f => derived.set(f.group, (derived.get(f.group) || 0) + 1));
    explicitGroups.forEach(g => { if (!derived.has(g)) derived.set(g, 0); });
    return [...derived.entries()].sort((a, b) => a[0] - b[0]);
  }, [fixtures, explicitGroups]);

  const dupGroups = useMemo(() => {
    const seen = new Set<number>();
    const dup = new Set<number>();
    explicitGroups.forEach(g => { if (seen.has(g)) dup.add(g); seen.add(g); });
    return dup;
  }, [explicitGroups]);

  const toggle = () => data?.onParamChange?.(id, 'expanded', !expanded);

  const selectOnly = (f: PatchFixture) => setSel(new Set([f.id]));
  const toggleSelect = (f: PatchFixture) => {
    setSel(prev => {
      const next = new Set(prev);
      if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
      return next;
    });
  };

  const onBarPointerDown = useCallback((e: React.PointerEvent, f: PatchFixture) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = { fid: f.id, origStart: f.start, startX: e.clientX, len: f.len, last: f.start };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const ns = clamp(d.origStart + Math.round((ev.clientX - d.startX) / CELL_W), 1, MAX_CHANNELS - d.len + 1);
      if (ns !== d.last) {
        d.last = ns;
        data?.onParamChange?.(d.fid, 'startChannel', ns);
      }
    };
    const onUp = () => {
      movedRef.current = dragRef.current ? dragRef.current.last !== dragRef.current.origStart : false;
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [data]);

  const onBarClick = useCallback((e: React.MouseEvent, f: PatchFixture) => {
    e.stopPropagation();
    if (movedRef.current) { movedRef.current = false; return; }
    if (e.ctrlKey || e.shiftKey) toggleSelect(f);
    else selectOnly(f);
  }, []);

  const setAddress = (v: string) => {
    const fid = [...sel][0];
    if (!fid) return;
    const f = fixtures.find(x => x.id === fid);
    if (!f) return;
    const ns = clamp(parseInt(v, 10) || f.start, 1, MAX_CHANNELS - f.len + 1);
    data?.onParamChange?.(fid, 'startChannel', ns);
  };

  const setGroups = (v: string) => {
    const g = parseInt(v, 10);
    if (isNaN(g) || g < 0) return;
    [...sel].forEach(fid => data?.onParamChange?.(fid, 'group', g));
  };

  const makeStack = () => {
    const ids = [...sel];
    if (ids.length < 2) return;
    const next = stacks.filter(s => !s.some(gid => ids.includes(gid)));
    next.push(ids);
    data?.onParamChange?.(id, 'stacks', next);
  };

  const unstack = () => {
    const ids = new Set(sel);
    const next = stacks
      .map(s => s.filter(gid => !ids.has(gid)))
      .filter(s => s.length > 1);
    data?.onParamChange?.(id, 'stacks', next);
  };

  const deleteSel = () => {
    [...sel].forEach(fid => data?.onDeleteNode?.(fid));
    setSel(new Set());
  };

  const addGroup = () => {
    const g = parseInt(newGroup, 10);
    if (isNaN(g)) return;
    data?.onParamChange?.(id, 'groups', [...explicitGroups, g]);
    setNewGroup('');
  };

  const saveToBank = () => {
    const fid = [...sel][0];
    if (!fid) return;
    const f = fixtures.find(x => x.id === fid);
    if (!f) return;
    const profile: FixtureProfile = {
      id: `${f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
      name: f.name,
      layout: f.layout.map(c => ({ offset: c.offset, label: c.label, type: c.type })),
    };
    saveFixtureProfile(profile);
    setBank(loadFixtureBank());
  };

  const createFromProfile = useCallback((profileId: string, ch: number) => {
    const profile = bank.find(p => p.id === profileId);
    if (!profile) return;
    const len = profile.layout.length;
    const start = clamp(ch, 1, MAX_CHANNELS - len + 1);
    const patchPos = getNode(id)?.position;
    const pos = patchPos ? { x: patchPos.x + 80, y: patchPos.y + 40 } : undefined;
    const builtin = isBuiltinType(profile.id);
    data?.onAddNode?.('fixture', pos, {
      label: `${profile.name} (CH ${start})`,
      params: {
        fixtureType: builtin ? profile.id : 'custom',
        ...(builtin ? {} : { customLayout: profile.layout }),
        startChannel: start,
        group: 0,
        manualValues: Array(len).fill(0),
        mutes: Array(len).fill(false),
        currentValues: Array(len).fill(0),
      },
    });
  }, [bank, data, getNode, id]);

  const selFixtures = fixtures.filter(f => sel.has(f.id));
  const singleSel = selFixtures.length === 1 ? selFixtures[0] : null;

  return (
    <div className={`bg-zinc-900 border-2 rounded-2xl shadow-2xl transition-all duration-300 ${selected ? 'border-zinc-500' : 'border-zinc-800'}`}
      style={{ width: 840 }}>
      {/* Заголовок */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 cursor-pointer" onClick={toggle}>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black uppercase tracking-widest text-cyan-400">⚡ Патч</span>
          <span className="text-[8px] text-zinc-600">
            приборов {fixtures.length} · каналов {usedChannels}/{MAX_CHANNELS}
            {conflictCount > 0 && <span className="text-red-500"> · конфликтов {conflictCount}</span>}
            {stacks.length > 0 && <span className="text-fuchsia-400"> · стаков {stacks.length}</span>}
          </span>
        </div>
        <span className="text-[10px] text-zinc-500">{expanded ? '▼' : '▶'}</span>
      </div>

      {expanded && (
        <div className="p-2 space-y-2">
          {/* Маркеры групп */}
          <div className="flex items-center gap-1 flex-wrap rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1">
            <span className="text-[8px] text-zinc-500 uppercase font-black mr-1">Группы (ALT+N):</span>
            {groupMarkers.length === 0 && <span className="text-[8px] text-zinc-600">нет групп</span>}
            {groupMarkers.map(([g, cnt]) => (
              <button key={g}
                className={`nodrag nopan text-[9px] font-black px-1.5 py-0.5 rounded-full border transition-all ${dupGroups.has(g) ? 'border-red-400 text-red-300 animate-pulse' : 'border-red-500/60 text-red-300'}`}
                style={{ background: focusGroup === g ? '#ef444444' : '#18181b' }}
                onClick={(e) => { e.stopPropagation(); setFocusGroup(focusGroup === g ? null : g); }}
                title={dupGroups.has(g) ? `⚠ Дубль номера группы ${g} в списке!` : `Группа ${g}: ${cnt} приборов. Клик — подсветить`}>
                {g}{cnt > 0 && <span className="ml-0.5 text-zinc-500">{cnt}</span>}
              </button>
            ))}
            <input
              className="nodrag nopan w-10 bg-zinc-800 rounded px-1 text-[9px] text-zinc-300 outline-none border border-zinc-700"
              placeholder="№"
              value={newGroup}
              onChange={e => setNewGroup(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addGroup(); }}
              onPointerDown={e => e.stopPropagation()}
            />
            <button className="nodrag nopan text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
              onClick={(e) => { e.stopPropagation(); addGroup(); }}>+</button>
            {dupGroups.size > 0 && (
              <span className="text-[8px] text-red-500 font-bold">⚠ одинаковые номера групп</span>
            )}
          </div>

          {/* Полотна юниверсов */}
          <div className="flex flex-col gap-2">
            <UniversePane
              title="Юниверс 1 · основная линия"
              subtitle="адреса 1–512"
              fixtures={fixtures}
              readonly={false}
              sel={sel}
              focusGroup={focusGroup}
              stacked={stacked}
              onBarPointerDown={onBarPointerDown}
              onBarClick={onBarClick}
              onDropProfile={(pid, ch) => createFromProfile(pid, ch)}
            />
            <UniversePane
              title="Юниверс 2 · зеркало U1"
              subtitle="те же адреса"
              fixtures={fixtures}
              readonly={true}
              sel={sel}
              focusGroup={focusGroup}
              stacked={stacked}
              onBarPointerDown={() => {}}
              onBarClick={() => {}}
              onDropProfile={() => {}}
            />
          </div>

          {/* Панель редактирования выбранных приборов */}
          {selFixtures.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap rounded-lg border border-cyan-500/30 bg-zinc-950 px-2 py-1.5">
              <span className="text-[8px] text-cyan-400 uppercase font-black">Выбрано: {selFixtures.length}</span>
              {singleSel ? (
                <>
                  <input
                    key={singleSel.id}
                    className="nodrag nopan w-14 bg-zinc-800 rounded px-1 text-[10px] text-zinc-200 outline-none border border-zinc-700"
                    defaultValue={singleSel.start}
                    onBlur={e => setAddress(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') setAddress((e.target as HTMLInputElement).value); }}
                    onPointerDown={e => e.stopPropagation()}
                    title="Адрес CH"
                  />
                  <span className="text-[8px] text-zinc-600">адрес ({singleSel.len} каналов)</span>
                </>
              ) : (
                <span className="text-[8px] text-zinc-500">адрес — по одному</span>
              )}
              <input
                className="nodrag nopan w-12 bg-zinc-800 rounded px-1 text-[10px] text-zinc-200 outline-none border border-zinc-700"
                placeholder="гр"
                defaultValue={selFixtures[0]?.group ?? 0}
                onBlur={e => setGroups(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') setGroups((e.target as HTMLInputElement).value); }}
                onPointerDown={e => e.stopPropagation()}
                title="Номер группы для всех выбранных"
              />
              <button className="nodrag nopan text-[9px] px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300 hover:bg-fuchsia-500/40 border border-fuchsia-500/40"
                onClick={() => makeStack()} disabled={selFixtures.length < 2} title="Намеренный параллель на одних адресах (спаренные приборы)">
                ⧉ Стак
              </button>
              <button className="nodrag nopan text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                onClick={() => unstack()} disabled={![...sel].some(fid => stacked.has(fid))} title="Убрать из стака">
                Разстак
              </button>
              {singleSel && (
                <button className="nodrag nopan text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/40 border border-amber-500/40"
                  onClick={() => saveToBank()} title="Сохранить профиль прибора в библиотеку">
                  В банк
                </button>
              )}
              <button className="nodrag nopan text-[9px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/40 border border-red-500/40"
                onClick={() => deleteSel()}>
                Удалить
              </button>
            </div>
          )}

          {/* Банк приборов */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5">
            <div className="text-[8px] text-zinc-500 uppercase font-black mb-1">
              Банк приборов <span className="normal-case font-normal">(перетащи на полотно U1)</span>
            </div>
            <div className="flex gap-1 flex-wrap">
              {bank.map(p => {
                const builtin = isBuiltinType(p.id);
                return (
                  <div key={p.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'copy'; }}
                    className="nodrag nopan group flex items-center gap-1 cursor-grab rounded-md border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 hover:border-cyan-400"
                    title={`${p.name} · ${p.layout.length} каналов`}>
                    <span className="text-[8px] text-zinc-300 whitespace-nowrap">{p.name}</span>
                    <span className="text-[8px] text-zinc-400 whitespace-nowrap">{p.layout.length}ch</span>
                    {!builtin && (
                      <button
                        className="text-[8px] text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100"
                        onClick={(e) => { e.stopPropagation(); removeFixtureProfile(p.id); setBank(loadFixtureBank()); }}
                        title="Удалить из банка">×</button>
                    )}
                  </div>
                );
              })}
              {bank.length === 0 && <span className="text-[8px] text-zinc-600">библиотека пуста</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
