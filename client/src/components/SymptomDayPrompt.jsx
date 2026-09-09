// -----------------------------------------------------------------------------
// Title:       SymptomDayPrompt.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-06
// Last Modified: 2026-09-06
// Purpose:     The end-of-day symptom reminder's UI: a small, dismissible card
//              asking whether an unlogged day was a clear one. IN-APP ONLY - it
//              is not a Web Push or Notification API surface, deliberately (see
//              DesktopPet's reminder effect for why that is a separate project).
//              Neutral wording: it asks a question about the record, it does not
//              congratulate a clear day or imply the user forgot something.
// Inputs:      props: onConfirm(), onDismiss()
// Outputs:     Portal-rendered card pinned above the nav bar
// -----------------------------------------------------------------------------

import { createPortal } from 'react-dom';
import { SYMPTOM_COLORS as C, MONO } from '../utils/symptomTheme';
import { useUIStore } from '../stores/useUIStore';

export default function SymptomDayPrompt({ onConfirm, onDismiss }) {
  const navBarHeight = useUIStore(s => s.navBarHeight);

  return createPortal(
    <div style={{
      position: 'fixed', left: 12, right: 12, bottom: navBarHeight + 12, zIndex: 55,
      background: C.panelRaised, border: `1px solid ${C.fieldBorder}`,
      borderRadius: 16, padding: '12px 14px',
      display: 'flex', alignItems: 'center', gap: 10,
      boxShadow: '0 8px 24px rgba(8,7,15,0.45)',
    }}>
      <span style={{ ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textMuted, flex: 1, minWidth: 0 }}>
        nothing logged today - was it a clear day?
      </span>
      <button
        onClick={onConfirm}
        style={{
          ...MONO, fontSize: 'var(--glim-text-2xs)', fontWeight: 600,
          background: C.accent, color: C.onAccent, border: 'none',
          borderRadius: 12, padding: '6px 14px', cursor: 'pointer', flexShrink: 0,
        }}
      >
        yes
      </button>
      <button
        onClick={onDismiss}
        style={{
          ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textFaint,
          background: 'none', border: `1px solid ${C.fieldBorder}`,
          borderRadius: 12, padding: '6px 12px', cursor: 'pointer', flexShrink: 0,
        }}
      >
        not now
      </button>
    </div>,
    document.body
  );
}
