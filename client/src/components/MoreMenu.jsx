// -----------------------------------------------------------------------------
// Title:       MoreMenu.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-04-05
// Last Modified: 2026-04-05
// Purpose:     "More" feature grid overlay. Slides up from the nav bar when the
//              user taps the "more" (•••) nav item. Shows a 3-column grid of
//              features categorized as "tracking" and "tools". Available features
//              are highlighted and tappable; future features are dimmed.
//              On mobile, nutrition lives here (it is in the nav bar on desktop).
// Inputs:      useUIStore (showMoreMenu, setShowMoreMenu, setActivePanel, etc.)
//              No props.
// Outputs:     Fixed-position overlay + scrim (z-index 45, above CompanionPanel)
// -----------------------------------------------------------------------------

import { useState, useEffect } from 'react';
import { useUIStore } from '../stores/useUIStore';

// ===== Feature icon components =====

function NutritionMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <path d="M7.5 9C5.5 10.5 4.5 13 5 15.5c.3 2 1.5 3.5 3 4.5 1 .6 2 .8 2.8.5.5-.2.8-.6 1.2-1 .4.4.7.8 1.2 1 .8.3 1.8.1 2.8-.5 1.5-1 2.7-2.5 3-4.5.5-2.5-.5-5-2.5-6.5C14.5 8 13.2 7.5 12 7.5S9.5 8 7.5 9z" />
      <ellipse cx="14" cy="5" rx="2.2" ry="1.2" transform="rotate(-45 14 5)" />
    </svg>
  );
}

// Diary page with a soft wave: an observation record, deliberately not a
// medical-cross or heartbeat glyph.
function SymptomsMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <rect x="4" y="3" width="16" height="18" rx="2.5" />
      <path d="M8 9h8" />
      <path d="M8 14c1.2 0 1.2-2 2.4-2s1.2 2 2.4 2 1.2-2 2.4-2" />
    </svg>
  );
}

function FocusMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function ExerciseMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

function MoodMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
    </svg>
  );
}

function SleepMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
}

function JournalMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function DashboardMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function TrendsMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function SettingsMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

// ===== Feature grid item =====

function MenuItem({ Icon, label, available, onTap }) {
  const iconBg   = available ? 'rgba(96,165,250,0.1)'  : 'rgba(200,210,230,0.06)';
  const iconColor = available ? 'rgba(96,165,250,0.75)' : 'rgba(200,210,230,0.6)';
  const labelColor = available ? 'rgba(200,210,230,0.7)' : 'rgba(200,210,230,0.5)';

  return (
    <div
      onClick={available ? onTap : undefined}
      style={{
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        gap:            6,
        padding:        '14px 8px',
        borderRadius:   12,
        cursor:         available ? 'pointer' : 'default',
        opacity:        available ? 1 : 0.3,
        transition:     'background 0.15s',
      }}
    >
      <div style={{
        width:          36,
        height:         36,
        borderRadius:   10,
        background:     iconBg,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        color:          iconColor,
      }}>
        <Icon />
      </div>
      <span style={{
        fontFamily: "'Courier New', monospace",
        fontSize:   'var(--glim-text-xs)',
        color:      labelColor,
        textAlign:  'center',
      }}>
        {label}
      </span>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      gridColumn:    '1 / -1',
      fontFamily:    "'Courier New', monospace",
      fontSize:      'var(--glim-text-2xs)',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color:         'rgba(200,210,230,0.25)',
      padding:       '8px 8px 2px',
    }}>
      {children}
    </div>
  );
}

// ===== Main component =====

