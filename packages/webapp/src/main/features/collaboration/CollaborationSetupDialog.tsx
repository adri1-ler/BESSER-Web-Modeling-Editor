import React, { useState } from 'react';

const PRESET_COLORS = [
  '#E53E3E', '#DD6B20', '#D69E2E', '#38A169',
  '#3182CE', '#805AD5', '#D53F8C', '#00B5D8',
  '#2C7A7B', '#553C9A', '#4A5568', '#E91E63',
];

interface Props {
  initialName: string;
  initialColor: string;
  onConfirm: (name: string, color: string) => void;
  onCancel: () => void;
}

export const CollaborationSetupDialog: React.FC<Props> = ({
  initialName,
  initialColor,
  onConfirm,
  onCancel,
}) => {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(name.trim() || 'Anonyme', color);
  };

  const initials = (name.trim() || 'A').slice(0, 2).toUpperCase();

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: 12,
          padding: '28px 32px',
          width: 360,
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          color: '#1a202c',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 17 }}>
          Rejoindre la session
        </div>

        {/* Name */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: '#718096' }}>
            Votre nom
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            placeholder="Ex : Alice"
            autoFocus
            style={{
              padding: '8px 12px',
              borderRadius: 7,
              border: '1.5px solid #cbd5e0',
              fontSize: 14,
              backgroundColor: '#f7fafc',
              color: '#1a202c',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>

        {/* Color */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: '#718096' }}>
            Votre couleur
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                title={c}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  backgroundColor: c,
                  border: color === c ? `3px solid #1a202c` : '2px solid #e2e8f0',
                  boxShadow: color === c ? `0 0 0 2px ${c}55` : 'none',
                  cursor: 'pointer',
                  padding: 0,
                  flexShrink: 0,
                  transform: color === c ? 'scale(1.2)' : 'scale(1)',
                  transition: 'transform 0.1s, box-shadow 0.1s',
                }}
              />
            ))}
            {/* Custom color picker swatch */}
            <label
              title="Couleur personnalisée"
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                border: !PRESET_COLORS.includes(color) ? '3px solid #1a202c' : '2px solid #e2e8f0',
                background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                style={{
                  opacity: 0,
                  position: 'absolute',
                  width: '100%',
                  height: '100%',
                  cursor: 'pointer',
                  padding: 0,
                  border: 'none',
                }}
              />
            </label>
          </div>

          {/* Avatar preview */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <div style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              backgroundColor: color,
              border: '2px solid white',
              boxShadow: `0 0 0 2px ${color}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              color: 'white',
              fontWeight: 700,
              flexShrink: 0,
            }}>
              {initials}
            </div>
            <span style={{ fontSize: 13, color: '#718096' }}>
              {name.trim() || 'Anonyme'}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '8px 18px',
              borderRadius: 7,
              border: '1.5px solid #cbd5e0',
              backgroundColor: 'transparent',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              color: '#4a5568',
              fontFamily: 'inherit',
            }}
          >
            Annuler
          </button>
          <button
            type="submit"
            style={{
              padding: '8px 22px',
              borderRadius: 7,
              border: 'none',
              backgroundColor: '#3182CE',
              color: 'white',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Rejoindre
          </button>
        </div>
      </form>
    </div>
  );
};
