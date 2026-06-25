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

/**
 * Inject the CSS transition rules for smooth remote-update interpolation.
 * Called once at component mount — idempotent (checks for existing style tag).
 *
 * Why: remote position updates arrive at ~20 fps.  A 60 ms CSS transition on
 * SVG g[transform] makes the browser interpolate positions between Redux
 * updates, giving the remote viewer 60 fps smooth motion for free.
 *
 * The :active rule disables the transition while the LOCAL user is dragging
 * so their own elements track the cursor instantly with no perceived lag.
 */
function injectCollabTransitionStyle(): void {
  const STYLE_ID = 'apollon-collab-transition';
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
    .apollon-collab-container svg g[transform] {
      transition: transform 80ms linear;
      will-change: transform;
    }
    .apollon-collab-container:active svg g[transform] {
      transition: none;
      will-change: auto;
    }
  `;
  document.head.appendChild(el);
}

/**
 * Compute a minimal JSON patch from the diff between the current editor model
 * and a received full-model snapshot, then apply it via importPatch.
 *
 * Fast path for drag: direct field comparison on bounds (no JSON.stringify)
 * → only the moved element gets a patch operation.
 * Slow path for structural changes: full JSON.stringify diff.
 */
function applyModelDiff(editor: ApollonEditor, received: UMLModel): void {
  const current = editor.model;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recvEl: Record<string, any> = (received as any).elements ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const curEl: Record<string, any> = (current as any).elements ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recvRel: Record<string, any> = (received as any).relationships ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const curRel: Record<string, any> = (current as any).relationships ?? {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Array<{ op: string; path: string; value?: unknown }> = [];

  for (const [id, newE] of Object.entries(recvEl)) {
    const cur = curEl[id];
    if (!cur) {
      patch.push({ op: 'add', path: `/elements/${id}`, value: newE });
    } else {
      const nb = newE.bounds;
      const cb = cur.bounds;
      if (nb.x !== cb.x || nb.y !== cb.y || nb.width !== cb.width || nb.height !== cb.height) {
        // Bounds-only patch: tiny payload, avoids serialising the whole element.
        patch.push({ op: 'replace', path: `/elements/${id}/bounds`, value: nb });
      } else if (JSON.stringify(cur) !== JSON.stringify(newE)) {
        // Structural change (rename, colour, attribute added…).
        patch.push({ op: 'replace', path: `/elements/${id}`, value: newE });
      }
    }
  }
  for (const id of Object.keys(curEl)) {
    if (!recvEl[id]) patch.push({ op: 'remove', path: `/elements/${id}` });
  }

  for (const [id, newR] of Object.entries(recvRel)) {
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

  if (patch.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.importPatch(patch as any);
  }
}

export const ApollonEditorComponent: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ApollonEditor | null>(null);
  const modelSubscriptionRef = useRef<number | null>(null);
  const continuousPatchSubRef = useRef<number | null>(null);
  const discretePatchSubRef = useRef<number | null>(null);
  const debouncedSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotSendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setupRunRef = useRef(0);
  const lastHandledRevisionRef = useRef(0);
  // Throttle: prevent flooding the WebSocket with patch + model messages.
  const lastPatchSendRef = useRef(0);
  const lastModelSendRef = useRef(0);
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

  const editorCreatedAtRef = useRef(0);
  // RAF batching: patches that arrive within the same animation frame are
  // merged into a single importPatch call. This avoids redundant Redux
  // dispatches when bursts of WebSocket messages land faster than 60 fps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingPatchOpsRef = useRef<any[]>([]);
  const patchRafIdRef = useRef<number | null>(null);

  // Inject smooth-motion CSS once for the lifetime of the app.
  useEffect(() => { injectCollabTransitionStyle(); }, []);

  // Patch handler — fast path: importPatch without full model round-trip.
  // Strip 'hash' fields added by the sender's PatchVerifier: on the receiver
  // the local waitlist is different, so signed ops could be rejected or cause
  // stale waitlist entries.  Without hash the verifier accepts all incoming ops.
  //
  // RAF batching: accumulate ops and flush once per animation frame so the
  // Redux store is updated in sync with the screen refresh cycle, which lets
  // the CSS transition start at the exact right time for each painted frame.
  const handleRemotePatch = useCallback((patch: unknown) => {
    if (!patch || !Array.isArray(patch)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsigned = (patch as any[]).map(({ hash: _h, ...op }) => op);
    pendingPatchOpsRef.current.push(...unsigned);

    if (patchRafIdRef.current === null) {
      patchRafIdRef.current = requestAnimationFrame(() => {
        patchRafIdRef.current = null;
        const editor = editorRef.current;
        const ops = pendingPatchOpsRef.current;
        pendingPatchOpsRef.current = [];
        if (!editor || ops.length === 0) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.importPatch(ops as any);
      });
    }
  }, []);

  // Full-model handler — initial load: editor.model (acceptable once on join).
  // Live model_update snapshots: applyModelDiff avoids recreateEditor + flicker.
  const handleRemoteModel = useCallback(
    (model: unknown, diagramType?: string, diagramId?: string, isInitialLoad?: boolean) => {
      const editor = editorRef.current;
      if (!editor || !model) return;
      const currentType = optionsRef.current.type;
      if (diagramType && currentType && diagramType !== currentType) return;
      const currentDiagramId = reduxDiagramRef.current?.id;
      if (diagramId && currentDiagramId && diagramId !== currentDiagramId) return;
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

  const destroyEditorDeferred = useCallback((editor: ApollonEditor) => {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        try { editor.destroy(); } catch (error) { console.warn('Error destroying editor:', error); }
        finally { resolve(); }
      }, 0);
    });
  }, []);

  const cleanupEditor = useCallback(async () => {
    if (debouncedSaveRef.current) { clearTimeout(debouncedSaveRef.current); debouncedSaveRef.current = null; }
    if (snapshotSendTimeoutRef.current) { clearTimeout(snapshotSendTimeoutRef.current); snapshotSendTimeoutRef.current = null; }
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
  }, [destroyEditorDeferred]);

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

      // Continuous patches during drag — throttled to 20 fps (50 ms).
      // 20 fps is enough because the receiver's 60 ms CSS transition interpolates
      // between updates, giving the remote viewer smooth 60 fps visuals.
      // Keeping it at 20 fps instead of Apollon's native ~60 fps reduces:
      //   • WebSocket bandwidth by 3×
      //   • Receiver's importPatch pipeline cost by 3×
      continuousPatchSubRef.current = nextEditor.subscribeToModelContinuousChangePatches((patch) => {
        if (!shouldBroadcast()) return;
        const now = Date.now();
        if (now - lastPatchSendRef.current < 50) return; // 20 fps cap
        lastPatchSendRef.current = now;
        sendPatchRef.current(patch, optionsRef.current.type, reduxDiagramRef.current?.id);
      });

      // Discrete patch on drag-end / element add / delete / edit.
      // No throttle — these are rare and must be sent immediately for consistency.
      discretePatchSubRef.current = nextEditor.subscribeToModelChangePatches((patch) => {
        if (shouldBroadcast()) {
          sendPatchRef.current(patch, optionsRef.current.type, reduxDiagramRef.current?.id);
        }
      });

      // Full-model backup at max 10 fps (100 ms).
      // Ensures receivers that missed patches (tab hidden, slow connection) can
      // always catch up.  applyModelDiff on the receiver makes this flicker-free.
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
    };

    setupEditor().catch(notifyError('Editor setup'));
  }, [editorRevision, cleanupEditor, destroyEditorDeferred, dispatch, setEditor, isRemoteUpdateRef]);

  return (
    <div
      ref={containerRef}
      className="apollon-collab-container flex flex-col grow overflow-hidden w-full h-full min-h-0"
      style={{ backgroundColor: 'var(--apollon-background, #ffffff)' }}
    />
  );
};
