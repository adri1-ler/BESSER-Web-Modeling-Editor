import React, { Suspense, useCallback, useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '../../app/store/hooks';
import {
  selectActiveDiagramType,
  selectActiveDiagramIndex,
  selectWorkspaceLoading,
  selectActiveDiagram,
  switchDiagramTypeThunk,
} from '../../app/store/workspaceSlice';
import type { SupportedDiagramType } from '../../shared/types/project';
import { ApollonEditorComponent } from './uml/ApollonEditorComponent';
import { EditorErrorBoundary } from '../../shared/components/error-handling/ErrorBoundary';
import { EditorSkeleton } from '../../shared/components/loading/EditorSkeleton';
import { SuspenseFallback } from '../../shared/components/loading/SuspenseFallback';
import { useCollaborationContext } from '../collaboration/CollaborationContext';
import { CollaborationCursors } from '../collaboration/CollaborationCursors';

// Lazy-loaded heavy editor integrations (GrapesJS ~1800 lines, Quantum ~350 lines)
const GraphicalUIEditor = React.lazy(() =>
  import('./gui').then((m) => ({ default: m.GraphicalUIEditor })),
);
const QuantumEditorComponent = React.lazy(() =>
  import('./quantum/QuantumEditorComponent').then((m) => ({ default: m.QuantumEditorComponent })),
);

const EditorContent: React.FC = () => {
  const dispatch = useAppDispatch();
  const activeDiagramType = useAppSelector(selectActiveDiagramType);
  const activeDiagramIndex = useAppSelector(selectActiveDiagramIndex);
  const isLoading = useAppSelector(selectWorkspaceLoading);
  const activeDiagram = useAppSelector(selectActiveDiagram);
  const { sessionId, isConnected, cursors, sendCursor, sendTabChange, setCurrentDiagramType, setCurrentDiagramId } =
    useCollaborationContext();

  // On mount: if the URL has ?type=, navigate to that diagram type so the
  // joining user lands on the same editor as the session host.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const typeFromUrl = params.get('type');
    const sessionFromUrl = params.get('session');
    if (typeFromUrl && sessionFromUrl) {
      dispatch(switchDiagramTypeThunk({ diagramType: typeFromUrl as SupportedDiagramType }));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Always track local diagram type so incoming model_update messages from peers
  // on a different tab can be filtered out — even without an active session.
  useEffect(() => {
    if (activeDiagramType) setCurrentDiagramType(activeDiagramType);
  }, [activeDiagramType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Always track local diagram ID for filtering incoming model_update messages
  useEffect(() => {
    if (activeDiagram?.id) setCurrentDiagramId(activeDiagram.id);
  }, [activeDiagram?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify peers whenever this user switches diagram type or sub-diagram.
  useEffect(() => {
    if (sessionId && activeDiagramType && activeDiagram?.id) {
      sendTabChange(activeDiagramType, activeDiagram.id);
    }
  }, [activeDiagramType, activeDiagram?.id, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendCursorRef = useRef(sendCursor);
  sendCursorRef.current = sendCursor;

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // For UML diagrams, convert to SVG diagram coordinates so the cursor position
    // is invariant to zoom and scroll — each peer then re-projects using their own CTM.
    const svg = e.currentTarget.querySelector<SVGSVGElement>('svg#modeling-editor-canvas');
    if (svg) {
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const diagramPt = pt.matrixTransform(ctm.inverse());
        sendCursorRef.current(diagramPt.x, diagramPt.y, activeDiagram?.id, 'diagram');
        return;
      }
    }
    // Fallback for non-UML editors (GrapesJS, Quantum): percentage of container.
    const rect = e.currentTarget.getBoundingClientRect();
    sendCursorRef.current(
      (e.clientX - rect.left) / rect.width,
      (e.clientY - rect.top) / rect.height,
      activeDiagram?.id,
      'pct',
    );
  }, [activeDiagram?.id]);

  if (isLoading) {
    return <EditorSkeleton />;
  }

  let editorNode: React.ReactNode;
  if (activeDiagramType === 'GUINoCodeDiagram') {
    editorNode = (
      <EditorErrorBoundary>
        <Suspense fallback={<SuspenseFallback message="Loading GUI editor..." />}>
          <GraphicalUIEditor key={`gui-${activeDiagramIndex}`} />
        </Suspense>
      </EditorErrorBoundary>
    );
  } else if (activeDiagramType === 'QuantumCircuitDiagram') {
    editorNode = (
      <EditorErrorBoundary>
        <Suspense fallback={<SuspenseFallback message="Loading quantum editor..." />}>
          <QuantumEditorComponent key={`quantum-${activeDiagramIndex}`} />
        </Suspense>
      </EditorErrorBoundary>
    );
  } else {
    editorNode = (
      <EditorErrorBoundary>
        <ApollonEditorComponent />
      </EditorErrorBoundary>
    );
  }

  return (
    <div
      className="flex flex-col grow overflow-hidden w-full h-full min-h-0"
      style={{ position: 'relative' }}
      onMouseMove={handleMouseMove}
    >
      {editorNode}
      {sessionId && (
        <CollaborationCursors
          cursors={cursors}
          activeDiagramType={activeDiagramType ?? undefined}
          activeDiagramId={activeDiagram?.id}
        />
      )}
    </div>
  );
};

// CollaborationProvider is now provided by WorkspaceShell — EditorView just renders the content.
export const EditorView: React.FC = () => <EditorContent />;