export default function MoreMenu() {
  const {
    showMoreMenu,
    setShowMoreMenu,
    setActiveNav,
    setActivePanel,
    setFocusView,
    navBarHeight,
  } = useUIStore();

  const [visible, setVisible] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 600);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 600);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // Slide-in animation when showMoreMenu becomes true
  useEffect(() => {
    if (showMoreMenu) {
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    }
  }, [showMoreMenu]);

  if (!showMoreMenu) return null;

  const close = () => {
    setVisible(false);
    setTimeout(() => {
      setShowMoreMenu(false);
    }, 280);
  };

  const openFeature = (panelName) => {
    close();
    // Small delay so close animation starts before panel opens
    setTimeout(() => {
      setActiveNav(panelName);
      setActivePanel(panelName);
    }, 150);
  };

  const openSettings = () => {
    close();
    setTimeout(() => {
      setFocusView('settings');
    }, 150);
  };

  // On mobile, nutrition is available in the more menu.
  // On desktop, nutrition is in the nav bar so it is not shown as available here.
  const nutritionAvailable = isMobile;

  return (
    <>
      {/* Scrim - covers everything above the menu */}
      <div
        onClick={close}
        style={{
          position:   'fixed',
          top:        0,
          left:       0,
          right:      0,
          bottom:     navBarHeight,
          zIndex:     44,
          background: 'rgba(0,0,0,0.35)',
          opacity:    visible ? 1 : 0,
          transition: 'opacity 0.28s ease',
        }}
      />

      {/* Menu panel */}
      <div style={{
        position:       'fixed',
        left:           0,
        right:          0,
        bottom:         navBarHeight,
        zIndex:         45,
        background:     'rgba(20,24,45,0.96)',
        backdropFilter: 'blur(20px)',
        borderRadius:   '20px 20px 0 0',
        border:         '1px solid rgba(255,255,255,0.1)',
        borderBottom:   'none',
        transform:      visible ? 'translateY(0)' : 'translateY(100%)',
        transition:     'transform 0.28s ease-out',
      }}>
        {/* Drag handle */}
        <div style={{
          width:        36,
          height:       4,
          background:   'rgba(200,210,230,0.2)',
          borderRadius: 2,
          margin:       '10px auto 0',
        }} />

        {/* Header */}
        <div style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          padding:        '12px 24px 8px',
        }}>
          <span style={{
            fontFamily:  "'Courier New', monospace",
            fontSize:    'var(--glim-text-md)',
            fontWeight:  600,
            color:       'rgba(200,210,230,0.7)',
            letterSpacing: '0.5px',
          }}>
            features
          </span>
          <button
            onClick={close}
            className="glim-tap"
            style={{
              position:       'relative',
              width:          28,
              height:         28,
              borderRadius:   '50%',
              border:         'none',
              background:     'rgba(200,210,230,0.06)',
              color:          'rgba(200,210,230,0.4)',
              fontSize:       'var(--glim-text-lg)',
              cursor:         'pointer',
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
            }}
          >
            {'\u2715'}
          </button>
        </div>

        {/* Feature grid */}
        <div style={{
          display:               'grid',
          gridTemplateColumns:   'repeat(3, 1fr)',
          gap:                   4,
          padding:               '4px 16px 16px',
        }}>
          <SectionLabel>tracking</SectionLabel>

          <MenuItem
            Icon={NutritionMenuIcon}
            label="nutrition"
            available={nutritionAvailable}
            onTap={() => openFeature('nutrition')}
          />
          {/* Symptoms is not in the nav bar on any breakpoint: the diary is
              sought out, never surfaced. The More menu is its only entry point. */}
          <MenuItem
            Icon={SymptomsMenuIcon}
            label="symptoms"
            available={true}
            onTap={() => openFeature('symptoms')}
          />
          {/* Cycle, like symptoms, is never in the nav bar: it is sought out,
              not surfaced. The More menu is its only entry point, and the panel
              itself stays off until enabled on THIS device. */}
          <MenuItem
            Icon={SymptomsMenuIcon}
            label="cycle"
            available={true}
            onTap={() => openFeature('cycle')}
          />
          <MenuItem Icon={FocusMenuIcon}    label="focus"    available={false} />
          <MenuItem Icon={ExerciseMenuIcon} label="exercise" available={false} />
          <MenuItem Icon={MoodMenuIcon}     label="mood"     available={false} />
          <MenuItem Icon={SleepMenuIcon}    label="sleep"    available={false} />
          <MenuItem Icon={JournalMenuIcon}  label="journal"  available={false} />

          <SectionLabel>tools</SectionLabel>

          <MenuItem Icon={DashboardMenuIcon} label="dashboard" available={false} />
          <MenuItem Icon={TrendsMenuIcon}    label="trends"    available={false} />
          <MenuItem
            Icon={SettingsMenuIcon}
            label="settings"
            available={true}
            onTap={openSettings}
          />
        </div>
      </div>
    </>
  );
}
