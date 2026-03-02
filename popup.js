document.addEventListener('DOMContentLoaded', async () => {
  const vcDot    = document.getElementById('vc-dot');
  const vcStatus = document.getElementById('vc-status');
  const vaDot    = document.getElementById('va-dot');
  const vaStatus = document.getElementById('va-status');
  const syncBtn  = document.getElementById('sync-btn');
  const syncIcon = document.getElementById('sync-icon');
  const syncLabel = document.getElementById('sync-label');
  const syncInfo = document.getElementById('sync-info');
  const syncTime = document.getElementById('sync-time');

  // Show extension version
  const version = chrome.runtime.getManifest().version;
  document.getElementById('ext-version').textContent = `v${version}`;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function timeAgo(ts) {
    if (!ts) return 'Never';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  function formatDate(d) {
    if (!d) return null;
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  const phaseLabels = {
    1: 'Received', 2: 'Initial Review', 3: 'Evidence Gathering',
    4: 'Review of Evidence', 5: 'Prep for Decision', 6: 'Pending Approval',
    7: 'Prep for Notification', 8: 'Complete'
  };

  // ── Load auth status ────────────────────────────────────────────────────

  chrome.runtime.sendMessage({ type: 'REQUEST_AUTH_STATUS' }, (auth) => {
    if (chrome.runtime.lastError || !auth) {
      vcDot.classList.add('red');
      vcStatus.textContent = 'Error';
      return;
    }

    if (auth.authenticated) {
      vcDot.classList.add('green');
      const name = auth.userData?.name || auth.userData?.email || 'Connected';
      vcStatus.textContent = name;
      vcStatus.style.color = '#e2e8f0';
    } else {
      vcDot.classList.add('red');
      vcStatus.textContent = 'Not linked';
      vcStatus.style.color = '#ef4444';
    }
  });

  // ── Load VA data ────────────────────────────────────────────────────────

  chrome.runtime.sendMessage({ type: 'REQUEST_VA_DATA' }, (data) => {
    if (chrome.runtime.lastError || !data) {
      vaDot.classList.add('red');
      vaStatus.textContent = 'Error';
      return;
    }

    // VA.gov session status
    if (data.vaLoggedIn) {
      vaDot.classList.add('green');
      vaStatus.textContent = 'Active';
      vaStatus.style.color = '#e2e8f0';
    } else if (data.vaClaims?.length > 0) {
      vaDot.classList.add('yellow');
      vaStatus.textContent = 'Cached';
      vaStatus.style.color = '#eab308';
    } else {
      vaDot.classList.add('red');
      vaStatus.textContent = 'Not detected';
      vaStatus.style.color = '#ef4444';
      document.getElementById('empty-state').style.display = 'block';
    }

    // Last synced timestamp
    const lastSync = data.lastSync || data.vaLastFetch;
    if (lastSync) {
      syncInfo.style.display = 'flex';
      syncTime.textContent = `Last synced ${timeAgo(lastSync)}`;
    }

    // Stats
    const claims  = data.vaClaims  || [];
    const appeals = data.vaAppeals || [];
    const ratings = data.vaRatings;

    document.getElementById('stat-claims').textContent  = claims.length;
    document.getElementById('stat-appeals').textContent = appeals.length;

    if (ratings?.combinedRating != null) {
      document.getElementById('stat-rating').textContent = ratings.combinedRating + '%';
    }

    // ── Render alerts ─────────────────────────────────────────────────────

    const alerts = data.pendingAlerts || [];
    // Also generate local alerts from ITF expiration
    const localAlerts = [...alerts];

    if (data.vaIntentToFile?.intents) {
      const now = Date.now();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      for (const itf of data.vaIntentToFile.intents) {
        if (itf.status?.toLowerCase() !== 'active') continue;
        const exp = new Date(itf.expirationDate).getTime();
        if (!isNaN(exp) && (exp - now) < thirtyDays && (exp - now) > 0) {
          const daysLeft = Math.ceil((exp - now) / (24 * 60 * 60 * 1000));
          localAlerts.push({
            type: 'DEADLINE_REMINDER',
            title: `ITF Expiring in ${daysLeft} days`,
            message: `Your ${itf.type || 'compensation'} Intent to File expires on ${formatDate(itf.expirationDate)}. File before then to preserve your effective date.`
          });
        }
      }
    }

    if (data.vaDebts?.debts?.length > 0) {
      const total = data.vaDebts.debts.reduce((s, d) => s + (d.amount || 0), 0);
      if (total > 0 && !localAlerts.some(a => a.type === 'DEBT_ALERT')) {
        localAlerts.push({
          type: 'DEBT_ALERT',
          title: 'Outstanding VA Debts',
          message: `$${total.toFixed(2)} in outstanding debts.`
        });
      }
    }

    if (localAlerts.length > 0) {
      const section = document.getElementById('alerts-section');
      const list = document.getElementById('alerts-list');
      const count = document.getElementById('alerts-count');
      section.style.display = 'block';
      count.textContent = localAlerts.length;

      list.innerHTML = localAlerts.slice(0, 5).map(a => {
        const cls = a.type === 'DEADLINE_REMINDER' || a.type === 'DEBT_ALERT' ? 'warning'
          : a.type === 'BENEFIT_DISCOVERED' ? 'info' : '';
        return `<div class="alert-card ${cls}">
          <div class="alert-title">${esc(a.title)}</div>
          <div class="alert-message">${esc(a.message)}</div>
        </div>`;
      }).join('');
    }

    // ── Render claims ─────────────────────────────────────────────────────

    if (claims.length > 0) {
      const section = document.getElementById('claims-section');
      const list    = document.getElementById('claims-list');
      const count   = document.getElementById('claims-count');
      section.style.display = 'block';
      count.textContent = claims.length;

      list.innerHTML = claims.slice(0, 6).map(c => {
        const pct = c.phase ? Math.round((c.phase / 8) * 100) : 0;
        const isComplete = c.phase >= 7;
        const statusText = c.phase ? phaseLabels[c.phase]
          : (c.status || c.latestPhaseType || '').replace(/_/g, ' ').toLowerCase()
              .replace(/\b\w/g, l => l.toUpperCase()) || 'Pending';

        const barClass = isComplete ? 'green' : c.documentsNeeded ? 'warn' : 'gold';

        const tags = (c.contentions || []).slice(0, 3).map(ct =>
          `<span class="tag">${esc(ct.name)}</span>`
        ).join('');
        const docsTag = c.documentsNeeded ? '<span class="tag warn">DOCS NEEDED</span>' : '';
        const completeTag = isComplete ? '<span class="tag success">COMPLETE</span>' : '';

        const estDate = formatDate(c.estimatedDecisionDate);
        const estHtml = estDate
          ? `<div class="claim-est"><strong>${estDate}</strong>Est. decision</div>`
          : '';

        return `
          <div class="claim-card">
            <div class="claim-header">
              <div>
                <div class="claim-title">${esc(c.claimType) || 'Claim'}</div>
                <div class="claim-id">#${esc(c.claimId)}</div>
              </div>
              ${estHtml}
            </div>
            <div class="claim-phase">
              <span>${esc(statusText)}</span>
              ${c.phase ? `<div class="bar"><div class="bar-fill ${barClass}" style="width:${pct}%"></div></div><span>${c.phase}/8</span>` : ''}
            </div>
            <div class="tags">${tags}${docsTag}${completeTag}</div>
          </div>
        `;
      }).join('');
    }

    // ── Render ratings ────────────────────────────────────────────────────

    if (ratings?.individualRatings?.length > 0) {
      const section = document.getElementById('ratings-section');
      const list    = document.getElementById('ratings-list');
      section.style.display = 'block';

      list.innerHTML = ratings.individualRatings.slice(0, 10).map(r => {
        const staticBadge = r.static ? '<span class="rating-static">Static</span>' : '';
        return `<div class="rating-row">
          <span class="rating-name">${esc(r.name)}</span>
          <span class="rating-pct">${r.rating ?? '\u2014'}%${staticBadge}</span>
        </div>`;
      }).join('');
    }

    // ── Render payments summary ───────────────────────────────────────────

    const payments = data.vaPayments || [];
    if (payments.length > 0) {
      const section = document.getElementById('payments-section');
      const list = document.getElementById('payments-list');
      section.style.display = 'block';

      // Show last 3 payments
      list.innerHTML = payments.slice(0, 3).map(p => {
        const amount = p.amount ? `$${parseFloat(p.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '\u2014';
        return `<div class="info-row">
          <span>${esc(p.type || 'Payment')} \u2014 ${formatDate(p.date) || 'N/A'}</span>
          <span class="info-row-value gold">${amount}</span>
        </div>`;
      }).join('');
    }

    // ── Render service history ────────────────────────────────────────────

    if (data.vaServiceHistory?.periods?.length > 0) {
      const section = document.getElementById('service-section');
      const list = document.getElementById('service-list');
      section.style.display = 'block';

      list.innerHTML = data.vaServiceHistory.periods.map(p => {
        const dates = [formatDate(p.startDate), formatDate(p.endDate)].filter(Boolean).join(' \u2013 ');
        return `<div class="info-row">
          <span>${esc(p.branch || 'Unknown Branch')}</span>
          <span class="info-row-value">${dates || 'Dates N/A'}</span>
        </div>`;
      }).join('');
    }

    // ── Render debts ──────────────────────────────────────────────────────

    if (data.vaDebts) {
      const debts = data.vaDebts.debts || [];
      const copays = data.vaDebts.copays || [];
      const total = debts.reduce((s, d) => s + (d.amount || 0), 0)
                  + copays.reduce((s, c) => s + (c.amount || 0), 0);

      if (total > 0) {
        const section = document.getElementById('debts-section');
        const list = document.getElementById('debts-list');
        section.style.display = 'block';

        let html = `<div class="info-row">
          <span>Total Outstanding</span>
          <span class="info-row-value danger">$${total.toFixed(2)}</span>
        </div>`;

        if (debts.length > 0) {
          html += `<div class="info-row">
            <span>Debts</span>
            <span class="info-row-value">${debts.length} item(s)</span>
          </div>`;
        }
        if (copays.length > 0) {
          html += `<div class="info-row">
            <span>Copays</span>
            <span class="info-row-value">${copays.length} item(s)</span>
          </div>`;
        }

        list.innerHTML = html;
      }
    }

    // Clear alerts when popup opens
    chrome.runtime.sendMessage({ type: 'CLEAR_ALERTS' });
  });

  // ── Sync button ─────────────────────────────────────────────────────────

  syncBtn.addEventListener('click', () => {
    syncBtn.disabled = true;
    syncIcon.style.display = 'none';
    syncLabel.innerHTML = '<span class="spinner"></span> Syncing...';

    chrome.runtime.sendMessage({ type: 'TRIGGER_VA_FETCH' }, (res) => {
      if (res?.success) {
        syncLabel.textContent = 'Synced!';
        syncLabel.style.color = '#16a34a';
        setTimeout(() => window.location.reload(), 800);
      } else {
        syncLabel.textContent = 'Failed \u2014 retry?';
        syncIcon.style.display = '';
        syncBtn.disabled = false;
      }
    });
  });
});
