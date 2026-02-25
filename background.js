/**
 * VA Intelligence Background Service Worker
 * Coordinates data flow between content script, VetClaim API, and storage.
 * Syncs scraped VA.gov claim data to the VetClaim backend.
 */

// Configuration — points to VetClaim Services API
const CONFIG = {
  apiBaseUrl: 'https://vetclaimservices.com/v1',
  webAppUrl: 'https://vetclaimservices.com',
  syncInterval: 300000 // 5 minutes
};

// State management
let syncTimer = null;

// Initialize on extension install
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[VetClaim Extension] Extension installed:', details.reason);

  if (details.reason === 'install') {
    initializeExtension();
  } else if (details.reason === 'update') {
    console.log('[VetClaim Extension] Updated to version:', chrome.runtime.getManifest().version);
  }
});

// Initialize extension
async function initializeExtension() {
  await chrome.storage.local.set({
    extensionEnabled: true,
    notificationsEnabled: true,
    syncEnabled: true,
    lastSync: null,
    userData: null,
    accessToken: null,
    refreshToken: null
  });

  // Open VetClaim login page for auth
  chrome.tabs.create({
    url: `${CONFIG.webAppUrl}/login?extension=true`
  });
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[VetClaim Extension] Message received:', message.type);

  if (message.type === 'CLAIM_DATA_INTERCEPTED') {
    handleClaimDataIntercepted(message, sender)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Async response
  }

  if (message.type === 'AI_ACTION_TRIGGERED') {
    handleAIAction(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === 'REQUEST_AUTH_STATUS') {
    checkAuthStatus()
      .then(status => sendResponse(status))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  // Allow the web app to pass auth tokens to the extension
  if (message.type === 'VETCLAIM_AUTH_TOKENS') {
    chrome.storage.local.set({
      accessToken: message.accessToken,
      refreshToken: message.refreshToken,
      userData: message.userData
    }).then(() => {
      console.log('[VetClaim Extension] Auth tokens stored');
      sendResponse({ success: true });
    });
    return true;
  }
});

/**
 * Handle intercepted claim data
 */
async function handleClaimDataIntercepted(message, sender) {
  console.log('[VetClaim Extension] Processing claim data:', message.data.dataType);

  const { data } = message;

  // Store raw data locally
  await storeClaimData(data);

  // Check if user is authenticated with VetClaim
  const authStatus = await checkAuthStatus();

  if (!authStatus.authenticated) {
    console.log('[VetClaim Extension] User not authenticated, skipping sync');
    return {
      success: true,
      aiInsights: getBasicInsights(data)
    };
  }

  // Sync claim data to VetClaim API
  try {
    await syncClaimToVetClaim(data, authStatus.accessToken);

    return {
      success: true,
      synced: true,
      aiInsights: getBasicInsights(data)
    };

  } catch (error) {
    console.error('[VetClaim Extension] Sync error:', error);
    return {
      success: false,
      error: error.message,
      aiInsights: getBasicInsights(data)
    };
  }
}

/**
 * Store claim data in local storage
 */
async function storeClaimData(data) {
  const storageKey = `claim_data_${data.dataType}`;

  await chrome.storage.local.set({
    [storageKey]: {
      raw: data.raw,
      structured: data.structured,
      lastUpdated: Date.now()
    }
  });

  console.log('[VetClaim Extension] Claim data stored:', storageKey);
}

/**
 * Sync a single claim to VetClaim API
 */
async function syncClaimToVetClaim(data, accessToken) {
  console.log('[VetClaim Extension] Syncing to VetClaim API...');

  const response = await fetch(`${CONFIG.apiBaseUrl}/va-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'X-Extension-Version': chrome.runtime.getManifest().version
    },
    body: JSON.stringify({
      claimData: data.structured,
      rawData: data.raw,
      dataType: data.dataType,
      timestamp: Date.now()
    })
  });

  if (!response.ok) {
    if (response.status === 401) {
      // Try to refresh the token
      const refreshed = await refreshAuthToken();
      if (refreshed) {
        // Retry with new token
        const retryResponse = await fetch(`${CONFIG.apiBaseUrl}/va-sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${refreshed.accessToken}`,
            'X-Extension-Version': chrome.runtime.getManifest().version
          },
          body: JSON.stringify({
            claimData: data.structured,
            rawData: data.raw,
            dataType: data.dataType,
            timestamp: Date.now()
          })
        });
        if (!retryResponse.ok) {
          throw new Error(`Sync failed after token refresh: ${retryResponse.statusText}`);
        }
        return await retryResponse.json();
      }
      throw new Error('Authentication failed. Please log in to VetClaim Services.');
    }
    throw new Error(`Sync failed: ${response.statusText}`);
  }

  const result = await response.json();
  console.log('[VetClaim Extension] Sync complete');

  return result;
}

/**
 * Check if user is authenticated with VetClaim
 */
async function checkAuthStatus() {
  const storage = await chrome.storage.local.get(['accessToken', 'refreshToken', 'userData']);

  if (!storage.accessToken) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    accessToken: storage.accessToken,
    refreshToken: storage.refreshToken,
    userData: storage.userData
  };
}

/**
 * Refresh authentication token via VetClaim API
 */
async function refreshAuthToken() {
  const storage = await chrome.storage.local.get(['refreshToken']);

  if (!storage.refreshToken) {
    return null;
  }

  try {
    const response = await fetch(`${CONFIG.apiBaseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        refreshToken: storage.refreshToken
      })
    });

    if (!response.ok) {
      // Refresh failed — clear tokens
      await chrome.storage.local.remove(['accessToken', 'refreshToken', 'userData']);
      return null;
    }

    const result = await response.json();
    const data = result.data || result;

    // Store new tokens
    await chrome.storage.local.set({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken
    });

    return data;
  } catch (error) {
    console.error('[VetClaim Extension] Token refresh failed:', error);
    return null;
  }
}

