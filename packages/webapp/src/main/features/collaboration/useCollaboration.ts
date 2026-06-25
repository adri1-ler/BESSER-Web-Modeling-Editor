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
  /** Called when a remote user sends a full model update. */
  onRemoteModelUpdate: (model: unknown, diagramType?: string, diagramId?: string) => void;
}

interface CollaborationAPI {
  isConnected: boolean;
  myUserId: string | null;
  myColor: string | null;
  users: CollabUser[];
  cursors: Record<string, CursorPosition>;
  /** Send the full model to all peers (call after a local change). */
  sendModel: (model: unknown, diagramType?: string, diagramId?: string) => void;
  /** Send cursor position to all peers. Throttled internally. */
  sendCursor: (x: number, y: number, diagramId?: string, coordSpace?: 'diagram' | 'pct') => void;
  /** Notify peers of the active diagram type and ID. */
  sendTabChange: (diagramType: string, diagramId: string) => void;
}

export function useCollaboration({ sessionId, userName, userColor, onRemoteModelUpdate }: Options): CollaborationAPI {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myColor, setMyColor] = useState<string | null>(null);
  const [users, setUsers] = useState<CollabUser[]>([]);
  const [cursors, setCursors] = useState<Record<string, CursorPosition>>({});

  // Keep callback ref stable so the WS handler always calls the latest version.
  const onRemoteRef = useRef(onRemoteModelUpdate);
  onRemoteRef.current = onRemoteModelUpdate;

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
          setUsers((data.users as CollabUser[]) || []);
          // Pass diagramType/diagramId so the receiver can filter the model
          // and avoid overwriting the wrong diagram on join.
          if (data.model) onRemoteRef.current(data.model, data.diagramType as string | undefined, data.diagramId as string | undefined);
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
          onRemoteRef.current(data.model, data.diagramType as string | undefined, data.diagramId as string | undefined);
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

  return { isConnected, myUserId, myColor, users, cursors, sendModel, sendCursor, sendTabChange };
}
