document.addEventListener('DOMContentLoaded', async () => {
  const vcDot    = document.getElementById('vc-dot');
  const vcStatus = document.getElementById('vc-status');
  const vaDot    = document.getElementById('va-dot');
  const vaStatus = document.getElementById('va-status');
  const syncBtn  = document.getElementById('sync-btn');

  // ── Load auth status ───────────────────────────────────────────────────
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
    } else {
      vcDot.classList.add('red');
      vcStatus.textContent = 'Not linked';
    }
  });

  // ── Load VA data ───────────────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: 'REQUEST_VA_DATA' }, (data) => {
    if (chrome.runtime.lastError || !data) {
      vaDot.classList.add('red');
      vaStatus.textContent = 'Error';
      return;
    }

    // VA.gov login status
    if (data.vaLoggedIn) {
      vaDot.classList.add('green');
      vaStatus.textContent = 'Logged in';
    } else if (data.vaClaims?.length > 0) {
      vaDot.classList.add('yellow');
      vaStatus.textContent = 'Cached';
    } else {
      vaDot.classList.add('red');
      vaStatus.textContent = 'Not detected';
      document.getElementById('empty-state').style.display = 'block';
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

    // ── Render claims ────────────────────────────────────────────────────
    if (claims.length > 0) {
      const section = document.getElementById('claims-section');
      const list    = document.getElementById('claims-list');
      section.style.display = 'block';

      const phaseLabels = {
        1:'Received',2:'Initial Review',3:'Evidence Gathering',
        4:'Review',5:'Prep for Decision',6:'Pending Approval',
        7:'Prep for Notification',8:'Complete'
      };

      list.innerHTML = claims.slice(0, 5).map(c => {
        const pct = c.phase ? Math.round((c.phase / 8) * 100) : 0;
        const tags = (c.contentions || []).slice(0, 3).map(ct =>
          `<span class="tag">${ct.name}</span>`
        ).join('');
        const docsTag = c.documentsNeeded ? '<span class="tag warn">DOCS NEEDED</span>' : '';

        return `
          <div class="claim-card">
            <div class="claim-title">${c.claimType || 'Claim'} #${c.claimId}</div>
            <div class="claim-phase">
              <span>${phaseLabels[c.phase] || 'Unknown'}</span>
              <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
              <span>${c.phase || '?'}/8</span>
            </div>
            <div class="tags">${tags}${docsTag}</div>
          </div>
        `;
      }).join('');
    }

    // ── Render ratings ───────────────────────────────────────────────────
    if (ratings?.individualRatings?.length > 0) {
      const section = document.getElementById('ratings-section');
      const list    = document.getElementById('ratings-list');
      section.style.display = 'block';

      list.innerHTML = ratings.individualRatings.slice(0, 8).map(r =>
        `<div class="rating-row">
          <span class="rating-name">${r.name}</span>
          <span class="rating-pct">${r.rating ?? '—'}%</span>
        </div>`
      ).join('');
    }
  });

  // ── Sync button ────────────────────────────────────────────────────────
  syncBtn.addEventListener('click', () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';

    chrome.runtime.sendMessage({ type: 'TRIGGER_VA_FETCH' }, (res) => {
      if (res?.success) {
        syncBtn.textContent = 'Done!';
        // Reload popup data after 1 second
        setTimeout(() => window.location.reload(), 1000);
      } else {
        syncBtn.textContent = 'Failed — retry?';
        syncBtn.disabled = false;
      }
    });
  });
});
