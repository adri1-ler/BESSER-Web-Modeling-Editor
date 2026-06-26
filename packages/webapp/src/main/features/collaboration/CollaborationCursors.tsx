import React, { useRef, useState, useEffect } from 'react';
import { CursorPosition } from './useCollaboration';

interface Props {
  cursors: Record<string, CursorPosition>;
  activeDiagramType?: string;
  activeDiagramId?: string;
}

function useEditorTransformWatcher() {
  const [, setTick] = useState(0);
  useEffect(() => {
    setTick((t) => t + 1);
    let rafId: number | null = null;
    const trigger = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => { rafId = null; setTick((t) => t + 1); });
    };
    window.addEventListener('wheel', trigger, { passive: true });
    window.addEventListener('scroll', trigger, { passive: true, capture: true });
    return () => {
      window.removeEventListener('wheel', trigger);
      window.removeEventListener('scroll', trigger, { capture: true });
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);
}

function toContainerPx(cursor: CursorPosition, container: HTMLDivElement): { left: number; top: number } | null {
  const rect = container.getBoundingClientRect();
  if (cursor.coordSpace === 'diagram') {
    const svg = document.querySelector<SVGSVGElement>('svg#modeling-editor-canvas');
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = cursor.x; pt.y = cursor.y;
    const screen = pt.matrixTransform(ctm);
    return { left: screen.x - rect.left, top: screen.y - rect.top };
  }
  return { left: cursor.x * rect.width, top: cursor.y * rect.height };
}

export const CollaborationCursors: React.FC<Props> = ({ cursors, activeDiagramType, activeDiagramId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  useEditorTransformWatcher();

  const filtered = Object.values(cursors).filter((cursor) => {
    if (activeDiagramId && cursor.diagramId) return cursor.diagramId === activeDiagramId;
    if (!activeDiagramId && !cursor.diagramId && activeDiagramType && cursor.diagramType)
      return cursor.diagramType === activeDiagramType;
    return false;
  });

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      {/* Remote user cursors */}
      {filtered.map((cursor) => {
        const pos = containerRef.current ? toContainerPx(cursor, containerRef.current) : null;
        if (!pos) return null;
        return (
          <div
            key={cursor.user_id}
            style={{
              position: 'absolute',
              left: pos.left,
              top: pos.top,
              pointerEvents: 'none',
              zIndex: 1000,
              transform: 'translate(-2px, -2px)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" style={{ overflow: 'visible', display: 'block' }}>
              <path
                d="M0 0 L0 14 L4 10 L8 18 L10 17 L6 9 L12 9 Z"
                fill={cursor.color}
                stroke="white"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            <div
              style={{
                position: 'absolute',
                top: '18px',
                left: '10px',
                backgroundColor: cursor.color,
                color: '#fff',
                padding: '2px 7px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 700,
                whiteSpace: 'nowrap',
                boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
                letterSpacing: '0.01em',
              }}
            >
              {cursor.name}
            </div>
          </div>
        );
      })}
    </div>
  );
};
