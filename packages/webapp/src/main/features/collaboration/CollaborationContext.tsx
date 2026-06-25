import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useCollaboration, CollabUser, CursorPosition } from './useCollaboration';
import { CollaborationSetupDialog } from './CollaborationSetupDialog';

const PRESET_COLORS = [
  '#E53E3E', '#DD6B20', '#D69E2E', '#38A169',
  '#3182CE', '#805AD5', '#D53F8C', '#00B5D8',
  '#2C7A7B', '#553C9A', '#4A5568', '#2D3748',
];

function randomPresetColor(): string {
  return PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
}

export interface CollaborationContextValue {
  sessionId: string | null;
  startCollaboration: (diagramId: string, diagramType?: string) => void;
  isConnected: boolean;
  myColor: string | null;
  myUserId: string | null;
  users: CollabUser[];
  cursors: Record<string, CursorPosition>;
  sendModel: (model: unknown, diagramType?: string, diagramId?: string) => void;
  sendPatch: (patch: unknown, diagramType?: string, diagramId?: string) => void;
  sendCursor: (x: number, y: number, diagramId?: string, coordSpace?: 'diagram' | 'pct') => void;
  sendTabChange: (diagramType: string, diagramId: string) => void;
  setCurrentDiagramType: (type: string) => void;
  setCurrentDiagramId: (id: string) => void;
  isRemoteUpdateRef: React.MutableRefObject<boolean>;
  registerRemoteModelHandler: (handler: ((model: unknown, diagramType?: string, diagramId?: string, isInitialLoad?: boolean) => void) | null) => void;
  registerRemotePatchHandler: (handler: ((patch: unknown, diagramType?: string, diagramId?: string) => void) | null) => void;
}

const CollaborationContext = createContext<CollaborationContextValue | null>(null);

