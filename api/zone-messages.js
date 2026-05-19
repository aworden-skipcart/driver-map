// /api/zone-messages.js
const MESSAGE_TEXT = 'Catering orders with high $$$ are waiting in your area! Go online now and check the Skipcart app before they’re accepted by another driver.';
const MESSAGE_B64 = Buffer.from(MESSAGE_TEXT, 'utf8').toString('base64');
const REGION_IDS = [54, 55, 56, 57, 58, 59, 60, 61, 62];

export default async function handler(req, res) {
  const APPTOKEN = (process.env.SKIPCART_APPTOKEN || '').trim();
  if (!APPTOKEN) return res.status(500).json({ error: 'Server misconfigured', reason: 'apptoken_missing' });
  const userToken = String(req.headers['x-usertoken'] || req.headers['X-Usertoken'] || req.headers['x-user-token'] || '').trim();
  if (!userToken) return res.status(401).json({ error: 'Unauthorized', reason: 'no_user_token' });
  try {
    if (req.method === 'GET') return handleGet(req, res, APPTOKEN, userToken);
    if (req.method === 'POST') return handlePost(req, res, APPTOKEN, userToken);
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message || 'Bad request' });
    console.error('[zone-messages] proxy error:', err);
    return res.status(err?.status || 502).json({ error: err.message || 'Could not reach zone message API' });
  }
}

async function handleGet(req, res, appToken, userToken) {
  const action = String(req.query?.action || '').toLowerCase();
  if (action === 'areas') {
    const regionId = asSafeInt(req.query?.regionId, 'regionId', 1, 9999);
    const upstream = await upstreamFetch(`https://live.skipcart.com/dash-api/v1api/region/areas/${regionId}`, { method: 'GET', appToken, userToken });
    const data = parseMaybeJson(upstream.text);
    const areas = Array.isArray(data?.Result) ? data.Result : Array.isArray(data) ? data : [];
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return res.status(200).json({ status: true, action, regionId, areas });
  }
  if (action === 'zones') {
    const areaId = asSafeInt(req.query?.areaId, 'areaId', 1, 999999);
    const upstream = await upstreamFetch(`https://live.skipcart.com/dash-api/v1api/Area/Zones/GetZonesByAreas/${areaId}`, { method: 'GET', appToken, userToken });
    const data = parseMaybeJson(upstream.text);
    const zones = Array.isArray(data?.Result) ? data.Result : Array.isArray(data) ? data : [];
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return res.status(200).json({ status: true, action, areaId, zones });
  }
  if (action === 'resolve-zone') {
    const areaId = asSafeInt(req.query?.areaId, 'areaId', 1, 999999);
    const zoneId = asSafeInt(req.query?.zoneId, 'zoneId', 1, 999999);
    const areaName = String(req.query?.areaName || '').trim();
    const zoneName = String(req.query?.zoneName || '').trim();
    const resolved = await resolveRegionAreaZone({ appToken, userToken, areaId, zoneId, areaName, zoneName });
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return res.status(200).json({ status: true, action, ...resolved });
  }
  return res.status(400).json({ error: 'Invalid action' });
}

async function handlePost(req, res, appToken, userToken) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const regionId = asSafeInt(body?.regionId, 'regionId', 1, 9999);
  const areaId = asSafeInt(body?.areaId, 'areaId', 1, 999999);
  const zoneId = asSafeInt(body?.zoneId, 'zoneId', 1, 999999);
  const sentBy = String(body?.sentBy || 'Driver Map').trim().slice(0, 100) || 'Driver Map';
  const baseFilters = { drivername: null, status: null, area: String(areaId), zone: String(zoneId), countrycode: 'US', region: String(regionId), driverstatus: 'active', isCateringDriver: true, IsBusyDriver: false, cohortType: '' };
  const smsPayload = { filters: { ...baseFilters, zip: null }, smsDescription: '', smsText: MESSAGE_B64, type: 'sms', sentBy };
  const notificationPayload = { filters: baseFilters, smsDescription: '', smsText: MESSAGE_B64, type: 'notification', sentBy };
  const sms = await upstreamFetch('https://live.skipcart.com/dash-api/v1api/BulkSMS/SearchSendMessageToDriver/sms', { method: 'POST', appToken, userToken, body: JSON.stringify(smsPayload) });
  const notification = await upstreamFetch('https://live.skipcart.com/dash-api/v1api/BulkSMS/SearchSendMessageToDriver/notification', { method: 'POST', appToken, userToken, body: JSON.stringify(notificationPayload) });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ status: true, messageText: MESSAGE_TEXT, filters: { regionId, areaId, zoneId }, results: { sms: summarizeSendResult(sms), notification: summarizeSendResult(notification) } });
}


