/**
 * VetClaim Background Service Worker
 * Uses webRequest to detect VA.gov activity, then directly fetches
 * VA.gov API endpoints and syncs ALL data to VetClaim via unified endpoint.
 */

// ─── Config ─────────────────────────────────────────────────────────────
const CONFIG = {
  apiBaseUrl: 'https://api.veteranclaimservices.com/v1',
  webAppUrl: 'https://veteranclaimservices.com',
  vaApiBase: 'https://api.va.gov',
  syncInterval: 300000,   // 5-minute periodic re-sync to VetClaim
  fetchCooldown: 60000    // Don't re-pull VA data within 60 s
};

const VA_ENDPOINTS = {
  claims:             '/v0/benefits_claims',
  ratedDisabilities:  '/v0/rated_disabilities',
  appeals:            '/v0/appeals',
  payments:           '/v0/profile/payment_history',
  serviceHistory:     '/v0/profile/service_history',
  intentToFile:       '/v0/intent_to_file',
  benefitLetters:     '/v0/letters/beneficiary',
  debts:              '/v0/debts',
  copays:             '/v0/medical_copays',
  dependents:         '/v0/dependents',
  documents:          '/v0/efolder',
  claimLetters:       '/v0/claim_letters'
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
      vaPayments: [],
      vaServiceHistory: null,
      vaIntentToFile: null,
      vaBenefitLetters: null,
      vaDebts: null,
      vaDependents: null,
      vaDocuments: null,
      vaClaimLetters: null,
      vaLoggedIn: false,
      lastSync: null,
      pendingAlerts: [],
      uploadedVaDocs: {}
    });
    chrome.tabs.create({ url: `${CONFIG.webAppUrl}/login?extension=true` });
  }
});

