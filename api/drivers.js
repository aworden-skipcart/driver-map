// /api/drivers.js
//
// GET /api/drivers?regionId=58
// Required header: X-Usertoken: <JWT from /api/auth>
//
// Skipcart's dash-api requires BOTH:
//   - AppToken  : the static app-level UUID (server-side env var)
//   - UserToken : the per-user JWT minted by auth2/Admin (passed by browser)
//
// So each user is authenticated as themselves on every upstream call —
// no shared session, audit trails preserve their identity.

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

  const rawUser =
       req.headers['x-usertoken']
    || req.headers['X-Usertoken']
    || req.headers['x-user-token']
    || '';
  const userToken = String(rawUser).trim();

  if (!userToken) {
    console.log('[drivers] missing user token', {
      headerKeys: Object.keys(req.headers).filter(k =>
        k.toLowerCase().includes('token') || k.toLowerCase().includes('auth'))
    });
    return res.status(401).json({ error: 'Unauthorized', reason: 'no_user_token' });
  }

  // Sanity-check that it looks like a JWT (3 base64url segments).
  // Don't validate the signature — Skipcart will do that.
  const jwtShape = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  if (!jwtShape.test(userToken)) {
    console.log('[drivers] user token failed shape check', { len: userToken.length });
    return res.status(401).json({ error: 'Unauthorized', reason: 'bad_token_shape' });
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
        'Apptoken':  APPTOKEN,
        'UserToken': userToken,
        'Accept':    'application/json',
        'Origin':    'https://live.skipcart.com',
        'Referer':   'https://live.skipcart.com/'
      }
    });

    const text = await r.text();

    if (!r.ok) {
      console.error('[drivers] upstream error', r.status, text.slice(0, 200));
      // Pass through 401s so the browser knows to log out and re-auth
      return res.status(r.status).json({
        error: 'Upstream error',
        status: r.status,
        upstream: tryParse(text)
      });
    }

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(text);
  } catch (err) {
    console.error('[drivers] proxy error:', err);
    return res.status(502).json({ error: 'Could not reach driver API' });
  }
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s.slice(0, 200); }
}
