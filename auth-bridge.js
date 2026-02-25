/**
 * Auth Bridge Content Script
 * Runs on vetclaimservices.com to relay auth tokens from the web app to the extension.
 * The web app posts a message after login; this script forwards it to the background service worker.
 */

(function () {
  'use strict';

  window.addEventListener('message', (event) => {
    // Only accept messages from the same window
    if (event.source !== window) return;

    // Only accept messages from vetclaimservices.com
    if (!event.origin.endsWith('vetclaimservices.com')) return;

    if (event.data?.type !== 'VETCLAIM_AUTH_TOKENS') return;

    console.log('[VetClaim Extension] Auth tokens received from web app');

    chrome.runtime.sendMessage({
      type: 'VETCLAIM_AUTH_TOKENS',
      accessToken: event.data.accessToken,
      refreshToken: event.data.refreshToken,
      userData: event.data.userData
    }).then(() => {
      console.log('[VetClaim Extension] Auth tokens stored successfully');
    }).catch((err) => {
      console.error('[VetClaim Extension] Failed to store auth tokens:', err);
    });
  });

  console.log('[VetClaim Extension] Auth bridge active on', window.location.hostname);
})();