/**
 * Get basic insights without AI (for unauthenticated users)
 */
function getBasicInsights(data) {
  const structured = data.structured;

  return {
    claimId: structured.claimId,
    status: 'basic',
    confidenceScore: 50,
    timeline: {
      daysToDecision: calculateBasicTimeline(structured),
      approvalProbability: 70,
      similarClaims: 0,
      keyFactors: ['Based on average processing times']
    },
    risks: identifyBasicRisks(structured),
    recommendations: [{
      title: 'Get AI-Powered Analysis',
      description: 'Log in to VetClaim Services for predictive timelines, risk assessment, and personalized recommendations.',
      impact: 'high',
      action: 'login',
      buttonText: 'Log In'
    }],
    missingBenefits: [],
    isBasic: true
  };
}

function calculateBasicTimeline(claimData) {
  const phaseTimelines = {
    1: 120,
    2: 90,
    3: 60,
    4: 30,
    5: 14,
    6: 7,
    7: 0
  };

  return phaseTimelines[claimData.phase] || 90;
}

function identifyBasicRisks(claimData) {
  const risks = [];

  if (claimData.documentsNeeded) {
    risks.push({
      title: 'Documents Required',
      description: 'VA is waiting for additional documentation from you.',
      severity: 'high',
      action: 'check-documents',
      actionText: 'View Requirements'
    });
  }

  if (claimData.jurisdiction === 'National Work Queue') {
    risks.push({
      title: 'National Work Queue',
      description: 'Claims in the national queue typically take longer to process.',
      severity: 'medium',
      action: null,
      actionText: null
    });
  }

  return risks;
}

/**
 * Handle AI action triggers
 */
async function handleAIAction(message) {
  console.log('[VetClaim Extension] Handling action:', message.action);

  const { action } = message;

  switch (action) {
    case 'detailed-report':
    case 'login':
      return { success: true, openUrl: true };

    case 'export-strategy':
      return { success: true, openUrl: true };

    case 'file-supplemental':
      return { success: true, openUrl: true };

    default:
      return { success: true };
  }
}

/**
 * Send browser notification
 */
function sendNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: title,
    message: message,
    priority: 2,
    requireInteraction: true
  });
}

/**
 * Setup periodic sync
 */
function setupPeriodicSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
  }

  syncTimer = setInterval(async () => {
    console.log('[VetClaim Extension] Running periodic sync...');

    const authStatus = await checkAuthStatus();
    if (authStatus.authenticated) {
      await syncAllClaimData(authStatus.accessToken);
    }
  }, CONFIG.syncInterval);
}

/**
 * Sync all stored claim data with VetClaim API
 */
async function syncAllClaimData(accessToken) {
  try {
    const storage = await chrome.storage.local.get(null);
    const claimDataKeys = Object.keys(storage).filter(k => k.startsWith('claim_data_'));

    const claims = claimDataKeys
      .map(key => storage[key])
      .filter(item => item.structured && item.structured.claimId);

    if (claims.length === 0) {
      console.log('[VetClaim Extension] No claim data to sync');
      return;
    }

    await fetch(`${CONFIG.apiBaseUrl}/va-sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        claims: claims,
        timestamp: Date.now()
      })
    });

    await chrome.storage.local.set({
      lastSync: Date.now()
    });

    console.log('[VetClaim Extension] Batch sync complete');

  } catch (error) {
    console.error('[VetClaim Extension] Sync error:', error);
  }
}

// Start periodic sync on extension load
setupPeriodicSync();

console.log('[VetClaim Extension] Background service worker initialized');
