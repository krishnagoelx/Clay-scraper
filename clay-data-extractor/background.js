// =============================================================
// background.js — Service Worker
// Central coordinator: stores captured data, handles exports,
// manages offscreen document for clipboard operations
// =============================================================

'use strict';

// ═══════════════════════════════════════════════════════════
// State Management
// ═══════════════════════════════════════════════════════════

let capturedData = {
  apiResponses: [],
  parsedTable: null, // { headers: string[], rows: string[][] }
  method: null, // 'api' | 'dom_visible' | 'dom_scroll'
  capturedAt: null,
  sourceUrl: null,
  tableMeta: null, // { tableName, sourceName, sourceLabel, totalRecords, searchParams }
};

// ═══════════════════════════════════════════════════════════
// Message Router
// ═══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    // ── From interceptor (via content.js bridge) ──
    case 'API_DATA_CAPTURED':
      handleApiCapture(message.payload, sender.tab);
      sendResponse({ ok: true });
      return false;

    case 'INTERCEPTOR_STATUS':
      // Could track interceptor readiness if needed
      sendResponse({ ok: true });
      return false;

    // ── From popup ──
    case 'GET_STATUS':
      sendResponse(getStatus());
      return false;

    case 'USE_API_DATA':
      handleUseApiData(sendResponse);
      return true; // async

    case 'SCRAPE_VISIBLE':
    case 'SCRAPE_ALL':
      forwardToContentScript(message.action, sendResponse);
      return true;

    case 'FETCH_TABLE_META':
      fetchTableMeta(sendResponse);
      return true;

    case 'TRIGGER_DATA_RELOAD':
      forwardToContentScript('TRIGGER_DATA_RELOAD', sendResponse);
      return true;

    case 'EXPORT_CSV':
      exportAsFile('csv', message.range, sendResponse);
      return true;

    case 'EXPORT_JSON':
      exportAsFile('json', message.range, sendResponse);
      return true;

    case 'COPY_CLIPBOARD':
      copyToClipboard(message.format || 'csv', message.range, sendResponse);
      return true;

    case 'CLEAR_DATA':
      capturedData = {
        apiResponses: [],
        parsedTable: null,
        method: null,
        capturedAt: null,
        sourceUrl: null,
        tableMeta: null,
      };
      sendResponse({ ok: true });
      return false;

    case 'GET_RAW_API':
      // Debug: return raw captured API responses
      sendResponse({ responses: capturedData.apiResponses });
      return false;

    // ── From offscreen ──
    case 'OFFSCREEN_COPY_RESULT':
      // Handled via promise in copyToClipboard
      return false;
  }
});

// ═══════════════════════════════════════════════════════════
// Status
// ═══════════════════════════════════════════════════════════

function getStatus() {
  return {
    hasCapturedData: capturedData.parsedTable !== null,
    rowCount: capturedData.parsedTable?.rows?.length || 0,
    headerCount: capturedData.parsedTable?.headers?.length || 0,
    method: capturedData.method,
    capturedAt: capturedData.capturedAt,
    apiResponseCount: capturedData.apiResponses.length,
    sourceUrl: capturedData.sourceUrl,
    tableMeta: capturedData.tableMeta,
  };
}

// ═══════════════════════════════════════════════════════════
// API Data Handling
// ═══════════════════════════════════════════════════════════

function handleApiCapture(payload, tab) {
  // Only keep responses that are likely to contain table data
  // Prioritize responses flagged as having table data
  if (payload.hasTableData) {
    // Insert at front for priority
    capturedData.apiResponses.unshift(payload);
  } else {
    capturedData.apiResponses.push(payload);
  }

  // Cap stored responses to prevent memory bloat
  if (capturedData.apiResponses.length > 100) {
    capturedData.apiResponses = capturedData.apiResponses.slice(0, 100);
  }

  capturedData.sourceUrl = tab?.url || null;

  // Auto-parse if we get a response with table data
  if (payload.hasTableData) {
    const parsed = parseApiResponsesToTable(capturedData.apiResponses);
    if (parsed && parsed.rows.length > 0) {
      if (!capturedData.parsedTable || parsed.rows.length >= capturedData.parsedTable.rows.length) {
        capturedData.parsedTable = parsed;
        capturedData.method = 'api';
        capturedData.capturedAt = Date.now();
        console.log(`[Clay Extractor] Auto-parsed ${parsed.rows.length} rows x ${parsed.headers.length} cols from API`);
      }
    }
  }
}

