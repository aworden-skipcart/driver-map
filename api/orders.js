// /api/orders.js
//
// GET /api/orders?hours=12&regionId=58
// Required header: X-Usertoken: <JWT from /api/auth>
//
// Pulls ezCater New orders for assignment plus Scheduled ezCater orders for
// driver-conflict detection. New orders are mapped in the Orders panel. Scheduled
// orders are returned separately so the browser can show which Catering drivers
// are already committed and hide them during assign mode.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const APPTOKEN = (process.env.SKIPCART_APPTOKEN || '').trim();
  if (!APPTOKEN) {
    console.error('[orders] SKIPCART_APPTOKEN is not set');
    return res.status(500).json({ error: 'Server misconfigured', reason: 'apptoken_missing' });
  }

  const userToken = String(
       req.headers['x-usertoken']
    || req.headers['X-Usertoken']
    || req.headers['x-user-token']
    || ''
  ).trim();

  if (!userToken) {
    return res.status(401).json({ error: 'Unauthorized', reason: 'no_user_token' });
  }

  const hoursRaw = Number(req.query?.hours || 12);
  const hours = [12, 24].includes(hoursRaw) ? hoursRaw : 12;

  const regionIdRaw = req.query?.regionId;
  const regionId = regionIdRaw !== undefined && regionIdRaw !== '' ? Number(regionIdRaw) : null;
  if (regionId !== null && (!Number.isInteger(regionId) || regionId < 0 || regionId > 9999)) {
    return res.status(400).json({ error: 'Invalid regionId' });
  }

  const now = new Date();
  const end = new Date(now.getTime() + hours * 60 * 60 * 1000);
  // Pull a small buffer beyond the visible order window so conflict detection can
  // catch scheduled drivers up to 1 hour after the selected order's window end.
  const scheduledEnd = new Date(end.getTime() + 2 * 60 * 60 * 1000);
  const windowStartMs = now.getTime();
  const windowEndMs = end.getTime();
  const scheduledEndMs = scheduledEnd.getTime();
  const pageSize = 75;
  const maxPages = 8; // hard cap safety; 600 rows per status before enrichment

  try {
    const requestedRegionName = REGION_NAMES[String(regionId)] || '';

    const newRaw = await fetchOrdersByStatus({ statusName: 'New', start: now, end, pageSize, maxPages, appToken: APPTOKEN, userToken });
    let scheduledRaw = await fetchOrdersByStatus({ statusName: 'Scheduled', start: now, end: scheduledEnd, pageSize, maxPages, appToken: APPTOKEN, userToken });

    // Some Skipcart views expose scheduled rows even when orderstatus is blank
    // but do not always honor a Scheduled status filter consistently. Fallback
    // to an unfiltered status search and keep only scheduled rows by response data.
    if (!scheduledRaw.length) {
      const unfiltered = await fetchOrdersByStatus({ statusName: null, start: now, end: scheduledEnd, pageSize, maxPages, appToken: APPTOKEN, userToken });
      scheduledRaw = unfiltered.filter(o => /scheduled/i.test(String(o.OrderStatus || o.orderStatus || '')));
    }

    const newRegionFiltered = requestedRegionName
      ? newRaw.filter(o => String(o.RegionName || '').toLowerCase() === requestedRegionName.toLowerCase())
      : newRaw;
    const scheduledRegionFiltered = requestedRegionName
      ? scheduledRaw.filter(o => String(o.RegionName || '').toLowerCase() === requestedRegionName.toLowerCase())
      : scheduledRaw;

    // Hard rolling-window filter. This prevents the Orders/search endpoint from
    // returning tomorrow/end-of-day records outside the selected 12/24h window.
    const newWindowFiltered = newRegionFiltered.filter(order => isOrderStartInsideWindow(order, windowStartMs, windowEndMs));
    const scheduledWindowFiltered = scheduledRegionFiltered.filter(order => orderOverlapsWindow(order, windowStartMs, scheduledEndMs));

    const [newEnriched, scheduledEnriched] = await Promise.all([
      enrichOrders(newWindowFiltered, APPTOKEN, userToken),
      enrichOrders(scheduledWindowFiltered, APPTOKEN, userToken)
    ]);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      status: true,
      hours,
      totalFound: newRaw.length,
      scheduledTotalFound: scheduledRaw.length,
      totalAfterRegionFilter: newRegionFiltered.length,
      scheduledAfterRegionFilter: scheduledRegionFiltered.length,
      totalInsideWindow: newWindowFiltered.length,
      scheduledInsideWindow: scheduledWindowFiltered.length,
      windowStart: now.toISOString(),
      windowEnd: end.toISOString(),
      scheduledWindowEnd: scheduledEnd.toISOString(),
      orders: newEnriched,
      scheduledOrders: scheduledEnriched
    });
  } catch (err) {
    console.error('[orders] proxy error:', err);
    return res.status(err.status || 502).json({ error: err.message || 'Could not reach orders API', upstream: err.upstream || null });
  }
}

