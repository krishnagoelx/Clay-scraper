// =============================================================
// interceptor.js — Runs in MAIN world (page's JS context)
// Monkey-patches fetch() and XMLHttpRequest to capture API
// responses containing table/row data from Clay.com
// =============================================================

(function () {
  'use strict';

  const MSG_PREFIX = '__CLAY_EXTRACTOR__';
  // Set to true for verbose logging in the browser console
  const DEBUG = true;

  function log(...args) {
    if (DEBUG) console.log('[Clay Extractor | Interceptor]', ...args);
  }

  // ── Endpoint filtering ──────────────────────────────────────
  // Skip things that are definitely NOT table data
  const SKIP_PATTERNS = [
    /\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|eot|ico|map)(\?|$)/i,
    /google-analytics|segment\.io|segment\.com|sentry\.io|intercom|hotjar|mixpanel|amplitude|knock\.app|knockapp/i,
    /\/auth\b/i,
    /\/login\b/i,
    /\/logout\b/i,
    /\/favicon/i,
    /fonts\./i,
    /cloudflare/i,
    /launchdarkly/i,
    /posthog/i,
  ];

  function shouldCapture(url) {
    if (!url || typeof url !== 'string') return false;
    // Skip known non-data URLs
    if (SKIP_PATTERNS.some(p => p.test(url))) return false;
    // Capture everything else from app.clay.com — we'll filter later
    // This ensures we don't miss Clay's actual data endpoints
    if (url.includes('clay.com') || url.startsWith('/')) return true;
    return false;
  }

  // Check if a response payload looks like it contains table row data
  function containsTableData(data) {
    if (!data || typeof data !== 'object') return false;

    // Look for arrays of objects (rows) anywhere in the response
    const found = findArraysOfObjects(data, 0);
    return found.length > 0;
  }

  function findArraysOfObjects(obj, depth) {
    if (depth > 6) return [];
    const results = [];

    if (Array.isArray(obj)) {
      if (obj.length >= 1 && typeof obj[0] === 'object' && obj[0] !== null && !Array.isArray(obj[0])) {
        const keyCount = Object.keys(obj[0]).length;
        if (keyCount >= 2) {
          results.push({ length: obj.length, keys: keyCount, sample: Object.keys(obj[0]).slice(0, 5) });
        }
      }
      for (const item of obj.slice(0, 3)) {
        if (typeof item === 'object' && item !== null) {
          results.push(...findArraysOfObjects(item, depth + 1));
        }
      }
    } else if (typeof obj === 'object' && obj !== null) {
      for (const key of Object.keys(obj)) {
        results.push(...findArraysOfObjects(obj[key], depth + 1));
      }
    }

    return results;
  }

  // ── Relay captured data to content script ───────────────────
  function relayData(url, method, data, hasTableData) {
    try {
      window.postMessage(
        {
          type: MSG_PREFIX,
          action: 'API_RESPONSE',
          payload: {
            url: url,
            method: method,
            data: data,
            hasTableData: hasTableData,
            timestamp: Date.now(),
          },
        },
        '*'
      );
      log('Relayed API response:', method, url, hasTableData ? '(HAS TABLE DATA)' : '');
    } catch (err) {
      // Payload might be too large for postMessage — try with truncated data
      try {
        const summary = {
          _truncated: true,
          _originalUrl: url,
          _keys: typeof data === 'object' ? Object.keys(data) : [],
        };
        window.postMessage(
          {
            type: MSG_PREFIX,
            action: 'API_RESPONSE',
            payload: { url, method, data: summary, hasTableData: false, timestamp: Date.now() },
          },
          '*'
        );
      } catch (e) {
        log('Failed to relay data:', e.message);
      }
    }
  }

  // ── fetch() override ───────────────────────────────────────
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      let url;
      if (args[0] instanceof Request) {
        url = args[0].url;
      } else {
        url = String(args[0]);
      }

      const method = (args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();

      if (shouldCapture(url)) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('json') || contentType.includes('text/plain') || contentType === '') {
          const clone = response.clone();
          clone.text().then(text => {
            try {
              const data = JSON.parse(text);
              const hasTable = containsTableData(data);
              // Only relay responses that have substantial data or look like table data
              if (hasTable || (typeof data === 'object' && JSON.stringify(data).length > 200)) {
                relayData(url, method, data, hasTable);
              }
            } catch (e) {
              // Not JSON, ignore
            }
          }).catch(() => {});
        }
      }
    } catch (err) {
      log('Error in fetch interceptor:', err.message);
    }

    return response;
  };

  // ── XMLHttpRequest override ────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  const originalOpen = OrigXHR.prototype.open;
  const originalSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method, url, ...rest) {
    this.__clay_url = url;
    this.__clay_method = method;
    return originalOpen.call(this, method, url, ...rest);
  };

  OrigXHR.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        if (shouldCapture(this.__clay_url)) {
          const contentType = this.getResponseHeader('content-type') || '';
          if (contentType.includes('json') || contentType.includes('text/plain') || contentType === '') {
            const data = JSON.parse(this.responseText);
            const hasTable = containsTableData(data);
            if (hasTable || (typeof data === 'object' && JSON.stringify(data).length > 200)) {
              relayData(this.__clay_url, this.__clay_method || 'GET', data, hasTable);
            }
          }
        }
      } catch (err) {
        // silently ignore
      }
    });
    return originalSend.apply(this, args);
  };

  // ── Listen for commands from content script ────────────────
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.data?.type !== MSG_PREFIX) return;

    if (event.data.action === 'TRIGGER_RELOAD') {
      log('Reload triggered — scrolling to force re-fetch');
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    }
  });

  // Signal that interceptor is ready
  window.postMessage(
    { type: MSG_PREFIX, action: 'INTERCEPTOR_READY', payload: { timestamp: Date.now() } },
    '*'
  );

  log('Interceptor installed — capturing API responses from Clay');
})();
