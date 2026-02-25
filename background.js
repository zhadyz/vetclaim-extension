/**
 * VetClaim Background Service Worker
 * Uses webRequest to detect VA.gov activity, then directly fetches
 * VA.gov API endpoints (claims, ratings, appeals) and syncs to VetClaim.
 */

// ─── Config ─────────────────────────────────────────────────────────────
const CONFIG = {
  apiBaseUrl: 'https://api.vetclaimservices.com/v1',
  webAppUrl: 'https://vetclaimservices.com',
  vaApiBase: 'https://api.va.gov',
  syncInterval: 300000,   // 5-minute periodic re-sync to VetClaim
  fetchCooldown: 60000    // Don't re-pull VA data within 60 s
};

const VA_ENDPOINTS = {
  claims:             '/v0/benefits_claims',
  ratedDisabilities:  '/v0/rated_disabilities',
  appeals:            '/v0/appeals'
};

let lastVaFetch = 0;

// ─── Install ────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[VetClaim] Installed:', details.reason);
  if (details.reason === 'install') {
    chrome.storage.local.set({
      accessToken: null,
      refreshToken: null,
      userData: null,
      vaClaims: [],
      vaRatings: null,
      vaAppeals: [],
      vaLoggedIn: false,
      lastSync: null
    });
    // Open VetClaim login so user can link their account
    chrome.tabs.create({ url: `${CONFIG.webAppUrl}/login?extension=true` });
  }
});

// ─── Detect VA.gov API activity via webRequest ──────────────────────────
// When the user is on VA.gov and the page loads claim data, we detect it
// and trigger a direct pull of ALL VA endpoints.
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const now = Date.now();
    if (now - lastVaFetch < CONFIG.fetchCooldown) return;
    lastVaFetch = now;
    console.log('[VetClaim] VA.gov API activity detected → pulling data');
    fetchAllVaData();
  },
  { urls: ['*://api.va.gov/v0/benefits_claims*', '*://api.va.gov/v0/rated_disabilities*'] }
);

// ─── Direct VA.gov Fetch ────────────────────────────────────────────────
// Because we have host_permissions for api.va.gov, Chrome includes the
// user's session cookies automatically with credentials: 'include'.
async function fetchVaEndpoint(path) {
  try {
    const res = await fetch(`${CONFIG.vaApiBase}${path}`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        await chrome.storage.local.set({ vaLoggedIn: false });
      }
      return null;
    }

    await chrome.storage.local.set({ vaLoggedIn: true });
    return await res.json();
  } catch (err) {
    console.error(`[VetClaim] Fetch ${path} failed:`, err);
    return null;
  }
}

