/**
 * VetClaim Content Script — runs on VA.gov claim pages
 * Requests cached claim data from background and injects an info overlay.
 * Claim cards are clickable — opens the VetClaim dashboard detail view.
 */

(function () {
  'use strict';

  console.log('[VetClaim] Content script loaded');

  // Inject interceptor as fallback (captures individual claim detail pages)
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('interceptor.js');
    script.setAttribute('data-extension-id', chrome.runtime.id);
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
  } catch (e) {
    // interceptor.js may not exist in newer builds — that's fine
  }

  // ── Request data from background on page load ──────────────────────────
  window.addEventListener('load', () => {
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'REQUEST_VA_DATA' }, (data) => {
        if (chrome.runtime.lastError || !data) return;
        if (data.vaClaims?.length > 0) {
          injectOverlay(data.vaClaims, data.vaRatings);
        }
      });
    }, 3000);
  });

  // ── Listen for fresh data pushed from background ───────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'VA_DATA_READY') {
      if (msg.claims?.length > 0) {
        injectOverlay(msg.claims, msg.ratings);
      }
      sendResponse({ success: true });
    }
    if (msg.type === 'AI_INSIGHTS_READY') {
      sendResponse({ success: true });
    }
    return true;
  });

  // Legacy: relay intercepted data from injected script to background
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'va-interceptor') return;

    if (event.data.type === 'VA_INTELLIGENCE_API_DATA') {
      chrome.runtime.sendMessage({
        type: 'CLAIM_DATA_INTERCEPTED',
        timestamp: event.data.timestamp,
        url: event.data.url,
        data: event.data.data
      }).catch(() => {});
    }
  });

  // ── Expanded claim detail panel ────────────────────────────────────────
  let expandedClaimId = null;

  function toggleClaimDetail(claimId, claims) {
    const detailEl = document.getElementById('vc-detail-' + claimId);

    // Close any other open details
    document.querySelectorAll('.vc-claim-detail').forEach(el => {
      if (el.id !== 'vc-detail-' + claimId) {
        el.style.display = 'none';
      }
    });

    if (detailEl) {
      const isVisible = detailEl.style.display !== 'none';
      detailEl.style.display = isVisible ? 'none' : 'block';
      expandedClaimId = isVisible ? null : claimId;
      return;
    }
  }

  // ─── Overlay ──────────────────────────────────────────────────────────
  function injectOverlay(claims, ratings) {
    const existing = document.getElementById('vetclaim-overlay');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'vetclaim-overlay';

    const combinedRating = ratings?.combinedRating;
    const claimCount = claims.length;
    const docsNeeded = claims.filter(c => c.documentsNeeded).length;

    const phaseLabels = {
      1:'Received', 2:'Initial Review', 3:'Evidence Gathering',
      4:'Review of Evidence', 5:'Prep for Decision', 6:'Pending Approval',
      7:'Prep for Notification', 8:'Complete'
    };

    container.innerHTML = `
      <style>
        #vetclaim-overlay {
          position: fixed;
          bottom: 20px;
          right: 20px;
          width: 360px;
          max-height: 85vh;
          background: #0f1d2f;
          border: 1px solid #1e3a5f;
          border-radius: 12px;
          color: #e2e8f0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          z-index: 999999;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        #vetclaim-overlay .vc-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: #162436;
          border-bottom: 1px solid #1e3a5f;
          flex-shrink: 0;
        }
        #vetclaim-overlay .vc-badge {
          display: flex; align-items: center; gap: 8px;
          font-weight: 600; color: #f0c040; font-size: 13px;
        }
        #vetclaim-overlay .vc-close {
          background: none; border: none; color: #64748b;
          font-size: 18px; cursor: pointer; padding: 0 4px;
        }
        #vetclaim-overlay .vc-close:hover { color: #e2e8f0; }
        #vetclaim-overlay .vc-body {
          padding: 14px 16px;
          overflow-y: auto;
          flex: 1;
        }
        #vetclaim-overlay .vc-stat-row {
          display: flex; gap: 10px; margin-bottom: 12px;
        }
        #vetclaim-overlay .vc-stat {
          flex: 1; background: #1a2a3f; border-radius: 8px;
          padding: 10px; text-align: center;
        }
        #vetclaim-overlay .vc-stat-value {
          font-size: 22px; font-weight: 700; color: #f0c040;
        }
        #vetclaim-overlay .vc-stat-label {
          font-size: 10px; color: #94a3b8; text-transform: uppercase; margin-top: 2px;
        }
        #vetclaim-overlay .vc-claim {
          background: #1a2a3f; border-radius: 8px;
          padding: 10px 12px; margin-bottom: 8px;
          cursor: pointer; border: 1px solid transparent;
          transition: border-color 0.15s, background 0.15s;
        }
        #vetclaim-overlay .vc-claim:hover {
          border-color: #2d4a6f; background: #1e3048;
        }
        #vetclaim-overlay .vc-claim-header {
          display: flex; align-items: center; justify-content: space-between;
        }
        #vetclaim-overlay .vc-claim-title {
          font-weight: 600; font-size: 12px; margin-bottom: 4px;
        }
        #vetclaim-overlay .vc-chevron {
          font-size: 14px; color: #64748b; transition: transform 0.2s;
        }
        #vetclaim-overlay .vc-claim.expanded .vc-chevron {
          transform: rotate(90deg);
        }
        #vetclaim-overlay .vc-phase {
          display: flex; align-items: center; gap: 8px;
          font-size: 11px; color: #94a3b8; margin-bottom: 6px;
        }
        #vetclaim-overlay .vc-bar {
          flex: 1; height: 4px; background: #0f1d2f;
          border-radius: 2px; overflow: hidden;
        }
        #vetclaim-overlay .vc-bar-fill {
          height: 100%; background: #f0c040; border-radius: 2px;
          transition: width 0.3s;
        }
        #vetclaim-overlay .vc-tags {
          display: flex; flex-wrap: wrap; gap: 4px;
        }
        #vetclaim-overlay .vc-tag {
          font-size: 10px; padding: 2px 6px; border-radius: 4px;
          background: #162436; color: #94a3b8;
        }
        #vetclaim-overlay .vc-tag.warn { background: #7c2d12; color: #fdba74; }
        #vetclaim-overlay .vc-tag.success { background: #14532d; color: #86efac; }

        /* Detail panel styles */
        #vetclaim-overlay .vc-claim-detail {
          display: none; margin-top: 8px; padding-top: 8px;
          border-top: 1px solid #1e3a5f;
        }
        #vetclaim-overlay .vc-detail-section {
          margin-bottom: 8px;
        }
        #vetclaim-overlay .vc-detail-label {
          font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px;
          color: #64748b; margin-bottom: 4px;
        }
        #vetclaim-overlay .vc-detail-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
        }
        #vetclaim-overlay .vc-detail-item {
          background: #0f1d2f; border-radius: 6px; padding: 6px 8px;
        }
        #vetclaim-overlay .vc-detail-item-label {
          font-size: 9px; color: #64748b; text-transform: uppercase;
        }
        #vetclaim-overlay .vc-detail-item-value {
          font-size: 11px; color: #e2e8f0; font-weight: 500; margin-top: 1px;
        }
        #vetclaim-overlay .vc-phase-steps {
          display: flex; flex-direction: column; gap: 2px;
        }
        #vetclaim-overlay .vc-phase-step {
          display: flex; align-items: center; gap: 6px; font-size: 10px;
        }
        #vetclaim-overlay .vc-phase-dot {
          width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        }
        #vetclaim-overlay .vc-phase-dot.done { background: #22c55e; }
        #vetclaim-overlay .vc-phase-dot.current { background: #3b82f6; box-shadow: 0 0 6px #3b82f6; }
        #vetclaim-overlay .vc-phase-dot.pending { background: #1e3a5f; }
        #vetclaim-overlay .vc-tracked-item {
          background: #0f1d2f; border-radius: 6px; padding: 6px 8px;
          margin-bottom: 4px; font-size: 11px;
        }
        #vetclaim-overlay .vc-tracked-status {
          font-size: 9px; color: #f0c040; text-transform: uppercase; font-weight: 600;
        }
        #vetclaim-overlay .vc-doc-row {
          display: flex; align-items: center; gap: 6px;
          font-size: 10px; color: #94a3b8; padding: 3px 0;
        }
        #vetclaim-overlay .vc-dashboard-btn {
          display: block; width: 100%; margin-top: 8px;
          padding: 6px; background: #1e3a5f; color: #60a5fa;
          border: none; border-radius: 6px; font-size: 11px;
          cursor: pointer; text-align: center; text-decoration: none;
        }
        #vetclaim-overlay .vc-dashboard-btn:hover {
          background: #2d4a6f; color: #93bbfc;
        }

        #vetclaim-overlay .vc-footer {
          padding: 10px 16px; border-top: 1px solid #1e3a5f;
          text-align: center; flex-shrink: 0;
        }
        #vetclaim-overlay .vc-link {
          color: #60a5fa; text-decoration: none; font-size: 11px;
        }
        #vetclaim-overlay .vc-link:hover { text-decoration: underline; }
      </style>

      <div class="vc-header">
        <div class="vc-badge">VetClaim AI</div>
        <button class="vc-close" id="vc-close-btn">&times;</button>
      </div>

      <div class="vc-body">
        <div class="vc-stat-row">
          <div class="vc-stat">
            <div class="vc-stat-value">${combinedRating != null ? combinedRating + '%' : '—'}</div>
            <div class="vc-stat-label">Combined Rating</div>
          </div>
          <div class="vc-stat">
            <div class="vc-stat-value">${claimCount}</div>
            <div class="vc-stat-label">Active Claims</div>
          </div>
          <div class="vc-stat">
            <div class="vc-stat-value">${docsNeeded}</div>
            <div class="vc-stat-label">Docs Needed</div>
          </div>
        </div>

        ${claims.map(c => {
          const pct = c.phase ? Math.round((c.phase / 8) * 100) : 0;
          const statusText = c.phase ? phaseLabels[c.phase]
            : (c.status || c.latestPhaseType || '').replace(/_/g, ' ').toLowerCase()
                .replace(/\b\w/g, l => l.toUpperCase()) || 'Pending';

          const dateStr = (d) => d ? new Date(d).toLocaleDateString() : '—';
          const isComplete = c.phase >= 7;

          // Build phase steps
          const phaseSteps = [1,2,3,4,5,6,7,8].map(step => {
            const cls = step < (c.phase || 0) ? 'done' : step === (c.phase || 0) ? 'current' : 'pending';
            return '<div class="vc-phase-step"><div class="vc-phase-dot ' + cls + '"></div><span style="color:' + (cls === 'pending' ? '#475569' : '#94a3b8') + '">' + phaseLabels[step] + '</span></div>';
          }).join('');

          // Build tracked items
          const trackedHtml = (c.trackedItems || []).slice(0, 5).map(t => {
            const name = t.displayName || t.description || t.name || 'Item';
            const status = t.status || '';
            const due = t.suspenseDate ? 'Due: ' + dateStr(t.suspenseDate) : '';
            return '<div class="vc-tracked-item"><div style="color:#e2e8f0">' + name + '</div>' +
              (status ? '<span class="vc-tracked-status">' + status + '</span> ' : '') +
              (due ? '<span style="font-size:9px;color:#64748b">' + due + '</span>' : '') +
              '</div>';
          }).join('');

          // Build documents
          const docsHtml = (c.supportingDocuments || []).slice(0, 5).map(d => {
            const label = d.documentTypeLabel || d.originalFileName || d.trackedItemId || 'Document';
            const uploaded = d.uploadDate ? dateStr(d.uploadDate) : '';
            return '<div class="vc-doc-row"><span style="flex-shrink:0">&#128196;</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + label + '</span>' +
              (uploaded ? '<span style="flex-shrink:0;color:#64748b">' + uploaded + '</span>' : '') +
              '</div>';
          }).join('');

          return '<div class="vc-claim" data-claim-id="' + c.claimId + '">' +
            '<div class="vc-claim-header">' +
              '<div class="vc-claim-title">' + (c.claimType || 'Claim') + ' #' + c.claimId + '</div>' +
              '<span class="vc-chevron">&#9656;</span>' +
            '</div>' +
            '<div class="vc-phase">' +
              '<span>' + statusText + '</span>' +
              (c.phase ? '<div class="vc-bar"><div class="vc-bar-fill" style="width:' + pct + '%"></div></div><span>' + c.phase + '/8</span>' : '') +
            '</div>' +
            (c.jurisdiction ? '<div style="font-size:10px;color:#94a3b8;margin-bottom:4px;">' + c.jurisdiction + '</div>' : '') +
            '<div class="vc-tags">' +
              (c.contentions || []).slice(0, 3).map(ct =>
                '<span class="vc-tag">' + ct.name + '</span>'
              ).join('') +
              (c.documentsNeeded ? '<span class="vc-tag warn">DOCS NEEDED</span>' : '') +
              (c.decisionLetterSent ? '<span class="vc-tag success">DECISION SENT</span>' : '') +
            '</div>' +

            // Expandable detail section
            '<div class="vc-claim-detail" id="vc-detail-' + c.claimId + '">' +
              // Key dates grid
              '<div class="vc-detail-section">' +
                '<div class="vc-detail-label">Key Dates</div>' +
                '<div class="vc-detail-grid">' +
                  '<div class="vc-detail-item"><div class="vc-detail-item-label">Filed</div><div class="vc-detail-item-value">' + dateStr(c.dateFiled || c.dateInitiated) + '</div></div>' +
                  '<div class="vc-detail-item"><div class="vc-detail-item-label">Est. Decision</div><div class="vc-detail-item-value">' + dateStr(c.estimatedDecisionDate) + '</div></div>' +
                  '<div class="vc-detail-item"><div class="vc-detail-item-label">Phase Changed</div><div class="vc-detail-item-value">' + dateStr(c.phaseChangeDate || (c.claimPhaseDates && c.claimPhaseDates.phaseChangeDate)) + '</div></div>' +
                  '<div class="vc-detail-item"><div class="vc-detail-item-label">Status</div><div class="vc-detail-item-value">' + (c.status || '—') + '</div></div>' +
                '</div>' +
              '</div>' +

              // Phase timeline
              '<div class="vc-detail-section">' +
                '<div class="vc-detail-label">Phase Timeline</div>' +
                '<div class="vc-phase-steps">' + phaseSteps + '</div>' +
              '</div>' +

              // All contentions
              ((c.contentions || []).length > 0 ? (
                '<div class="vc-detail-section">' +
                  '<div class="vc-detail-label">All Claimed Conditions (' + c.contentions.length + ')</div>' +
                  '<div class="vc-tags" style="margin-top:4px">' +
                    c.contentions.map(ct => '<span class="vc-tag">' + ct.name + '</span>').join('') +
                  '</div>' +
                '</div>'
              ) : '') +

              // Tracked items
              ((c.trackedItems || []).length > 0 ? (
                '<div class="vc-detail-section">' +
                  '<div class="vc-detail-label">Tracked Items (' + (c.trackedItems || []).length + ')</div>' +
                  trackedHtml +
                '</div>'
              ) : '') +

              // Documents
              ((c.supportingDocuments || []).length > 0 ? (
                '<div class="vc-detail-section">' +
                  '<div class="vc-detail-label">Documents (' + (c.supportingDocuments || []).length + ')</div>' +
                  docsHtml +
                '</div>'
              ) : '') +

              // Flags
              '<div class="vc-detail-section">' +
                '<div class="vc-detail-label">Flags</div>' +
                '<div class="vc-tags" style="gap:6px">' +
                  (c.developmentLetterSent ? '<span class="vc-tag">Dev Letter Sent</span>' : '') +
                  (c.decisionLetterSent ? '<span class="vc-tag success">Decision Sent</span>' : '') +
                  (c.waiverSubmitted ? '<span class="vc-tag">5103 Waiver</span>' : '') +
                  (c.documentsNeeded ? '<span class="vc-tag warn">Action Required</span>' : '') +
                  (!c.developmentLetterSent && !c.decisionLetterSent && !c.waiverSubmitted && !c.documentsNeeded ? '<span class="vc-tag">None</span>' : '') +
                '</div>' +
              '</div>' +

              '<a class="vc-dashboard-btn" href="https://vetclaimservices.com/dashboard" target="_blank">Open in VetClaim Dashboard &rarr;</a>' +
            '</div>' +
          '</div>';
        }).join('')}
      </div>

      <div class="vc-footer">
        <a class="vc-link" href="https://vetclaimservices.com/dashboard" target="_blank">
          Open VetClaim Dashboard for full AI analysis &rarr;
        </a>
      </div>
    `;

    document.body.appendChild(container);

    // Close button
    document.getElementById('vc-close-btn').addEventListener('click', () => {
      container.remove();
      chrome.storage.local.set({ overlayDismissed: Date.now() });
    });

    // Click handlers for claim cards
    container.querySelectorAll('.vc-claim').forEach(card => {
      card.addEventListener('click', (e) => {
        // Don't toggle if clicking the dashboard button
        if (e.target.closest('.vc-dashboard-btn')) return;

        const claimId = card.dataset.claimId;
        const detail = document.getElementById('vc-detail-' + claimId);
        if (!detail) return;

        const isOpen = detail.style.display !== 'none';
        // Close all
        container.querySelectorAll('.vc-claim-detail').forEach(d => d.style.display = 'none');
        container.querySelectorAll('.vc-claim').forEach(c => c.classList.remove('expanded'));

        if (!isOpen) {
          detail.style.display = 'block';
          card.classList.add('expanded');
        }
      });
    });
  }

  console.log('[VetClaim] Content script initialized');
})();
