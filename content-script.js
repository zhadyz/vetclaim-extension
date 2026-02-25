/**
 * VA Intelligence Content Script
 * Runs on va.gov pages to inject interceptor and manage UI
 */

(function() {
  'use strict';
  
  console.log('[VA Intelligence] Content script loaded');
  
  // Inject the interceptor script into page context
  function injectInterceptor() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('interceptor.js');
    script.setAttribute('data-extension-id', chrome.runtime.id);
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
  }
  
  // Inject immediately
  injectInterceptor();
  
  // Listen for messages from interceptor (page context)
  window.addEventListener('message', (event) => {
    // Verify source
    if (event.source !== window) return;
    if (event.data.source !== 'va-interceptor') return;
    
    if (event.data.type === 'VA_INTELLIGENCE_API_DATA') {
      console.log('[VA Intelligence] Received claim data from interceptor');
      
      // Forward to background script for processing
      chrome.runtime.sendMessage({
        type: 'CLAIM_DATA_INTERCEPTED',
        timestamp: event.data.timestamp,
        url: event.data.url,
        data: event.data.data
      }).then(response => {
        if (response && response.aiInsights) {
          // Inject AI insights into page
          injectAIOverlay(response.aiInsights);
        }
      }).catch(err => {
        console.error('[VA Intelligence] Error sending to background:', err);
      });
    }
  });
  
  // Listen for messages from background script (AI results ready)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'AI_INSIGHTS_READY') {
      console.log('[VA Intelligence] AI insights received from background');
      injectAIOverlay(message.insights);
      sendResponse({ success: true });
    }
    
    if (message.type === 'UPDATE_OVERLAY') {
      updateAIOverlay(message.data);
      sendResponse({ success: true });
    }
    
    return true; // Keep message channel open for async response
  });
  
  /**
   * Inject AI insights overlay into VA.gov page
   */
  function injectAIOverlay(insights) {
    // Remove existing overlay if present
    const existing = document.getElementById('va-intelligence-overlay');
    if (existing) {
      existing.remove();
    }
    
    // Find insertion point (after claim details section)
    const insertionPoints = [
      '.claim-detail-layout',
      '.claim-status-wrapper',
      '.claim-container',
      'main[id="main"]'
    ];
    
    let insertionPoint = null;
    for (const selector of insertionPoints) {
      insertionPoint = document.querySelector(selector);
      if (insertionPoint) break;
    }
    
    if (!insertionPoint) {
      console.warn('[VA Intelligence] Could not find insertion point for overlay');
      return;
    }
    
    // Create overlay
    const overlay = createAIOverlay(insights);
    
    // Insert after the claim details
    insertionPoint.parentNode.insertBefore(overlay, insertionPoint.nextSibling);
    
    // Add event listeners
    setupOverlayEventListeners(overlay, insights);
    
    console.log('[VA Intelligence] AI overlay injected successfully');
  }
  
  /**
   * Create the AI overlay DOM element
   */
  function createAIOverlay(insights) {
    const container = document.createElement('div');
    container.id = 'va-intelligence-overlay';
    container.className = 'va-ai-copilot';
    
    container.innerHTML = `
      <div class="ai-header">
        <div class="ai-badge">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 2L2 7v6c0 5 8 8 8 8s8-3 8-8V7l-8-5z"/>
          </svg>
          <span>AI Copilot</span>
        </div>
        <div class="ai-status ${insights.status || 'medium'}">
          ${insights.confidenceScore || 75}% Confidence
        </div>
        <button class="ai-close" aria-label="Close">×</button>
      </div>
      
      <div class="ai-body">
        ${renderPredictionCard(insights.timeline)}
        ${renderRiskCard(insights.risks)}
        ${renderRecommendations(insights.recommendations)}
        ${renderMissingBenefits(insights.missingBenefits)}
      </div>
      
      <div class="ai-footer">
        <button class="ai-btn-primary" data-action="detailed-report">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 4h12v2H2V4zm0 4h12v2H2V8zm0 4h8v2H2v-2z"/>
          </svg>
          View Full Analysis
        </button>
        <button class="ai-btn-secondary" data-action="export-strategy">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 2v8m0 0l3-3m-3 3L5 7m9 7H2"/>
          </svg>
          Export Strategy
        </button>
      </div>
    `;
    
    return container;
  }
  
  function renderPredictionCard(timeline) {
    if (!timeline) {
      return '<div class="ai-card loading">Analyzing your claim timeline...</div>';
    }
    
    return `
      <div class="ai-card prediction">
        <div class="card-header">
          <h3>📊 Timeline Prediction</h3>
        </div>
        <div class="card-body">
          <div class="prediction-main">
            <div class="metric">
              <span class="number">${timeline.approvalProbability || 0}%</span>
              <span class="label">Approval Probability</span>
            </div>
            <div class="metric">
              <span class="number">${timeline.daysToDecision || '?'}</span>
              <span class="label">Days to Decision</span>
            </div>
          </div>
          <div class="prediction-details">
            <p class="basis">Based on ${(timeline.similarClaims || 0).toLocaleString()} similar claims</p>
            ${timeline.reasoning ? `
              <div class="reasoning">
                <strong>Key Factors:</strong>
                <ul>
                  ${(timeline.keyFactors || []).slice(0, 3).map(factor => 
                    `<li>${factor}</li>`
                  ).join('')}
                </ul>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }
  
  function renderRiskCard(risks) {
    if (!risks || risks.length === 0) {
      return '';
    }
    
    return `
      <div class="ai-card risks">
        <div class="card-header">
          <h3>⚠️ Risk Factors (${risks.length})</h3>
        </div>
        <div class="card-body">
          <ul class="risk-list">
            ${risks.map(risk => `
              <li class="risk-item ${risk.severity}">
                <div class="risk-icon">${getRiskIcon(risk.severity)}</div>
                <div class="risk-content">
                  <strong>${risk.title}</strong>
                  <p>${risk.description}</p>
                  ${risk.action ? `
                    <button class="risk-action" data-action="${risk.action}">
                      ${risk.actionText || 'Take Action'}
                    </button>
                  ` : ''}
                </div>
              </li>
            `).join('')}
          </ul>
        </div>
      </div>
    `;
  }
  
  function renderRecommendations(recommendations) {
    if (!recommendations || recommendations.length === 0) {
      return '';
    }
    
    return `
      <div class="ai-card recommendations">
        <div class="card-header">
          <h3>💡 Recommended Actions</h3>
        </div>
        <div class="card-body">
          ${recommendations.map((rec, idx) => `
            <div class="recommendation-item">
              <div class="rec-number">${idx + 1}</div>
              <div class="rec-content">
                <h4>${rec.title}</h4>
                <p>${rec.description}</p>
                <div class="rec-impact">
                  Impact: <span class="impact-${rec.impact}">${rec.impact.toUpperCase()}</span>
                </div>
              </div>
              <button class="rec-action" data-action="${rec.action}">
                ${rec.buttonText || 'Start'}
              </button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
  
  function renderMissingBenefits(benefits) {
    if (!benefits || benefits.length === 0) {
      return '';
    }
    
    const totalMonthly = benefits.reduce((sum, b) => sum + (b.monthlyAmount || 0), 0);
    const totalAnnual = totalMonthly * 12;
    
    return `
      <div class="ai-card missing-benefits highlight">
        <div class="card-header">
          <h3>💰 Unclaimed Benefits Detected</h3>
          <div class="total-amount">
            <span class="monthly">$${totalMonthly.toLocaleString()}/mo</span>
            <span class="annual">$${totalAnnual.toLocaleString()}/year</span>
          </div>
        </div>
        <div class="card-body">
          <ul class="benefits-list">
            ${benefits.map(benefit => `
              <li class="benefit-item">
                <div class="benefit-info">
                  <div class="benefit-name">${benefit.condition}</div>
                  <div class="benefit-type">${benefit.relationship}</div>
                </div>
                <div class="benefit-rating">Est. ${benefit.rating}%</div>
                <div class="benefit-amount">+$${benefit.monthlyAmount.toLocaleString()}/mo</div>
                <button class="benefit-action" data-action="add-condition" 
                        data-condition="${benefit.condition}">
                  Add to Claim
                </button>
              </li>
            `).join('')}
          </ul>
          <button class="ai-btn-primary full-width" data-action="file-supplemental">
            File Supplemental Claim for All
          </button>
        </div>
      </div>
    `;
  }
  
  function getRiskIcon(severity) {
    const icons = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢'
    };
    return icons[severity] || '⚠️';
  }
  
  function setupOverlayEventListeners(overlay, insights) {
    // Close button
    const closeBtn = overlay.querySelector('.ai-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        overlay.style.display = 'none';
        // Save preference
        chrome.storage.local.set({ overlayHidden: true });
      });
    }
    
    // Action buttons
    overlay.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        const condition = e.target.dataset.condition;
        
        handleAIAction(action, insights, condition);
      });
    });
  }
  
  function handleAIAction(action, insights, extraData) {
    console.log('[VA Intelligence] Action triggered:', action);
    
    // Send to background for processing
    chrome.runtime.sendMessage({
      type: 'AI_ACTION_TRIGGERED',
      action: action,
      context: insights,
      extraData: extraData
    });
    
    // For actions that need web app
    const webAppActions = [
      'detailed-report',
      'export-strategy',
      'file-supplemental',
      'generate-nexus',
      'add-condition'
    ];
    
    if (webAppActions.includes(action)) {
      const baseUrl = 'https://vetclaimservices.com';
      const params = new URLSearchParams({
        action: action,
        claimId: insights.claimId || '',
        condition: extraData || ''
      });

      window.open(`${baseUrl}/claims?${params.toString()}`, '_blank');
    }
  }
  
  function updateAIOverlay(data) {
    const overlay = document.getElementById('va-intelligence-overlay');
    if (!overlay) return;
    
    // Update specific sections without full re-render
    if (data.timeline) {
      const predictionCard = overlay.querySelector('.prediction .card-body');
      if (predictionCard) {
        predictionCard.innerHTML = renderPredictionCard(data.timeline);
      }
    }
    
    // Add loading states, animations, etc.
  }
  
  console.log('[VA Intelligence] Content script initialized');
})();