function handleUseApiData(sendResponse) {
  if (capturedData.apiResponses.length === 0) {
    sendResponse({
      success: false,
      error:
        'No API responses captured yet. Navigate to a Clay table, reload the page (Ctrl+R), then try again.',
    });
    return;
  }

  const parsed = parseApiResponsesToTable(capturedData.apiResponses);
  if (parsed && parsed.rows.length > 0) {
    capturedData.parsedTable = parsed;
    capturedData.method = 'api';
    capturedData.capturedAt = Date.now();
    sendResponse({
      success: true,
      headers: parsed.headers,
      rows: parsed.rows,
      rowCount: parsed.rows.length,
      method: 'api',
    });
  } else {
    // Provide debug info about what we captured
    const withTableData = capturedData.apiResponses.filter(r => r.hasTableData).length;
    const urls = capturedData.apiResponses.slice(0, 5).map(r => r.url).join(', ');
    sendResponse({
      success: false,
      error: `Captured ${capturedData.apiResponses.length} API responses (${withTableData} with table-like data) but could not map to table columns. URLs: ${urls}. Try DOM scraping instead.`,
    });
  }
}

// ═══════════════════════════════════════════════════════════
// API Response Parsing
// ═══════════════════════════════════════════════════════════

function parseApiResponsesToTable(responses) {
  let bestResult = null;

  for (const resp of responses) {
    const data = resp.data;
    const candidates = findAllTableArrays(data);

    for (const tableData of candidates) {
      if (tableData.length === 0) continue;

      const headers = extractHeadersFromObjects(tableData);
      if (headers.length === 0) continue;

      const rows = tableData.map(item => headers.map(h => flattenValue(item[h])));

      if (!bestResult || rows.length > bestResult.rows.length) {
        bestResult = { headers, rows };
      }
    }
  }

  return bestResult;
}

function findAllTableArrays(obj, depth = 0, results = []) {
  if (depth > 8) return results;

  if (Array.isArray(obj)) {
    // Check if this array looks like table rows (array of similar objects)
    if (obj.length >= 1 && typeof obj[0] === 'object' && obj[0] !== null && !Array.isArray(obj[0])) {
      // Verify objects have consistent keys (table-like structure)
      const firstKeys = Object.keys(obj[0]);
      if (firstKeys.length >= 2) {
        const isConsistent = obj.slice(0, Math.min(5, obj.length)).every(item => {
          if (typeof item !== 'object' || item === null) return false;
          const keys = Object.keys(item);
          // At least half the keys should overlap with the first item
          const overlap = firstKeys.filter(k => keys.includes(k));
          return overlap.length >= firstKeys.length * 0.5;
        });
        if (isConsistent) {
          results.push(obj);
        }
      }
    }
    // Also recurse into array items
    for (const item of obj) {
      if (typeof item === 'object' && item !== null) {
        findAllTableArrays(item, depth + 1, results);
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const key of Object.keys(obj)) {
      findAllTableArrays(obj[key], depth + 1, results);
    }
  }

  return results;
}

function extractHeadersFromObjects(arr) {
  // Collect all keys from all objects, maintaining order from first object
  const firstKeys = Object.keys(arr[0]);
  const allKeys = new Set(firstKeys);

  for (let i = 1; i < Math.min(arr.length, 10); i++) {
    if (typeof arr[i] === 'object' && arr[i] !== null) {
      for (const key of Object.keys(arr[i])) {
        allKeys.add(key);
      }
    }
  }

  // Filter out internal/metadata keys that aren't useful as columns
  const skipKeys = new Set([
    '__typename',
    '_id',
    'createdAt',
    'updatedAt',
    'created_at',
    'updated_at',
    '__v',
    'cursor',
    'node',
  ]);

  return Array.from(allKeys).filter(k => !skipKeys.has(k));
}

function flattenValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);

  if (Array.isArray(val)) {
    if (val.length === 0) return '';
    // If array of primitives, join them
    if (val.every(v => typeof v !== 'object' || v === null)) {
      return val.map(v => (v === null ? '' : String(v))).join('; ');
    }
    // Array of objects: try to extract meaningful values
    return val.map(v => flattenValue(v)).join('; ');
  }

  if (typeof val === 'object') {
    // Try common patterns for enriched data objects
    if (val.value !== undefined) return flattenValue(val.value);
    if (val.text !== undefined) return flattenValue(val.text);
    if (val.name !== undefined) return flattenValue(val.name);
    if (val.label !== undefined) return flattenValue(val.label);
    if (val.title !== undefined) return flattenValue(val.title);
    if (val.display !== undefined) return flattenValue(val.display);
    if (val.url !== undefined) return String(val.url);
    if (val.href !== undefined) return String(val.href);
    if (val.email !== undefined) return String(val.email);
    if (val.phone !== undefined) return String(val.phone);

    // If it has a small number of keys, format as key:value pairs
    const keys = Object.keys(val);
    if (keys.length <= 4) {
      return keys.map(k => `${k}: ${flattenValue(val[k])}`).join(', ');
    }

    // Last resort: JSON
    return JSON.stringify(val);
  }

  return String(val);
}

