// =============================================================
// popup.js — Popup UI logic
// Handles user interactions, triggers capture/export actions
// =============================================================

'use strict';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await refreshStatus();
  bindButtons();

  // Auto-refresh status every 3 seconds (catches new API interceptions)
  setInterval(refreshStatus, 3000);
}

// ═══════════════════════════════════════════════════════════
// Status Management
// ═══════════════════════════════════════════════════════════

async function refreshStatus() {
  const statusEl = document.getElementById('status-indicator');
  const dataInfoEl = document.getElementById('data-info');
  const apiCountEl = document.getElementById('api-count');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isClayPage = tab?.url?.includes('app.clay.com');

    if (!isClayPage) {
      statusEl.textContent = 'Navigate to app.clay.com first';
      statusEl.className = 'status idle';
      dataInfoEl.classList.add('hidden');
      apiCountEl.classList.add('hidden');
      disableButtons('#capture-section .btn');
      hideExportSection();
      return;
    }

    enableButtons('#capture-section .btn');

    const status = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });

    // Show API response count
    if (status.apiResponseCount > 0) {
      apiCountEl.classList.remove('hidden');
      document.getElementById('api-response-count').textContent = status.apiResponseCount;
    } else {
      apiCountEl.classList.add('hidden');
    }

    if (status.hasCapturedData) {
      statusEl.textContent = 'Data captured!';
      statusEl.className = 'status has-data';
      showDataInfo(status);
      showExportSection();
    } else {
      statusEl.textContent = 'Ready — capture data below';
      statusEl.className = 'status ready';
      dataInfoEl.classList.add('hidden');
      hideExportSection();
    }
  } catch (err) {
    statusEl.textContent = 'Error connecting';
    statusEl.className = 'status error';
    log('Error: ' + err.message, 'error');
  }
}

function showDataInfo(status) {
  const dataInfoEl = document.getElementById('data-info');
  dataInfoEl.classList.remove('hidden');
  document.getElementById('row-count').textContent = status.rowCount;
  document.getElementById('col-count').textContent = status.headerCount;

  const badge = document.getElementById('capture-method');
  if (status.method === 'api') {
    badge.textContent = 'API';
    badge.className = 'badge api';
  } else {
    badge.textContent = 'DOM';
    badge.className = 'badge dom';
  }
}

function showExportSection() {
  document.getElementById('export-section').classList.remove('hidden');
}

function hideExportSection() {
  document.getElementById('export-section').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════
// Button Handlers
// ═══════════════════════════════════════════════════════════

function bindButtons() {
  // ── Capture: Use Intercepted API Data ──
  document.getElementById('btn-use-api').addEventListener('click', async () => {
    const btn = document.getElementById('btn-use-api');
    setButtonLoading(btn, true);
    log('Parsing intercepted API data...');

    try {
      const result = await chrome.runtime.sendMessage({ action: 'USE_API_DATA' });
      handleCaptureResult(result);
    } catch (err) {
      log('Error: ' + err.message, 'error');
    }

    setButtonLoading(btn, false);
  });

  // ── Capture: Scrape Visible Rows ──
  document.getElementById('btn-scrape-visible').addEventListener('click', async () => {
    const btn = document.getElementById('btn-scrape-visible');
    setButtonLoading(btn, true);
    log('Scraping visible rows from DOM...');

    try {
      const result = await chrome.runtime.sendMessage({ action: 'SCRAPE_VISIBLE' });
      handleCaptureResult(result);
    } catch (err) {
      log('Error: ' + err.message, 'error');
    }

    setButtonLoading(btn, false);
  });

  // ── Capture: Scrape All Rows by Scrolling ──
  document.getElementById('btn-scrape-all').addEventListener('click', async () => {
    const btn = document.getElementById('btn-scrape-all');
    setButtonLoading(btn, true);
    log('Scrolling through table to capture all rows...');

    try {
      const result = await chrome.runtime.sendMessage({ action: 'SCRAPE_ALL' });
      handleCaptureResult(result);
    } catch (err) {
      log('Error: ' + err.message, 'error');
    }

    setButtonLoading(btn, false);
  });

  // ── Export: Download ──
  document.getElementById('btn-download').addEventListener('click', async () => {
    const btn = document.getElementById('btn-download');
    const format = getSelectedFormat();
    setButtonLoading(btn, true);

    try {
      const action = format === 'csv' ? 'EXPORT_CSV' : 'EXPORT_JSON';
      const result = await chrome.runtime.sendMessage({ action });
      if (result.success) {
        log(`Downloading ${format.toUpperCase()} file...`, 'success');
      } else {
        log('Download failed: ' + result.error, 'error');
      }
    } catch (err) {
      log('Download error: ' + err.message, 'error');
    }

    setButtonLoading(btn, false);
  });

  // ── Export: Copy to Clipboard ──
  document.getElementById('btn-copy').addEventListener('click', async () => {
    const btn = document.getElementById('btn-copy');
    const format = getSelectedFormat();
    setButtonLoading(btn, true);

    try {
      const result = await chrome.runtime.sendMessage({ action: 'COPY_CLIPBOARD', format });
      if (result.success) {
        log(`Copied ${format.toUpperCase()} to clipboard!`, 'success');
        // Brief visual feedback
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span class="btn-icon-inline">&#x2713;</span> Copied!';
        setTimeout(() => {
          btn.innerHTML = originalText;
        }, 2000);
      } else {
        log('Copy failed: ' + result.error, 'error');
      }
    } catch (err) {
      log('Copy error: ' + err.message, 'error');
    }

    setButtonLoading(btn, false);
  });

  // ── Clear Data ──
  document.getElementById('btn-clear').addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'CLEAR_DATA' });
      log('Data cleared.');
      await refreshStatus();
    } catch (err) {
      log('Error: ' + err.message, 'error');
    }
  });
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function handleCaptureResult(result) {
  if (result?.success) {
    log(`Captured ${result.rowCount} rows (${result.method || 'unknown'})`, 'success');
    refreshStatus();
  } else {
    log('Capture failed: ' + (result?.error || 'Unknown error'), 'error');
  }
}

function getSelectedFormat() {
  return document.querySelector('input[name="format"]:checked')?.value || 'csv';
}

function setButtonLoading(btn, loading) {
  if (loading) {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function disableButtons(selector) {
  document.querySelectorAll(selector).forEach(btn => (btn.disabled = true));
}

function enableButtons(selector) {
  document.querySelectorAll(selector).forEach(btn => (btn.disabled = false));
}

function log(message, level = 'info') {
  const logEl = document.getElementById('log');
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  entry.appendChild(time);
  entry.appendChild(document.createTextNode(message));
  logEl.prepend(entry);

  // Keep log manageable
  while (logEl.children.length > 50) {
    logEl.removeChild(logEl.lastChild);
  }
}