async function fetchOrdersByStatus({ statusName, start, end, pageSize, maxPages, appToken, userToken }) {
  const baseFilters = {
    customers: [],
    orderstatus: statusName ? [{ name: statusName }] : [],
    orders: [],
    partners: [{ partnerId: 'EZCater' }],
    drivers: [],
    lastEvents: [],
    deliverywindowrange: {
      delwindowStartAt: start.toISOString(),
      delwindowEndAt: end.toISOString()
    },
    jobs: [],
    areas: [],
    stores: [],
    brandname: [],
    externalorderids: [],
    regions: [],
    partnercountry: [],
    activeproblemdeliveries: [],
    aggorderids: [],
    carriers: [],
    controlledContents: '',
    zoneIds: [],
    zipcode: [],
    latePickupInMinute: '',
    excludePartners: [{ partnerId: 'Daas' }]
  };

  const allOrders = [];
  const seen = new Set();
  let totalCount = null;

  for (let pageindex = 1; pageindex <= maxPages; pageindex++) {
    const body = {
      filters: baseFilters,
      pageindex,
      pagesize: String(pageSize),
      sortColumn: 'DelWindowStart',
      sortDirection: 'asc'
    };

    const searchJson = await upstreamJson('https://live.skipcart.com/dash-api/v2api/Orders/search', {
      method: 'POST',
      headers: makeHeaders(appToken, userToken, true),
      body: JSON.stringify(body)
    });

    const result = searchJson?.Result || searchJson?.result || {};
    const rows = result.OrderData || result.orderData || [];
    totalCount = result.TotalCount ?? result.totalCount ?? totalCount;

    for (const row of rows) {
      const key = String(row.OrderId || row.orderId || row.JobId || row.jobId || JSON.stringify(row).slice(0, 80));
      if (seen.has(key)) continue;
      seen.add(key);
      allOrders.push(row);
    }

    if (!rows.length || rows.length < pageSize) break;
    if (totalCount !== null && allOrders.length >= totalCount) break;
  }

  return allOrders;
}

