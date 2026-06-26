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

const UNIVERSAL_ELEMENT_TYPES = new Set<string>([
  ...Object.values(ColorLegendElementType),
  ...Object.values(CommentsElementType),
]);

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

// Diffs current editor model against a received snapshot and applies only changed ops.
// Avoids the full editor.model = … setter (which triggers a full Redux rehydration).
function applyModelDiff(editor: ApollonEditor, received: UMLModel): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = received as any, c = editor.model as any;
  const recvEl = r.elements ?? {}, curEl = c.elements ?? {};
  const recvRel = r.relationships ?? {}, curRel = c.relationships ?? {};
  const patch: Array<{ op: string; path: string; value?: unknown }> = [];

  for (const [id, newE] of Object.entries(recvEl) as [string, any][]) {
    const cur = curEl[id];
    if (!cur) {
      patch.push({ op: 'add', path: `/elements/${id}`, value: newE });
    } else {
      const { x, y, width, height } = newE.bounds, cb = cur.bounds;
      if (x !== cb.x || y !== cb.y || width !== cb.width || height !== cb.height) {
        patch.push({ op: 'replace', path: `/elements/${id}/bounds`, value: newE.bounds });
      } else if (JSON.stringify(cur) !== JSON.stringify(newE)) {
        patch.push({ op: 'replace', path: `/elements/${id}`, value: newE });
      }
    }
  }
  for (const id of Object.keys(curEl)) {
    if (!recvEl[id]) patch.push({ op: 'remove', path: `/elements/${id}` });
  }

  for (const [id, newR] of Object.entries(recvRel) as [string, any][]) {
    const cur = curRel[id];
    if (!cur) {
      patch.push({ op: 'add', path: `/relationships/${id}`, value: newR });
    } else if (JSON.stringify(cur) !== JSON.stringify(newR)) {
      patch.push({ op: 'replace', path: `/relationships/${id}`, value: newR });
    }
  }
  for (const id of Object.keys(curRel)) {
    if (!recvRel[id]) patch.push({ op: 'remove', path: `/relationships/${id}` });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (patch.length > 0) editor.importPatch(patch as any);
}

function destroyEditorDeferred(editor: ApollonEditor): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      try { editor.destroy(); } catch (error) { console.warn('Error destroying editor:', error); }
      finally { resolve(); }
    }, 0);
  });
}

