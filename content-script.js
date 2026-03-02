/**
 * VetClaim Content Script — Intelligent VA.gov Claim Overlay
 *
 * Features:
 * - Minimized floating pill → expands to full panel
 * - Claims sorted: ATTENTION NEEDED → ACTIVE → COMPLETED
 * - Appeal window countdown (1 year from decision)
 * - Days in process + estimated days remaining
 * - Contention outcome color coding (favorable/unfavorable)
 * - Next action suggestions per claim
 * - Open tracked items count
 * - Individual ratings section
 * - Smooth CSS-driven animations
 */

(function () {
  'use strict';

  const LOGO_URL = chrome.runtime.getURL('icons/logo-small.png');

  const PHASE_LABELS = {
    1: 'Claim Received',
    2: 'Initial Review',
    3: 'Evidence Gathering',
    4: 'Review of Evidence',
    5: 'Prep for Decision',
    6: 'Pending Approval',
    7: 'Prep for Notification',
    8: 'Complete',
  };

  const APPEAL_WINDOW_DAYS = 365; // 1 year for HLR, Board Appeal, NOD

  // ─── State ──────────────────────────────────────────────────────────────

  let overlayVisible = false;

  // ─── Helpers ────────────────────────────────────────────────────────────

  function shortDate(d) {
    if (!d) return '\u2014';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '\u2014';
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function compactDate(d) {
    if (!d) return '\u2014';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '\u2014';
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function daysBetween(start, end) {
    if (!start || !end) return null;
    const s = new Date(start);
    const e = new Date(end);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
    return Math.round((e - s) / 86400000);
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Claim Intelligence ─────────────────────────────────────────────────

  function classifyClaim(c) {
    const phase = c.phase || 0;
    const isComplete = phase >= 7 || (c.status || '').toLowerCase() === 'complete';
    const isClosed = (c.status || '').toLowerCase().includes('can') || (c.status || '').toLowerCase() === 'closed';
    const needsDocs = !!c.documentsNeeded;
    const hasOverdueItems = (c.trackedItems || []).some(t => t.overdue);

    // Days in process
    const filed = c.dateFiled || c.dateInitiated;
    const daysInProcess = filed ? daysBetween(filed, new Date()) : null;

    // Estimated days remaining
    let daysRemaining = null;
    if (c.estimatedDecisionDate) {
      daysRemaining = daysBetween(new Date(), c.estimatedDecisionDate);
      if (daysRemaining !== null && daysRemaining < 0) daysRemaining = 0;
    }

    // Appeal window
    let appealInfo = null;
    if (isComplete || isClosed) {
      // Best guess for decision date: phaseChangeDate for phase 7/8, or updatedAt
      const decisionDate = c.phaseChangeDate
        || (c.claimPhaseDates && c.claimPhaseDates.phaseChangeDate)
        || c.updatedAt
        || null;

      if (decisionDate) {
        const deadline = new Date(new Date(decisionDate).getTime() + APPEAL_WINDOW_DAYS * 86400000);
        const daysLeft = daysBetween(new Date(), deadline);
        appealInfo = {
          decisionDate,
          deadline,
          daysLeft: daysLeft || 0,
          expired: daysLeft !== null && daysLeft <= 0,
        };
      }
    }

    // Open tracked items
    const openTracked = (c.trackedItems || []).filter(t =>
      t.status && !['ACCEPTED', 'NO_LONGER_REQUIRED', 'COMPLETED'].includes(t.status.toUpperCase())
    ).length;
    const totalTracked = (c.trackedItems || []).length;

    // Contention outcomes
    const contentions = c.contentions || [];
    const favorable = contentions.filter(ct => (ct.status || '').toUpperCase() === 'FAVORABLE').length;
    const unfavorable = contentions.filter(ct => (ct.status || '').toUpperCase() === 'UNFAVORABLE').length;

    // Priority (higher = more urgent)
    let priority = 0;
    if (needsDocs) priority += 100;
    if (hasOverdueItems) priority += 80;
    if (openTracked > 0 && !isComplete) priority += 30;
    if (!isComplete && !isClosed) priority += 10;
    if (isComplete && appealInfo && !appealInfo.expired && appealInfo.daysLeft < 90) priority += 50;

    // Next action suggestion
    let nextAction = null;
    if (needsDocs) {
      nextAction = 'Upload requested documents to avoid delays';
    } else if (hasOverdueItems) {
      nextAction = 'Respond to overdue tracked items immediately';
    } else if (openTracked > 0) {
      nextAction = `${openTracked} tracked item${openTracked > 1 ? 's' : ''} pending your response`;
    } else if (isComplete && appealInfo && !appealInfo.expired && appealInfo.daysLeft <= 90 && unfavorable > 0) {
      nextAction = `${appealInfo.daysLeft} days left to appeal unfavorable conditions`;
    } else if (phase === 3) {
      nextAction = 'Gather and submit supporting evidence (buddy letters, medical records)';
    } else if (phase >= 4 && phase <= 6) {
      nextAction = 'VA is reviewing \u2014 no action needed, monitor for updates';
    }

    // Category
    let category;
    if (needsDocs || hasOverdueItems) category = 'attention';
    else if (isComplete || isClosed) category = 'completed';
    else category = 'active';

    return {
      ...c,
      isComplete,
      isClosed,
      needsDocs,
      hasOverdueItems,
      daysInProcess,
      daysRemaining,
      appealInfo,
      openTracked,
      totalTracked,
      favorable,
      unfavorable,
      priority,
      nextAction,
      category,
    };
  }

  // ─── Inject interceptor (legacy) ────────────────────────────────────────

  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('interceptor.js');
    script.setAttribute('data-extension-id', chrome.runtime.id);
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
  } catch (e) { /* optional */ }

  // ─── Data loading ───────────────────────────────────────────────────────

  window.addEventListener('load', () => {
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'REQUEST_VA_DATA' }, (data) => {
        if (chrome.runtime.lastError || !data) return;
        if (data.vaClaims?.length > 0) {
          render(data.vaClaims, data.vaRatings, data.lastSync || data.vaLastFetch, data);
        }
      });
    }, 2500);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'VA_DATA_READY' && msg.claims?.length > 0) {
      render(msg.claims, msg.ratings, Date.now(), msg);
      sendResponse({ success: true });
    }
    if (msg.type === 'AI_INSIGHTS_READY') sendResponse({ success: true });
    return true;
  });

  // Legacy relay
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'va-interceptor') return;
    if (event.data.type === 'VA_INTELLIGENCE_API_DATA') {
      chrome.runtime.sendMessage({
        type: 'CLAIM_DATA_INTERCEPTED',
        timestamp: event.data.timestamp,
        url: event.data.url,
        data: event.data.data,
      }).catch(() => {});
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  RENDER ENTRY POINT
  // ═══════════════════════════════════════════════════════════════════════

  function render(claims, ratings, lastSync, extraData) {
    removePill();
    removeOverlay();

    chrome.storage.local.get(['overlayExpanded', 'overlayDismissed'], (s) => {
      // Don't show if dismissed within last 30 minutes
      if (s.overlayDismissed && Date.now() - s.overlayDismissed < 1800000) return;

      if (s.overlayExpanded) {
        showOverlay(claims, ratings, lastSync, extraData);
      } else {
        createPill(claims, ratings, lastSync, extraData);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PILL
  // ═══════════════════════════════════════════════════════════════════════

  function removePill() {
    const el = document.getElementById('vetclaim-pill');
    if (el) el.remove();
  }

  function createPill(claims, ratings, lastSync, extraData) {
    removePill();

    const classified = claims.map(classifyClaim);
    const attention = classified.filter(c => c.category === 'attention').length;
    const active = classified.filter(c => c.category === 'active').length;

    const pill = document.createElement('div');
    pill.id = 'vetclaim-pill';

    const badgeCount = attention || active || claims.length;
    const isUrgent = attention > 0;

    pill.innerHTML = `
      <img class="vc-pill-logo" src="${LOGO_URL}" alt="" />
      <span class="vc-pill-text"><strong>VetClaim</strong></span>
      <span class="vc-pill-badge ${isUrgent ? 'vc-pill-alert' : ''}">${badgeCount}</span>
      <span class="vc-pill-pulse"></span>
    `;

    pill.title = isUrgent
      ? `${attention} claim(s) need your attention`
      : `${active} active claim(s)`;

    pill.addEventListener('click', () => {
      removePill();
      chrome.storage.local.set({ overlayExpanded: true });
      showOverlay(claims, ratings, lastSync, extraData);
    });

    document.body.appendChild(pill);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  OVERLAY
  // ═══════════════════════════════════════════════════════════════════════

  function removeOverlay() {
    const el = document.getElementById('vetclaim-overlay');
    if (el) el.remove();
    overlayVisible = false;
  }

  function showOverlay(claims, ratings, lastSync, extraData) {
    removeOverlay();
    overlayVisible = true;

    // Classify and sort claims
    const classified = claims.map(classifyClaim).sort((a, b) => b.priority - a.priority);

    const attentionClaims = classified.filter(c => c.category === 'attention');
    const activeClaims = classified.filter(c => c.category === 'active');
    const completedClaims = classified.filter(c => c.category === 'completed');

    // Appealable completed claims
    const appealable = completedClaims.filter(c => c.appealInfo && !c.appealInfo.expired);
    const urgentAppeals = appealable.filter(c => c.appealInfo.daysLeft <= 90);

    const combinedRating = ratings?.combinedRating;
    const totalDocsNeeded = attentionClaims.filter(c => c.needsDocs).length;
    const syncText = lastSync ? timeAgo(lastSync) : '';

    const container = document.createElement('div');
    container.id = 'vetclaim-overlay';

    // ── Build body sections ──────────────────────────────────────────────

    let bodyHtml = '';

    // Stats
    bodyHtml += `
      <div class="vc-stats">
        <div class="vc-stat">
          <div class="vc-stat-value">${combinedRating != null ? combinedRating + '%' : '\u2014'}</div>
          <div class="vc-stat-label">Rating</div>
        </div>
        <div class="vc-stat">
          <div class="vc-stat-value">${activeClaims.length + attentionClaims.length}</div>
          <div class="vc-stat-label">Active</div>
        </div>
        <div class="vc-stat">
          <div class="vc-stat-value ${totalDocsNeeded > 0 ? 'vc-danger' : ''}">${totalDocsNeeded}</div>
          <div class="vc-stat-label">Docs Needed</div>
        </div>
        <div class="vc-stat">
          <div class="vc-stat-value">${appealable.length}</div>
          <div class="vc-stat-label">Appealable</div>
        </div>
      </div>
    `;

    // Urgent appeal warning banner
    if (urgentAppeals.length > 0) {
      bodyHtml += `
        <div class="vc-action-banner vc-action-banner-appeal">
          <span class="vc-action-icon">\u26A0\uFE0F</span>
          <span class="vc-action-text">
            <strong>${urgentAppeals.length} claim${urgentAppeals.length > 1 ? 's' : ''} approaching appeal deadline.</strong>
            Review completed claims below for time remaining.
          </span>
        </div>
      `;
    }

    // ATTENTION NEEDED section
    if (attentionClaims.length > 0) {
      bodyHtml += `
        <div class="vc-section">
          <div class="vc-section-head">
            <span class="vc-section-dot vc-section-dot-red"></span>
            <span class="vc-section-title vc-section-title-red">Attention Needed</span>
            <span class="vc-section-count">${attentionClaims.length}</span>
          </div>
          ${attentionClaims.map(c => buildClaimCard(c)).join('')}
        </div>
      `;
    }

    // ACTIVE CLAIMS section
    if (activeClaims.length > 0) {
      bodyHtml += `
        <div class="vc-section">
          <div class="vc-section-head">
            <span class="vc-section-dot vc-section-dot-blue"></span>
            <span class="vc-section-title vc-section-title-blue">Active Claims</span>
            <span class="vc-section-count">${activeClaims.length}</span>
          </div>
          ${activeClaims.map(c => buildClaimCard(c)).join('')}
        </div>
      `;
    }

    // COMPLETED section (collapsible)
    if (completedClaims.length > 0) {
      bodyHtml += `
        <div class="vc-section">
          <div class="vc-section-toggle" id="vc-completed-toggle">
            <svg class="vc-section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
            <span class="vc-section-dot vc-section-dot-green"></span>
            <span class="vc-section-title vc-section-title-green">Completed</span>
            <span class="vc-section-count">${completedClaims.length}</span>
          </div>
          <div class="vc-section-content" id="vc-completed-content">
            ${completedClaims.map(c => buildClaimCard(c)).join('')}
          </div>
        </div>
      `;
    }

    // RATINGS section (collapsible)
    if (ratings?.individualRatings?.length > 0) {
      bodyHtml += `
        <div class="vc-section">
          <div class="vc-section-toggle" id="vc-ratings-toggle">
            <svg class="vc-section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
            <span class="vc-section-dot vc-section-dot-amber"></span>
            <span class="vc-section-title vc-section-title-amber">Service-Connected Disabilities</span>
          </div>
          <div class="vc-section-content" id="vc-ratings-content">
            ${ratings.individualRatings.map(r => `
              <div class="vc-rating-row">
                <span class="vc-rating-name">${esc(r.name)}</span>
                <span class="vc-rating-pct">${r.rating ?? '\u2014'}%${r.static ? '<span class="vc-rating-static">Static</span>' : ''}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // ── ITF EXPIRATION WARNING ────────────────────────────────────────────
    const itfIntents = extraData?.vaIntentToFile?.intents || [];
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const expiringItfs = itfIntents.filter(itf => {
      if (itf.status?.toLowerCase() !== 'active') return false;
      const exp = new Date(itf.expirationDate).getTime();
      return !isNaN(exp) && (exp - now) < thirtyDays && (exp - now) > 0;
    });

    if (expiringItfs.length > 0) {
      const itfHtml = expiringItfs.map(itf => {
        const exp = new Date(itf.expirationDate).getTime();
        const daysLeft = Math.ceil((exp - now) / (24 * 60 * 60 * 1000));
        const expDate = new Date(itf.expirationDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return `
          <div class="vc-action-banner vc-action-banner-urgent">
            <span class="vc-action-icon">\u23F0</span>
            <span class="vc-action-text">
              <strong>Intent to File expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}!</strong>
              Your ${esc(itf.type || 'compensation')} ITF expires ${expDate}. File your claim before then to preserve your effective date.
            </span>
          </div>
        `;
      }).join('');
      bodyHtml += itfHtml;
    }

    // ── APPEALS SECTION ──────────────────────────────────────────────────
    const appeals = extraData?.vaAppeals || [];
    const activeAppeals = appeals.filter(a => a.active !== false);
    if (activeAppeals.length > 0) {
      bodyHtml += `
        <div class="vc-section">
          <div class="vc-section-toggle" id="vc-appeals-toggle">
            <svg class="vc-section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
            <span class="vc-section-dot vc-section-dot-amber"></span>
            <span class="vc-section-title vc-section-title-amber">Active Appeals</span>
            <span class="vc-section-count">${activeAppeals.length}</span>
          </div>
          <div class="vc-section-content" id="vc-appeals-content">
            ${activeAppeals.map(a => {
              const issueList = (a.issues || []).slice(0, 3).map(i =>
                `<span class="vc-tag">${esc(i.description || 'Issue')}</span>`
              ).join('');
              const statusText = (a.status || 'Pending').replace(/_/g, ' ');
              return `
                <div class="vc-appeal-row">
                  <div class="vc-appeal-header">
                    <span class="vc-appeal-type">${esc(a.type || 'Appeal')}</span>
                    <span class="vc-appeal-status">${esc(statusText)}</span>
                  </div>
                  ${issueList ? `<div class="vc-appeal-issues">${issueList}</div>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    // ── DEBTS WARNING ────────────────────────────────────────────────────
    const debts = extraData?.vaDebts?.debts || [];
    const copays = extraData?.vaDebts?.copays || [];
    const totalDebt = debts.reduce((s, d) => s + (d.amount || 0), 0)
                    + copays.reduce((s, c) => s + (c.amount || 0), 0);
    if (totalDebt > 0) {
      bodyHtml += `
        <div class="vc-action-banner vc-action-banner-urgent">
          <span class="vc-action-icon">\uD83D\uDCB3</span>
          <span class="vc-action-text">
            <strong>$${totalDebt.toFixed(2)} in outstanding VA debts.</strong>
            ${debts.length} debt${debts.length !== 1 ? 's' : ''}, ${copays.length} copay${copays.length !== 1 ? 's' : ''}.
          </span>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="vc-header">
        <img class="vc-header-logo" src="${LOGO_URL}" alt="" />
        <div class="vc-header-text">
          <div class="vc-header-title">VetClaim</div>
          <div class="vc-header-sub">Claim Intelligence</div>
        </div>
        <div class="vc-header-actions">
          <button class="vc-btn-icon" id="vc-minimize-btn" title="Minimize">\u2212</button>
          <button class="vc-btn-icon" id="vc-close-btn" title="Close">\u00D7</button>
        </div>
      </div>
      <div class="vc-body">${bodyHtml}</div>
      <div class="vc-footer">
        <a class="vc-footer-link" href="https://vetclaimservices.com/dashboard" target="_blank">Open Dashboard \u2192</a>
        ${syncText ? `<span class="vc-footer-sync"><span class="vc-footer-dot"></span>Synced ${esc(syncText)}</span>` : ''}
      </div>
    `;

    document.body.appendChild(container);
    bindOverlayEvents(container, claims, ratings, lastSync);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  EVENT BINDING
  // ═══════════════════════════════════════════════════════════════════════

  function bindOverlayEvents(container, claims, ratings, lastSync) {
    // Minimize
    document.getElementById('vc-minimize-btn').addEventListener('click', () => {
      removeOverlay();
      chrome.storage.local.set({ overlayExpanded: false });
      createPill(claims, ratings, lastSync);
    });

    // Close
    document.getElementById('vc-close-btn').addEventListener('click', () => {
      removeOverlay();
      removePill();
      chrome.storage.local.set({ overlayExpanded: false, overlayDismissed: Date.now() });
    });

    // Collapsible sections
    ['vc-completed-toggle', 'vc-ratings-toggle', 'vc-appeals-toggle'].forEach(id => {
      const toggle = document.getElementById(id);
      if (!toggle) return;
      toggle.addEventListener('click', () => {
        toggle.classList.toggle('vc-open');
      });
    });

    // Claim card expand/collapse
    container.querySelectorAll('.vc-claim').forEach(card => {
      const summary = card.querySelector('.vc-claim-summary');
      if (!summary) return;
      summary.addEventListener('click', (e) => {
        if (e.target.closest('.vc-dash-link')) return;
        const wasExpanded = card.classList.contains('vc-expanded');
        // Close all other cards
        container.querySelectorAll('.vc-claim.vc-expanded').forEach(other => {
          if (other !== card) other.classList.remove('vc-expanded');
        });
        if (wasExpanded) {
          card.classList.remove('vc-expanded');
        } else {
          card.classList.add('vc-expanded');
          setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  CLAIM CARD BUILDER
  // ═══════════════════════════════════════════════════════════════════════

  function buildClaimCard(c) {
    const pct = c.phase ? Math.round((c.phase / 8) * 100) : 0;
    const statusText = c.phase ? PHASE_LABELS[c.phase]
      : (c.status || c.latestPhaseType || '').replace(/_/g, ' ').toLowerCase()
          .replace(/\b\w/g, l => l.toUpperCase()) || 'Pending';

    const barClass = c.isComplete ? 'vc-bar-green' : c.needsDocs ? 'vc-bar-warn' : 'vc-bar-gold';

    // Summary tags
    const contentions = c.contentions || [];
    const contTags = contentions.slice(0, 3).map(ct => {
      const status = (ct.status || '').toUpperCase();
      let cls = 'vc-tag';
      if (status === 'FAVORABLE') cls = 'vc-tag vc-tag-favorable';
      else if (status === 'UNFAVORABLE') cls = 'vc-tag vc-tag-unfavorable';
      return `<span class="${cls}">${esc(ct.name)}</span>`;
    }).join('');
    const extraCount = contentions.length - 3;
    const moreTag = extraCount > 0 ? `<span class="vc-tag">+${extraCount}</span>` : '';
    const warnTag = c.needsDocs ? '<span class="vc-tag vc-tag-warn">DOCS NEEDED</span>' : '';
    const doneTag = c.isComplete ? '<span class="vc-tag vc-tag-success">COMPLETE</span>' : '';
    const decisionTag = c.decisionLetterSent && !c.isComplete ? '<span class="vc-tag vc-tag-success">DECISION SENT</span>' : '';

    // Days display
    let daysHtml = '';
    if (c.daysInProcess !== null && !c.isComplete) {
      daysHtml = `<div class="vc-claim-days"><strong>${c.daysInProcess}d</strong>in process</div>`;
    } else if (c.daysRemaining !== null && c.daysRemaining > 0) {
      daysHtml = `<div class="vc-claim-days"><strong>~${c.daysRemaining}d</strong>remaining</div>`;
    }

    // Next action
    let actionHtml = '';
    if (c.nextAction) {
      actionHtml = `
        <div class="vc-next-action">
          <span class="vc-next-action-icon">\u27A1\uFE0F</span>
          ${esc(c.nextAction)}
        </div>
      `;
    }

    // Appeal badge (for completed claims)
    let appealHtml = '';
    if (c.appealInfo) {
      if (c.appealInfo.expired) {
        appealHtml = `<div class="vc-appeal-badge vc-appeal-expired">\u23F0 Appeal window closed</div>`;
      } else {
        const urgency = c.appealInfo.daysLeft <= 60 ? '\u26A0\uFE0F' : '\u23F0';
        appealHtml = `<div class="vc-appeal-badge vc-appeal-active">${urgency} Appealable \u2014 ${c.appealInfo.daysLeft} days remaining (until ${compactDate(c.appealInfo.deadline)})</div>`;
      }
    }

    // Tracked items summary
    let trackedSummary = '';
    if (c.totalTracked > 0 && !c.isComplete) {
      trackedSummary = `<span class="vc-tag">${c.openTracked}/${c.totalTracked} items open</span>`;
    }

    // Build detail
    const detailHtml = buildDetailHtml(c);

    return `
      <div class="vc-claim" data-claim-id="${esc(c.claimId)}">
        <div class="vc-claim-summary">
          <div class="vc-claim-top">
            <div class="vc-claim-title-row">
              <div>
                <div class="vc-claim-title">${esc(c.claimType || 'Claim')}</div>
                <div class="vc-claim-id">#${esc(c.claimId)}</div>
              </div>
            </div>
            ${daysHtml}
            <svg class="vc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </div>
          <div class="vc-phase">
            <span>${esc(statusText)}</span>
            ${c.phase ? `<div class="vc-bar"><div class="vc-bar-fill ${barClass}" style="width:${pct}%"></div></div><span>${c.phase}/8</span>` : ''}
          </div>
          <div class="vc-tags">${contTags}${moreTag}${trackedSummary}${warnTag}${doneTag}${decisionTag}</div>
          ${appealHtml}
          ${actionHtml}
        </div>
        <div class="vc-detail"><div class="vc-detail-inner">${detailHtml}</div></div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  DETAIL PANEL BUILDER
  // ═══════════════════════════════════════════════════════════════════════

  function buildDetailHtml(c) {
    let html = '';

    // Key dates
    html += `
      <div class="vc-detail-section">
        <div class="vc-detail-label">Key Dates</div>
        <div class="vc-detail-grid">
          <div class="vc-detail-item">
            <div class="vc-detail-item-label">Filed</div>
            <div class="vc-detail-item-value">${compactDate(c.dateFiled || c.dateInitiated)}</div>
          </div>
          <div class="vc-detail-item">
            <div class="vc-detail-item-label">Est. Decision</div>
            <div class="vc-detail-item-value">${compactDate(c.estimatedDecisionDate)}</div>
          </div>
          <div class="vc-detail-item">
            <div class="vc-detail-item-label">Phase Changed</div>
            <div class="vc-detail-item-value">${compactDate(c.phaseChangeDate || (c.claimPhaseDates && c.claimPhaseDates.phaseChangeDate))}</div>
          </div>
          <div class="vc-detail-item">
            <div class="vc-detail-item-label">Days in Process</div>
            <div class="vc-detail-item-value">${c.daysInProcess !== null ? c.daysInProcess + ' days' : '\u2014'}</div>
          </div>
        </div>
      </div>
    `;

    // Phase timeline
    const steps = [1,2,3,4,5,6,7,8].map(step => {
      const phase = c.phase || 0;
      const dotCls = step < phase ? 'vc-dot-done' : step === phase ? 'vc-dot-current' : 'vc-dot-pending';
      const textColor = step < phase ? '#94a3b8' : step === phase ? '#e2e8f0' : '#374151';
      const weight = step === phase ? 'font-weight:600' : '';
      return `<div class="vc-step"><div class="vc-dot ${dotCls}"></div><span style="color:${textColor};${weight}">${PHASE_LABELS[step]}</span></div>`;
    }).join('');

    html += `
      <div class="vc-detail-section">
        <div class="vc-detail-label">Phase Timeline</div>
        <div class="vc-timeline">${steps}</div>
      </div>
    `;

    // Contentions with outcome color coding
    const contentions = c.contentions || [];
    if (contentions.length > 0) {
      const contHtml = contentions.map(ct => {
        const status = (ct.status || '').toUpperCase();
        let cls = 'vc-tag';
        if (status === 'FAVORABLE') cls = 'vc-tag vc-tag-favorable';
        else if (status === 'UNFAVORABLE') cls = 'vc-tag vc-tag-unfavorable';
        const suffix = status ? ` (${status.toLowerCase()})` : '';
        return `<span class="${cls}">${esc(ct.name)}${suffix}</span>`;
      }).join('');

      let summary = '';
      if (c.favorable > 0 || c.unfavorable > 0) {
        summary = `<div style="font-size:10px;color:#64748b;margin-bottom:4px">${c.favorable} favorable, ${c.unfavorable} unfavorable, ${contentions.length - c.favorable - c.unfavorable} pending</div>`;
      }

      html += `
        <div class="vc-detail-section">
          <div class="vc-detail-label">Claimed Conditions (${contentions.length})</div>
          ${summary}
          <div class="vc-tags" style="gap:5px">${contHtml}</div>
        </div>
      `;
    }

    // Tracked items
    const tracked = c.trackedItems || [];
    if (tracked.length > 0) {
      const items = tracked.slice(0, 6).map(t => {
        const name = t.displayName || t.description || t.name || 'Item';
        const status = t.status || '';
        const due = t.suspenseDate ? compactDate(t.suspenseDate) : '';
        const overdue = t.overdue ? '<span class="vc-tracked-overdue">OVERDUE</span>' : '';
        return `
          <div class="vc-tracked">
            <div class="vc-tracked-name">${esc(name)}</div>
            <div class="vc-tracked-meta">
              ${status ? `<span class="vc-tracked-status">${esc(status)}</span>` : ''}
              ${due ? `<span>Due: ${due}</span>` : ''}
              ${overdue}
            </div>
          </div>
        `;
      }).join('');

      const more = tracked.length > 6 ? `<div style="font-size:9px;color:#475569;margin-top:4px">+ ${tracked.length - 6} more</div>` : '';

      html += `
        <div class="vc-detail-section">
          <div class="vc-detail-label">Tracked Items (${c.openTracked} open / ${c.totalTracked} total)</div>
          ${items}${more}
        </div>
      `;
    }

    // Documents
    const docs = c.supportingDocuments || [];
    if (docs.length > 0) {
      const docRows = docs.slice(0, 6).map(d => {
        const label = d.documentTypeLabel || d.originalFileName || 'Document';
        const uploaded = d.uploadDate ? compactDate(d.uploadDate) : '';
        return `
          <div class="vc-doc">
            <span>\uD83D\uDCC4</span>
            <span class="vc-doc-name">${esc(label)}</span>
            ${uploaded ? `<span class="vc-doc-date">${uploaded}</span>` : ''}
          </div>
        `;
      }).join('');
      const more = docs.length > 6 ? `<div style="font-size:9px;color:#475569;margin-top:2px">+ ${docs.length - 6} more documents</div>` : '';

      html += `
        <div class="vc-detail-section">
          <div class="vc-detail-label">Documents (${docs.length})</div>
          ${docRows}${more}
        </div>
      `;
    }

    // Flags
    const flags = [];
    if (c.developmentLetterSent) flags.push('<span class="vc-tag">Dev Letter Sent</span>');
    if (c.decisionLetterSent) flags.push('<span class="vc-tag vc-tag-success">Decision Sent</span>');
    if (c.waiverSubmitted) flags.push('<span class="vc-tag">5103 Waiver</span>');
    if (c.needsDocs) flags.push('<span class="vc-tag vc-tag-warn">Action Required</span>');
    if (flags.length > 0) {
      html += `
        <div class="vc-detail-section">
          <div class="vc-detail-label">Flags</div>
          <div class="vc-tags" style="gap:6px">${flags.join('')}</div>
        </div>
      `;
    }

    // Appeal info for completed claims
    if (c.appealInfo) {
      const decDate = shortDate(c.appealInfo.decisionDate);
      const deadlineDate = shortDate(c.appealInfo.deadline);
      html += `
        <div class="vc-detail-section">
          <div class="vc-detail-label">Appeal Window</div>
          <div class="vc-detail-grid">
            <div class="vc-detail-item">
              <div class="vc-detail-item-label">Decision Date</div>
              <div class="vc-detail-item-value">${decDate}</div>
            </div>
            <div class="vc-detail-item">
              <div class="vc-detail-item-label">Deadline</div>
              <div class="vc-detail-item-value" style="color:${c.appealInfo.expired ? '#64748b' : c.appealInfo.daysLeft <= 60 ? '#f87171' : '#fbbf24'}">${c.appealInfo.expired ? 'Expired' : deadlineDate}</div>
            </div>
          </div>
          ${!c.appealInfo.expired && c.unfavorable > 0 ? `
            <div style="margin-top:6px;font-size:10px;color:#fbbf24;line-height:1.4">
              \u26A0\uFE0F ${c.unfavorable} unfavorable condition${c.unfavorable > 1 ? 's' : ''} may be worth appealing.
              Ask your AI advisor for guidance.
            </div>
          ` : ''}
        </div>
      `;
    }

    // Dashboard link
    html += `<a class="vc-dash-link" href="https://vetclaimservices.com/dashboard" target="_blank">Open in VetClaim Dashboard \u2192</a>`;

    return html;
  }

  console.log('[VetClaim] Content script initialized');
})();
