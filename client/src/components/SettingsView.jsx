// -----------------------------------------------------------------------------
// Title:       SettingsView.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-04-13
// Last Modified: 2026-09-15
// Purpose:     Full-screen focus-mode settings view. Replaces the old gear-icon
//              floating panel. Accessed via the "more" menu. Manages collapsible
//              accordion sections with single-expand behavior (opening one
//              section auto-collapses any other). Each section is its own
//              component that reads/writes its tracker store directly.
//              Sign-out and reset-all-data live at the bottom.
// Inputs:      useUIStore (focusView, setFocusView), useSettingsStore,
//              useWaterStore, useStepsStore, useNutritionStore
// Outputs:     Full-screen overlay at z-index 50
// -----------------------------------------------------------------------------

import { useState, useEffect } from 'react';
import { signOut } from 'firebase/auth';
import { deleteDoc, getDocs, collection, doc } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { auth, db } from '../firebase';
import { flushSync } from '../sync';
import { useUIStore } from '../stores/useUIStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useWaterStore } from '../stores/useWaterStore';
import { useStepsStore } from '../stores/useStepsStore';
import { useNutritionStore } from '../stores/useNutritionStore';

import RemindersSettings, { remindersSummary, remindersIcon } from './settings/RemindersSettings';
import WaterSettings, { waterSummary, waterIcon } from './settings/WaterSettings';
import StepsSettings, { stepsSummary, stepsIcon } from './settings/StepsSettings';
import NutritionSettings, { nutritionSummary, nutritionIcon } from './settings/NutritionSettings';

// localStorage keys cleared by "reset all data".
//
// KNOWN DEFECT (logged 2026-07-16 as two BACKLOG items in glim_handoff.Rmd,
// amended 2026-09-06 for the symptom domains; also in the Decision Register
// entry of 2026-09-06): this list and deleteFirestoreData below are INCOMPLETE.
// The four symptom keys/collections (glim-symptoms, glim-symptoms-library,
// glim-symptoms-categories, glim-symptom-days) are absent from both, and
// deleteFirestoreData clears only journal and water plus three singletons. So
// "reset all data" leaves symptom health records in localStorage AND in
// Firestore, and the domains it clears locally but not remotely (steps,
// nutrition, nutrition library) are re-pulled on the next sync. Not fixed here
// because the correct scope of reset - and whether it must refuse to run
// offline, since a local-only clear is undone by the next pull - is a product
// decision, not a code one. The UID-change guard in App.jsx uses a prefix scan
// for exactly this reason and is not affected.
const LOCAL_KEYS = [
  'glim-water', 'glim-steps', 'glim-journal', 'glim-pokes',
  'glim-settings', 'glim-sync-meta', 'glim-uid', 'glim-nutrition',
  'glim-nutrition-library',
];

// Firestore collections/singletons to delete (best-effort)
async function deleteFirestoreData(uid) {
  for (const col of ['journal', 'water']) {
    try {
      const snap = await getDocs(collection(db, 'users', uid, col));
      await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
    } catch { /* ignore */ }
  }
  const singletons = [
    ['pokes', 'counters'],
    ['settings', 'current'],
    ['water-config', 'current'],
  ];
  for (const [col, id] of singletons) {
    try {
      await deleteDoc(doc(db, 'users', uid, col, id));
    } catch { /* ignore */ }
  }
}

