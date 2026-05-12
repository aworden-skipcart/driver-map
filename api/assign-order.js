// /api/assign-order.js
//
// POST /api/assign-order
// Required header: X-Usertoken: <JWT from /api/auth>
// Body: { jobId, driverId, orderId }
//
// Sends the delivery confirmation/offer to a selected driver. This mirrors the
// HAR endpoint: /v2api/driver/SendDeliveryConfirmation/{JobId}/{DriverId}/{OrderId}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const APPTOKEN = (process.env.SKIPCART_APPTOKEN || '').trim();
  if (!APPTOKEN) {
    console.error('[assign-order] SKIPCART_APPTOKEN is not set');
    return res.status(500).json({ error: 'Server misconfigured', reason: 'apptoken_missing' });
  }

  const userToken = String(
       req.headers['x-usertoken']
    || req.headers['X-Usertoken']
    || req.headers['x-user-token']
    || ''
  ).trim();
  if (!userToken) return res.status(401).json({ error: 'Unauthorized', reason: 'no_user_token' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const jobId = cleanInt(body?.jobId);
  const driverId = cleanInt(body?.driverId);
  const orderId = cleanInt(body?.orderId);
  if (!jobId || !driverId || !orderId) {
    return res.status(400).json({ error: 'jobId, driverId, and orderId are required' });
  }

  const target = `https://live.skipcart.com/dash-api/v2api/driver/SendDeliveryConfirmation/${jobId}/${driverId}/${orderId}`;

  try {
    const r = await fetch(target, {
      method: 'GET',
      headers: {
        'AppToken': APPTOKEN,
        'UserToken': userToken,
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'Origin': 'https://live.skipcart.com',
        'Referer': 'https://live.skipcart.com/'
      }
    });

    const text = await r.text();
    let json;
    try { json = JSON.parse(text); }
    catch { json = { raw: text.slice(0, 500) }; }

    if (!r.ok) return res.status(r.status).json({ error: 'Upstream error', upstream: json });

    // Skipcart often returns HTTP 200 with status/status_code carrying the true outcome.
    const ok = json?.status === true || json?.Status === true || json?.result === true || json?.Result === true;
    return res.status(ok ? 200 : 400).json(json);
  } catch (err) {
    console.error('[assign-order] proxy error:', err);
    return res.status(502).json({ error: 'Could not reach assignment API' });
  }
}

function cleanInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
