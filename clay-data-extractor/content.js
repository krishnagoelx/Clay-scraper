// =============================================================
// content.js — Runs in ISOLATED world
// Acts as bridge between interceptor.js (MAIN) and background.js
// Clay-specific DOM scraping with precise selectors
// =============================================================

(function () {
  'use strict';

  const MSG_PREFIX = '__CLAY_EXTRACTOR__';

  function log(...args) {
    console.log('[Clay Extractor | Content]', ...args);
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 1: Bridge — postMessage ↔ chrome.runtime
  // ═══════════════════════════════════════════════════════════

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.data?.type !== MSG_PREFIX) return;

    switch (event.data.action) {
      case 'API_RESPONSE':
        chrome.runtime.sendMessage({
          action: 'API_DATA_CAPTURED',
          payload: event.data.payload,
        });
        break;

      case 'INTERCEPTOR_READY':
        chrome.runtime.sendMessage({
          action: 'INTERCEPTOR_STATUS',
          payload: { ready: true, timestamp: event.data.payload.timestamp },
        });
        break;
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SECTION 2: Command listener from background/popup
  // ═══════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'SCRAPE_VISIBLE':
        scrapeVisibleRows().then(sendResponse);
        return true;

      case 'SCRAPE_ALL':
        scrapeAllRowsByScrolling().then(sendResponse);
        return true;

      case 'FETCH_TABLE_META':
        fetchTableMetadata().then(sendResponse);
        return true;

      case 'TRIGGER_DATA_RELOAD':
        window.postMessage({ type: MSG_PREFIX, action: 'TRIGGER_RELOAD' }, '*');
        sendResponse({ ok: true });
        return false;

      case 'PING':
        sendResponse({ ok: true, url: window.location.href });
        return false;
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SECTION 3: Clay-Specific Header Extraction
  // ═══════════════════════════════════════════════════════════

  // Returns { labels: string[], fieldIds: string[] }
  function extractHeaders() {
    // Clay headers: #grid-table-header [data-testid="table-header-cell"]
    // Each has id="table-header-cell-f_FIELDID"
    // Label is inside ColumnLabel component → <p> tag
    const headerCells = document.querySelectorAll('[data-testid="table-header-cell"]');

    if (headerCells.length === 0) {
      throw new Error('Could not find Clay table headers. Make sure a table is visible on the page.');
    }

    const labels = [];
    const fieldIds = [];

    headerCells.forEach(cell => {
      // Extract field ID from element id: "table-header-cell-f_xxx" → "f_xxx"
      const cellId = cell.id || '';
      const fieldId = cellId.replace('table-header-cell-', '');

      // Extract label from the <p> inside ColumnLabel
      const labelEl = cell.querySelector('[data-sentry-component="ColumnLabel"] p');
      const label = labelEl ? labelEl.textContent.trim() : (cell.textContent.trim() || fieldId);

      labels.push(label);
      fieldIds.push(fieldId);
    });

    log(`Found ${labels.length} headers:`, labels);
    return { labels, fieldIds };
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 4: Clay-Specific Row/Cell Extraction
  // ═══════════════════════════════════════════════════════════

  // Extract data from all currently rendered rows
  // Returns Map<rowId, { index: number, cells: Map<fieldId, value> }>
  function extractRenderedRows(fieldIds) {
    const rows = new Map();
    const body = document.getElementById('grid-view-body');
    if (!body) {
      log('grid-view-body not found');
      return rows;
    }

    // Clay rows: .group/row[data-index] inside #grid-view-body
    const rowElements = body.querySelectorAll('[data-index]');

    for (const rowEl of rowElements) {
      const dataIndex = parseInt(rowEl.getAttribute('data-index'), 10);
      if (isNaN(dataIndex)) continue;

      // Extract row ID from leading cell class: "leading-cell--r_ROWID"
      const leadingCell = rowEl.querySelector('[data-sentry-component="TableLeadingCell"]');
      let rowId = null;
      if (leadingCell) {
        const cls = leadingCell.className || '';
        const match = cls.match(/leading-cell--r_(\S+)/);
        if (match) rowId = 'r_' + match[1].split(/\s/)[0];
      }
      if (!rowId) rowId = `idx_${dataIndex}`;

      // If we already captured this row with more cells, skip
      if (rows.has(rowId) && rows.get(rowId).cells.size >= fieldIds.length) continue;

      const cellValues = new Map();

      // Method 1: Find cells by data-cell-id attribute
      // Format: data-cell-id="f_FIELDID.r_ROWID"
      const cellElements = rowEl.querySelectorAll('[data-cell-id]');
      for (const cellEl of cellElements) {
        const cellId = cellEl.getAttribute('data-cell-id');
        const dotIndex = cellId.indexOf('.');
        if (dotIndex === -1) continue;
        const fieldId = cellId.substring(0, dotIndex);

        if (!fieldIds.includes(fieldId)) continue;

        const value = extractCellValue(cellEl);
        cellValues.set(fieldId, value);
      }

      // Method 2: Find cells by data-testid="cell-rX-cY"
      // The column index (cY) maps to fieldIds array position
      const testIdCells = rowEl.querySelectorAll('[data-testid^="cell-"]');
      for (const cellEl of testIdCells) {
        const testId = cellEl.getAttribute('data-testid');
        const match = testId.match(/cell-r(\d+)-c(\d+)/);
        if (!match) continue;
        const colIndex = parseInt(match[2], 10);

        // data-testid column indices start from 1 for first data column after pinned
        // But there may be pinned columns at index 0
        // The cell also has an id="table-cell-f_FIELDID.r_ROWID" — use that
        const cellIdAttr = cellEl.id || '';
        const fieldMatch = cellIdAttr.match(/table-cell-(f_[^.]+)\./);
        if (fieldMatch) {
          const fieldId = fieldMatch[1];
          if (!cellValues.has(fieldId)) {
            // Find the inner data-cell-id element for value extraction
            const innerCell = cellEl.querySelector('[data-cell-id]');
            const value = extractCellValue(innerCell || cellEl);
            cellValues.set(fieldId, value);
          }
        }
      }

      // Method 3: Handle pinned columns (inside sticky container, no data-testid)
      // These FieldValueInput elements are inside the sticky pinned section
      const pinnedContainer = rowEl.querySelector('[id="table-header-pinned-fields-container"]')?.parentElement;
      if (!pinnedContainer) {
        // Pinned cells are in the sticky div at the start of the row
        const stickyDiv = rowEl.querySelector('.sticky');
        if (stickyDiv) {
          const pinnedCellIds = stickyDiv.querySelectorAll('[data-cell-id]');
          for (const cellEl of pinnedCellIds) {
            const cellId = cellEl.getAttribute('data-cell-id');
            const dotIndex = cellId.indexOf('.');
            if (dotIndex === -1) continue;
            const fieldId = cellId.substring(0, dotIndex);
            if (fieldIds.includes(fieldId) && !cellValues.has(fieldId)) {
              cellValues.set(fieldId, extractCellValue(cellEl));
            }
          }
        }
      }

      // Merge with existing row data (for horizontal scroll passes)
      if (rows.has(rowId)) {
        const existing = rows.get(rowId);
        for (const [fid, val] of cellValues) {
          if (!existing.cells.has(fid) || existing.cells.get(fid) === '') {
            existing.cells.set(fid, val);
          }
        }
      } else {
        rows.set(rowId, { index: dataIndex, cells: cellValues });
      }
    }

    return rows;
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 5: Cell Value Extraction (Clay-specific)
  // ═══════════════════════════════════════════════════════════

  function extractCellValue(cellEl) {
    if (!cellEl) return '';

    // Clay cells contain FieldValueInput → then the actual value display
    const fieldInput = cellEl.querySelector('[data-sentry-component="FieldValueInput"]') || cellEl;

    // Check for links (LinkedIn profiles, URLs, etc.)
    const links = fieldInput.querySelectorAll('a[href]');
    if (links.length === 1) {
      const href = links[0].href;
      const text = links[0].textContent.trim();
      // For LinkedIn URLs and similar, just return the URL
      if (href.includes('linkedin.com') || href.includes('http')) {
        return text && text !== href && !href.includes(text) ? `${text}` : href;
      }
      return text || href;
    }
    if (links.length > 1) {
      return Array.from(links)
        .map(a => a.textContent.trim() || a.href)
        .filter(v => v)
        .join('; ');
    }

    // Check for images (avatars) — return alt text if present
    const img = fieldInput.querySelector('img[src]');
    if (img && !fieldInput.textContent.trim()) {
      return img.alt || '';
    }

    // Check for ValueViewer <p> tags (most common for text values)
    const valueViewerP = fieldInput.querySelector('[data-sentry-source-file="ValueViewer.tsx"] p, [data-sentry-source-file="ValueViewer.tsx"]');
    if (valueViewerP) {
      return valueViewerP.textContent.trim();
    }

    // Check for any <p> tags within FieldValueInput (Clay uses <p> for text values)
    const pTags = fieldInput.querySelectorAll('p[data-slot="text"]');
    if (pTags.length > 0) {
      const texts = Array.from(pTags)
        .map(p => p.textContent.trim())
        .filter(t => t);
      if (texts.length > 0) return texts.join('; ');
    }

    // Check for tags/pills/chips
    const tags = fieldInput.querySelectorAll('[class*="tag"], [class*="pill"], [class*="chip"], [class*="badge"]');
    if (tags.length > 1) {
      return Array.from(tags)
        .map(t => t.textContent.trim())
        .filter(t => t)
        .join('; ');
    }

    // Check for tooltip with full value (truncated cells)
    const tooltipTrigger = fieldInput.querySelector('[aria-describedby]');
    if (tooltipTrigger) {
      const text = tooltipTrigger.textContent.trim();
      if (text) return text;
    }

    // Default: all text content, cleaned up
    let text = fieldInput.textContent.trim();
    text = text.replace(/\s+/g, ' ');
    return text;
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 6: Scrape Visible Rows
  // ═══════════════════════════════════════════════════════════

  async function scrapeVisibleRows() {
    try {
      const { labels, fieldIds } = extractHeaders();
      const rowsMap = extractRenderedRows(fieldIds);

      // Convert Map to ordered array
      const rows = convertRowsMapToArray(rowsMap, fieldIds);

      log(`Scraped ${rows.length} visible rows x ${labels.length} columns`);
      return {
        success: true,
        headers: labels,
        rows: rows,
        rowCount: rows.length,
        method: 'dom_visible',
      };
    } catch (error) {
      log('scrapeVisibleRows error:', error);
      return { success: false, error: error.message };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 7: Scrape All Rows by Scrolling
  // Handles both vertical AND horizontal virtualization
  // ═══════════════════════════════════════════════════════════

  async function scrapeAllRowsByScrolling() {
    try {
      const { labels, fieldIds } = extractHeaders();
      const scrollContainer = document.getElementById('grid-view-scroll-container');

      if (!scrollContainer) {
        log('grid-view-scroll-container not found, trying visible-only');
        return scrapeVisibleRows();
      }

      const allRows = new Map(); // rowId → { index, cells: Map<fieldId, value> }

      // Save original scroll position
      const origScrollTop = scrollContainer.scrollTop;
      const origScrollLeft = scrollContainer.scrollLeft;

      // Determine scroll bounds
      const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const maxScrollLeft = scrollContainer.scrollWidth - scrollContainer.clientWidth;
      const verticalStep = Math.max(scrollContainer.clientHeight * 0.6, 150);
      const horizontalStep = Math.max(scrollContainer.clientWidth * 0.6, 300);

      // Build list of horizontal positions to scan
      const hPositions = [0];
      if (maxScrollLeft > 10) {
        let hPos = horizontalStep;
        while (hPos < maxScrollLeft) {
          hPositions.push(hPos);
          hPos += horizontalStep;
        }
        hPositions.push(maxScrollLeft);
      }

      log(`Scrolling: maxV=${maxScrollTop}, maxH=${maxScrollLeft}, hPositions=${hPositions.length}`);

      // For each horizontal position, scroll vertically through all rows
      for (const hPos of hPositions) {
        scrollContainer.scrollLeft = hPos;
        await sleep(200);

        // Scroll to top
        scrollContainer.scrollTop = 0;
        await sleep(200);

        let prevScrollTop = -1;
        let stableCount = 0;

        while (stableCount < 3) {
          // Capture currently visible cells
          const rendered = extractRenderedRows(fieldIds);
          mergeRows(allRows, rendered);

          // Scroll down
          scrollContainer.scrollTop += verticalStep;
          await sleep(200);

          if (Math.abs(scrollContainer.scrollTop - prevScrollTop) < 2) {
            stableCount++;
          } else {
            stableCount = 0;
          }
          prevScrollTop = scrollContainer.scrollTop;
        }
      }

      // Restore original scroll position
      scrollContainer.scrollTop = origScrollTop;
      scrollContainer.scrollLeft = origScrollLeft;

      // Convert to array
      const rows = convertRowsMapToArray(allRows, fieldIds);

      log(`Scraped ${rows.length} total rows x ${labels.length} columns via scrolling`);
      return {
        success: true,
        headers: labels,
        rows: rows,
        rowCount: rows.length,
        method: 'dom_scroll',
      };
    } catch (error) {
      log('scrapeAllRowsByScrolling error:', error);
      return { success: false, error: error.message };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 8: Utilities
  // ═══════════════════════════════════════════════════════════

  // Merge new rows into the accumulator map
  function mergeRows(target, source) {
    for (const [rowId, rowData] of source) {
      if (target.has(rowId)) {
        const existing = target.get(rowId);
        for (const [fid, val] of rowData.cells) {
          if (val && (!existing.cells.has(fid) || existing.cells.get(fid) === '')) {
            existing.cells.set(fid, val);
          }
        }
      } else {
        target.set(rowId, rowData);
      }
    }
  }

  // Convert the rowId → cells Map into an ordered 2D array matching header order
  function convertRowsMapToArray(rowsMap, fieldIds) {
    // Sort rows by their original index
    const sorted = Array.from(rowsMap.values()).sort((a, b) => a.index - b.index);

    return sorted.map(row => {
      return fieldIds.map(fid => row.cells.get(fid) || '');
    });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 9: Fetch Table Metadata from Clay API
  // Extracts table name + source search parameters for filenames
  // ═══════════════════════════════════════════════════════════

  async function fetchTableMetadata() {
    try {
      const url = window.location.href;
      const tableId = url.match(/tables\/(t_[^/]+)/)?.[1];
      if (!tableId) {
        return { success: false, error: 'Could not find table ID in URL' };
      }

      // Fetch table name from document title as fallback
      const titleMatch = document.title.match(/Clay\s*\|\s*(.+)/);
      const tableName = titleMatch ? titleMatch[1].trim() : '';

      // Fetch sources (contains search parameters)
      const srcRes = await fetch(`https://api.clay.com/v3/sources?tableId=${tableId}`, { credentials: 'include' });
      if (!srcRes.ok) {
        return { success: true, tableName, sourceLabel: '', searchParams: {} };
      }

      const sources = await srcRes.json();
      if (!Array.isArray(sources) || sources.length === 0) {
        return { success: true, tableName, sourceLabel: '', searchParams: {} };
      }

      const source = sources[0];
      const inputs = source.typeSettings?.inputs || {};
      const sourceName = source.name || source.typeSettings?.name || '';
      const totalRecords = source.state?.numSourceRecords || 0;

      // Collect ALL non-empty search fields as human-readable metadata
      const searchFields = {};
      const filenameParts = [];

      for (const [key, val] of Object.entries(inputs)) {
        // Skip empty/null/default values
        if (val === null || val === undefined || val === '' || val === false) continue;
        if (Array.isArray(val) && val.length === 0) continue;
        if (typeof val === 'number' && val === 0) continue;
        // Skip internal/technical fields
        if (/bitmap|method|table_id|record_id|raw_location|past_experiences|exact_match/i.test(key)) continue;
        if (key === 'limit' || key === 'name') continue;

        // Store the raw value for metadata
        const readableKey = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        searchFields[readableKey] = Array.isArray(val) ? val.join(', ') : String(val);

        // Build filename parts from the most descriptive fields
        if (Array.isArray(val) && val.length > 0) {
          const abbreviated = val.map(v => abbreviateValue(key, v));
          filenameParts.push(abbreviated.join('+'));
        } else if (typeof val === 'number' && val > 0) {
          filenameParts.push(`${key.replace(/_/g, '')}${val}`);
        }
      }

      const sourceLabel = filenameParts.length > 0 ? filenameParts.join('_') : sourceName;

      log(`Table metadata: name="${tableName}", source="${sourceLabel}", fields=${Object.keys(searchFields).length}`);
      return {
        success: true,
        tableName,
        sourceName,
        sourceLabel,
        totalRecords,
        searchFields,   // ALL non-empty search params as readable key-value pairs
        searchParams: inputs,  // raw params
      };
    } catch (err) {
      log('fetchTableMetadata error:', err);
      return { success: false, error: err.message };
    }
  }

  function abbreviateValue(key, value) {
    if (typeof value !== 'string') return String(value);

    // Country abbreviations
    const countries = { 'United States': 'US', 'United Kingdom': 'UK', 'United Arab Emirates': 'UAE', 'India': 'IN', 'Canada': 'CA', 'Australia': 'AU', 'Germany': 'DE', 'France': 'FR', 'Singapore': 'SG', 'Japan': 'JP', 'China': 'CN', 'Brazil': 'BR', 'Netherlands': 'NL', 'Switzerland': 'CH', 'Israel': 'IL' };
    if (countries[value]) return countries[value];

    // School abbreviations
    if (/indian institute of technology/i.test(value)) return 'IIT';
    if (/indian institute of management/i.test(value)) return 'IIM';
    if (/indian institute of science/i.test(value)) return 'IISc';

    // Industry shortening
    if (key.includes('industr')) {
      return value
        .replace(/\band\b/gi, '&').replace(/\bServices\b/gi, 'Svc')
        .replace(/\bTechnology\b/gi, 'Tech').replace(/\bManagement\b/gi, 'Mgmt')
        .replace(/\bConsulting\b/gi, 'Consult').replace(/\bEngineering\b/gi, 'Eng')
        .trim();
    }

    // For location states/cities, keep as-is but truncate
    return value.substring(0, 25);
  }

  log('Content script loaded (Clay-specific selectors)');
})();
