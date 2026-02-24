// =============================================================
// popup.js — Popup UI logic
// Single capture mode (scroll all) + row range for export
// =============================================================

'use strict';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await refreshStatus();
  bindButtons();
  // Fetch table metadata (search params) in background
  fetchMeta();
}

// ═══════════════════════════════════════════════════════════
// Status Management
// ═══════════════════════════════════════════════════════════

async function refreshStatus() {
  const statusEl = document.getElementById('status-indicator');
  const dataInfoEl = document.getElementById('data-info');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isClayPage = tab?.url?.includes('app.clay.com');

    if (!isClayPage) {
      statusEl.textContent = 'Navigate to app.clay.com first';
      statusEl.className = 'status idle';
      dataInfoEl.classList.add('hidden');
      disableButtons('#capture-section .btn');
      hideExportSection();
      return;
    }

    enableButtons('#capture-section .btn');

    const status = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });

    if (status.hasCapturedData) {
      statusEl.textContent = 'Data captured!';
      statusEl.className = 'status has-data';
      showDataInfo(status);
      showExportSection();
      updateRangeHint(status.rowCount);
    } else {
      statusEl.textContent = 'Ready — extract data below';
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

  // Show table name if we have metadata
  if (status.tableMeta?.tableName) {
    showTableMeta(status.tableMeta);
  }
}

function showTableMeta(meta) {
  const metaEl = document.getElementById('table-meta');
  if (!metaEl) return;
  metaEl.classList.remove('hidden');

  const nameEl = document.getElementById('meta-table-name');
  if (nameEl) nameEl.textContent = meta.tableName || '';

  const sourceEl = document.getElementById('meta-source-label');
  if (sourceEl) {
    sourceEl.textContent = meta.sourceLabel || meta.sourceName || '';
  }
}

async function fetchMeta() {
  try {
    const result = await chrome.runtime.sendMessage({ action: 'FETCH_TABLE_META' });
    if (result?.success) {
      showTableMeta(result);
    }
  } catch (e) {
    // Silently ignore — metadata is optional
  }
}

function showExportSection() {
  document.getElementById('export-section').classList.remove('hidden');
}

function hideExportSection() {
  document.getElementById('export-section').classList.add('hidden');
}

function updateRangeHint(totalRows) {
  const hint = document.getElementById('range-hint');
  hint.textContent = `1-${totalRows} available. Leave empty for all rows.`;
  document.getElementById('row-range').placeholder = `e.g. 1-${totalRows} (all rows)`;
}

// ═══════════════════════════════════════════════════════════
// Row Range Parsing
// ═══════════════════════════════════════════════════════════

// Parse "a-b" into { start, end } (1-indexed, inclusive)
// Returns null for "all rows"
function parseRowRange(input, totalRows) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null; // all rows

  const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    // Try single number
    const single = parseInt(trimmed, 10);
    if (!isNaN(single) && single >= 1 && single <= totalRows) {
      return { start: single, end: single };
    }
    throw new Error(`Invalid range "${trimmed}". Use format: 1-25`);
  }

  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);

  if (start < 1) throw new Error('Start row must be at least 1');
  if (end > totalRows) throw new Error(`End row can't exceed ${totalRows}`);
  if (start > end) throw new Error('Start must be less than or equal to end');

  return { start, end };
}

// ═══════════════════════════════════════════════════════════
// Button Handlers
// ═══════════════════════════════════════════════════════════

function bindButtons() {
  // ── Extract All Rows ──
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

  // ── Download ──
  document.getElementById('btn-download').addEventListener('click', async () => {
    const btn = document.getElementById('btn-download');
    const format = getSelectedFormat();
    setButtonLoading(btn, true);

    try {
      const range = getRangeOrError();
      const action = format === 'csv' ? 'EXPORT_CSV' : 'EXPORT_JSON';
      const result = await chrome.runtime.sendMessage({ action, range });
      if (result.success) {
        const rangeLabel = range ? ` (rows ${range.start}-${range.end})` : '';
        log(`Downloading ${format.toUpperCase()}${rangeLabel}...`, 'success');
      } else {
        log('Download failed: ' + result.error, 'error');
      }
    } catch (err) {
      log(err.message, 'error');
    }

    setButtonLoading(btn, false);
  });

  // ── Copy to Clipboard ──
  document.getElementById('btn-copy').addEventListener('click', async () => {
    const btn = document.getElementById('btn-copy');
    const format = getSelectedFormat();
    setButtonLoading(btn, true);

    try {
      const range = getRangeOrError();
      const result = await chrome.runtime.sendMessage({ action: 'COPY_CLIPBOARD', format, range });
      if (result.success) {
        const rangeLabel = range ? ` (rows ${range.start}-${range.end})` : '';
        log(`Copied ${format.toUpperCase()}${rangeLabel} to clipboard!`, 'success');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span class="btn-icon-inline">&#x2713;</span> Copied!';
        setTimeout(() => { btn.innerHTML = originalText; }, 2000);
      } else {
        log('Copy failed: ' + result.error, 'error');
      }
    } catch (err) {
      log(err.message, 'error');
    }

    setButtonLoading(btn, false);
  });

  // ── Range: "All" reset button ──
  document.getElementById('btn-range-all').addEventListener('click', () => {
    document.getElementById('row-range').value = '';
  });

  // ── Clear Data ──
  document.getElementById('btn-clear').addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'CLEAR_DATA' });
      document.getElementById('row-range').value = '';
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

function getRangeOrError() {
  const input = document.getElementById('row-range').value;
  const totalRows = parseInt(document.getElementById('row-count').textContent, 10) || 0;
  return parseRowRange(input, totalRows);
}

function handleCaptureResult(result) {
  if (result?.success) {
    log(`Captured ${result.rowCount} rows x ${result.headers?.length || '?'} columns`, 'success');
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

  while (logEl.children.length > 50) {
    logEl.removeChild(logEl.lastChild);
  }
}
