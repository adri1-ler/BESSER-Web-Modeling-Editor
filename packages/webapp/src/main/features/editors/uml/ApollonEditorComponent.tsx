import { ApollonEditor, UMLModel, diagramBridge, UMLElementsForDiagram, ColorLegendElementType, CommentsElementType } from '@besser/wme';
import type { UMLDiagramType } from '@besser/wme';
import React, { useCallback, useContext, useEffect, useRef } from 'react';

import { ApollonEditorContext } from './apollon-editor-context';
import { useAppDispatch, useAppSelector } from '../../../app/store/hooks';
import { isUMLModel } from '../../../shared/types/project';
import {
  updateDiagramModelThunk,
  selectActiveDiagram,
  selectEditorOptions,
  selectEditorRevision,
  selectStateMachineDiagrams,
  selectQuantumCircuitDiagrams,
} from '../../../app/store/workspaceSlice';
import { notifyError } from '../../../shared/utils/notifyError';
import { useCollaborationContext } from '../../collaboration/CollaborationContext';

// Types that are allowed in every diagram regardless of its primary type.
const UNIVERSAL_ELEMENT_TYPES = new Set<string>([
  ...Object.values(ColorLegendElementType),
  ...Object.values(CommentsElementType),
]);

/**
 * Remove elements whose type is not valid for the given diagram type.
 * Relationships are NOT filtered: they reference elements by ID, so orphaned
 * ones (whose source/target was removed) are simply ignored by Apollon.
 * This prevents cross-diagram copy-paste pollution (e.g. a UML Class
 * appearing in an AgentDiagram palette or model).
 */
function sanitizeModel(model: UMLModel, diagramType: UMLDiagramType): UMLModel {
  const allowed = UMLElementsForDiagram[diagramType];
  if (!allowed) return model;
  const allowedSet = new Set<string>([
    ...Object.values(allowed as Record<string, string>),
    ...UNIVERSAL_ELEMENT_TYPES,
  ]);

  const elements = Object.fromEntries(
    Object.entries(model.elements ?? {}).filter(([, el]) => allowedSet.has((el as { type: string }).type)),
  );

  return { ...model, elements };
}

