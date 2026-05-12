// /api/auth.js
//
// POST /api/auth
// Body: { email, password }
//
// Flow:
//   1. Validate credentials by calling Skipcart's auth2/Admin endpoint
//      (using the server-side apptoken to authorize the login call itself)
//   2. If Skipcart returns Status=true, hand the apptoken back to the browser
//      along with the user's identity info from the login response
//   3. The browser then uses that apptoken to call /api/drivers
//
// Env vars required:
//   SKIPCART_APPTOKEN  — the public app-level UUID (e.g. 72f303a7-...)
//
// Optional:
//   ALLOWED_DOMAINS    — comma-separated email domains to allow
//                        (e.g. "skipcart.com,7-eleven.com"). If unset,
//                        any user that Skipcart authenticates is allowed.

export default async function handler(req, res) {
  // Same-origin only — no CORS headers, no cross-origin POSTs.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const APPTOKEN = process.env.SKIPCART_APPTOKEN;
  if (!APPTOKEN) {
    console.error('SKIPCART_APPTOKEN is not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const email    = (body?.email    || '').trim();
  const password =  body?.password || '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  // Optional email-domain allowlist (defense in depth — Skipcart already gates).
  const allowed = (process.env.ALLOWED_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || !allowed.includes(domain)) {
      // Same error message as bad creds — don't leak whether the domain is gated
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  }

  try {
    const r = await fetch('https://livedashapi.skipcart.com/v1api/auth2/Admin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apptoken':     APPTOKEN,
        'accept':       'application/json, text/plain, */*',
        'origin':       'https://live.skipcart.com',
        'referer':      'https://live.skipcart.com/'
      },
      body: JSON.stringify({ email, password })
    });

    const text = await r.text();

    // Skipcart sometimes returns HTML error pages on failure
    if (text.includes('<html')) {
      return res.status(502).json({ error: 'Auth provider returned an unexpected response' });
    }

    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(502).json({ error: 'Auth provider returned invalid JSON' }); }

    if (r.status !== 200 || data?.Status !== true) {
      // Generic message — don't leak whether email is valid vs password wrong
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const result = data.Result || {};

    // Pluck useful identity fields if Skipcart returns them. Names may vary;
    // we'll surface whatever's there so the UI can show "logged in as X".
    const identity = {
      email:     result.Email     || result.email     || email,
      name:      result.FullName  || result.Name      || result.name      || null,
      userId:    result.UserId    || result.userId    || null,
      userToken: result.UserToken || null,
      userTokenExpires: result.UserTokenExpires || null
    };

    return res.status(200).json({
      token:     APPTOKEN,             // the credential the browser will use for /api/drivers
      email:     identity.email,
      name:      identity.name,
      userId:    identity.userId,
      userToken: identity.userToken,   // kept for future write operations if needed
      userTokenExpires: identity.userTokenExpires
    });
  } catch (err) {
    console.error('Auth proxy error:', err);
    return res.status(502).json({ error: 'Could not reach auth provider' });
  }
}