export const ApollonEditorComponent: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ApollonEditor | null>(null);
  const modelSubscriptionRef = useRef<number | null>(null);
  const continuousPatchSubRef = useRef<number | null>(null);
  const discretePatchSubRef = useRef<number | null>(null);
  const debouncedSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setupRunRef = useRef(0);
  const lastHandledRevisionRef = useRef(0);
  const lastPatchSendRef = useRef(0);
  const lastModelSendRef = useRef(0);
  const editorCreatedAtRef = useRef(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingPatchOpsRef = useRef<any[]>([]);
  const patchRafIdRef = useRef<number | null>(null);

  const dispatch = useAppDispatch();
  const reduxDiagram = useAppSelector(selectActiveDiagram);
  const options = useAppSelector(selectEditorOptions);
  const editorRevision = useAppSelector(selectEditorRevision);
  const stateMachineDiagrams = useAppSelector(selectStateMachineDiagrams);
  const quantumCircuitDiagrams = useAppSelector(selectQuantumCircuitDiagrams);
  const { setEditor } = useContext(ApollonEditorContext);

  const reduxDiagramRef = useRef(reduxDiagram);
  reduxDiagramRef.current = reduxDiagram;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const { sendModel, sendPatch, isRemoteUpdateRef, registerRemoteModelHandler, registerRemotePatchHandler } =
    useCollaborationContext();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendModelRef = useRef<any>(null);
  sendModelRef.current = sendModel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendPatchRef = useRef<any>(null);
  sendPatchRef.current = sendPatch;

  // Batches ops arriving within the same animation frame into one importPatch call.
  const handleRemotePatch = useCallback((patch: unknown) => {
    if (!patch || !Array.isArray(patch)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsigned = (patch as any[]).map(({ hash: _h, ...op }) => op);
    pendingPatchOpsRef.current.push(...unsigned);
    if (patchRafIdRef.current !== null) return;
    patchRafIdRef.current = requestAnimationFrame(() => {
      patchRafIdRef.current = null;
      const editor = editorRef.current;
      const ops = pendingPatchOpsRef.current.splice(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (editor && ops.length > 0) editor.importPatch(ops as any);
    });
  }, []);

  const handleRemoteModel = useCallback(
    (model: unknown, diagramType?: string, diagramId?: string, isInitialLoad?: boolean) => {
      const editor = editorRef.current;
      if (!editor || !model) return;
      const currentType = optionsRef.current.type;
      if (diagramType && currentType && diagramType !== currentType) return;
      if (diagramId && reduxDiagramRef.current?.id && diagramId !== reduxDiagramRef.current.id) return;

      // A full model supersedes any pending patches — cancel them to avoid stale ops
      // (e.g. patches from before a template load) re-adding elements that no longer exist.
      pendingPatchOpsRef.current = [];
      if (patchRafIdRef.current !== null) {
        cancelAnimationFrame(patchRafIdRef.current);
        patchRafIdRef.current = null;
      }

      const rawModel = model as UMLModel;
      const stamped = currentType ? { ...rawModel, type: currentType } : rawModel;
      const modelObj = currentType ? sanitizeModel(stamped, currentType) : stamped;

      if (isInitialLoad) {
        editor.model = modelObj;
      } else {
        applyModelDiff(editor, modelObj);
      }

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

  useEffect(() => {
    registerRemotePatchHandler(handleRemotePatch);
    return () => registerRemotePatchHandler(null);
  }, [registerRemotePatchHandler, handleRemotePatch]);

  const cleanupEditor = useCallback(async () => {
    if (debouncedSaveRef.current) { clearTimeout(debouncedSaveRef.current); debouncedSaveRef.current = null; }
    if (remoteSaveTimeoutRef.current) { clearTimeout(remoteSaveTimeoutRef.current); remoteSaveTimeoutRef.current = null; }
    if (patchRafIdRef.current !== null) { cancelAnimationFrame(patchRafIdRef.current); patchRafIdRef.current = null; }
    pendingPatchOpsRef.current = [];
    const editor = editorRef.current;
    editorRef.current = null;
    if (!editor) return;
    if (modelSubscriptionRef.current !== null) {
      editor.unsubscribeFromModelChange(modelSubscriptionRef.current);
      modelSubscriptionRef.current = null;
    }
    if (continuousPatchSubRef.current !== null) {
      editor.unsubscribeFromModelChangePatches(continuousPatchSubRef.current);
      continuousPatchSubRef.current = null;
    }
    if (discretePatchSubRef.current !== null) {
      editor.unsubscribeFromModelChangePatches(discretePatchSubRef.current);
      discretePatchSubRef.current = null;
    }
    await destroyEditorDeferred(editor);
  }, []);

  useEffect(() => {
    const smDiagrams = stateMachineDiagrams ?? [];
    const qcDiagrams = quantumCircuitDiagrams ?? [];
    diagramBridge.setStateMachineDiagrams(smDiagrams.filter(d => d.id && d.title).map(d => ({ id: d.id, name: d.title })));
    diagramBridge.setQuantumCircuitDiagrams(qcDiagrams.filter(d => d.id && d.title).map(d => ({ id: d.id, name: d.title })));
  }, [stateMachineDiagrams, quantumCircuitDiagrams]);

  useEffect(() => {
    return () => {
      setupRunRef.current += 1;
      cleanupEditor().catch(notifyError('Editor cleanup'));
      setEditor!(undefined);
    };
  }, [cleanupEditor, setEditor]);

  useEffect(() => {
    if (editorRevision === 0 || editorRevision === lastHandledRevisionRef.current) return;

    const setupEditor = async () => {
      if (!containerRef.current) return;
      lastHandledRevisionRef.current = editorRevision;
      const runId = ++setupRunRef.current;

      await cleanupEditor();
      if (!containerRef.current || runId !== setupRunRef.current) return;

      const currentOptions = optionsRef.current;
      const currentDiagram = reduxDiagramRef.current;

      const nextEditor = new ApollonEditor(containerRef.current, currentOptions);
      editorRef.current = nextEditor;
      editorCreatedAtRef.current = Date.now();
      lastPatchSendRef.current = 0;
      lastModelSendRef.current = 0;

      await nextEditor.nextRender;
      if (runId !== setupRunRef.current || editorRef.current !== nextEditor) {
        await destroyEditorDeferred(nextEditor);
        return;
      }

      if (currentDiagram?.model && isUMLModel(currentDiagram.model)) {
        const targetType = currentOptions.type;
        nextEditor.model = targetType ? { ...currentDiagram.model, type: targetType } : currentDiagram.model;
      }

      const msSinceCreated = () => Date.now() - editorCreatedAtRef.current;
      const shouldBroadcast = () => !isRemoteUpdateRef.current && msSinceCreated() > 800;

      // Throttled to 20 fps — enough for smooth collaboration without flooding the WebSocket.
      continuousPatchSubRef.current = nextEditor.subscribeToModelContinuousChangePatches((patch) => {
        if (!shouldBroadcast()) return;
        const now = Date.now();
        if (now - lastPatchSendRef.current < 50) return;
        lastPatchSendRef.current = now;
        sendPatchRef.current(patch, optionsRef.current.type, reduxDiagramRef.current?.id);
      });

      discretePatchSubRef.current = nextEditor.subscribeToModelChangePatches((patch) => {
        if (shouldBroadcast()) sendPatchRef.current(patch, optionsRef.current.type, reduxDiagramRef.current?.id);
      });

      modelSubscriptionRef.current = nextEditor.subscribeToModelChange((model: UMLModel) => {
        const currentType = optionsRef.current.type;
        const clean = currentType ? sanitizeModel(model, currentType) : model;

        if (shouldBroadcast()) {
          const now = Date.now();
          if (now - lastModelSendRef.current >= 100) {
            lastModelSendRef.current = now;
            sendModelRef.current(clean, currentType, reduxDiagramRef.current?.id);
          }
        }

        if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);
        debouncedSaveRef.current = setTimeout(() => {
          dispatch(updateDiagramModelThunk({ model: clean }));
        }, 300);
      });

      setEditor!(nextEditor);

      // After the 800ms broadcast-suppression window, force one full model send so that
      // collaborators who missed the initial load (e.g. after a template change that
      // remounts the editor) receive the current state.
      setTimeout(() => {
        if (runId !== setupRunRef.current || editorRef.current !== nextEditor) return;
        const currentModel = nextEditor.model;
        const type = optionsRef.current.type;
        const diagramId = reduxDiagramRef.current?.id;
        sendModelRef.current?.(currentModel, type, diagramId);
      }, 900);
    };

    setupEditor().catch(notifyError('Editor setup'));
  }, [editorRevision, cleanupEditor, dispatch, setEditor, isRemoteUpdateRef]);

  return (
    <div
      ref={containerRef}
      className="apollon-collab-container flex flex-col grow overflow-hidden w-full h-full min-h-0"
      style={{ backgroundColor: 'var(--apollon-background, #ffffff)' }}
    />
  );
};