async function fetchAllVaData() {
  console.log('[VetClaim] Fetching VA.gov endpoints…');

  const [claimsRes, ratingsRes, appealsRes] = await Promise.allSettled([
    fetchVaEndpoint(VA_ENDPOINTS.claims),
    fetchVaEndpoint(VA_ENDPOINTS.ratedDisabilities),
    fetchVaEndpoint(VA_ENDPOINTS.appeals)
  ]);

  const claimsJson  = claimsRes.status  === 'fulfilled' ? claimsRes.value  : null;
  const ratingsJson = ratingsRes.status === 'fulfilled' ? ratingsRes.value : null;
  const appealsJson = appealsRes.status === 'fulfilled' ? appealsRes.value : null;

  // ── Parse claims (list gives minimal data, so fetch each detail) ──────
  let parsedClaims = [];
  if (claimsJson?.data) {
    const items = Array.isArray(claimsJson.data) ? claimsJson.data : [claimsJson.data];
    const claimIds = items.map(d => d.id).filter(Boolean);

    // Fetch full details for each claim (the detail endpoint has phase, contentions, etc.)
    const detailResults = await Promise.allSettled(
      claimIds.map(id => fetchVaEndpoint(`${VA_ENDPOINTS.claims}/${id}`))
    );

    for (let i = 0; i < claimIds.length; i++) {
      const detailRes = detailResults[i];
      if (detailRes.status === 'fulfilled' && detailRes.value?.data) {
        // Use the detailed response (has phase, contentions, tracked items)
        parsedClaims.push(parseBenefitClaim(detailRes.value.data));
      } else {
        // Fall back to the minimal list data
        parsedClaims.push(parseBenefitClaim(items[i]));
      }
    }

    console.log(`[VetClaim] Fetched details for ${parsedClaims.length} claims`);
  }

  // ── Parse rated disabilities ──────────────────────────────────────────
  let parsedRatings = null;
  if (ratingsJson?.data?.attributes) {
    const attrs = ratingsJson.data.attributes;
    const indiv = attrs.individual_ratings || attrs.individualRatings || [];
    parsedRatings = {
      combinedRating: attrs.combined_disability_rating ?? attrs.combinedDisabilityRating ?? null,
      individualRatings: indiv.map(r => ({
        name:           r.name || r.diagnostic_text || r.diagnosticText || '',
        rating:         r.rating_percentage ?? r.ratingPercentage ?? null,
        diagnosticCode: r.diagnostic_type_code || r.diagnosticCode || '',
        effectiveDate:  r.effective_date || r.effectiveDate || '',
        static:         r.static_ind ?? r.staticInd ?? false
      }))
    };
  }

  // ── Parse appeals ─────────────────────────────────────────────────────
  let parsedAppeals = [];
  if (appealsJson?.data && Array.isArray(appealsJson.data)) {
    parsedAppeals = appealsJson.data.map(a => ({
      appealId: a.id,
      type:     a.type,
      status:   a.attributes?.status,
      active:   a.attributes?.active,
      updated:  a.attributes?.updated,
      issues:   (a.attributes?.issues || []).map(i => ({
        description:    i.description,
        diagnosticCode: i.diagnosticCode,
        lastAction:     i.lastAction,
        date:           i.date
      })),
      events: a.attributes?.events || [],
      alerts: a.attributes?.alerts || []
    }));
  }

  // ── Persist locally (including raw for debugging) ─────────────────────
  await chrome.storage.local.set({
    vaClaims:    parsedClaims,
    vaRatings:   parsedRatings,
    vaAppeals:   parsedAppeals,
    vaLastFetch: Date.now(),
    _rawClaims:  claimsJson,   // raw VA response for debugging
    _rawRatings: ratingsJson
  });

  console.log(
    `[VetClaim] Fetched ${parsedClaims.length} claims, ` +
    `${parsedRatings ? parsedRatings.individualRatings.length : 0} ratings, ` +
    `${parsedAppeals.length} appeals`
  );

  // ── Sync to VetClaim API ──────────────────────────────────────────────
  const auth = await checkAuthStatus();
  if (auth.authenticated && parsedClaims.length > 0) {
    await syncClaimsToVetClaim(parsedClaims, claimsJson, auth.accessToken);
  }

  // ── Notify any open VA.gov tabs (for overlay) ─────────────────────────
  const vaTabs = await chrome.tabs.query({ url: '*://www.va.gov/*' });
  for (const tab of vaTabs) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'VA_DATA_READY',
      claims: parsedClaims,
      ratings: parsedRatings
    }).catch(() => {});
  }

  if (parsedClaims.length > 0) {
    sendNotification('Claims Synced', `${parsedClaims.length} claim(s) pulled from VA.gov`);
  }
}

// ─── Phase Type → Number Mapping ────────────────────────────────────────
// VA.gov returns latestPhaseType as a human-readable string inside claimPhaseDates.
const PHASE_MAP = {
  'claim received':               1,
  'under review':                 2,
  'initial review':               2,
  'gathering of evidence':        3,
  'evidence gathering':           3,
  'review of evidence':           4,
  'preparation for decision':     5,
  'pending decision approval':    6,
  'preparation for notification': 7,
  'complete':                     8,
  'closed':                       8
};