// ═══════════════════════════════════════════════════════════
// Content Script Communication
// ═══════════════════════════════════════════════════════════

async function forwardToContentScript(action, sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      sendResponse({ success: false, error: 'No active tab found' });
      return;
    }
    if (!tab.url || !tab.url.includes('app.clay.com')) {
      sendResponse({ success: false, error: 'Not on a Clay.com page' });
      return;
    }

    const result = await chrome.tabs.sendMessage(tab.id, { action });

    if (result?.success) {
      capturedData.parsedTable = { headers: result.headers, rows: result.rows };
      capturedData.method = result.method;
      capturedData.capturedAt = Date.now();
      capturedData.sourceUrl = tab.url;
    }

    sendResponse(result);
  } catch (err) {
    sendResponse({
      success: false,
      error: `Could not communicate with the page: ${err.message}. Try reloading the Clay page.`,
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Table Metadata
// ═══════════════════════════════════════════════════════════

async function fetchTableMeta(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url?.includes('app.clay.com')) {
      sendResponse({ success: false, error: 'Not on a Clay page' });
      return;
    }

    const tableIdMatch = tab.url.match(/tables\/(t_[^/]+)/);
    if (!tableIdMatch) {
      sendResponse({ success: false, error: 'Could not find table ID in URL' });
      return;
    }
    const tableId = tableIdMatch[1];
    const tableName = (tab.title || '').replace(/\s*\|\s*Clay\s*$/, '').trim();

    console.log(`[Clay Extractor] Using executeScript to fetch sources in page context, tableId=${tableId}`);

    // Execute fetch in the page's MAIN world — identical to running in the browser console
    // Use __clayOriginalFetch to bypass the interceptor's patched fetch
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [tableId],
      func: (tId) => {
        // Use the unpatched fetch stored by our interceptor
        const fetchFn = window.__clayOriginalFetch || window.fetch;
        return fetchFn('https://api.clay.com/v3/sources?tableId=' + tId, { credentials: 'include' })
          .then(function (r) {
            if (!r.ok) return { ok: false, status: r.status };
            return r.json().then(function (data) { return { ok: true, data: data }; });
          })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
    });

    const injResult = injectionResults?.[0]?.result;
    console.log(`[Clay Extractor] executeScript raw result type: ${typeof injResult}`);
    console.log(`[Clay Extractor] executeScript result:`, injResult ? JSON.stringify(injResult).substring(0, 800) : 'null/undefined');

    if (!injResult?.ok) {
      console.log(`[Clay Extractor] Page fetch failed:`, JSON.stringify(injResult));
      sendResponse({ success: true, tableName, sourceName: '', sourceLabel: '', searchFields: {} });
      return;
    }

    const sources = injResult.data;
    if (!Array.isArray(sources) || sources.length === 0) {
      console.log(`[Clay Extractor] No sources returned`);
      sendResponse({ success: true, tableName, sourceName: '', sourceLabel: '', searchFields: {} });
      return;
    }

    const source = sources[0];
    const inputs = source.typeSettings?.inputs || {};
    const sourceName = source.name || source.typeSettings?.name || '';
    const totalRecords = source.state?.numSourceRecords || 0;

    console.log(`[Clay Extractor] Source: "${sourceName}", inputs keys: ${Object.keys(inputs).join(', ')}`);

    const result = buildMetadataResult(tableName, sourceName, totalRecords, inputs);
    capturedData.tableMeta = result;
    sendResponse(result);
  } catch (err) {
    console.error(`[Clay Extractor] fetchTableMeta error:`, err);
    sendResponse({ success: false, error: err.message });
  }
}

