
import React, { memo } from 'react';
import {
  BaseEdge,
  getBezierPath,
  type EdgeProps
} from '@xyflow/react';
import { LuminaEdge } from '../types';

// memo: иначе все рёбра ре-рендерятся при любом движении любой ноды
const ButtonEdge = memo(function ButtonEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
}: EdgeProps<LuminaEdge>) {
  
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // The simplified edge only renders the path.
  // Visuals for deletion are handled via CSS (.alt-active)
  // Deletion logic is handled via onEdgeClick in App.tsx
  return (
    <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
  );
});

export default ButtonEdge;