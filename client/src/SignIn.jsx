// -----------------------------------------------------------------------------
// Title:       SignIn.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-26
// Last Modified: 2026-09-15
// Purpose:     Sign-in screen shown to unauthenticated users. Google sign-in
//              takes one of two paths. On web it uses signInWithPopup, and when
//              the popup is blocked (installed PWA standalone webview) it shows
//              a fallback prompt to open Glim in Safari, which shares origin
//              storage with the PWA. On native (Capacitor iOS) the popup flow
//              cannot work at all, so it takes a Google credential from the
//              native plugin and then signs the JS SDK in with
//              signInWithCredential. Both layers are required: Firestore access
//              runs through the JS SDK, so without the second step request.auth
//              is null and firestore.rules rejects everything.
// Inputs:      auth and googleProvider from firebase.js, FirebaseAuthentication
//              from @capacitor-firebase/authentication
// Outputs:     Triggers onAuthStateChanged in App.jsx on successful sign-in
// Usage:       Rendered by App.jsx when auth state is null (not signed in)
// -----------------------------------------------------------------------------

import { useState } from 'react';
import { GoogleAuthProvider, signInWithCredential, signInWithPopup } from 'firebase/auth';
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { auth, googleProvider } from './firebase';

// --- Google "G" logo SVG (inline, official brand colors) ---

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}

// --- Native (Capacitor) Google sign-in ---
//
// Step 1 has to happen natively: signInWithPopup needs the popup/redirect
// resolver, which never initializes from the capacitor://localhost origin. That
// is the same hang documented in firebase.js.
//
// Step 2 is not optional. Glim's Firestore calls all go through the JS SDK and
// carry its auth state, not the native layer's. Without signInWithCredential,
// request.auth is null and every firestore.rules rule rejects.
async function signInWithGoogleNative() {
  const result = await FirebaseAuthentication.signInWithGoogle();
  const idToken = result.credential?.idToken;
  if (!idToken) {
    throw new Error('native sign-in returned no id token');
  }
  const credential = GoogleAuthProvider.credential(idToken);
  await signInWithCredential(auth, credential);
}

// --- Sign-in screen ---

export default function SignIn() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showBrowserPrompt, setShowBrowserPrompt] = useState(false);

  async function handleSignIn() {
    setError(null);
    setLoading(true);
    try {
      if (Capacitor.isNativePlatform()) {
        await signInWithGoogleNative();
      } else {
        await signInWithPopup(auth, googleProvider);
      }
      // onAuthStateChanged in App.jsx handles the transition
    } catch (err) {
      if (Capacitor.isNativePlatform()) {
        // The plugin has no documented error constant for a user-cancelled
        // Google sheet, and none was found in its iOS source. So log the raw
        // error and show a generic message for now. Once a real cancellation
        // has been seen in the Xcode console, suppress that specific case here
        // instead of reporting it as a failure.
        console.warn('[glim] native sign-in failed:', err?.code, err?.message, err);
        setError('sign-in failed - try again');
      } else if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-browser') {
        const isStandalone =
          window.navigator.standalone === true ||
          window.matchMedia('(display-mode: standalone)').matches;
        if (isStandalone) {
          setShowBrowserPrompt(true);
        } else {
          setError('popup was blocked - check your browser settings');
        }
      } else if (err.code !== 'auth/popup-closed-by-user') {
        setError('sign-in failed - try again');
      }
      setLoading(false);
    }
  }

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'radial-gradient(ellipse at 50% 60%, #1a0a2e 0%, #080415 50%, #020108 100%)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>

      {/* Subtle star field */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        {Array.from({ length: 60 }, (_, i) => (
          <div key={i} style={{
            position: 'absolute',
            left: `${(i * 137.5) % 100}%`,
            top: `${(i * 97.3) % 100}%`,
            width: i % 7 === 0 ? '2px' : '1px',
            height: i % 7 === 0 ? '2px' : '1px',
            borderRadius: '50%',
            background: 'white',
            opacity: 0.2 + (i % 5) * 0.12,
          }} />
        ))}
      </div>

      {/* Sign-in card */}
      <div style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '20px',
        padding: '48px 40px',
        background: 'rgba(255, 255, 255, 0.06)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: '24px',
        maxWidth: '340px',
        width: '90%',
        textAlign: 'center',
      }}>

        {/* Icon */}
        <img
          src={`${import.meta.env.BASE_URL}glim-icon.svg`}
          alt="Glim"
          style={{ width: '80px', height: '80px', borderRadius: '20px' }}
        />

        {/* Name + tagline */}
        <div>
          <div style={{
            fontSize: 'var(--glim-text-splash-title)',
            fontWeight: '700',
            letterSpacing: '0.05em',
            color: 'transparent',
            backgroundImage: 'linear-gradient(135deg, #c084fc, #818cf8, #67e8f9)',
            backgroundClip: 'text',
            WebkitBackgroundClip: 'text',
            marginBottom: '8px',
          }}>
            glim
          </div>
          <div style={{ fontSize: 'var(--glim-text-splash-sub)', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
            your little companion is waiting
          </div>
        </div>

        {/* Google sign-in button */}
        <button
          onClick={handleSignIn}
          disabled={loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '11px 20px',
            background: loading ? 'rgba(255,255,255,0.7)' : 'white',
            border: 'none',
            borderRadius: '10px',
            fontSize: 'var(--glim-text-base)',
            fontWeight: '600',
            color: '#1f2937',
            cursor: loading ? 'not-allowed' : 'pointer',
            transition: 'opacity 0.15s',
            width: '100%',
            justifyContent: 'center',
          }}
        >
          <GoogleIcon />
          {loading ? 'signing in...' : 'continue with google'}
        </button>

        {/* PWA standalone fallback prompt */}
        {showBrowserPrompt && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px',
          }}>
            <div style={{ fontSize: 'var(--glim-text-sm)', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
              the pwa can't open sign-in directly - tap below to sign in through safari, then come back here
            </div>
            <button
              onClick={() => window.open('https://reihastings.github.io/Glim/', '_blank')}
              style={{
                padding: '9px 18px',
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '8px',
                fontSize: 'var(--glim-text-sm)',
                fontWeight: '600',
                color: 'rgba(255,255,255,0.8)',
                cursor: 'pointer',
              }}
            >
              open in safari
            </button>
            <button
              onClick={() => { setShowBrowserPrompt(false); setError(null); }}
              style={{
                padding: '4px',
                background: 'none',
                border: 'none',
                fontSize: 'var(--glim-text-xs)',
                color: 'rgba(255,255,255,0.35)',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              try again
            </button>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div style={{ fontSize: 'var(--glim-text-sm)', color: '#f87171' }}>
            {error}
          </div>
        )}

        {/* Footer note */}
        <div style={{ fontSize: 'var(--glim-text-xs)', color: 'rgba(255,255,255,0.3)', lineHeight: 1.5 }}>
          sign-in keeps your data synced across devices
        </div>

      </div>
    </div>
  );
}
