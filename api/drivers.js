// /api/drivers.js
//
// GET /api/drivers?regionId=58
// Required header: X-Apptoken: <the apptoken handed back by /api/auth>
//
// We don't trust the browser-supplied token blindly — we check it matches
// the server-side SKIPCART_APPTOKEN. The /api/auth endpoint is the only
// thing that hands that token out, and only after Skipcart validates the
// user's credentials. So a valid X-Apptoken header means the bearer
// authenticated as a Skipcart user at some point in this session.

export const config = {
  // Edge runtime is fine here — we're just proxying. Faster cold starts,
  // lower latency, and Vercel caches the response naturally.
  runtime: 'nodejs'
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const APPTOKEN = process.env.SKIPCART_APPTOKEN;
  if (!APPTOKEN) {
    console.error('SKIPCART_APPTOKEN is not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Token check — constant-time-ish comparison
  const supplied = req.headers['x-apptoken'] || req.headers['X-Apptoken'];
  if (!supplied || !safeEqual(String(supplied), APPTOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse + validate regionId
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
      return res.status(r.status).json({ error: 'Upstream error', status: r.status });
    }

    // 30-second edge cache — driver locations are real-time-ish but
    // the dashboard polls maybe every 30-60s anyway.
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(text);
  } catch (err) {
    console.error('Driver proxy error:', err);
    return res.status(502).json({ error: 'Could not reach driver API' });
  }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
