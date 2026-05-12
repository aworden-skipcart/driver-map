// /api/drivers.js
//
// GET /api/drivers?regionId=58
// Required header: X-Apptoken: <the apptoken handed back by /api/auth>

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const APPTOKEN = (process.env.SKIPCART_APPTOKEN || '').trim();
  if (!APPTOKEN) {
    console.error('[drivers] SKIPCART_APPTOKEN is not set');
    return res.status(500).json({ error: 'Server misconfigured', reason: 'apptoken_missing' });
  }

  // Node lowercases incoming header names, but be defensive.
  const raw =
       req.headers['x-apptoken']
    || req.headers['X-Apptoken']
    || '';
  const supplied = String(raw).trim();

  // Diagnostic logging — visible in Vercel function logs
  console.log('[drivers] received request', {
    hasHeader: !!supplied,
    suppliedLen: supplied.length,
    expectedLen: APPTOKEN.length,
    suppliedPrefix: supplied.slice(0, 8),
    expectedPrefix: APPTOKEN.slice(0, 8),
    match: supplied === APPTOKEN,
    headerKeys: Object.keys(req.headers).filter(k =>
      k.toLowerCase().includes('apptoken') || k.toLowerCase().includes('auth'))
  });

  if (!supplied || !safeEqual(supplied, APPTOKEN)) {
    return res.status(401).json({
      error: 'Unauthorized',
      debug: {
        suppliedLen: supplied.length,
        expectedLen: APPTOKEN.length,
        hasHeader: !!supplied,
        match: supplied === APPTOKEN
      }
    });
  }

  const regionId = req.query?.regionId;
  let target = 'https://live.skipcart.com/dash-api/v2api/Driver/GetDriverLocationGeoJson';
  if (regionId !== undefined && regionId !== '') {
    const n = Number(regionId);
    if (!Number.isInteger(n) || n < 0 || n > 9999) {
      return res.status(400).json({ error: 'Invalid regionId' });
    }
    target += '?regionId=' + n;
  }

  try {
    const r = await fetch(target, {
      headers: {
        'Apptoken': APPTOKEN,
        'Accept':   'application/json',
        'Origin':   'https://live.skipcart.com',
        'Referer':  'https://live.skipcart.com/'
      }
    });

    const text = await r.text();

    if (!r.ok) {
      console.error('[drivers] upstream error', r.status, text.slice(0, 200));
      return res.status(r.status).json({ error: 'Upstream error', status: r.status });
    }

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(text);
  } catch (err) {
    console.error('[drivers] proxy error:', err);
    return res.status(502).json({ error: 'Could not reach driver API' });
  }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
