import { useCallback, useEffect, useRef, useState } from 'react';

// Derive WebSocket base from BACKEND_URL env (set by Vite):
//   http://localhost:9000/besser_api  →  ws://localhost:9000
const _BACKEND_URL: string = (process.env.BACKEND_URL as string) || 'http://localhost:9000/besser_api';
const WS_BASE = _BACKEND_URL.replace(/^http/, 'ws').replace(/\/besser_api.*$/, '');

export interface CollabUser {
  user_id: string;
  color: string;
  name: string;
  currentDiagramType?: string;
  currentDiagramId?: string;
}

export interface CursorPosition {
  user_id: string;
  color: string;
  name: string;
  x: number;
  y: number;
  /**
   * 'diagram' = SVG canvas coordinates (zoom/scroll-invariant, used for UML editor).
   * 'pct'     = 0–1 fraction of container (fallback for non-UML editors).
   * Absent/undefined is treated as 'pct' for backward compatibility.
   */
  coordSpace?: 'diagram' | 'pct';
  diagramType?: string;
  diagramId?: string;
}

interface Options {
  sessionId: string | null;
  userName: string;
  userColor: string;
  /**
   * Called when a remote user sends a full model update.
   * `isInitialLoad = true` means this is the room_state snapshot (joining a room)
   * and the editor should load it via editor.model.
   * `isInitialLoad = false` means a live model_update — only save to Redux, no visual load.
   */
  onRemoteModelUpdate: (model: unknown, diagramType?: string, diagramId?: string, isInitialLoad?: boolean) => void;
  /** Called when a remote user sends a live patch (element drag). */
  onRemotePatchUpdate: (patch: unknown, diagramType?: string, diagramId?: string) => void;
}

interface CollaborationAPI {
  isConnected: boolean;
  myUserId: string | null;
  myColor: string | null;
  users: CollabUser[];
  cursors: Record<string, CursorPosition>;
  /** Send the full model to all peers (backend snapshot for late joiners). */
  sendModel: (model: unknown, diagramType?: string, diagramId?: string) => void;
  /** Send a JSON patch to all peers (live drag — no full model replace on receiver). */
  sendPatch: (patch: unknown, diagramType?: string, diagramId?: string) => void;
  /** Send cursor position to all peers. Throttled internally. */
  sendCursor: (x: number, y: number, diagramId?: string, coordSpace?: 'diagram' | 'pct') => void;
  /** Notify peers of the active diagram type and ID. */
  sendTabChange: (diagramType: string, diagramId: string) => void;
}

export function useCollaboration({ sessionId, userName, userColor, onRemoteModelUpdate, onRemotePatchUpdate }: Options): CollaborationAPI {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myColor, setMyColor] = useState<string | null>(null);
  const [users, setUsers] = useState<CollabUser[]>([]);
  const [cursors, setCursors] = useState<Record<string, CursorPosition>>({});

  const onRemoteRef = useRef(onRemoteModelUpdate);
  onRemoteRef.current = onRemoteModelUpdate;

  const onRemotePatchRef = useRef(onRemotePatchUpdate);
  onRemotePatchRef.current = onRemotePatchUpdate;

  // Throttle cursor sends to ~20 fps.
  const lastCursorTimeRef = useRef(0);

  useEffect(() => {
    if (!sessionId) return;

    const url = `${WS_BASE}/ws/collaborate/${encodeURIComponent(sessionId)}?name=${encodeURIComponent(userName)}&color=${encodeURIComponent(userColor)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setIsConnected(true);

    ws.onclose = () => {
      setIsConnected(false);
      setMyUserId(null);
      setMyColor(null);
      setUsers([]);
      setCursors({});
      wsRef.current = null;
    };

    ws.onerror = (err) => console.error('[Collaboration] WebSocket error', err);

    ws.onmessage = (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (data.type) {
        case 'room_state':
          setMyUserId(data.user_id as string);
          setMyColor(data.color as string);
          // Filter out the current user — the backend includes them in the list.
          setUsers(((data.users as CollabUser[]) || []).filter((u) => u.user_id !== (data.user_id as string)));
          // isInitialLoad=true: editor should load this via editor.model (one-time, no flicker concern).
          if (data.model) onRemoteRef.current(data.model, data.diagramType as string | undefined, data.diagramId as string | undefined, true);
          break;

        case 'user_joined':
          setUsers((prev) => [
            ...prev.filter((u) => u.user_id !== (data.user_id as string)),
            {
              user_id: data.user_id as string,
              color: data.color as string,
              name: data.name as string,
              currentDiagramType: data.currentDiagramType as string | undefined,
              currentDiagramId: data.currentDiagramId as string | undefined,
            },
          ]);
          break;

        case 'user_left':
          setUsers((prev) => prev.filter((u) => u.user_id !== (data.user_id as string)));
          setCursors((prev) => {
            const next = { ...prev };
            delete next[data.user_id as string];
            return next;
          });
          break;

        case 'user_tab_changed':
          setUsers((prev) =>
            prev.map((u) =>
              u.user_id === (data.user_id as string)
                ? {
                    ...u,
                    currentDiagramType: data.diagramType as string | undefined,
                    currentDiagramId: data.diagramId as string | undefined,
                  }
                : u,
            ),
          );
          break;

        case 'model_update':
          // isInitialLoad=false: this is a background snapshot, not an initial load.
          // Receivers apply it to Redux/localStorage only — patches handle the visual sync.
          onRemoteRef.current(data.model, data.diagramType as string | undefined, data.diagramId as string | undefined, false);
          break;

        case 'patch_update':
          if (data.patch) {
            onRemotePatchRef.current(data.patch, data.diagramType as string | undefined, data.diagramId as string | undefined);
          }
          break;

        case 'cursor_move':
          setCursors((prev) => ({
            ...prev,
            [data.user_id as string]: {
              user_id: data.user_id as string,
              color: data.color as string,
              name: data.name as string,
              x: data.x as number,
              y: data.y as number,
              coordSpace: (data.coordSpace as 'diagram' | 'pct' | undefined) ?? 'pct',
              diagramType: data.diagramType as string | undefined,
              diagramId: data.diagramId as string | undefined,
            },
          }));
          break;
      }
    };

    return () => {
      ws.close();
    };
  }, [sessionId, userName, userColor]);

  const sendModel = useCallback((model: unknown, diagramType?: string, diagramId?: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'model_update', model, diagramType, diagramId }));
    }
  }, []);

  const sendPatch = useCallback((patch: unknown, diagramType?: string, diagramId?: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'patch_update', patch, diagramType, diagramId }));
    }
  }, []);

  const sendCursor = useCallback((x: number, y: number, diagramId?: string, coordSpace?: 'diagram' | 'pct') => {
    const now = Date.now();
    if (now - lastCursorTimeRef.current < 50) return;
    lastCursorTimeRef.current = now;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'cursor_move', x, y, diagramId, coordSpace }));
    }
  }, []);

  const sendTabChange = useCallback((diagramType: string, diagramId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'tab_change', diagramType, diagramId }));
    }
  }, []);

  return { isConnected, myUserId, myColor, users, cursors, sendModel, sendPatch, sendCursor, sendTabChange };
}