export const ApollonEditorComponent: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ApollonEditor | null>(null);
  const modelSubscriptionRef = useRef<number | null>(null);
  const debouncedSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setupRunRef = useRef(0);
  const lastHandledRevisionRef = useRef(0);
  const dispatch = useAppDispatch();
  const reduxDiagram = useAppSelector(selectActiveDiagram);
  const options = useAppSelector(selectEditorOptions);
  const editorRevision = useAppSelector(selectEditorRevision);
  const stateMachineDiagrams = useAppSelector(selectStateMachineDiagrams);
  const quantumCircuitDiagrams = useAppSelector(selectQuantumCircuitDiagrams);
  const { setEditor } = useContext(ApollonEditorContext);

  // Stable refs so the setup effect can read current values without
  // needing them in its dependency array (avoids destroy/recreate loops).
  const reduxDiagramRef = useRef(reduxDiagram);
  reduxDiagramRef.current = reduxDiagram;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // --- Collaboration (via shared context from EditorView) ---
  const { sendModel, isRemoteUpdateRef, registerRemoteModelHandler } = useCollaborationContext();

  // Stable ref so the subscription closure always calls the latest sendModel.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendModelRef = useRef<any>(null);
  sendModelRef.current = sendModel;

  // Timestamp set each time the editor is (re)created. Used to suppress the
  // automatic model-change broadcast that Apollon fires ~50 ms after
  // nextEditor.model is set during tab initialisation.
  const editorCreatedAtRef = useRef(0);

  // Debounced save triggered by incoming remote models — avoids hammering Redux/
  // localStorage on every drag frame while keeping the editor visually in sync.
  const remoteSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRemoteModel = useCallback(
    (model: unknown, diagramType?: string, diagramId?: string) => {
      const editor = editorRef.current;
      if (!editor || !model) return;
      // Reject if sender is on a different diagram type.
      const currentType = optionsRef.current.type;
      if (diagramType && currentType && diagramType !== currentType) return;
      // Reject if sender is on a different sub-diagram (e.g. ClassDiagram[1] vs [0]).
      const currentDiagramId = reduxDiagramRef.current?.id;
      if (diagramId && currentDiagramId && diagramId !== currentDiagramId) return;
      // Re-stamp the diagram type and sanitize elements for this diagram type.
      const rawModel = model as UMLModel;
      const stamped = currentType ? { ...rawModel, type: currentType } : rawModel;
      const modelObj = currentType ? sanitizeModel(stamped, currentType) : stamped;
      // Update the editor visually right away (real-time drag sync).
      // subscribeToModelChange will fire ~50ms later and handle localStorage saving
      // (isRemoteUpdateRef prevents it from echoing back to peers).
      editor.model = modelObj;
      // Debounce the Redux/localStorage save so storage isn't written on every
      // drag frame — only once the stream of updates slows down.
      if (remoteSaveTimeoutRef.current) clearTimeout(remoteSaveTimeoutRef.current);
      remoteSaveTimeoutRef.current = setTimeout(() => {
        dispatch(updateDiagramModelThunk({ model: modelObj }));
      }, 400);
    },
    [dispatch],
  );

  useEffect(() => {
    registerRemoteModelHandler(handleRemoteModel);
    return () => registerRemoteModelHandler(null);
  }, [registerRemoteModelHandler, handleRemoteModel]);
  // --- End collaboration ---

  const destroyEditorDeferred = useCallback((editor: ApollonEditor) => {
    return new Promise<void>((resolve) => {
      // Defer destroy to avoid React unmount race warnings during render transitions.
      setTimeout(() => {
        try {
          editor.destroy();
        } catch (error) {
          console.warn('Error destroying editor:', error);
        } finally {
          resolve();
        }
      }, 0);
    });
  }, []);

  // Cleanup function
  const cleanupEditor = useCallback(async () => {
    // Clear any pending debounced saves
    if (debouncedSaveRef.current) {
      clearTimeout(debouncedSaveRef.current);
      debouncedSaveRef.current = null;
    }
    if (remoteSaveTimeoutRef.current) {
      clearTimeout(remoteSaveTimeoutRef.current);
      remoteSaveTimeoutRef.current = null;
    }
    const editor = editorRef.current;
    editorRef.current = null;
    if (!editor) return;
    // Unsubscribe from model changes before destroying
    if (modelSubscriptionRef.current !== null) {
      editor.unsubscribeFromModelChange(modelSubscriptionRef.current);
      modelSubscriptionRef.current = null;
    }
    await destroyEditorDeferred(editor);
  }, [destroyEditorDeferred]);

  useEffect(() => {
    const smDiagrams = stateMachineDiagrams ?? [];
    const qcDiagrams = quantumCircuitDiagrams ?? [];

    const stateMachines = smDiagrams
      .filter(d => d.id && d.title)
      .map(d => ({ id: d.id, name: d.title }));

    const quantumCircuits = qcDiagrams
      .filter(d => d.id && d.title)
      .map(d => ({ id: d.id, name: d.title }));

    diagramBridge.setStateMachineDiagrams(stateMachines);
    diagramBridge.setQuantumCircuitDiagrams(quantumCircuits);
  }, [stateMachineDiagrams, quantumCircuitDiagrams]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      setupRunRef.current += 1;
      cleanupEditor().catch(notifyError('Editor cleanup'));
      setEditor!(undefined);
    };
  }, [cleanupEditor, setEditor]);

  // Handle editor creation/recreation (initial load + diagram switches/templates).
  // Only runs when editorRevision actually changes (not on every Redux update).
  useEffect(() => {
    if (editorRevision === 0 || editorRevision === lastHandledRevisionRef.current) return;

    const setupEditor = async () => {
      if (!containerRef.current) return;

      lastHandledRevisionRef.current = editorRevision;
      const runId = ++setupRunRef.current;

      // Always destroy old editor before creating a new one
      await cleanupEditor();
      if (!containerRef.current || runId !== setupRunRef.current) return;

      const currentOptions = optionsRef.current;
      const currentDiagram = reduxDiagramRef.current;

      const nextEditor = new ApollonEditor(containerRef.current, currentOptions);
      editorRef.current = nextEditor;

      // Record creation time. The subscription callback will not broadcast
      // while Date.now() - editorCreatedAtRef.current < 800 ms, which safely
      // covers the Apollon-internal 50 ms debounce + our own 300 ms debounce
      // that fire when the initial model is loaded below. This prevents tab
      // switches from broadcasting the new-tab's model to all collaborators.
      editorCreatedAtRef.current = Date.now();

      await nextEditor.nextRender;
      if (runId !== setupRunRef.current || editorRef.current !== nextEditor) {
        await destroyEditorDeferred(nextEditor);
        return;
      }

      // Load diagram model if available (only UML models).
      // Always stamp model.type with the expected diagram type so the editor's
      // internal palette (CreatePane) receives the correct type even when an
      // old project stored a null or stale type field.
      if (currentDiagram?.model && isUMLModel(currentDiagram.model)) {
        const targetType = currentOptions.type;
        const modelToLoad = targetType
          ? { ...currentDiagram.model, type: targetType }
          : currentDiagram.model;
        nextEditor.model = modelToLoad;
      }

      // Subscribe to model changes.
      // - Collaboration broadcast: sent immediately so peers see live element movement.
      //   Apollon already debounces internally (~50 ms), which is fast enough for smooth
      //   real-time sync without flooding the WebSocket.
      // - localStorage save: debounced at 300 ms so storage isn't written on every
      //   drag frame; only once the user pauses or finishes moving.
      // The 800 ms settling window still suppresses the initial load broadcast.
      modelSubscriptionRef.current = nextEditor.subscribeToModelChange((model: UMLModel) => {
        const currentType = optionsRef.current.type;
        const clean = currentType ? sanitizeModel(model, currentType) : model;
        const msSinceEditorCreated = Date.now() - editorCreatedAtRef.current;

        // Broadcast to peers immediately (no extra debounce on top of Apollon's own).
        if (!isRemoteUpdateRef.current && msSinceEditorCreated > 800) {
          sendModelRef.current(clean, currentType, reduxDiagramRef.current?.id);
        }

        // Debounced localStorage / Redux save.
        if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);
        debouncedSaveRef.current = setTimeout(() => {
          dispatch(updateDiagramModelThunk({ model: clean }));
        }, 300);
      });

      setEditor!(nextEditor);
    };

    setupEditor().catch(notifyError('Editor setup'));
  }, [editorRevision, cleanupEditor, destroyEditorDeferred, dispatch, setEditor, isRemoteUpdateRef]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col grow overflow-hidden w-full h-full min-h-0"
      style={{ backgroundColor: 'var(--apollon-background, #ffffff)' }}
    />
  );
};