export const CollaborationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Always start disconnected — connection only happens after the setup dialog is confirmed.
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Read URL params once at mount.
  const _urlSession = new URLSearchParams(window.location.search).get('session');
  const _urlType = new URLSearchParams(window.location.search).get('type') ?? undefined;

  const [pendingSessionId, setPendingSessionId] = useState<string | null>(_urlSession);
  const [pendingDiagramType, setPendingDiagramType] = useState<string | undefined>(_urlType);

  // Show the setup dialog immediately when the page was reached via a shared link
  // (?session= present) but NOT on a plain page reload (F5).
  // performance.navigation.type === 1 means reload; anything else is a fresh navigation.
  const [showSetupDialog, setShowSetupDialog] = useState<boolean>(() => {
    if (!_urlSession) return false;
    const navType = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type;
    return navType !== 'reload';
  });

  // User identity — reset to empty/random each session (not persisted)
  const [userName, setUserName] = useState<string>('');
  const [userColor, setUserColor] = useState<string>(randomPresetColor);

  const isRemoteUpdateRef = useRef(false);
  const remoteUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteHandlerRef = useRef<((model: unknown, diagramType?: string, diagramId?: string, isInitialLoad?: boolean) => void) | null>(null);
  const remotePatchHandlerRef = useRef<((patch: unknown, diagramType?: string, diagramId?: string) => void) | null>(null);
  const currentDiagramTypeRef = useRef<string | null>(null);
  const currentDiagramIdRef = useRef<string | null>(null);

  const setCurrentDiagramType = useCallback((type: string) => {
    currentDiagramTypeRef.current = type;
  }, []);

  const setCurrentDiagramId = useCallback((id: string) => {
    currentDiagramIdRef.current = id;
  }, []);

  const handleRemoteModel = useCallback((model: unknown, diagramType?: string, diagramId?: string, isInitialLoad?: boolean) => {
    if (diagramType && currentDiagramTypeRef.current && diagramType !== currentDiagramTypeRef.current) return;
    isRemoteUpdateRef.current = true;
    remoteHandlerRef.current?.(model, diagramType, diagramId, isInitialLoad);
    if (remoteUpdateTimerRef.current) clearTimeout(remoteUpdateTimerRef.current);
    remoteUpdateTimerRef.current = setTimeout(() => {
      isRemoteUpdateRef.current = false;
    }, 300);
  }, []);

  const handleRemotePatch = useCallback((patch: unknown, diagramType?: string, diagramId?: string) => {
    if (diagramType && currentDiagramTypeRef.current && diagramType !== currentDiagramTypeRef.current) return;
    isRemoteUpdateRef.current = true;
    remotePatchHandlerRef.current?.(patch, diagramType, diagramId);
    if (remoteUpdateTimerRef.current) clearTimeout(remoteUpdateTimerRef.current);
    remoteUpdateTimerRef.current = setTimeout(() => {
      isRemoteUpdateRef.current = false;
    }, 300);
  }, []);

  const { isConnected, myUserId, myColor, users, cursors, sendModel, sendPatch, sendCursor, sendTabChange } = useCollaboration({
    sessionId,
    userName,
    userColor,
    onRemoteModelUpdate: handleRemoteModel,
    onRemotePatchUpdate: handleRemotePatch,
  });

  // "Collaborer" button clicked → show setup dialog before connecting.
  // If the URL already contains a ?session= (shared link), use that session ID
  // so the joining user lands in the correct room.
  const startCollaboration = useCallback((diagramId: string, diagramType?: string) => {
    const urlSession = new URLSearchParams(window.location.search).get('session');
    setPendingSessionId(urlSession ?? diagramId);
    setPendingDiagramType(diagramType);
    setShowSetupDialog(true);
  }, []);

  // User confirmed name + color in the setup dialog
  const handleConfirmSetup = useCallback((name: string, color: string) => {
    setUserName(name);
    setUserColor(color);

    const sid = pendingSessionId;
    const dtype = pendingDiagramType;
    setShowSetupDialog(false);
    setPendingSessionId(null);
    setPendingDiagramType(undefined);

    if (sid) {
      setSessionId(sid);
      const url = new URL(window.location.href);
      url.searchParams.set('session', sid);
      if (dtype) url.searchParams.set('type', dtype);
      window.history.replaceState({}, '', url.toString());
    }
  }, [pendingSessionId, pendingDiagramType]);

  const handleCancelSetup = useCallback(() => {
    setShowSetupDialog(false);
    setPendingSessionId(null);
    setPendingDiagramType(undefined);
    // Remove ?session= from URL if we were joining via link but user cancelled
    const url = new URL(window.location.href);
    if (url.searchParams.has('session')) {
      url.searchParams.delete('session');
      url.searchParams.delete('type');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const registerRemoteModelHandler = useCallback(
    (handler: ((model: unknown, diagramType?: string, diagramId?: string, isInitialLoad?: boolean) => void) | null) => {
      remoteHandlerRef.current = handler;
    },
    [],
  );

  const registerRemotePatchHandler = useCallback(
    (handler: ((patch: unknown, diagramType?: string, diagramId?: string) => void) | null) => {
      remotePatchHandlerRef.current = handler;
    },
    [],
  );

  return (
    <CollaborationContext.Provider
      value={{
        sessionId,
        startCollaboration,
        isConnected,
        myColor,
        myUserId,
        users,
        cursors,
        sendModel,
        sendPatch,
        sendCursor,
        sendTabChange,
        setCurrentDiagramType,
        setCurrentDiagramId,
        isRemoteUpdateRef,
        registerRemoteModelHandler,
        registerRemotePatchHandler,
      }}
    >
      {children}
      {showSetupDialog && (
        <CollaborationSetupDialog
          initialName={userName}
          initialColor={userColor}
          onConfirm={handleConfirmSetup}
          onCancel={handleCancelSetup}
        />
      )}
    </CollaborationContext.Provider>
  );
};

export function useCollaborationContext(): CollaborationContextValue {
  const ctx = useContext(CollaborationContext);
  if (!ctx) throw new Error('useCollaborationContext must be used within CollaborationProvider');
  return ctx;
}
