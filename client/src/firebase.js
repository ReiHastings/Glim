// -----------------------------------------------------------------------------
// Title:       Firebase Initialization
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-26
// Last Modified: 2026-03-26
// Purpose:     Initializes the Firebase app and exports Firestore and Auth
//              instances for use across the app. Config values are loaded from
//              environment variables so API keys stay out of the public repo.
// Outputs:     Named exports: `db` (Firestore), `auth` (Firebase Auth),
//              `googleProvider` (GoogleAuthProvider)
// Usage:       import { db, auth, googleProvider } from './firebase'
// -----------------------------------------------------------------------------

import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import {
  getAuth,
  initializeAuth,
  indexedDBLocalPersistence,
  GoogleAuthProvider,
} from 'firebase/auth';
import { Capacitor } from '@capacitor/core';

// --- Config ---

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// --- Initialize ---

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);

// --- Auth ---
// Platform-dependent, and it has to be.
//
// getAuth() installs browserPopupRedirectResolver by default, and Firebase
// awaits that resolver during initialization. Initializing it loads gapi from
// apis.google.com and opens a hidden iframe on the authDomain, then waits for a
// postMessage handshake that validates the parent origin. From
// capacitor://localhost that handshake never completes and there is no timeout,
// so the internal initialization promise never settles and onAuthStateChanged
// never fires. Verified on device 2026-09-14: IndexedDB and localStorage both
// work and the authDomain is reachable, so the resolver is the only candidate
// left.
//
// initializeAuth() without a popupRedirectResolver skips that branch. Native
// sign-in goes through @capacitor-firebase/authentication instead (step 3).
// signInWithPopup is unavailable on this path by design, and now throws
// immediately rather than hanging.
//
// IndexedDB persistence is pinned explicitly rather than left to the default
// hierarchy, and is safe here: the on-device probe confirmed IndexedDB opens
// and completes in this WebView.
export const auth = Capacitor.isNativePlatform()
  ? initializeAuth(app, { persistence: indexedDBLocalPersistence })
  : getAuth(app);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
