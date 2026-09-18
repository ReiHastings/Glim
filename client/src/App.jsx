// -----------------------------------------------------------------------------
// Title:       App.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-25
// Last Modified: 2026-09-06
// Purpose:     Root application component. Gates the app behind Firebase Auth.
//              Listens for auth state changes and routes to SignIn or DesktopPet.
//              Renders as soon as auth resolves; the Firestore user-document
//              creation and the sync service both run in the background so a slow
//              network cannot stall startup. On sign-in, checks if the UID changed
//              since last session; if so, clears all localStorage data and reloads
//              stores to prevent cross-user data contamination. Also requests
//              persistent storage (eviction resistance) where the browser supports
//              it.
// Inputs:      Firebase auth, db from firebase.js
// Outputs:     Renders SignIn (unauthenticated), DesktopPet (authenticated),
//              or a blank loading screen while auth state resolves.
// -----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { auth, db } from './firebase';
import { startSync, stopSync } from './sync';
import { importSteps } from './health/stepsImport';
import { reloadAllStores } from './stores';
import DesktopPet from './DesktopPet.jsx';
import SignIn from './SignIn.jsx';
import SplashScreen from './SplashScreen.jsx';

// --- Create user document on first sign-in ---
// Uses getDoc check so createdAt is only written once, not overwritten on every login.

async function ensureUserDocument(user) {
  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    // This now runs in the background (see the auth effect), so a fast
    // sign-in then sign-out could let it resolve after the account changed.
    // Re-check the user is still the active one before writing.
    if (auth.currentUser?.uid !== user.uid) return;
    await setDoc(userRef, {
      name: user.displayName,
      email: user.email,
      createdAt: serverTimestamp(),
    });
  }
}

// --- Root component ---

export default function App() {
  // undefined = auth state not yet resolved (loading)
  // null      = resolved, no user signed in
  // object    = resolved, user is signed in
  const [user, setUser] = useState(undefined);

  // --- Request persistent storage (eviction resistance) ---
  // Safari/WebKit evicts script-writable storage (localStorage/IndexedDB) after
  // ~7 days without first-party interaction. A granted persistence request
  // exempts the origin. This is a request the browser may deny, not a guarantee;
  // Home-Screen install remains the strongest protection. Feature-detected and
  // non-blocking - does nothing where the StorageManager API is unavailable.
  useEffect(() => {
    if (!navigator.storage?.persist) return;
    (async () => {
      try {
        if (await navigator.storage.persisted()) {
          console.info('[glim] storage already persisted');
          return;
        }
        const granted = await navigator.storage.persist();
        console.info(`[glim] storage persist ${granted ? 'granted' : 'denied'}`);
      } catch (e) {
        console.warn('[glim] storage persist request failed:', e);
      }
    })();
  }, []);

  // --- Health step import, foreground trigger ---
  //
  // Capacitor's appStateChange fires when the app is brought back to the front,
  // which is the moment a user's step count is most likely to have moved: they
  // have been walking with the phone in a pocket. The import's own interval
  // floor collapses this with the startup and panel triggers.
  //
  // The listener is removed on unmount. Without that, a dev-server hot reload
  // stacks a new listener on every edit and each foreground fires N imports -
  // invisible in testing, because the interval floor swallows them.
  //
  // Native only: on the web the null adapter would no-op anyway, but there is no
  // reason to import the plugin or run the guard chain in a browser tab.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let remove = null;
    let cancelled = false;
    (async () => {
      try {
        const { App: CapacitorApp } = await import('@capacitor/app');
        const handle = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) return;
          importSteps({ reason: 'resume' }).catch(e =>
            console.warn('[glim health] resume import failed:', e));
        });
        if (cancelled) handle.remove();
        else remove = () => handle.remove();
      } catch (e) {
        console.warn('[glim health] could not listen for foreground events:', e);
      }
    })();
    return () => { cancelled = true; if (remove) remove(); };
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        // --- UID change detection: clear stale cross-user data ---
        // If a different user signs in on this device, the previous user's
        // localStorage data must be cleared before sync starts, otherwise
        // it would get pushed to Firestore under the new user's UID. This is
        // pure localStorage work, so it stays synchronous and runs before both
        // the render and startSync below.
        const storedUid = localStorage.getItem('glim-uid');
        if (storedUid && storedUid !== currentUser.uid) {
          // Remove every Glim-owned key via prefix scan, so a domain added later
          // is cleared automatically without editing a hardcoded list (a missed
          // key would leak the prior user's data into the new account). Keep
          // 'glim-uid' - it is the identity marker we overwrite just below.
          // Iterate backwards because removeItem reindexes localStorage.
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith('glim-') && k !== 'glim-uid') localStorage.removeItem(k);
          }
          // Re-hydrate through the store barrel, never a hardcoded list here: a
          // per-store list has twice silently missed a new domain (a53da46 for
          // nutrition, and both symptom stores before Phase 1.5), leaving the
          // previous user's rows in Zustand memory to be re-persisted and pushed
          // under the new uid.
          reloadAllStores();
        }
        localStorage.setItem('glim-uid', currentUser.uid);

        // Render immediately once auth resolves. The app reads from localStorage,
        // so it must not wait on any network round-trip. Creating the Firestore
        // user document is fire-and-forget: gating render on it previously caused
        // a multi-minute splash-screen hang whenever Firestore was slow to reach.
        setUser(currentUser);
        startSync(currentUser.uid);
        ensureUserDocument(currentUser).catch(e =>
          console.warn('[glim] ensureUserDocument failed:', e));

        // Health step import, startup trigger. Fire-and-forget for the same
        // reason as ensureUserDocument: nothing on screen waits for it, and the
        // panel shows whatever is already stored. It no-ops unless this device
        // has the import switched on.
        if (Capacitor.isNativePlatform()) {
          importSteps({ reason: 'startup' }).catch(e =>
            console.warn('[glim health] startup import failed:', e));
        }
      } else {
        stopSync();
        setUser(null);
      }
    });
    return unsubscribe;
  }, []);

  // Loading: auth state not resolved yet - show splash screen
  if (user === undefined) {
    return <SplashScreen />;
  }

  if (!user) {
    return <SignIn />;
  }

  return <DesktopPet />;
}