function buildMetadataResult(tableName, sourceName, totalRecords, inputs) {
  const searchFields = {};
  const filenameParts = [];
  const countries = { 'United States': 'US', 'United Kingdom': 'UK', 'United Arab Emirates': 'UAE', 'India': 'IN', 'Canada': 'CA', 'Australia': 'AU', 'Germany': 'DE', 'France': 'FR', 'Singapore': 'SG', 'Japan': 'JP', 'China': 'CN', 'Brazil': 'BR', 'Netherlands': 'NL', 'Switzerland': 'CH', 'Israel': 'IL' };

  for (const [key, val] of Object.entries(inputs)) {
    if (val === null || val === undefined || val === '' || val === false) continue;
    if (Array.isArray(val) && val.length === 0) continue;
    if (typeof val === 'number' && val === 0) continue;
    if (/bitmap|method|table_id|record_id|raw_location|past_experiences|exact_match/i.test(key)) continue;
    if (key === 'limit' || key === 'name') continue;

    const readableKey = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    searchFields[readableKey] = Array.isArray(val) ? val.join(', ') : String(val);

    if (Array.isArray(val) && val.length > 0) {
      const abbreviated = val.map(v => {
        if (typeof v !== 'string') return String(v);
        if (countries[v]) return countries[v];
        if (/indian institute of technology/i.test(v)) return 'IIT';
        if (/indian institute of management/i.test(v)) return 'IIM';
        if (key.includes('industr')) {
          return v.replace(/\band\b/gi, '&').replace(/\bServices\b/gi, 'Svc').replace(/\bTechnology\b/gi, 'Tech').replace(/\bManagement\b/gi, 'Mgmt').replace(/\bConsulting\b/gi, 'Consult').replace(/\bEngineering\b/gi, 'Eng').trim();
        }
        return v.substring(0, 25);
      });
      filenameParts.push(abbreviated.join('+'));
    } else if (typeof val === 'number' && val > 0) {
      filenameParts.push(`${key.replace(/_/g, '')}${val}`);
    }
  }

  const sourceLabel = filenameParts.length > 0 ? filenameParts.join('_') : sourceName;

  return {
    success: true,
    tableName,
    sourceName,
    sourceLabel,
    totalRecords,
    searchFields,
    searchParams: inputs,
  };
}

function buildSmartFilename(format, range) {
  const meta = capturedData.tableMeta;
  const parts = [];

  if (meta?.sourceLabel) {
    parts.push(sanitizeFilename(meta.sourceLabel));
  } else if (meta?.tableName) {
    parts.push(sanitizeFilename(meta.tableName));
  } else {
    parts.push('clay-export');
  }

  if (range) parts.push(`rows${range.start}-${range.end}`);

  return parts.join('_') + '.' + format;
}