function phaseFromString(str) {
  if (!str) return null;
  const key = str.toLowerCase().replace(/_/g, ' ').trim();
  return PHASE_MAP[key] || null;
}

// ─── Claim Parser ───────────────────────────────────────────────────────
// Handles both the list endpoint and detail endpoint response formats.
// VA.gov API uses EVSS-style fields:
//   - claimPhaseDates.latestPhaseType (nested, human-readable string)
//   - contentionList (array of strings, not objects)
//   - status/claimStatus ("PEND", "CAN", etc.)
//   - decisionNotificationSent / developmentLetterSent ("Yes"/"No" strings)
//   - attentionNeeded ("Yes"/"No")
//   - statusType (claim type like "Compensation")
function parseBenefitClaim(data) {
  const a = data.attributes || {};

  // Phase info lives inside claimPhaseDates
  const phaseDates = a.claimPhaseDates || {};
  const latestPhaseType = phaseDates.latestPhaseType || a.latestPhaseType || a.phaseType || '';

  // Phase number: prefer explicit, fall back to string mapping
  const rawPhase = a.phase ?? a.currentPhase ?? null;
  const phase = (typeof rawPhase === 'number' && rawPhase >= 1)
    ? rawPhase
    : phaseFromString(latestPhaseType);

  // Status
  const status = a.status || a.claimStatus || '';

  // Claim type — VA uses statusType or claimType
  const claimType = a.claimType || a.statusType || '';

  // Contentions — VA returns contentionList as string array OR contentions as object array
  let contentions = [];
  if (a.contentionList && Array.isArray(a.contentionList)) {
    contentions = a.contentionList.map(item => {
      if (typeof item === 'string') return { name: item, code: '', classification: '', status: '' };
      return { name: item.name || '', code: item.code || '', classification: item.classification || '', status: item.status || '' };
    });
  } else if (a.contentions && Array.isArray(a.contentions)) {
    contentions = a.contentions.map(c => ({
      name: c.name || '', code: c.code || '', classification: c.classification || '', status: c.status || ''
    }));
  }

  // Boolean flags — VA uses "Yes"/"No" strings OR actual booleans
  const toBool = (v) => v === true || v === 'Yes' || v === 'yes';

  return {
    claimId:                String(data.id),
    claimType:              claimType,
    claimTypeCode:          a.claimTypeCode || a.benefitClaimTypeCode || '',
    status:                 status,
    phase:                  phase,
    latestPhaseType:        latestPhaseType,
    phaseChangeDate:        phaseDates.phaseChangeDate || a.phaseChangeDate || null,
    dateInitiated:          a.claimDate || a.date || a.dateFiled || null,
    dateFiled:              a.dateFiled || a.date || null,
    estimatedDecisionDate:  a.maxEstClaimDate || phaseDates.phaseMaxEstDate || a.estimatedDecisionDate || null,
    developmentLetterSent:  toBool(a.developmentLetterSent),
    decisionLetterSent:     toBool(a.decisionNotificationSent || a.decisionLetterSent),
    documentsNeeded:        toBool(a.attentionNeeded) || toBool(a.documentsNeeded),
    waiverSubmitted:        toBool(a.waiver5103Submitted || a.waiverSubmitted),
    contentions:            contentions,
    supportingDocuments:    a.supportingDocuments || a.vbaDocumentList || [],
    trackedItems:           a.trackedItems || a.consolidatedTrackedItemsList || a.claimTrackedItems || [],
    jurisdiction:           a.jurisdiction || a.tempJurisdiction || '',
    eventsTimeline:         a.eventsTimeline || [],
    claimPhaseDates:        phaseDates,
    updatedAt:              a.updatedAt || null,
    createdAt:              a.createdAt || null
  };
}

