/**
 * VetClaim Content Script — runs on VA.gov claim pages
 * Requests cached claim data from background and injects an info overlay.
 * Also keeps the legacy interceptor as a fallback for individual claim pages.
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
    // Give VA.gov a moment to fire its own API calls, then ask background
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

    // Legacy interceptor relay
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

  // ─── Overlay ──────────────────────────────────────────────────────────
  function injectOverlay(claims, ratings) {
    // Remove existing
    const existing = document.getElementById('vetclaim-overlay');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'vetclaim-overlay';

    const combinedRating = ratings?.combinedRating;
    const claimCount = claims.length;
    const docsNeeded = claims.filter(c => c.documentsNeeded).length;

    container.innerHTML = `
      <style>
        #vetclaim-overlay {
          position: fixed;
          bottom: 20px;
          right: 20px;
          width: 340px;
          background: #0f1d2f;
          border: 1px solid #1e3a5f;
          border-radius: 12px;
          color: #e2e8f0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          z-index: 999999;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
          overflow: hidden;
        }
        #vetclaim-overlay .vc-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: #162436;
          border-bottom: 1px solid #1e3a5f;
        }
        #vetclaim-overlay .vc-badge {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 600;
          color: #f0c040;
          font-size: 13px;
        }
        #vetclaim-overlay .vc-close {
          background: none;
          border: none;
          color: #64748b;
          font-size: 18px;
          cursor: pointer;
          padding: 0 4px;
        }
        #vetclaim-overlay .vc-close:hover { color: #e2e8f0; }
        #vetclaim-overlay .vc-body { padding: 14px 16px; }
        #vetclaim-overlay .vc-stat-row {
          display: flex;
          gap: 10px;
          margin-bottom: 12px;
        }
        #vetclaim-overlay .vc-stat {
          flex: 1;
          background: #1a2a3f;
          border-radius: 8px;
          padding: 10px;
          text-align: center;
        }
        #vetclaim-overlay .vc-stat-value {
          font-size: 22px;
          font-weight: 700;
          color: #f0c040;
        }
        #vetclaim-overlay .vc-stat-label {
          font-size: 10px;
          color: #94a3b8;
          text-transform: uppercase;
          margin-top: 2px;
        }
        #vetclaim-overlay .vc-claim {
          background: #1a2a3f;
          border-radius: 8px;
          padding: 10px 12px;
          margin-bottom: 8px;
        }
        #vetclaim-overlay .vc-claim-title {
          font-weight: 600;
          font-size: 12px;
          margin-bottom: 4px;
        }
        #vetclaim-overlay .vc-phase {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          color: #94a3b8;
          margin-bottom: 6px;
        }
        #vetclaim-overlay .vc-bar {
          flex: 1;
          height: 4px;
          background: #0f1d2f;
          border-radius: 2px;
          overflow: hidden;
        }
        #vetclaim-overlay .vc-bar-fill {
          height: 100%;
          background: #f0c040;
          border-radius: 2px;
          transition: width 0.3s;
        }
        #vetclaim-overlay .vc-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        #vetclaim-overlay .vc-tag {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 4px;
          background: #162436;
          color: #94a3b8;
        }
        #vetclaim-overlay .vc-tag.warn {
          background: #7c2d12;
          color: #fdba74;
        }
        #vetclaim-overlay .vc-footer {
          padding: 10px 16px;
          border-top: 1px solid #1e3a5f;
          text-align: center;
        }
        #vetclaim-overlay .vc-link {
          color: #60a5fa;
          text-decoration: none;
          font-size: 11px;
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

        ${claims.slice(0, 4).map(c => {
          const pct = c.phase ? Math.round((c.phase / 8) * 100) : 0;
          const phaseLabels = {
            1:'Received',2:'Initial Review',3:'Evidence Gathering',
            4:'Review of Evidence',5:'Prep for Decision',6:'Pending Approval',
            7:'Prep for Notification',8:'Complete'
          };
          // Human-readable status from raw VA status string
          const statusText = c.phase ? phaseLabels[c.phase]
            : (c.status || c.latestPhaseType || '').replace(/_/g, ' ').toLowerCase()
                .replace(/\b\w/g, l => l.toUpperCase()) || 'Pending';
          return `
            <div class="vc-claim">
              <div class="vc-claim-title">${c.claimType || 'Claim'} #${c.claimId}</div>
              <div class="vc-phase">
                <span>${statusText}</span>
                ${c.phase ? `<div class="vc-bar"><div class="vc-bar-fill" style="width:${pct}%"></div></div><span>${c.phase}/8</span>` : ''}
              </div>
              ${c.jurisdiction ? `<div style="font-size:10px;color:#94a3b8;margin-bottom:4px;">${c.jurisdiction}</div>` : ''}
              <div class="vc-tags">
                ${(c.contentions || []).slice(0, 4).map(ct =>
                  `<span class="vc-tag">${ct.name}</span>`
                ).join('')}
                ${c.documentsNeeded ? '<span class="vc-tag warn">DOCS NEEDED</span>' : ''}
                ${c.decisionLetterSent ? '<span class="vc-tag" style="background:#14532d;color:#86efac;">DECISION SENT</span>' : ''}
              </div>
            </div>
          `;
        }).join('')}
        ${claims.length > 4 ? `<div style="text-align:center;color:#64748b;font-size:11px;margin-top:4px;">+ ${claims.length - 4} more claim(s)</div>` : ''}
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
  }

  console.log('[VetClaim] Content script initialized');
})();