function sanitizeFilename(str) {
  return str
    .replace(/[<>:"/\\|?*]/g, '') // remove invalid chars
    .replace(/\s+/g, '_')         // spaces to underscores
    .replace(/_+/g, '_')          // collapse multiple underscores
    .replace(/^_|_$/g, '')        // trim underscores
    .substring(0, 80);            // limit length
}

// ═══════════════════════════════════════════════════════════
// CSV / JSON Generation
// ═══════════════════════════════════════════════════════════

function buildSearchMetadata() {
  const meta = capturedData.tableMeta;
  if (!meta) return null;

  const result = {};
  if (meta.tableName) result['Table Name'] = meta.tableName;
  if (meta.sourceName) result['Source'] = meta.sourceName;
  if (meta.totalRecords) result['Total Records'] = meta.totalRecords;

  // Include all search fields the user entered
  if (meta.searchFields) {
    Object.assign(result, meta.searchFields);
  }

  return Object.keys(result).length > 0 ? result : null;
}

function generateCSV(headers, rows) {
  const escape = val => {
    const str = String(val ?? '');
    return '"' + str.replace(/"/g, '""') + '"';
  };

  const lines = [];

  // Add search metadata as comment rows at the top
  const metadata = buildSearchMetadata();
  if (metadata) {
    lines.push('"--- SEARCH PARAMETERS ---"');
    for (const [key, val] of Object.entries(metadata)) {
      lines.push(`${escape(key)},${escape(String(val))}`);
    }
    lines.push('"---"');
    lines.push(''); // blank line separator
  }

  // Header row + data rows
  lines.push(headers.map(escape).join(','));
  for (const row of rows) {
    const paddedRow = headers.map((_, i) => escape(row[i]));
    lines.push(paddedRow.join(','));
  }
  return '\uFEFF' + lines.join('\r\n'); // BOM for Excel UTF-8 compatibility
}

function generateJSON(headers, rows) {
  const records = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? '';
    });
    return obj;
  });

  // Wrap with metadata
  const metadata = buildSearchMetadata();
  if (metadata) {
    return JSON.stringify({
      _searchParameters: metadata,
      data: records,
    }, null, 2);
  }

  return JSON.stringify(records, null, 2);
}

// ═══════════════════════════════════════════════════════════
// File Export
// ═══════════════════════════════════════════════════════════

// Apply row range to rows array. Range is 1-indexed inclusive, or null for all.
function applyRange(rows, range) {
  if (!range) return rows;
  // range.start and range.end are 1-indexed inclusive
  return rows.slice(range.start - 1, range.end);
}

async function exportAsFile(format, range, sendResponse) {
  if (!capturedData.parsedTable) {
    sendResponse({ success: false, error: 'No data captured yet' });
    return;
  }

  const { headers } = capturedData.parsedTable;
  const rows = applyRange(capturedData.parsedTable.rows, range);
  let content, mimeType, extension;

  if (format === 'json') {
    content = generateJSON(headers, rows);
    mimeType = 'application/json';
    extension = 'json';
  } else {
    content = generateCSV(headers, rows);
    mimeType = 'text/csv';
    extension = 'csv';
  }

  const filename = buildSmartFilename(extension, range);

  try {
    // Use data URL approach (works reliably in service workers)
    const base64 = btoa(unescape(encodeURIComponent(content)));
    const dataUrl = `data:${mimeType};base64,${base64}`;

    await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: true,
    });

    sendResponse({ success: true, filename });
  } catch (err) {
    sendResponse({ success: false, error: `Download failed: ${err.message}` });
  }
}

// ═══════════════════════════════════════════════════════════
// Clipboard (via Offscreen Document)
// ═══════════════════════════════════════════════════════════

async function copyToClipboard(format, range, sendResponse) {
  if (!capturedData.parsedTable) {
    sendResponse({ success: false, error: 'No data captured yet' });
    return;
  }

  const { headers } = capturedData.parsedTable;
  const rows = applyRange(capturedData.parsedTable.rows, range);
  const text = format === 'json' ? generateJSON(headers, rows) : generateCSV(headers, rows);

  try {
    // Create offscreen document for clipboard access
    await ensureOffscreenDocument();

    // Use a message channel approach
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Clipboard copy timed out')), 5000);

      const listener = (msg, msgSender, msgSendResponse) => {
        if (msg.action === 'OFFSCREEN_COPY_RESULT') {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          resolve(msg);
        }
      };
      chrome.runtime.onMessage.addListener(listener);

      chrome.runtime.sendMessage({
        action: 'OFFSCREEN_COPY',
        text: text,
      });
    });

    if (response.success) {
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: response.error || 'Clipboard copy failed' });
    }
  } catch (err) {
    sendResponse({ success: false, error: `Clipboard error: ${err.message}` });
  }
}

async function ensureOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Copy exported data to clipboard',
      });
    }
  } catch (err) {
    // If getContexts isn't available, try creating and catch "already exists" error
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Copy exported data to clipboard',
      });
    } catch (createErr) {
      // Document already exists, which is fine
      if (!createErr.message.includes('already exists')) {
        throw createErr;
      }
    }
  }
}

console.log('[Clay Extractor | Background] Service worker loaded');
