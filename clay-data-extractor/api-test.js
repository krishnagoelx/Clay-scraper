// ============================================================
// Paste this into the browser console on a Clay table page
// to discover available API endpoints and their responses.
// ============================================================

(async function testClayAPIs() {
  const url = window.location.href;
  const tableIdMatch = url.match(/tables\/(t_[^/]+)/);
  if (!tableIdMatch) {
    console.error('Not on a Clay table page. Navigate to a table first.');
    return;
  }
  const tableId = tableIdMatch[1];
  console.log(`%c=== Clay API Test for tableId: ${tableId} ===`, 'font-size:16px;font-weight:bold;color:#2196F3');

  const fetchFn = window.__clayOriginalFetch || window.fetch;

  const endpoints = [
    // Sources endpoints
    { label: 'GET /v3/sources?tableId=', url: `https://api.clay.com/v3/sources?tableId=${tableId}` },
    { label: 'GET /v3/sources (no param)', url: `https://api.clay.com/v3/sources` },

    // Table endpoints
    { label: 'GET /v3/tables/{id}', url: `https://api.clay.com/v3/tables/${tableId}` },
    { label: 'GET /v3/tables/{id}/rows', url: `https://api.clay.com/v3/tables/${tableId}/rows` },
    { label: 'GET /v3/tables/{id}/columns', url: `https://api.clay.com/v3/tables/${tableId}/columns` },
    { label: 'GET /v3/tables/{id}/sources', url: `https://api.clay.com/v3/tables/${tableId}/sources` },
    { label: 'GET /v3/tables/{id}/metadata', url: `https://api.clay.com/v3/tables/${tableId}/metadata` },

    // Workbook / workspace endpoints (common in SaaS apps)
    { label: 'GET /v3/workbooks', url: `https://api.clay.com/v3/workbooks` },
    { label: 'GET /v3/workspace', url: `https://api.clay.com/v3/workspace` },

    // API v1/v2 variants
    { label: 'GET /v1/sources?tableId=', url: `https://api.clay.com/v1/sources?tableId=${tableId}` },
    { label: 'GET /v2/sources?tableId=', url: `https://api.clay.com/v2/sources?tableId=${tableId}` },
    { label: 'GET /v1/tables/{id}', url: `https://api.clay.com/v1/tables/${tableId}` },
    { label: 'GET /v2/tables/{id}', url: `https://api.clay.com/v2/tables/${tableId}` },

    // GraphQL (Clay may use it)
    { label: 'GET /graphql', url: `https://api.clay.com/graphql` },
    { label: 'GET /api/graphql', url: `https://app.clay.com/api/graphql` },
  ];

  const results = [];

  for (const ep of endpoints) {
    try {
      const res = await fetchFn(ep.url, { credentials: 'include' });
      let body = null;
      let bodyPreview = '';
      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('json') || contentType.includes('text')) {
        const text = await res.text();
        bodyPreview = text.substring(0, 500);
        try { body = JSON.parse(text); } catch(e) { body = text; }
      }

      const result = {
        endpoint: ep.label,
        status: res.status,
        statusText: res.statusText,
        contentType,
        bodyPreview,
        bodyKeys: body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : (Array.isArray(body) ? `Array[${body.length}]` : typeof body),
      };
      results.push(result);

      const color = res.ok ? 'color:green' : 'color:red';
      console.log(`%c${res.status} ${ep.label}`, color);
      if (res.ok && body) {
        console.log('  Keys/Type:', result.bodyKeys);
        console.log('  Preview:', bodyPreview.substring(0, 300));
      }
    } catch (err) {
      results.push({ endpoint: ep.label, status: 'ERROR', error: err.message });
      console.log(`%cERROR ${ep.label}: ${err.message}`, 'color:orange');
    }
  }

  // Also try a GraphQL introspection query
  console.log(`%c\n=== GraphQL Introspection Test ===`, 'font-size:14px;font-weight:bold;color:#FF9800');
  for (const gqlUrl of ['https://api.clay.com/graphql', 'https://app.clay.com/api/graphql']) {
    try {
      const res = await fetchFn(gqlUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ __schema { queryType { name } mutationType { name } } }' }),
      });
      const text = await res.text();
      console.log(`%c${res.status} POST ${gqlUrl}`, res.ok ? 'color:green' : 'color:red');
      console.log('  Response:', text.substring(0, 500));
      results.push({ endpoint: `POST ${gqlUrl}`, status: res.status, bodyPreview: text.substring(0, 500) });
    } catch (err) {
      console.log(`%cERROR POST ${gqlUrl}: ${err.message}`, 'color:orange');
    }
  }

  // Check what API calls Clay made on page load (from interceptor)
  console.log(`%c\n=== Intercepted API URLs (from page load) ===`, 'font-size:14px;font-weight:bold;color:#9C27B0');
  // Try to get this from the extension's captured data
  // These would show in the service worker logs already, but let's also check network entries
  if (window.performance && window.performance.getEntriesByType) {
    const resources = window.performance.getEntriesByType('resource');
    const clayApis = resources
      .filter(r => r.name.includes('clay.com') && (r.name.includes('/v') || r.name.includes('/api') || r.name.includes('graphql')))
      .map(r => ({ url: r.name, type: r.initiatorType, duration: Math.round(r.duration) + 'ms' }));

    if (clayApis.length > 0) {
      console.table(clayApis);
      results.push({ endpoint: '--- Intercepted URLs ---', urls: clayApis });
    } else {
      console.log('No Clay API entries found in performance timeline (may have been cleared)');
    }
  }

  console.log(`%c\n=== Summary Table ===`, 'font-size:14px;font-weight:bold;color:#4CAF50');
  console.table(results.map(r => ({
    Endpoint: r.endpoint,
    Status: r.status,
    Keys: r.bodyKeys || '',
    Preview: (r.bodyPreview || '').substring(0, 100),
  })));

  // Return results so they can be inspected
  return results;
})();
