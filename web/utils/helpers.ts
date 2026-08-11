
export const arraysEqual = (a: number[] | undefined, b: number[] | undefined) => {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

export const getColorFromName = (name: string): string => {
  const n = name.toLowerCase();
  if (n.includes('red')) return '#ef4444';
  if (n.includes('green') || n.includes('grn')) return '#10b981';
  if (n.includes('blue') || n.includes('blu')) return '#3b82f6';
  if (n.includes('white') || n.includes('wht')) return '#ffffff';
  if (n.includes('wash')) return '#f59e0b'; // Amber
  if (n.includes('top')) return '#8b5cf6'; // Purple
  if (n.includes('led')) return '#ec4899'; // Pink
  if (n.includes('fx') || n.includes('spider')) return '#06b6d4'; // Cyan
  if (n.includes('spark')) return '#f97316'; // Orange
  if (n.includes('laser')) return '#d946ef'; // Fuchsia
  return '#10b981'; // Default Emerald
};
