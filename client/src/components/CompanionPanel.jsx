// -----------------------------------------------------------------------------
// Title:       CompanionPanel.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-27
// Last Modified: 2026-03-30
// Purpose:     Slide-up companion mode panel. Renders when activePanel is set
//              in useUIStore. Animates up from the bottom over 300ms. Supports
//              drag-handle-to-dismiss (drag > 80px triggers close) and
//              tap-outside-to-dismiss. Panel sits above the nav bar.
//              Content is a placeholder per panel type until Phase 2 trackers
//              are built.
// Inputs:      Reads activePanel, setActivePanel, setActiveNav from useUIStore.
//              No props.
// Outputs:     Fixed-position overlay (backdrop) + slide-up panel
// -----------------------------------------------------------------------------

import { useState, useRef, useEffect } from 'react';
import { useUIStore } from '../stores/useUIStore';
import WaterPanel from './WaterPanel';
import StepsPanel from './StepsPanel';
import NutritionPanel from './NutritionPanel';
import SymptomsPanel from './SymptomsPanel';

// ===== Per-panel layout overrides =====
// Default panel height is 42vh. Symptoms is an approved deviation at ~62%: it
// carries a chip grid AND today's entry list, and compressing the creature zone
// to ~34% was signed off with the mockup.
const PANEL_HEIGHTS = {
  symptoms: '62vh',
};

// Panels that manage their own internal scroll split (fixed header area + one
// scrolling region) opt out of the outer scroll container.
const SELF_SCROLLING_PANELS = ['nutrition', 'symptoms'];

// ===== Placeholder content per panel type =====

function PanelContent({ type }) {
  const style = {
    fontFamily: "'Courier New', monospace",
    fontSize: 'var(--glim-text-sm)',
    color: 'rgba(255,255,255,0.4)',
    textAlign: 'center',
    padding: '32px 20px',
    lineHeight: 1.6,
  };
  const labels = {
    focus:     'pomodoro timer',
    tasks:     'to-do list',
    nutrition: 'nutrition tracker',
  };
  return (
    <div style={style}>
      <div style={{ fontSize: 'var(--glim-text-xl)', marginBottom: 12, opacity: 0.3 }}>
        {type === 'focus' ? '⏱' : type === 'tasks' ? '✓' : '🌿'}
      </div>
      <div>{labels[type] || type}</div>
      <div style={{ marginTop: 6, fontSize: 'var(--glim-text-xs)', opacity: 0.6 }}>coming soon</div>
    </div>
  );
}

// ===== Component =====

export default function CompanionPanel() {
  const { activePanel, setActivePanel, setActiveNav, navBarHeight, requestClose, setRequestClose } = useUIStore();

  // Drag-to-dismiss state
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [visible, setVisible] = useState(false);
  const startYRef = useRef(null);
  const prevPanelRef = useRef(null);

  // Slide in only when opening from home (no previous panel)
  useEffect(() => {
    if (activePanel) {
      if (prevPanelRef.current) {
        // Switching between panels - no animation, content swaps via re-render
      } else {
        // Opening from home - slide in
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setVisible(true));
        });
      }
    }
    prevPanelRef.current = activePanel;
  }, [activePanel]);

  // Handle toggle-close requests from NavBar (routes through dismiss for animation)
  useEffect(() => {
    if (requestClose) {
      setRequestClose(false);
      dismiss();
    }
  }, [requestClose]);

  const dismiss = () => {
    setVisible(false);
    // Wait for slide-out before clearing store
    setTimeout(() => {
      setActivePanel(null);
      setActiveNav('home');
    }, 300);
  };

  // Drag handle pointer events
  const handleHandlePointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    startYRef.current = e.clientY;
    setIsDragging(true);
  };

  const handleHandlePointerMove = (e) => {
    if (!isDragging || startYRef.current === null) return;
    const dy = Math.max(0, e.clientY - startYRef.current);
    setDragY(dy);
  };

  const handleHandlePointerUp = () => {
    if (dragY > 80) {
      dismiss();
    } else {
      setDragY(0);
    }
    setIsDragging(false);
    startYRef.current = null;
  };

  if (!activePanel) return null;

  const panelBottom = `${navBarHeight}px`;

  return (
    <>
      {/* Backdrop - tap outside to dismiss */}
      <div
        onClick={dismiss}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: navBarHeight + 'px',
          zIndex: 39,
          // No background - creature stays visible, backdrop is transparent
        }}
      />

      {/* Panel */}
      <div style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: panelBottom,
        height: PANEL_HEIGHTS[activePanel] ?? '42vh',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(8,6,20,0.92)',
        backdropFilter: 'blur(20px)',
        borderRadius: '20px 20px 0 0',
        border: '1px solid rgba(255,255,255,0.1)',
        borderBottom: 'none',
        transform: visible ? `translateY(${dragY}px)` : 'translateY(100%)',
        transition: isDragging ? 'none' : 'transform 300ms ease-out',
        touchAction: 'none',
      }}>
        {/* Drag handle */}
        <div
          onPointerDown={handleHandlePointerDown}
          onPointerMove={handleHandlePointerMove}
          onPointerUp={handleHandlePointerUp}
          onPointerCancel={handleHandlePointerUp}
          style={{
            padding: '12px 0 8px',
            cursor: 'grab',
            flexShrink: 0,
            touchAction: 'none',
          }}
        >
          <div style={{
            width: 36,
            height: 4,
            background: 'rgba(255,255,255,0.18)',
            borderRadius: 2,
            margin: '0 auto',
          }} />
        </div>

        {/* Scrollable content. Nutrition and symptoms manage their own scroll split. */}
        <div style={{
          flex:      1,
          overflowY: SELF_SCROLLING_PANELS.includes(activePanel) ? 'hidden' : 'auto',
          overflowX: 'hidden',
        }}>
          {activePanel === 'water'     ? <WaterPanel /> :
           activePanel === 'steps'     ? <StepsPanel /> :
           activePanel === 'nutrition' ? <NutritionPanel /> :
           activePanel === 'symptoms'  ? <SymptomsPanel /> :
           <PanelContent type={activePanel} />}
        </div>
      </div>
    </>
  );
}
