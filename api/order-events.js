// /api/order-events.js
// GET /api/order-events?orderIds=123,456
// GET /api/order-events?orderId=123&details=1
// Required header: X-Usertoken: <JWT from /api/auth>
// Checks Skipcart order events for pickup_delay alerts and can return normalized event details/trails.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const APPTOKEN = (process.env.SKIPCART_APPTOKEN || '').trim();
  if (!APPTOKEN) return res.status(500).json({ error: 'Server misconfigured', reason: 'apptoken_missing' });

  const userToken = String(
       req.headers['x-usertoken']
    || req.headers['X-Usertoken']
    || req.headers['x-user-token']
    || ''
  ).trim();
  if (!userToken) return res.status(401).json({ error: 'Unauthorized', reason: 'no_user_token' });

  const detailsMode = truthy(req.query?.details) || String(req.query?.mode || '').toLowerCase() === 'details';
  const singleOrderId = String(req.query?.orderId || '').trim();
  const orderIds = String(req.query?.orderIds || singleOrderId || '')
    .split(',')
    .map(v => v.trim())
    .filter(v => /^\d+$/.test(v))
    .slice(0, detailsMode ? 10 : 60);

  if (!orderIds.length) {
    return res.status(400).json({ error: detailsMode ? 'orderId is required' : 'orderIds is required' });
  }

  try {
    const results = await mapLimit(orderIds, detailsMode ? 3 : 6, async orderId => {
      try {
        const rawEvents = await fetchOrderEvents(orderId, APPTOKEN, userToken);
        const events = rawEvents.map(e => normalizeEvent(e, orderId));
        const alert = findPickupDelayAlert(rawEvents, orderId);
        return { orderId, alert, events: detailsMode ? events : undefined, checked: true };
      } catch (err) {
        return { orderId, checked: false, error: err.message || 'event lookup failed', events: detailsMode ? [] : undefined };
      }
    });

    const alerts = results.map(r => r.alert).filter(Boolean);
    res.setHeader('Cache-Control', 'no-store');
    if (detailsMode && orderIds.length === 1) {
      const first = results[0] || { orderId: orderIds[0], events: [], checked: false };
      return res.status(200).json({ status: true, orderId: first.orderId, events: first.events || [], alert: first.alert || null, checked: !!first.checked, error: first.error || null });
    }
    return res.status(200).json({ status: true, checked: results.length, alerts, results });
  } catch (err) {
    console.error('[order-events] proxy error:', err);
    return res.status(err.status || 502).json({ error: err.message || 'Could not load order events', upstream: err.upstream || null });
  }
}

async function fetchOrderEvents(orderId, appToken, userToken) {
  const json = await upstreamJson(`https://live.skipcart.com/dash-api/v1api/Event/GetOrderEvent/${encodeURIComponent(orderId)}`, {
    method: 'GET',
    headers: makeHeaders(appToken, userToken, false)
  });
  const result = json?.Result || json?.result || [];
  return Array.isArray(result) ? result : [];
}


function normalizeEvent(e, fallbackOrderId) {
  const eventDateTime = e.eventdatetime || e.EventDateTime || e.updatedon || e.UpdatedOn || null;
  return {
    eventId: String(e.eventid || e.EventId || ''),
    eventName: String(e.eventname || e.EventName || ''),
    eventDateTime,
    updatedOn: e.updatedon || e.UpdatedOn || null,
    jobId: String(e.jobid || e.JobId || ''),
    driverId: String(e.driverid || e.DriverId || ''),
    driverName: String(e.drivername || e.DriverName || ''),
    orderId: String(e.orderid || e.OrderId || fallbackOrderId || ''),
    exceptionalEvent: e.exceptionalevent || e.ExceptionalEvent || null,
    latitude: toNumberOrNull(e.latitude || e.Latitude),
    longitude: toNumberOrNull(e.longitude || e.Longitude),
    eta: e.Eta || e.ETA || e.eta || null,
    duration: e.duration || e.Duration || '',
    webhookStatus: e.webhookstatus ?? e.WebhookStatus ?? null,
    webhookDate: e.webhookdate || e.WebhookDate || null
  };
}

function truthy(value) {
  return /^(1|true|yes|y)$/i.test(String(value || '').trim());
}

function findPickupDelayAlert(events, fallbackOrderId) {
  const matches = events.filter(e => {
    const eventName = String(e.eventname || e.EventName || '').trim().toLowerCase();
    const exceptional = String(e.exceptionalevent || e.ExceptionalEvent || '').trim();
    return eventName === 'pickup_delay' && /order\s+is\s+still\s+being\s+prepared/i.test(exceptional);
  });
  if (!matches.length) return null;

  matches.sort((a, b) => Date.parse(b.eventdatetime || b.EventDateTime || b.updatedon || 0) - Date.parse(a.eventdatetime || a.EventDateTime || a.updatedon || 0));
  const e = matches[0];
  return {
    orderId: String(e.orderid || e.OrderId || fallbackOrderId || ''),
    jobId: String(e.jobid || e.JobId || ''),
    driverId: String(e.driverid || e.DriverId || ''),
    driverName: String(e.drivername || e.DriverName || ''),
    eventId: String(e.eventid || e.EventId || ''),
    eventName: String(e.eventname || e.EventName || 'pickup_delay'),
    exceptionalEvent: String(e.exceptionalevent || e.ExceptionalEvent || 'Order is still being prepared'),
    message: String(e.exceptionalevent || e.ExceptionalEvent || 'Order is still being prepared'),
    eventDateTime: e.eventdatetime || e.EventDateTime || e.updatedon || e.UpdatedOn || null,
    latitude: toNumberOrNull(e.latitude || e.Latitude),
    longitude: toNumberOrNull(e.longitude || e.Longitude)
  };
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function makeHeaders(appToken, userToken, isJson) {
  const headers = {
    'AppToken': appToken,
    'UserToken': userToken,
    'Accept': 'application/json',
    'Origin': 'https://live.skipcart.com',
    'Referer': 'https://live.skipcart.com/'
  };
  if (isJson) headers['Content-Type'] = 'application/json';
  return headers;
}

async function upstreamJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); }
  catch { json = { raw: text.slice(0, 500) }; }
  if (!r.ok) {
    const err = new Error('Upstream error (' + r.status + ')');
    err.status = r.status;
    err.upstream = json;
    throw err;
  }
  return json;
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const current = idx++;
      out[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}
