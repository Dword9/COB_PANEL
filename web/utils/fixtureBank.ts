
import { FIXTURE_LAYOUTS } from '../constants';

export interface FixtureProfile {
  id: string;
  name: string;
  layout: { offset: number; label: string; type: string }[];
}

const BANK_KEY = 'lumina-fixture-bank';
const HIDDEN_KEY = 'lumina-bank-hidden';

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x: any) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

const BUILTIN_NAMES: Record<string, string> = {
  dimmer: 'Dimmer / PAR (1ch)',
  led_par: 'LED PAR (6ch)',
  led_par_8ch: 'LED PAR 8ch / COB',
  spider: 'Spider (13ch)',
  spark: 'Spark (2ch)',
  laser: 'Laser (8ch)',
  comb_rgbw: 'Расчёска RGBW (43ch)',
  mini_par: 'Mini PAR RGBW (7ch)',
};

const builtinProfiles = (): FixtureProfile[] =>
  Object.entries(FIXTURE_LAYOUTS).map(([id, layout]) => ({
    id,
    name: BUILTIN_NAMES[id] || id,
    layout: layout as { offset: number; label: string; type: string }[],
  }));

const isBuiltin = (id: string) => Object.prototype.hasOwnProperty.call(FIXTURE_LAYOUTS, id);

export function loadFixtureBank(): FixtureProfile[] {
  const hidden = loadHidden();
  const builtin = builtinProfiles().filter(p => !hidden.has(p.id));
  try {
    const raw = localStorage.getItem(BANK_KEY);
    if (!raw) return builtin;
    const custom = JSON.parse(raw);
    if (!Array.isArray(custom)) return builtin;
    const valid = custom.filter((p: any) =>
      p && typeof p === 'object' && typeof p.name === 'string' &&
      Array.isArray(p.layout) && p.layout.length > 0);
    return [...builtin, ...valid];
  } catch {
    return builtin;
  }
}

function loadCustom(): FixtureProfile[] {
  try {
    const raw = localStorage.getItem(BANK_KEY);
    if (!raw) return [];
    const custom = JSON.parse(raw);
    if (!Array.isArray(custom)) return [];
    return custom.filter((p: any) => p && typeof p === 'object' && typeof p.name === 'string');
  } catch {
    return [];
  }
}

export function saveFixtureProfile(profile: FixtureProfile) {
  if (isBuiltin(profile.id)) return;
  const next = loadCustom().filter(p => p.id !== profile.id);
  next.push(profile);
  localStorage.setItem(BANK_KEY, JSON.stringify(next));
}

export function removeFixtureProfile(id: string) {
  if (isBuiltin(id)) {
    // Дефолтный профиль нельзя удалить физически (он в FIXTURE_LAYOUTS),
    // поэтому прячем его через скрытый список (17.08).
    const h = loadHidden();
    h.add(id);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...h]));
    return;
  }
  localStorage.setItem(BANK_KEY, JSON.stringify(loadCustom().filter(p => p.id !== id)));
}

export function isBuiltinProfile(id: string): boolean {
  return isBuiltin(id);
}