// ─── Detect VA.gov API activity via webRequest ──────────────────────────
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

  // Fetch all endpoints in parallel
  const [
    claimsRes, ratingsRes, appealsRes, paymentsRes,
    serviceHistoryRes, itfRes, lettersRes, debtsRes, copaysRes, dependentsRes, documentsRes,
    claimLettersRes
  ] = await Promise.allSettled([
    fetchVaEndpoint(VA_ENDPOINTS.claims),
    fetchVaEndpoint(VA_ENDPOINTS.ratedDisabilities),
    fetchVaEndpoint(VA_ENDPOINTS.appeals),
    fetchVaEndpoint(VA_ENDPOINTS.payments),
    fetchVaEndpoint(VA_ENDPOINTS.serviceHistory),
    fetchVaEndpoint(VA_ENDPOINTS.intentToFile),
    fetchVaEndpoint(VA_ENDPOINTS.benefitLetters),
    fetchVaEndpoint(VA_ENDPOINTS.debts),
    fetchVaEndpoint(VA_ENDPOINTS.copays),
    fetchVaEndpoint(VA_ENDPOINTS.dependents),
    fetchVaEndpoint(VA_ENDPOINTS.documents),
    fetchVaEndpoint(VA_ENDPOINTS.claimLetters)
  ]);

  const settled = (r) => r.status === 'fulfilled' ? r.value : null;
  const claimsJson   = settled(claimsRes);
  const ratingsJson  = settled(ratingsRes);
  const appealsJson  = settled(appealsRes);
  const paymentsJson = settled(paymentsRes);
  const serviceHistoryJson = settled(serviceHistoryRes);
  const itfJson      = settled(itfRes);
  const lettersJson  = settled(lettersRes);
  const debtsJson    = settled(debtsRes);
  const copaysJson   = settled(copaysRes);
  const dependentsJson = settled(dependentsRes);
  const documentsJson = settled(documentsRes);
  const claimLettersJson = settled(claimLettersRes);

  // ── Parse claims (list gives minimal data, so fetch each detail) ──────
  let parsedClaims = [];
  if (claimsJson?.data) {
    const items = Array.isArray(claimsJson.data) ? claimsJson.data : [claimsJson.data];
    const claimIds = items.map(d => d.id).filter(Boolean);

    const detailResults = await Promise.allSettled(
      claimIds.map(id => fetchVaEndpoint(`${VA_ENDPOINTS.claims}/${id}`))
    );

    for (let i = 0; i < claimIds.length; i++) {
      const detailRes = detailResults[i];
      if (detailRes.status === 'fulfilled' && detailRes.value?.data) {
        parsedClaims.push(parseBenefitClaim(detailRes.value.data));
      } else {
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

    if (indiv.length > 0) {
      console.log('[VetClaim] Raw VA rating fields:', Object.keys(indiv[0]));
    }

    parsedRatings = {
      combinedRating: attrs.combined_disability_rating ?? attrs.combinedDisabilityRating ?? null,
      individualRatings: indiv.map(r => ({
        ...r,
        name:               r.name || r.diagnostic_text || r.diagnosticText || '',
        nameFull:           r.diagnostic_type_name || r.diagnosticTypeName || '',
        rating:             r.rating_percentage ?? r.ratingPercentage ?? r.rating ?? null,
        diagnosticCode:     r.diagnostic_type_code || r.diagnosticCode || '',
        effectiveDate:      r.effective_date || r.effectiveDate || '',
        decision:           r.decision || r.rating_decision || '',
        static:             r.static_ind ?? r.staticInd ?? false,
        ratingEndDate:      r.rating_end_date || r.ratingEndDate || null
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

  // ── Parse payments ───────────────────────────────────────────────────
  let parsedPayments = [];
  let paymentsData = paymentsJson;
  if (!paymentsData?.data) {
    const fallbacks = ['/v0/payments', '/v0/payment_history', '/v0/ppiu/payment_information'];
    for (const path of fallbacks) {
      if (path === VA_ENDPOINTS.payments) continue;
      const fb = await fetchVaEndpoint(path);
      if (fb?.data) { paymentsData = fb; break; }
    }
  }
  if (paymentsData?.data?.attributes?.payments) {
    const raw = paymentsData.data.attributes.payments;
    parsedPayments = raw.map(p => ({
      ...p,
      date:      p.payment_date || p.paymentDate || p.date || null,
      amount:    p.payment_amount || p.paymentAmount || p.amount || null,
      type:      p.payment_type || p.paymentType || p.type || '',
      method:    p.payment_method || p.paymentMethod || '',
      bank:      p.bank_name || p.bankName || '',
      account:   p.account_number ? `****${p.account_number.slice(-4)}` : ''
    }));
  } else if (paymentsData?.data && Array.isArray(paymentsData.data)) {
    parsedPayments = paymentsData.data.map(p => {
      const a = p.attributes || p;
      return {
        ...a,
        date:   a.payment_date || a.paymentDate || a.date || null,
        amount: a.payment_amount || a.paymentAmount || a.amount || null,
        type:   a.payment_type || a.paymentType || a.type || '',
        method: a.payment_method || a.paymentMethod || '',
      };
    });
  }

  // ── Parse service history ─────────────────────────────────────────────
  let parsedServiceHistory = null;
  if (serviceHistoryJson?.data?.attributes) {
    const attrs = serviceHistoryJson.data.attributes;
    const periods = attrs.service_episodes || attrs.serviceEpisodes || attrs.service_history || [];
    parsedServiceHistory = {
      periods: periods.map(p => ({
        branch:       p.branch_of_service || p.branchOfService || '',
        component:    p.personnel_category_type_code || p.personnelCategoryTypeCode || '',
        startDate:    p.begin_date || p.beginDate || p.start_date || p.startDate || '',
        endDate:      p.end_date || p.endDate || '',
        dutyType:     p.personnel_category_type_code || '',
        campaign:     p.deployments?.[0]?.location || '',
        description:  p.character_of_discharge_code || p.characterOfDischargeCode || ''
      }))
    };
  }

  // ── Parse intent to file ──────────────────────────────────────────────
  let parsedIntentToFile = null;
  if (itfJson?.data) {
    const items = Array.isArray(itfJson.data) ? itfJson.data : [itfJson.data];
    parsedIntentToFile = {
      intents: items.map(i => {
        const attrs = i.attributes || i;
        return {
          type:           attrs.type || i.type || '',
          status:         attrs.status || '',
          expirationDate: attrs.expiration_date || attrs.expirationDate || '',
          creationDate:   attrs.creation_date || attrs.creationDate || ''
        };
      })
    };
  }

  // ── Parse benefit letters ─────────────────────────────────────────────
  let parsedBenefitLetters = null;
  if (lettersJson?.data) {
    const attrs = lettersJson.data.attributes || lettersJson.data;
    parsedBenefitLetters = {
      letters: (attrs.letters || []).map(l => ({
        name:       l.name || l.letterName || '',
        letterType: l.letter_type || l.letterType || ''
      })),
      benefitInfo: attrs.benefit_information || attrs.benefitInformation || {}
    };
  }

  // ── Parse debts ───────────────────────────────────────────────────────
  let parsedDebts = null;
  const debtItems = debtsJson?.debts || debtsJson?.data || [];
  const copayItems = copaysJson?.data || [];
  if (debtItems.length > 0 || copayItems.length > 0) {
    parsedDebts = {
      debts: (Array.isArray(debtItems) ? debtItems : []).map(d => ({
        ...d,
        type:   d.deduction_code || d.deductionCode || d.type || '',
        amount: d.current_ar || d.currentAr || d.original_ar || d.originalAr || d.amount || 0,
        status: d.debt_history?.[0]?.status || d.status || ''
      })),
      copays: (Array.isArray(copayItems) ? copayItems : []).map(c => ({
        ...c,
        station:     c.facility_name || c.facilityName || '',
        amount:      c.pH_AMT_DUE || c.pHAmtDue || c.amount || 0,
        billingDate: c.pH_DTE_BILL || c.pHDteBill || ''
      }))
    };
  }

  // ── Parse dependents ──────────────────────────────────────────────────
  let parsedDependents = null;
  if (dependentsJson?.data) {
    const items = Array.isArray(dependentsJson.data) ? dependentsJson.data : [dependentsJson.data];
    parsedDependents = {
      dependents: items.map(d => {
        const attrs = d.attributes || d;
        return {
          firstName:    attrs.first_name || attrs.firstName || '',
          lastName:     attrs.last_name || attrs.lastName || '',
          relationship: attrs.relationship || attrs.related_to || '',
          dateOfBirth:  attrs.date_of_birth || attrs.dateOfBirth || ''
        };
      })
    };
  }

  // ── Parse documents (eFolder returns a plain array, not { data: [...] })
  let parsedDocuments = null;
  const efolderItems = Array.isArray(documentsJson) ? documentsJson
    : (documentsJson?.data ? (Array.isArray(documentsJson.data) ? documentsJson.data : []) : []);
  if (efolderItems.length > 0) {
    parsedDocuments = {
      documents: efolderItems.map(d => ({
        documentId:      d.document_id || d.documentId || d.id || '',
        typeDescription: d.type_description || d.typeDescription || '',
        receivedAt:      d.received_at || d.receivedAt || d.upload_date || ''
      })),
      totalCount: efolderItems.length
    };
  }

  // ── Parse claim letters (/v0/claim_letters — decision/notification letters)
  let parsedClaimLetters = null;
  const claimLetterItems = Array.isArray(claimLettersJson) ? claimLettersJson
    : (claimLettersJson?.data ? (Array.isArray(claimLettersJson.data) ? claimLettersJson.data : []) : []);
  if (claimLetterItems.length > 0) {
    parsedClaimLetters = {
      documents: claimLetterItems.map(d => ({
        documentId:      d.document_id || d.documentId || d.id || '',
        typeDescription: d.type_description || d.typeDescription || '',
        subject:         d.subject || '',
        docType:         d.doc_type || d.docType || '',
        receivedAt:      d.received_at || d.receivedAt || d.upload_date || '',
        mimeType:        d.mime_type || d.mimeType || 'application/pdf'
      })),
      totalCount: claimLetterItems.length
    };
    console.log(`[VetClaim] Found ${parsedClaimLetters.totalCount} claim letters from VA`);
  }

  // ── Persist locally ───────────────────────────────────────────────────
  await chrome.storage.local.set({
    vaClaims:          parsedClaims,
    vaRatings:         parsedRatings,
    vaAppeals:         parsedAppeals,
    vaPayments:        parsedPayments,
    vaServiceHistory:  parsedServiceHistory,
    vaIntentToFile:    parsedIntentToFile,
    vaBenefitLetters:  parsedBenefitLetters,
    vaDebts:           parsedDebts,
    vaDependents:      parsedDependents,
    vaDocuments:       parsedDocuments,
    vaClaimLetters:    parsedClaimLetters,
    vaLastFetch:       Date.now(),
    _rawClaims:        claimsJson,
    _rawRatings:       ratingsJson,
    _rawPayments:      paymentsJson
  });

  console.log(
    `[VetClaim] Fetched: ${parsedClaims.length} claims, ` +
    `${parsedRatings ? parsedRatings.individualRatings.length : 0} ratings, ` +
    `${parsedAppeals.length} appeals, ${parsedPayments.length} payments, ` +
    `SH:${parsedServiceHistory ? 'yes' : 'no'}, ITF:${parsedIntentToFile ? 'yes' : 'no'}, ` +
    `Letters:${parsedBenefitLetters ? 'yes' : 'no'}, Debts:${parsedDebts ? 'yes' : 'no'}`
  );

  // ── Unified sync to VetClaim API ──────────────────────────────────────
  const auth = await checkAuthStatus();
  if (auth.authenticated) {
    await syncAllToVetClaim(auth.accessToken);

    // Fire-and-forget: auto-analyze decision/denial letters from /v0/claim_letters
    if (parsedClaimLetters?.documents?.length > 0) {
      processDecisionLetters(parsedClaimLetters.documents, auth.accessToken).catch(err => {
        console.error('[VetClaim] Decision letter processing error:', err);
      });
    }
  }

  // ── Notify VA.gov tabs ────────────────────────────────────────────────
  const vaTabs = await chrome.tabs.query({ url: '*://www.va.gov/*' });
  for (const tab of vaTabs) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'VA_DATA_READY',
      claims: parsedClaims,
      ratings: parsedRatings,
      appeals: parsedAppeals,
      serviceHistory: parsedServiceHistory,
      intentToFile: parsedIntentToFile,
      benefitLetters: parsedBenefitLetters,
      debts: parsedDebts
    }).catch(() => {});
  }

  if (parsedClaims.length > 0) {
    sendNotification('Claims Synced', `${parsedClaims.length} claim(s) pulled from VA.gov`);
  }

  // Update badge
  updateBadge();
}

// ─── Decision Letter Auto-Analysis ──────────────────────────────────────

/**
 * Classify a VA claim letter by its typeDescription and docType.
 * VA /v0/claim_letters uses doc_type "184" for claim decisions.
 * Returns 'DECISION_LETTER', 'DENIAL_LETTER', or null.
 */
function classifyVaDocument(typeDescription, docType) {
  if (!typeDescription && !docType) return null;
  const desc = (typeDescription || '').toLowerCase();

  // doc_type 184 = "Claim decision (or other notification, like Intent to File)"
  if (docType === '184' || desc.includes('claim decision') || desc.includes('rating decision')
      || desc.includes('decision letter') || desc.includes('decision notice')
      || desc.includes('notification letter')) {
    return 'DECISION_LETTER';
  }

  if (desc.includes('denial letter') || desc.includes('denial notice') || desc.includes('denial of claim')) {
    return 'DENIAL_LETTER';
  }

  return null;
}

/**
 * Fetch actual PDF binary from VA /v0/claim_letters/{id}.
 * Returns { blob, contentType } or null.
 */
async function fetchVaDocumentBinary(documentId) {
  try {
    const res = await fetch(`${CONFIG.vaApiBase}/v0/claim_letters/${documentId}`, {
      credentials: 'include',
      headers: { 'Accept': 'application/pdf' }
    });
    if (!res.ok) {
      console.warn(`[VetClaim] VA doc fetch ${documentId} returned ${res.status}`);
      return null;
    }
    const contentType = res.headers.get('content-type') || 'application/pdf';
    const blob = await res.blob();
    // Reject files > 10MB
    if (blob.size > 10 * 1024 * 1024) {
      console.warn(`[VetClaim] VA doc ${documentId} too large (${blob.size} bytes), skipping`);
      return null;
    }
    return { blob, contentType };
  } catch (err) {
    console.error(`[VetClaim] VA doc binary fetch failed for ${documentId}:`, err);
    return null;
  }
}

/**
 * Upload a VA document to VetClaim's existing /v1/files/upload endpoint.
 * Returns { documentId, alreadyExists, analysisStatus } or null.
 */
async function uploadVaDocumentToVetClaim(documentId, blob, contentType, documentType, accessToken) {
  const ext = contentType.includes('pdf') ? 'pdf' : 'bin';
  const formData = new FormData();
  // Text fields MUST come before the file for @fastify/multipart to parse them
  formData.append('vaDocumentId', documentId);
  formData.append('documentType', documentType);
  formData.append('file', blob, `va-doc-${documentId}.${ext}`);

  const doUpload = async (token) => {
    const res = await fetch(`${CONFIG.apiBaseUrl}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    return res;
  };

  try {
    let res = await doUpload(accessToken);

    // Retry once with refreshed token on 401
    if (res.status === 401) {
      const refreshed = await refreshAuthToken();
      if (!refreshed) return null;
      res = await doUpload(refreshed.accessToken);
    }

    if (!res.ok) {
      console.error(`[VetClaim] Upload failed for VA doc ${documentId}: ${res.status}`);
      return null;
    }

    const json = await res.json();
    return {
      documentId: json.data?.documentId,
      alreadyExists: json.alreadyExists || false,
      analysisStatus: json.data?.analysisStatus || null
    };
  } catch (err) {
    console.error(`[VetClaim] Upload error for VA doc ${documentId}:`, err);
    return null;
  }
}

/**
 * Orchestrator: find decision/denial letters from /v0/claim_letters,
 * download PDFs, and upload them to VetClaim for AI analysis.
 */
async function processDecisionLetters(documents, accessToken) {
  const MAX_RETRIES = 3;
  const storage = await chrome.storage.local.get(['uploadedVaDocs']);
  const uploaded = storage.uploadedVaDocs || {};

  // Filter for decision/denial letters not already uploaded
  const candidates = [];
  for (const doc of documents) {
    const docType = classifyVaDocument(doc.typeDescription, doc.docType);
    if (!docType) continue;

    const existing = uploaded[doc.documentId];
    if (existing?.status === 'uploaded') continue;
    if (existing?.retryCount >= MAX_RETRIES) continue;

    candidates.push({ ...doc, docType, retryCount: existing?.retryCount || 0 });
  }

  if (candidates.length === 0) return;
  console.log(`[VetClaim] Found ${candidates.length} unprocessed decision letter(s)`);

  for (const candidate of candidates) {
    const { documentId, docType, retryCount } = candidate;

    // Download PDF from VA
    const binary = await fetchVaDocumentBinary(documentId);
    if (!binary) {
      uploaded[documentId] = {
        status: 'download_failed',
        timestamp: Date.now(),
        retryCount: retryCount + 1
      };
      continue;
    }

    // Upload to VetClaim API (with delay between uploads to avoid rate limits)
    if (candidates.indexOf(candidate) > 0) {
      await new Promise(r => setTimeout(r, 5000)); // 5s between uploads
    }
    const result = await uploadVaDocumentToVetClaim(
      documentId, binary.blob, binary.contentType, docType, accessToken
    );

    if (result) {
      uploaded[documentId] = {
        vetclaimDocId: result.documentId,
        status: 'uploaded',
        alreadyExists: result.alreadyExists,
        timestamp: Date.now(),
        retryCount: 0
      };

      if (!result.alreadyExists) {
        sendNotification(
          'Decision Letter Found',
          `A ${docType === 'DENIAL_LETTER' ? 'denial' : 'decision'} letter has been sent for AI analysis.`
        );
      }
    } else {
      uploaded[documentId] = {
        status: 'upload_failed',
        timestamp: Date.now(),
        retryCount: retryCount + 1
      };
    }
  }

  await chrome.storage.local.set({ uploadedVaDocs: uploaded });
  console.log(`[VetClaim] Decision letter processing complete`);
}

// ─── Phase Type → Number Mapping ────────────────────────────────────────
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
function parseBenefitClaim(data) {
  const a = data.attributes || {};
  const phaseDates = a.claimPhaseDates || {};
  const latestPhaseType = phaseDates.latestPhaseType || a.latestPhaseType || a.phaseType || '';
  const rawPhase = a.phase ?? a.currentPhase ?? null;
  const phase = (typeof rawPhase === 'number' && rawPhase >= 1)
    ? rawPhase
    : phaseFromString(latestPhaseType);
  const status = a.status || a.claimStatus || '';
  const claimType = a.claimType || a.statusType || '';

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

// ─── Unified VetClaim API Sync ──────────────────────────────────────────
// Posts ALL data types in a single request to /va-sync/full.
// Falls back to individual endpoints if unified fails.
async function syncAllToVetClaim(accessToken) {
  const data = await chrome.storage.local.get([
    'vaClaims', 'vaRatings', 'vaAppeals', 'vaPayments',
    'vaServiceHistory', 'vaIntentToFile', 'vaBenefitLetters',
    'vaDebts', 'vaDependents', 'vaDocuments', '_rawClaims'
  ]);

  const payload = { timestamp: Date.now() };

  if (data.vaClaims?.length > 0) {
    payload.claims = data.vaClaims.map((c, i) => ({
      structured: c,
      raw: data._rawClaims?.data?.[i] ?? null,
      lastUpdated: Date.now()
    }));
  }
  if (data.vaRatings) {
    payload.ratings = data.vaRatings;
  }
  if (data.vaAppeals?.length > 0) {
    payload.appeals = data.vaAppeals;
  }
  if (data.vaPayments?.length > 0) {
    payload.payments = data.vaPayments;
  }
  if (data.vaServiceHistory) {
    payload.serviceHistory = data.vaServiceHistory;
  }
  if (data.vaIntentToFile) {
    payload.intentToFile = data.vaIntentToFile;
  }
  if (data.vaBenefitLetters) {
    payload.benefitLetters = data.vaBenefitLetters;
  }
  if (data.vaDebts) {
    payload.debts = data.vaDebts;
  }
  if (data.vaDependents) {
    payload.dependents = data.vaDependents;
  }
  if (data.vaDocuments) {
    payload.documents = data.vaDocuments;
  }

  try {
    const res = await fetch(`${CONFIG.apiBaseUrl}/va-sync/full`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Extension-Version': chrome.runtime.getManifest().version
      },
      body: JSON.stringify(payload)
    });

    if (res.status === 401) {
      const refreshed = await refreshAuthToken();
      if (refreshed) return syncAllToVetClaim(refreshed.accessToken);
      return;
    }

    if (res.ok) {
      const result = await res.json();
      const changes = result?.data?.changes;
      const notifications = result?.data?.notifications || [];

      await chrome.storage.local.set({
        lastSync: Date.now(),
        lastSyncChanges: changes,
        pendingAlerts: notifications
      });

      // Show Chrome notifications for significant changes
      if (notifications.length > 0) {
        const urgent = notifications.filter(n =>
          n.type === 'DEADLINE_REMINDER' || n.type === 'RATING_CHANGE' || n.type === 'DEBT_ALERT'
        );
        if (urgent.length > 0) {
          sendNotification(urgent[0].title, urgent[0].message);
        }
      }

      console.log(`[VetClaim] Unified sync complete. ${notifications.length} notification(s).`);
      updateBadge();
      return;
    }

    // If unified endpoint not available yet, fall back to individual syncs
    console.warn('[VetClaim] Unified sync failed, falling back to individual endpoints');
    await fallbackIndividualSync(data, accessToken);
  } catch (err) {
    console.error('[VetClaim] Unified sync error, falling back:', err);
    const data2 = await chrome.storage.local.get([
      'vaClaims', 'vaRatings', 'vaAppeals', 'vaPayments', '_rawClaims'
    ]);
    await fallbackIndividualSync(data2, accessToken);
  }
}

// Legacy individual sync (backward compatibility during rollout)
async function fallbackIndividualSync(data, accessToken) {
  const tasks = [];

  if (data.vaClaims?.length > 0) {
    tasks.push(syncClaimsToVetClaim(data.vaClaims, data._rawClaims, accessToken));
  }
  if (data.vaRatings) {
    tasks.push(syncRatingsToVetClaim(data.vaRatings, accessToken));
  }
  if (data.vaAppeals?.length > 0) {
    tasks.push(syncAppealsToVetClaim(data.vaAppeals, accessToken));
  }
  if (data.vaPayments?.length > 0) {
    tasks.push(syncPaymentsToVetClaim(data.vaPayments, accessToken));
  }

  await Promise.allSettled(tasks);
  await chrome.storage.local.set({ lastSync: Date.now() });
}

// Legacy individual sync functions (kept for fallback)
async function syncClaimsToVetClaim(claims, rawJson, accessToken) {
  try {
    const endpoint = claims.length === 1 ? '/va-sync' : '/va-sync/batch';
    const body = claims.length === 1
      ? { claimData: claims[0], rawData: rawJson?.data ?? null, dataType: 'benefit_claim', timestamp: Date.now() }
      : { claims: claims.map((c, i) => ({ structured: c, raw: rawJson?.data?.[i] ?? null, lastUpdated: Date.now() })), timestamp: Date.now() };

    const res = await fetch(`${CONFIG.apiBaseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Extension-Version': chrome.runtime.getManifest().version
      },
      body: JSON.stringify(body)
    });

    if (res?.status === 401) {
      const refreshed = await refreshAuthToken();
      if (refreshed) return syncClaimsToVetClaim(claims, rawJson, refreshed.accessToken);
    }
    console.log('[VetClaim] Claims sync complete');
  } catch (err) {
    console.error('[VetClaim] Claims sync error:', err);
  }
}

async function syncRatingsToVetClaim(ratings, accessToken) {
  if (!ratings) return;
  try {
    const res = await fetch(`${CONFIG.apiBaseUrl}/va-sync/ratings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'X-Extension-Version': chrome.runtime.getManifest().version },
      body: JSON.stringify({ combinedRating: ratings.combinedRating, individualRatings: ratings.individualRatings, timestamp: Date.now() })
    });
    if (res?.status === 401) { const r = await refreshAuthToken(); if (r) return syncRatingsToVetClaim(ratings, r.accessToken); }
    console.log(`[VetClaim] Ratings synced: combined=${ratings.combinedRating}%`);
  } catch (err) { console.error('[VetClaim] Ratings sync error:', err); }
}

async function syncAppealsToVetClaim(appeals, accessToken) {
  if (!appeals?.length) return;
  try {
    const res = await fetch(`${CONFIG.apiBaseUrl}/va-sync/appeals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'X-Extension-Version': chrome.runtime.getManifest().version },
      body: JSON.stringify({ appeals, timestamp: Date.now() })
    });
    if (res?.status === 401) { const r = await refreshAuthToken(); if (r) return syncAppealsToVetClaim(appeals, r.accessToken); }
    console.log(`[VetClaim] Appeals synced: ${appeals.length}`);
  } catch (err) { console.error('[VetClaim] Appeals sync error:', err); }
}

