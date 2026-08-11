
import { LuminaNode, LuminaEdge } from '../types';
import { FIXTURE_LAYOUTS } from '../constants';

export const computeAutoLayout = (
  nodes: LuminaNode[], 
  edges: LuminaEdge[], 
  mode: 'smart' | 'grid', 
  density: number
): LuminaNode[] => {
  const selectedNodes = nodes.filter(n => n.selected);
  const targets = selectedNodes.length > 1 ? selectedNodes : nodes;
  const targetIds = new Set(targets.map(n => n.id));
  
  // Calculate Bounds
  let originX = 50;
  let originY = 50;
  if (selectedNodes.length > 1) {
    originX = Math.min(...targets.map(n => n.position.x));
    originY = Math.min(...targets.map(n => n.position.y));
  }

  const GAP_X = 400 * density;
  const GAP_Y = 250 * density;
  const newPositions = new Map<string, {x: number, y: number}>();

  if (mode === 'grid') {
    const cols = Math.ceil(Math.sqrt(targets.length));
    const sortedTargets = [...targets].sort((a, b) => {
        if (a.type !== b.type) return (a.type || '').localeCompare(b.type || '');
        return (a.data.label as string).localeCompare(b.data.label as string);
    });
    sortedTargets.forEach((n, i) => { 
        const col = i % cols;
        const row = Math.floor(i / cols);
        newPositions.set(n.id, { x: originX + (col * GAP_X), y: originY + (row * GAP_Y) });
    });
  } else {
    // Smart Topological Sort
    const ranks = new Map<string, number>();
    const children = new Map<string, string[]>();
    const parents = new Map<string, string[]>();
    
    targets.forEach(n => {
      ranks.set(n.id, 0);
      children.set(n.id, []);
      parents.set(n.id, []);
    });

    edges.forEach(e => {
      if (targetIds.has(e.source) && targetIds.has(e.target)) {
        children.get(e.source)?.push(e.target);
        parents.get(e.target)?.push(e.source);
      }
    });

    // Assign Ranks (Safe topological rank assignment)
    const MAX_ITERATIONS = targets.length;
    for(let i=0; i < MAX_ITERATIONS; i++) {
       let changed = false;
       targets.forEach(n => {
           const ps = parents.get(n.id) || [];
           if (ps.length > 0) {
               const maxParentRank = Math.max(...ps.map(p => ranks.get(p) || 0));
               const newRank = maxParentRank + 1;
               if (ranks.get(n.id) !== newRank) {
                   ranks.set(n.id, newRank);
                   changed = true;
               }
           }
       });
       if (!changed) break;
    }
    
    targets.filter(n => n.type === 'fixture').forEach(n => {
        const r = ranks.get(n.id) || 0;
        ranks.set(n.id, Math.max(r, 2));
    });

    const layers: Record<number, LuminaNode[]> = {};
    targets.forEach(n => {
        const r = ranks.get(n.id) || 0;
        if (!layers[r]) layers[r] = [];
        layers[r].push(n);
    });

    const maxRank = Array.from(ranks.values()).length > 0 ? Math.max(...Array.from(ranks.values())) : 0;
    
    // Position nodes
    for (let r = 0; r <= Math.min(maxRank, 20); r++) {
        const layerNodes = layers[r];
        if (!layerNodes) continue;

        layerNodes.sort((a, b) => {
            const getAvgParentY = (nid: string) => {
               const ps = parents.get(nid) || [];
               if (ps.length === 0) return 0;
               const parentPositions = ps.map(pid => newPositions.get(pid)?.y || 0);
               return parentPositions.reduce((sum, y) => sum + y, 0) / ps.length;
            };
            
            const ay = getAvgParentY(a.id);
            const by = getAvgParentY(b.id);
            
            if (ay === 0 && by === 0) {
                // Если нет родителей, сортируем по типу для красоты (входы выше)
                const typeOrder: Record<string, number> = { input: 0, midi: 1, 'group-activator': 2, audio: 3, math: 4, fixture: 5 };
                const aOrder = typeOrder[a.type as string] ?? 99;
                const bOrder = typeOrder[b.type as string] ?? 99;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return (a.data.label as string).localeCompare(b.data.label as string);
            }
            return ay - by;
        });

        let layerY = originY;
        layerNodes.forEach((n) => {
            newPositions.set(n.id, { 
                x: originX + (r * GAP_X), 
                y: layerY 
            });
            // Динамический расчет высоты для плотной упаковки
            const nodeHeight = n.type === 'fixture' ? (n.data.params?.customLayout?.length || FIXTURE_LAYOUTS[n.data.params?.fixtureType as keyof typeof FIXTURE_LAYOUTS]?.length || 1) * 36 + 100 : 180;
            layerY += nodeHeight + 40;
        });
    }
  }

  return nodes.map(n => {
    if (newPositions.has(n.id)) {
        return { ...n, position: newPositions.get(n.id)! };
    }
    return n;
  });
};