// Chevron SVG (rotates 180deg when section is expanded)
function Chevron({ expanded }) {
  return (
    <svg
      viewBox="0 0 20 20" fill="none"
      style={{
        width: 20, height: 20, flexShrink: 0, marginLeft: 8,
        color: 'rgba(200,210,230,0.35)',
        transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.25s ease',
      }}
    >
      <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Display section placeholder
const displayIcon = (
  <div style={{
    width: 32, height: 32, borderRadius: 8,
    background: 'rgba(160,120,200,0.25)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 'var(--glim-text-lg)', flexShrink: 0,
  }}>
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none"
      stroke="rgba(180,160,220,0.8)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  </div>
);

// --- Section definitions ---
const SECTIONS = [
  { id: 'reminders',  title: 'reminders',       icon: remindersIcon,  getSummary: remindersSummary, Component: RemindersSettings },
  { id: 'water',      title: 'water',            icon: waterIcon,      getSummary: waterSummary,     Component: WaterSettings },
  { id: 'steps',      title: 'steps',            icon: stepsIcon,      getSummary: stepsSummary,     Component: StepsSettings },
  { id: 'nutrition',  title: 'nutrition goals',   icon: nutritionIcon,  getSummary: nutritionSummary, Component: NutritionSettings },
  { id: 'display',    title: 'display',           icon: displayIcon,    getSummary: () => 'water avg: bottles, theme: auto', Component: null },
];

export default function SettingsView() {
  const { focusView, setFocusView } = useUIStore();
  const settingsStore = useSettingsStore();
  const waterStore = useWaterStore();
  const stepsStore = useStepsStore();
  const nutritionStore = useNutritionStore();

  const [activeSection, setActiveSection] = useState(null);
  const [visible, setVisible] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Slide-in animation
  useEffect(() => {
    if (focusView === 'settings') {
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    }
  }, [focusView]);

  if (focusView !== 'settings') return null;

  const close = () => {
    setVisible(false);
    setTimeout(() => {
      setFocusView(null);
      setActiveSection(null);
      setShowConfirm(false);
      setConfirmText('');
    }, 300);
  };

  const toggleSection = (id) => {
    setActiveSection(prev => prev === id ? null : id);
  };

  // Map section ids to their store for summary computation
  const storeForSection = {
    reminders: settingsStore,
    water: waterStore,
    steps: stepsStore,
    nutrition: nutritionStore,
    display: null,
  };

  const canDelete = confirmText.trim().toLowerCase() === 'delete';

  const handleReset = async () => {
    if (!canDelete || deleting) return;
    setDeleting(true);
    LOCAL_KEYS.forEach(k => localStorage.removeItem(k));
    const uid = auth.currentUser?.uid;
    if (uid) await deleteFirestoreData(uid).catch(() => {});
    window.location.reload();
  };

  // Run a FULL sync while still authenticated, so anything written since the
  // last one reaches Firestore before the session (and, on an account switch,
  // its localStorage) ends. flushSync waits for any run already in flight and
  // then performs a full run (push + pull): this call is awaited, so it can
  // afford the read that makes pushing the mutable domains (symptoms,
  // libraries, categories, clear days) safe, whereas the fire-and-forget
  // tab-hide flushWriteOnce cannot and so skips them. Best-effort: sign-out
  // must proceed even if the sync fails (e.g. offline). The reset-all-data
  // path deliberately does NOT sync - it is a delete, so pushing first would
  // be counterproductive.
  const handleSignOut = async () => {
    try { await flushSync('sign-out'); } catch { /* ignore */ }
    // Native sign-in leaves two independent sessions: the native Firebase SDK
    // plus the Google provider, and the JS SDK. Both must be cleared. A
    // surviving native session makes the next sign-in reuse the old account
    // silently, which also defeats the prompt: 'select_account' parameter set
    // on googleProvider in firebase.js.
    //
    // Native first, deliberately. signOut(auth) fires onAuthStateChanged, which
    // makes App.jsx render SignIn and unmount this component, so anything
    // awaited after it may never run.
    if (Capacitor.isNativePlatform()) {
      try { await FirebaseAuthentication.signOut(); } catch { /* best effort */ }
    }
    await signOut(auth);
  };

  const cancelConfirm = () => {
    setShowConfirm(false);
    setConfirmText('');
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      background: '#0a0e1a',
      display: 'flex', flexDirection: 'column',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      opacity: visible ? 1 : 0,
      transform: visible ? 'translateY(0)' : 'translateY(20px)',
      transition: 'opacity 0.3s ease, transform 0.3s ease',
    }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: 'calc(env(safe-area-inset-top, 0px) + 16px) 20px 14px 20px',
        background: 'rgba(15,20,35,0.85)',
        borderBottom: '1px solid rgba(100,120,160,0.12)',
        flexShrink: 0,
      }}>
        {/* Back arrow */}
        <button
          onClick={close}
          style={{
            width: 28, height: 28, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'rgba(200,210,230,0.5)',
            background: 'none', border: 'none', flexShrink: 0,
            transition: 'color 0.15s',
          }}
          onPointerEnter={(e) => { e.currentTarget.style.color = 'rgba(200,210,230,0.9)'; }}
          onPointerLeave={(e) => { e.currentTarget.style.color = 'rgba(200,210,230,0.5)'; }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Title */}
        <div style={{
          flex: 1, textAlign: 'center',
          fontSize: 'var(--glim-text-md)', fontWeight: 600, letterSpacing: '0.3px',
          color: 'rgba(200,210,230,0.9)',
        }}>
          settings
        </div>

        {/* Mini-Glim placeholder */}
        <div style={{
          width: 40, height: 40, borderRadius: '50%',
          background: 'radial-gradient(circle at 50% 45%, rgba(94,234,212,0.15), transparent 70%)',
          border: '1.5px solid rgba(94,234,212,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 'var(--glim-text-lg)', lineHeight: 1, opacity: 0.7 }}>
            {'\u{1F43E}'}
          </span>
        </div>
      </div>

      {/* Scrollable body */}
      <div style={{
        flex: 1, overflowY: 'auto',
        padding: '12px 16px 16px 16px',
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(100,120,160,0.2) transparent',
      }}>

        {/* Accordion sections */}
        {SECTIONS.map(({ id, title, icon, getSummary, Component }) => {
          const expanded = activeSection === id;
          const store = storeForSection[id];
          const summary = store ? getSummary(store) : getSummary();

          return (
            <div key={id} style={{
              marginBottom: 8, borderRadius: 12,
              background: 'rgba(30,40,65,0.6)',
              border: '1px solid rgba(100,120,160,0.2)',
              overflow: 'hidden', transition: 'background 0.2s',
            }}>
              {/* Section header */}
              <div
                onClick={() => toggleSection(id)}
                style={{
                  display: 'flex', alignItems: 'center',
                  padding: '14px 16px', cursor: 'pointer',
                  userSelect: 'none', transition: 'background 0.15s',
                }}
                onPointerEnter={(e) => { e.currentTarget.style.background = 'rgba(40,55,80,0.7)'; }}
                onPointerLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {icon}
                <div style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                  <div style={{
                    fontSize: 'var(--glim-text-md)', fontWeight: 600,
                    color: 'rgba(200,210,230,0.9)', lineHeight: 1.3,
                  }}>
                    {title}
                  </div>
                  <div style={{
                    fontSize: 'var(--glim-text-sm)', color: 'rgba(200,210,230,0.5)',
                    marginTop: 2, whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {summary}
                  </div>
                </div>
                <Chevron expanded={expanded} />
              </div>

              {/* Section content (collapsible) */}
              <div style={{
                maxHeight: expanded ? 600 : 0,
                overflow: 'hidden',
                transition: 'max-height 0.3s ease',
              }}>
                {Component ? <Component /> : (
                  <div style={{
                    padding: '16px 16px 20px',
                    borderTop: '1px solid rgba(100,120,160,0.12)',
                    color: 'rgba(200,210,230,0.35)', fontSize: 'var(--glim-text-base)',
                    textAlign: 'center', fontStyle: 'italic',
                  }}>
                    coming soon - avg display format, theme
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Sign out */}
        <div style={{ marginTop: 16, padding: '0 4px' }}>
          <button
            onClick={handleSignOut}
            style={{
              width: '100%', padding: 12,
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 10, color: 'rgba(239,68,68,0.8)',
              fontSize: 'var(--glim-text-base)', fontWeight: 500, cursor: 'pointer',
              transition: 'all 0.15s', textAlign: 'center',
              fontFamily: 'inherit',
            }}
            onPointerEnter={(e) => {
              e.currentTarget.style.background = 'rgba(239,68,68,0.15)';
              e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)';
            }}
            onPointerLeave={(e) => {
              e.currentTarget.style.background = 'rgba(239,68,68,0.1)';
              e.currentTarget.style.borderColor = 'rgba(239,68,68,0.2)';
            }}
          >
            sign out
          </button>
        </div>

        {/* Reset all data */}
        <div style={{ marginTop: 8, padding: '0 4px' }}>
          {!showConfirm ? (
            <button
              onClick={() => setShowConfirm(true)}
              style={{
                width: '100%', padding: 12,
                background: 'rgba(239,68,68,0.06)',
                border: '1px solid rgba(239,68,68,0.12)',
                borderRadius: 10, color: 'rgba(239,68,68,0.45)',
                fontSize: 'var(--glim-text-base)', fontWeight: 500, cursor: 'pointer',
                transition: 'all 0.15s', textAlign: 'center',
                fontFamily: 'inherit',
              }}
              onPointerEnter={(e) => {
                e.currentTarget.style.background = 'rgba(239,68,68,0.12)';
                e.currentTarget.style.color = 'rgba(239,68,68,0.7)';
              }}
              onPointerLeave={(e) => {
                e.currentTarget.style.background = 'rgba(239,68,68,0.06)';
                e.currentTarget.style.color = 'rgba(239,68,68,0.45)';
              }}
            >
              reset all data
            </button>
          ) : (
            <div style={{
              padding: 16, borderRadius: 10,
              background: 'rgba(239,68,68,0.06)',
              border: '1px solid rgba(239,68,68,0.15)',
            }}>
              <p style={{
                margin: '0 0 10px', fontSize: 'var(--glim-text-sm)',
                color: 'rgba(239,68,68,0.75)', lineHeight: 1.5,
              }}>
                this will permanently delete your journal, water logs, step logs,
                nutrition data, pokes, and settings on all devices. this cannot be undone.
              </p>
              <input
                autoFocus
                type="text"
                placeholder='type "delete" to confirm'
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') cancelConfirm();
                  if (e.key === 'Enter') handleReset();
                }}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '8px 10px', borderRadius: 8, marginBottom: 10,
                  background: 'rgba(239,68,68,0.06)',
                  border: '1px solid rgba(239,68,68,0.25)',
                  color: 'rgba(255,255,255,0.7)',
                  fontFamily: "'Courier New', monospace",
                  fontSize: 'var(--glim-text-lg)', outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={cancelConfirm}
                  style={{
                    flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer',
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: 'rgba(255,255,255,0.4)',
                    fontFamily: 'inherit', fontSize: 'var(--glim-text-base)',
                  }}
                >
                  cancel
                </button>
                <button
                  onClick={handleReset}
                  disabled={!canDelete || deleting}
                  style={{
                    flex: 1, padding: '8px 0', borderRadius: 8,
                    cursor: canDelete && !deleting ? 'pointer' : 'not-allowed',
                    background: canDelete ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.05)',
                    border: `1px solid ${canDelete ? 'rgba(239,68,68,0.5)' : 'rgba(239,68,68,0.15)'}`,
                    color: canDelete ? 'rgba(239,68,68,0.9)' : 'rgba(239,68,68,0.25)',
                    fontFamily: 'inherit', fontSize: 'var(--glim-text-base)',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {deleting ? 'deleting...' : 'delete everything'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Bottom spacer for safe area */}
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}