async function syncPaymentsToVetClaim(payments, accessToken) {
  if (!payments?.length) return;
  try {
    const res = await fetch(`${CONFIG.apiBaseUrl}/va-sync/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'X-Extension-Version': chrome.runtime.getManifest().version },
      body: JSON.stringify({ payments, timestamp: Date.now() })
    });
    if (res?.status === 401) { const r = await refreshAuthToken(); if (r) return syncPaymentsToVetClaim(payments, r.accessToken); }
    console.log(`[VetClaim] Payments synced: ${payments.length}`);
  } catch (err) { console.error('[VetClaim] Payments sync error:', err); }
}

// ─── Badge Management ──────────────────────────────────────────────────
async function updateBadge() {
  const data = await chrome.storage.local.get(['pendingAlerts', 'vaClaims', 'vaIntentToFile']);
  let alertCount = 0;
  let urgent = false;

  // Count pending alerts
  if (data.pendingAlerts?.length > 0) {
    alertCount = data.pendingAlerts.length;
    urgent = data.pendingAlerts.some(a =>
      a.type === 'DEADLINE_REMINDER' || a.type === 'DEBT_ALERT'
    );
  }

  // Count claims needing docs
  if (data.vaClaims) {
    const docsNeeded = data.vaClaims.filter(c => c.documentsNeeded).length;
    alertCount += docsNeeded;
    if (docsNeeded > 0) urgent = true;
  }

  // Check ITF expirations
  if (data.vaIntentToFile?.intents) {
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const expiring = data.vaIntentToFile.intents.filter(i => {
      if (i.status?.toLowerCase() !== 'active') return false;
      const exp = new Date(i.expirationDate).getTime();
      return !isNaN(exp) && (exp - now) < thirtyDays;
    });
    alertCount += expiring.length;
    if (expiring.length > 0) urgent = true;
  }

  if (alertCount > 0) {
    chrome.action.setBadgeText({ text: String(alertCount) });
    chrome.action.setBadgeBackgroundColor({ color: urgent ? '#e53e3e' : '#f0c040' });
  } else {
    chrome.action.setBadgeText({ text: '' });
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
    case 'VETCLAIM_AUTH_TOKENS':
      chrome.storage.local.set({
        accessToken:  msg.accessToken,
        refreshToken: msg.refreshToken,
        userData:     msg.userData
      }).then(() => sendResponse({ success: true }));
      return true;

    case 'REQUEST_AUTH_STATUS':
      checkAuthStatus().then(sendResponse);
      return true;

    case 'REQUEST_VA_DATA':
      chrome.storage.local.get([
        'vaClaims', 'vaRatings', 'vaAppeals', 'vaPayments',
        'vaServiceHistory', 'vaIntentToFile', 'vaBenefitLetters',
        'vaDebts', 'vaDependents', 'vaDocuments',
        'vaLoggedIn', 'vaLastFetch', 'lastSync',
        'lastSyncChanges', 'pendingAlerts'
      ]).then(sendResponse);
      return true;

    case 'TRIGGER_VA_FETCH':
      lastVaFetch = 0;
      fetchAllVaData()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ error: e.message }));
      return true;

    case 'CLEAR_ALERTS':
      chrome.storage.local.set({ pendingAlerts: [] }).then(() => {
        updateBadge();
        sendResponse({ success: true });
      });
      return true;

    default:
      return false;
  }
});

// ─── Periodic Re-sync ───────────────────────────────────────────────────
setInterval(async () => {
  const auth = await checkAuthStatus();
  if (!auth.authenticated) return;

  console.log('[VetClaim] Periodic re-sync…');
  await syncAllToVetClaim(auth.accessToken);
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

// ─── Auto-fetch on startup ─────────────────────────────────────────────
(async () => {
  try {
    await new Promise(r => setTimeout(r, 2000));
    console.log('[VetClaim] Auto-fetching VA.gov data on startup…');
    lastVaFetch = 0;
    await fetchAllVaData();
    console.log('[VetClaim] Startup fetch complete');
  } catch (err) {
    console.log('[VetClaim] Startup fetch skipped:', err?.message);
  }
})();

console.log('[VetClaim] Service worker initialized');