// ─── VetClaim API Sync ──────────────────────────────────────────────────
async function syncClaimsToVetClaim(claims, rawJson, accessToken) {
  try {
    let res;

    if (claims.length === 1) {
      res = await fetch(`${CONFIG.apiBaseUrl}/va-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Extension-Version': chrome.runtime.getManifest().version
        },
        body: JSON.stringify({
          claimData: claims[0],
          rawData: rawJson?.data ?? null,
          dataType: 'benefit_claim',
          timestamp: Date.now()
        })
      });
    } else {
      res = await fetch(`${CONFIG.apiBaseUrl}/va-sync/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Extension-Version': chrome.runtime.getManifest().version
        },
        body: JSON.stringify({
          claims: claims.map((c, i) => ({
            structured: c,
            raw: rawJson?.data?.[i] ?? null,
            lastUpdated: Date.now()
          })),
          timestamp: Date.now()
        })
      });
    }

    if (res && res.status === 401) {
      const refreshed = await refreshAuthToken();
      if (refreshed) {
        return syncClaimsToVetClaim(claims, rawJson, refreshed.accessToken);
      }
      return;
    }

    await chrome.storage.local.set({ lastSync: Date.now() });
    console.log('[VetClaim] Sync complete');
  } catch (err) {
    console.error('[VetClaim] Sync error:', err);
  }
}

// ─── Auth Helpers ───────────────────────────────────────────────────────
async function checkAuthStatus() {
  const s = await chrome.storage.local.get(['accessToken', 'refreshToken', 'userData']);
  if (!s.accessToken) return { authenticated: false };
  return { authenticated: true, ...s };
}

async function refreshAuthToken() {
  const s = await chrome.storage.local.get(['refreshToken']);
  if (!s.refreshToken) return null;

  try {
    const res = await fetch(`${CONFIG.apiBaseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: s.refreshToken })
    });

    if (!res.ok) {
      await chrome.storage.local.remove(['accessToken', 'refreshToken', 'userData']);
      return null;
    }

    const json = await res.json();
    const data = json.data || json;
    await chrome.storage.local.set({
      accessToken:  data.accessToken,
      refreshToken: data.refreshToken
    });
    return data;
  } catch (err) {
    console.error('[VetClaim] Token refresh failed:', err);
    return null;
  }
}

// ─── Message Handler ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    // Auth tokens from web app via auth-bridge.js
    case 'VETCLAIM_AUTH_TOKENS':
      chrome.storage.local.set({
        accessToken:  msg.accessToken,
        refreshToken: msg.refreshToken,
        userData:     msg.userData
      }).then(() => sendResponse({ success: true }));
      return true;

    // Popup / content script asks for auth status
    case 'REQUEST_AUTH_STATUS':
      checkAuthStatus().then(sendResponse);
      return true;

    // Popup / content script asks for cached VA data
    case 'REQUEST_VA_DATA':
      chrome.storage.local.get([
        'vaClaims', 'vaRatings', 'vaAppeals', 'vaLoggedIn', 'vaLastFetch', 'lastSync'
      ]).then(sendResponse);
      return true;

    // Manual "Sync Now" from popup
    case 'TRIGGER_VA_FETCH':
      lastVaFetch = 0; // bypass cooldown
      fetchAllVaData()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ error: e.message }));
      return true;

    default:
      return false;
  }
});

// ─── Periodic Re-sync ───────────────────────────────────────────────────
setInterval(async () => {
  const auth = await checkAuthStatus();
  const { vaClaims } = await chrome.storage.local.get('vaClaims');
  if (auth.authenticated && vaClaims?.length > 0) {
    console.log('[VetClaim] Periodic re-sync…');
    await syncClaimsToVetClaim(vaClaims, null, auth.accessToken);
  }
}, CONFIG.syncInterval);

// ─── Notification Helper ────────────────────────────────────────────────
function sendNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 1
  });
}

console.log('[VetClaim] Service worker initialized');
