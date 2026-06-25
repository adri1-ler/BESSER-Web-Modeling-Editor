import React, { useState } from 'react';
import { CollabUser } from './useCollaboration';
import { useCollaborationContext } from './CollaborationContext';

interface Props {
  isConnected: boolean;
  myColor: string | null;
  users: CollabUser[];
  sessionId: string | null;
  onStartCollaboration: () => void;
}

export const CollaborationPanel: React.FC<Props> = ({
  isConnected,
  myColor,
  users,
  sessionId,
  onStartCollaboration,
}) => {
  const [copied, setCopied] = useState(false);
  const { myUserId } = useCollaborationContext();

  // Find own user entry to display initials (populated after joining)
  const myUser = users.find((u) => u.user_id === myUserId);
  const myDisplayName = myUser?.name || 'Moi';

  // Exclude the current user from the peer list — they are already shown via the "Moi" dot.
  const otherUsers = users.filter((u) => u.user_id !== myUserId);

  const handleClick = () => {
    if (!isConnected) {
      onStartCollaboration();
      return;
    }
    // Build share URL with ?session= param
    const url = new URL(window.location.href);
    if (sessionId) url.searchParams.set('session', sessionId);
    navigator.clipboard.writeText(url.toString()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '4px 8px',
      }}
    >
      {/* Connected user avatars */}
      {isConnected && otherUsers.length > 0 && (
        <div style={{ display: 'flex', gap: '-4px', alignItems: 'center', marginRight: '4px' }}>
          {otherUsers.slice(0, 6).map((u) => (
            <div
              key={u.user_id}
              title={u.name}
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                backgroundColor: u.color,
                border: '2px solid white',
                marginLeft: '-4px',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '9px',
                color: 'white',
                fontWeight: 700,
              }}
            >
              {u.name.slice(0, 2)}
            </div>
          ))}
          {/* My own dot */}
          {myColor && (
            <div
              title={myDisplayName}
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                backgroundColor: myColor,
                border: '2px solid white',
                marginLeft: '-4px',
                boxShadow: `0 0 0 2px ${myColor}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '9px',
                color: 'white',
                fontWeight: 700,
              }}
            >
              {myDisplayName.slice(0, 2).toUpperCase()}
            </div>
          )}
        </div>
      )}

      {/* Status dot */}
      {isConnected && (
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            backgroundColor: '#38A169',
            flexShrink: 0,
          }}
          title="Collaboration active"
        />
      )}

      {/* Main button */}
      <button
        onClick={handleClick}
        style={{
          padding: '4px 12px',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 700,
          backgroundColor: isConnected ? '#38A169' : '#3182CE',
          color: 'white',
          border: 'none',
          cursor: 'pointer',
          letterSpacing: '0.02em',
          transition: 'background-color 0.15s',
          whiteSpace: 'nowrap',
        }}
      >
        {copied ? '✓ Lien copié !' : isConnected ? 'Copier le lien' : 'Collaborer'}
      </button>
    </div>
  );
};