async function enrichOrders(orders, appToken, userToken) {
  return mapLimit(orders, 6, async (order) => {
    const jobId = order.JobId || order.jobId;
    if (!jobId) return normalizeOrder(order, null);
    try {
      const stepsJson = await upstreamJson(`https://live.skipcart.com/dash-api/v2api/steps/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: makeHeaders(appToken, userToken, false)
      });
      return normalizeOrder(order, stepsJson?.Result || stepsJson?.result || null);
    } catch (err) {
      console.error('[orders] steps enrichment failed', jobId, err.message);
      return normalizeOrder(order, null, err.message);
    }
  });
}

function isOrderStartInsideWindow(order, startMs, endMs) {
  const orderMs = getOrderWindowStartMs(order);
  if (!Number.isFinite(orderMs)) return false;
  return orderMs >= startMs && orderMs <= endMs;
}

function orderOverlapsWindow(order, startMs, endMs) {
  const orderStartMs = getOrderWindowStartMs(order);
  const orderEndMs = getOrderWindowEndMs(order);
  if (!Number.isFinite(orderStartMs) && !Number.isFinite(orderEndMs)) return false;
  const start = Number.isFinite(orderStartMs) ? orderStartMs : orderEndMs;
  const end = Number.isFinite(orderEndMs) ? orderEndMs : orderStartMs;
  return start <= endMs && end >= startMs;
}

function getOrderWindowStartMs(order) {
  const candidates = [
    order?.DelWindowStartString,
    order?.DelWindowStart,
    order?.delWindowStartString,
    order?.delWindowStart,
    order?.PickupWindowStart,
    order?.PickupWindowStartString,
    order?.DeliveryWindowStart,
    order?.DeliveryWindowStartString
  ];

  for (const value of candidates) {
    const ms = parseSkipcartDateMs(value);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

function getOrderWindowEndMs(order) {
  const candidates = [
    order?.DelWindowEndString,
    order?.DelWindowEnd,
    order?.delWindowEndString,
    order?.delWindowEnd,
    order?.PickupWindowEnd,
    order?.PickupWindowEndString,
    order?.DeliveryWindowEnd,
    order?.DeliveryWindowEndString
  ];

  for (const value of candidates) {
    const ms = parseSkipcartDateMs(value);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

function parseSkipcartDateMs(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;

  const raw = String(value).trim();
  if (!raw) return NaN;

  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(raw)) {
    const asUtc = Date.parse(raw + 'Z');
    if (Number.isFinite(asUtc)) return asUtc;
  }

  return NaN;
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

function normalizeOrder(order, stepsResult, stepsError) {
  const stops = Array.isArray(stepsResult?.stops) ? stepsResult.stops : [];
  const pickup = stops.find(s => (s.tasks || []).some(t => String(t.task_type || '').toLowerCase() === 'pickup')) || null;
  const dropoff = stops.find(s => (s.tasks || []).some(t => ['drop','dropoff','delivery'].includes(String(t.task_type || '').toLowerCase()))) || null;
  const pickupTask = pickup?.tasks?.find(t => String(t.task_type || '').toLowerCase() === 'pickup') || null;
  const dropoffTask = dropoff?.tasks?.[0] || null;
  const carrierDetails = Array.isArray(order.CarriersOrdersDetails) ? order.CarriersOrdersDetails : [];
  const firstCarrier = carrierDetails[0] || null;
  const firstCarrierDriver = Array.isArray(firstCarrier?.Drivers) ? firstCarrier.Drivers[0] : null;
  const assignedDriverId = order.DriverId || order.driverId || firstCarrier?.DriverId || firstCarrier?.driverId || null;
  const assignedDriverName = firstCarrier?.CarrierDriverName
    || [firstCarrierDriver?.FirstName, firstCarrierDriver?.LastName].filter(Boolean).join(' ')
    || order.DriverName
    || order.driverName
    || '';

  return {
    orderId: order.OrderId || order.orderId || pickupTask?.order_id || dropoffTask?.order_id || null,
    externalOrderId: order.ExternalOrderID || order.externalOrderId || pickupTask?.partner_order_id || null,
    jobId: order.JobId || order.jobId || stepsResult?.delivery_id || null,
    orderStatus: order.OrderStatus || order.orderStatus || '',
    brandName: order.BrandName || order.brandName || pickupTask?.entity?.brand_name || pickupTask?.entity?.name || '',
    partnerCode: order.PartnerCode || order.partnerCode || 'EZCater',
    regionName: order.RegionName || '',
    zoneName: order.ZoneName || '',
    areaName: Array.isArray(order.AreaData) && order.AreaData[0] ? order.AreaData[0].areaname : '',
    delWindowStart: order.DelWindowStartString || order.DelWindowStart || '',
    delWindowEnd: order.DelWindowEndString || order.DelWindowEnd || '',
    driverId: assignedDriverId,
    driverName: assignedDriverName,
    carrierDriverName: firstCarrier?.CarrierDriverName || '',
    carrierDeliveryId: firstCarrier?.CarrierDeliveryId || '',
    lastEvent: order.LastEvent || '',
    pickup: pickup ? {
      address: pickup.address || '',
      lat: Number(pickup.latitude),
      lng: Number(pickup.longitude),
      entityName: pickupTask?.entity?.name || pickupTask?.entity?.brand_name || order.BrandName || '',
      phone: pickupTask?.entity?.phone || '',
      status: pickup.status || pickupTask?.Status || ''
    } : null,
    dropoff: dropoff ? {
      address: dropoff.address || '',
      lat: Number(dropoff.latitude),
      lng: Number(dropoff.longitude),
      customerName: dropoffTask?.entity?.customer_name || '',
      phone: dropoffTask?.entity?.customer_phonenumber || '',
      status: dropoff.status || dropoffTask?.Status || ''
    } : null,
    stops,
    stepsError: stepsError || null
  };
}

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      ret[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return ret;
}

const REGION_NAMES = {
  '54': 'US Region 1',
  '55': 'US Region 2',
  '56': 'US Region 3',
  '57': 'US Region 4',
  '58': 'US Region 5',
  '59': 'US Region 6',
  '60': 'US Region 7',
  '61': 'US Region 8',
  '62': 'US Region 9'
};