async function resolveRegionAreaZone({ appToken, userToken, areaId, zoneId, areaName, zoneName }) {
  let matchedRegionId = null;
  let matchedArea = null;
  for (const regionId of REGION_IDS) {
    const upstream = await upstreamFetch(`https://live.skipcart.com/dash-api/v1api/region/areas/${regionId}`, { method: 'GET', appToken, userToken });
    const data = parseMaybeJson(upstream.text);
    const areas = Array.isArray(data?.Result) ? data.Result : Array.isArray(data) ? data : [];
    matchedArea = areas.find(a => Number(a?.AreaId ?? a?.AreaID ?? a?.Id) === Number(areaId))
      || (areaName ? areas.find(a => normalizeName(a?.AreaName || a?.Name) === normalizeName(areaName)) : null);
    if (matchedArea) { matchedRegionId = regionId; break; }
  }
  if (!matchedRegionId) {
    const err = new Error('Could not map that area to a Skipcart region.');
    err.status = 400;
    throw err;
  }
  let matchedZone = null;
  try {
    const zoneUpstream = await upstreamFetch(`https://live.skipcart.com/dash-api/v1api/Area/Zones/GetZonesByAreas/${areaId}`, { method: 'GET', appToken, userToken });
    const zoneData = parseMaybeJson(zoneUpstream.text);
    const zones = Array.isArray(zoneData?.Result) ? zoneData.Result : Array.isArray(zoneData) ? zoneData : [];
    matchedZone = zones.find(z => Number(z?.ZoneId ?? z?.ZoneID ?? z?.Id) === Number(zoneId))
      || (zoneName ? zones.find(z => normalizeName(z?.ZoneName || z?.Name) === normalizeName(zoneName)) : null);
  } catch { matchedZone = null; }
  return {
    regionId: matchedRegionId,
    areaId: Number(matchedArea?.AreaId ?? matchedArea?.AreaID ?? areaId),
    areaName: String(matchedArea?.AreaName || matchedArea?.Name || areaName || areaId),
    zoneId: Number(matchedZone?.ZoneId ?? matchedZone?.ZoneID ?? zoneId),
    zoneName: String(matchedZone?.ZoneName || matchedZone?.Name || zoneName || zoneId)
  };
}
function normalizeName(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }

async function upstreamFetch(url, { method, appToken, userToken, body }) {
  const r = await fetch(url, { method, headers: { 'Apptoken': appToken, 'UserToken': userToken, 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'Origin': 'https://live.skipcart.com', 'Referer': 'https://live.skipcart.com/' }, body });
  const text = await r.text();
  if (!r.ok) { const err = new Error('Upstream error'); err.status = r.status; err.text = text.slice(0, 250); throw err; }
  return { status: r.status, text };
}
function summarizeSendResult(result) { const text = String(result?.text || '').trim(); return { status: result?.status || 0, ok: !/record not found/i.test(text), response: parseMaybeJson(text) || text.slice(0, 500) }; }
function parseMaybeJson(text) { if (!text) return null; try { return JSON.parse(text); } catch { return null; } }
function asSafeInt(value, label, min, max) { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) { const err = new Error(`Invalid ${label}`); err.status = 400; throw err; } return n; }
