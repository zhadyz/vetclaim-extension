/**
 * Auth Bridge Content Script
 * Runs on vetclaimservices.com to relay auth tokens to the extension.
 * 1. Auto-detects existing tokens in localStorage on page load
 * 2. Listens for postMessage from the login flow for fresh tokens
 */

(function () {
  'use strict';

  function sendTokensToExtension(accessToken, refreshToken, userData) {
    if (!accessToken) return;

    chrome.runtime.sendMessage({
      type: 'VETCLAIM_AUTH_TOKENS',
      accessToken,
      refreshToken,
      userData
    }).then(() => {
      console.log('[VetClaim Extension] Auth tokens synced to extension');
    }).catch((err) => {
      console.error('[VetClaim Extension] Failed to store auth tokens:', err);
    });
  }

  // ── Auto-detect tokens on page load ────────────────────────────────────
  // If user is already logged in, localStorage has tokens — relay them
  try {
    const at = localStorage.getItem('vetclaim_at') || localStorage.getItem('vetclaim_access_token');
    const rt = localStorage.getItem('vetclaim_refresh_token');

    if (at) {
      console.log('[VetClaim Extension] Found existing auth tokens, syncing…');
      sendTokensToExtension(at, rt, null);
    }
  } catch (e) {
    // localStorage may throw in some contexts
  }

  // ── Listen for fresh tokens from login flow ────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.origin.endsWith('vetclaimservices.com')) return;
    if (event.data?.type !== 'VETCLAIM_AUTH_TOKENS') return;

    console.log('[VetClaim Extension] Fresh auth tokens received from login');
    sendTokensToExtension(
      event.data.accessToken,
      event.data.refreshToken,
      event.data.userData
    );
  });

  console.log('[VetClaim Extension] Auth bridge active on', window.location.hostname);
})();
