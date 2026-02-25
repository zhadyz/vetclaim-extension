/**
 * VA Intelligence Interceptor
 * Intercepts VA.gov API calls to extract claim data
 * Runs in page context (injected by content-script.js)
 */

(function() {
  'use strict';
  
  console.log('[VA Intelligence] Interceptor loaded');
  
  // Store original fetch
  const originalFetch = window.fetch;
  
  // Override fetch to intercept VA.gov API responses
  window.fetch = function(...args) {
    const url = args[0];
    
    return originalFetch.apply(this, args).then(response => {
      // Only intercept on claim status pages
      const currentUrl = window.location.href;
      const isStatusPage = currentUrl.includes('/status') && 
                          (currentUrl.split('/').pop() === 'status' || 
                           currentUrl.includes('/claim-or-appeal-status'));
      
      if (!isStatusPage) {
        return response;
      }
      
      // Skip keepalive requests
      if (url.includes('keepalive')) {
        return response;
      }
      
      // Check if this is a VA API endpoint we care about
      const isVAApi = url.includes('api.va.gov') || 
                     url.includes('/v0/') || 
                     url.includes('/services/');
      
      if (!isVAApi) {
        return response;
      }
      
      // Clone response so we don't consume it
      const clonedResponse = response.clone();
      
      // Parse and extract data
      clonedResponse.json()
        .then(json => {
          const extractedData = extractClaimData(json, url);
          
          if (extractedData) {
            // Send to content script
            window.postMessage({
              type: 'VA_INTELLIGENCE_API_DATA',
              source: 'va-interceptor',
              timestamp: Date.now(),
              url: url,
              data: extractedData
            }, '*');
            
            console.log('[VA Intelligence] Captured claim data:', extractedData.dataType);
          }
        })
        .catch(err => {
          console.error('[VA Intelligence] Error parsing response:', err);
        });
      
      return response;
    });
  };
  
  /**
   * Extract and structure claim data from API responses
   */
  function extractClaimData(json, url) {
    // Benefit Claims (Original disability claims)
    if (json.data && json.data.type === 'claim') {
      return {
        dataType: 'benefit_claim',
        raw: json.data,
        structured: parseBenefitClaim(json.data)
      };
    }
    
    // Appeals Claims
    if (Array.isArray(json.data) && 
        json.data.length > 0 && 
        ['higherLevelReview', 'supplementalClaim', 'appeal', 'legacyAppeal'].includes(json.data[0].type)) {
      return {
        dataType: 'appeal_claims',
        raw: json.data,
        structured: parseAppealClaims(json.data)
      };
    }
    
    // Individual claim details (deeper endpoint)
    if (url.includes('/evss_claims/') && json.claim) {
      return {
        dataType: 'claim_details',
        raw: json.claim,
        structured: parseClaimDetails(json.claim)
      };
    }
    
    return null;
  }
  
  /**
   * Parse benefit claim data into structured format
   */
  function parseBenefitClaim(data) {
    const attrs = data.attributes || {};
    
    return {
      claimId: data.id,
      claimType: attrs.claimType,
      claimTypeCode: attrs.claimTypeCode,
      
      // Status and phase
      status: attrs.status,
      phase: attrs.phase,
      phaseChangeDate: attrs.phaseChangeDate,
      
      // Timeline
      dateInitiated: attrs.claimDate,
      dateFiled: attrs.dateFiled,
      estimatedDecisionDate: attrs.estimatedDecisionDate,
      
      // Hidden flags that matter
      developmentLetterSent: attrs.developmentLetterSent || false,
      decisionLetterSent: attrs.decisionLetterSent || false,
      documentsNeeded: attrs.documentsNeeded || false,
      waiverSubmitted: attrs.waiverSubmitted || false,
      
      // Contentions (claimed conditions)
      contentions: (attrs.contentions || []).map(c => ({
        name: c.name,
        code: c.code,
        classification: c.classification,
        status: c.status // FAVORABLE, UNFAVORABLE, PENDING
      })),
      
      // Evidence and documents
      supportingDocuments: attrs.supportingDocuments || [],
      trackedItems: attrs.trackedItems || [],
      
      // Regional office data
      jurisdiction: attrs.jurisdiction,
      regionalOffice: attrs.claimPhaseDates?.currentPhaseBack,
      
      // Timeline events
      eventsTimeline: attrs.eventsTimeline || [],
      claimPhaseDates: attrs.claimPhaseDates || {},
      
      // Veteran info
      veteranParticipantId: attrs.veteranParticipantId,
      
      // Metadata
      updatedAt: attrs.updatedAt,
      createdAt: attrs.createdAt
    };
  }
  
  /**
   * Parse appeal claims data
   */
  function parseAppealClaims(dataArray) {
    return dataArray.map(appeal => {
      const attrs = appeal.attributes || {};
      
      return {
        appealId: appeal.id,
        type: appeal.type,
        
        status: attrs.status,
        active: attrs.active,
        
        // Timeline
        updated: attrs.updated,
        programArea: attrs.programArea,
        
        // Issues being appealed
        issues: (attrs.issues || []).map(issue => ({
          description: issue.description,
          diagnosticCode: issue.diagnosticCode,
          lastAction: issue.lastAction,
          date: issue.date
        })),
        
        // Events
        events: attrs.events || [],
        alerts: attrs.alerts || []
      };
    });
  }
  
  /**
   * Parse detailed claim information
   */
  function parseClaimDetails(claim) {
    return {
      claimId: claim.id,
      
      // Additional details not in basic endpoint
      vaRepresentative: claim.vaRepresentative,
      poa: claim.poa,
      
      // Detailed contentions with medical info
      contentions: (claim.contentions || []).map(c => ({
        name: c.name,
        medicalTerm: c.medicalTerm,
        condition: c.condition,
        decisionDate: c.decisionDate,
        diagnosticCode: c.diagnosticCode
      })),
      
      // C&P exam info
      requestedDecision: claim.requestedDecision,
      claimantCertification: claim.claimantCertification,
      
      // More timeline data
      maxEstDate: claim.maxEstDate,
      minEstDate: claim.minEstDate
    };
  }
  
  console.log('[VA Intelligence] Fetch interceptor active');
})();
