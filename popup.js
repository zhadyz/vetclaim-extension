// VA Intelligence Extension - Popup Logic

document.addEventListener('DOMContentLoaded', function() {
  // Update status
  updateStatus();

  // Button handlers
  document.getElementById('openVA').addEventListener('click', function() {
    chrome.tabs.create({ url: 'https://va.gov/claim-or-appeal-status/' });
  });

  document.getElementById('viewDocs').addEventListener('click', function() {
    chrome.tabs.create({ url: 'https://va-intelligence.app/docs' });
  });
});

async function updateStatus() {
  try {
    // Check if extension is working
    const statusElement = document.getElementById('status');
    
    // Query active tab to see if we're on VA.gov
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab && tab.url && tab.url.includes('va.gov')) {
      statusElement.textContent = 'Active on VA.gov';
      statusElement.style.color = '#28a745';
    } else {
      statusElement.textContent = 'Visit VA.gov to activate';
      statusElement.style.color = '#ffc107';
    }
  } catch (error) {
    console.error('Status check error:', error);
    document.getElementById('status').textContent = 'Error';
    document.getElementById('status').style.color = '#dc3545';
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'statusUpdate') {
    updateStatus();
  }
});