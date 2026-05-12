// /api/orders.js
//
// GET /api/orders?hours=12&regionId=58
// Required header: X-Usertoken: <JWT from /api/auth>
//
// Pulls New ezCater orders for a true rolling next 12/24 hours window, then
// enriches each order with pickup/dropoff coordinates from /v2api/steps/{JobId}
// so the browser can map pickup pins and draw pickup-to-delivery route lines.
//
// Important: Skipcart can return date-bucket spillover depending on how the
// dispatch search interprets deliverywindowrange. We therefore apply a second
// server-side hard cap after search so the 24-hour view never includes orders
// later than exactly now + 24 hours.

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
  const windowStartMs = now.getTime();
  const windowEndMs = end.getTime();
  const pageSize = 75;
  const maxPages = 8; // hard cap safety; 600 orders max before enrichment

  try {
    const baseFilters = {
      customers: [],
      orderstatus: [{ name: 'New' }],
      orders: [],
      partners: [{ partnerId: 'EZCater' }],
      drivers: [],
      lastEvents: [],
      deliverywindowrange: {
        delwindowStartAt: now.toISOString(),
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

    // The HAR did not include a region-filtered example. To avoid guessing a
    // brittle payload shape, we pull the ezCater New-order set and filter by
    // RegionName after the response when a region is selected.
    const requestedRegionName = REGION_NAMES[String(regionId)] || '';

    const allOrders = [];
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
        headers: makeHeaders(APPTOKEN, userToken, true),
        body: JSON.stringify(body)
      });

      const result = searchJson?.Result || searchJson?.result || {};
      const rows = result.OrderData || result.orderData || [];
      totalCount = result.TotalCount ?? result.totalCount ?? totalCount;
      allOrders.push(...rows);

      if (!rows.length || rows.length < pageSize) break;
      if (totalCount !== null && allOrders.length >= totalCount) break;
    }

    const regionFiltered = requestedRegionName
      ? allOrders.filter(o => String(o.RegionName || '').toLowerCase() === requestedRegionName.toLowerCase())
      : allOrders;

    // Hard rolling-window filter. This prevents the Orders/search endpoint from
    // returning tomorrow/end-of-day records outside the selected 12/24h window.
    const windowFiltered = regionFiltered.filter(order => isOrderInsideWindow(order, windowStartMs, windowEndMs));

    const enriched = await mapLimit(windowFiltered, 6, async (order) => {
      const jobId = order.JobId || order.jobId;
      if (!jobId) return normalizeOrder(order, null);
      try {
        const stepsJson = await upstreamJson(`https://live.skipcart.com/dash-api/v2api/steps/${encodeURIComponent(jobId)}`, {
          method: 'GET',
          headers: makeHeaders(APPTOKEN, userToken, false)
        });
        return normalizeOrder(order, stepsJson?.Result || stepsJson?.result || null);
      } catch (err) {
        console.error('[orders] steps enrichment failed', jobId, err.message);
        return normalizeOrder(order, null, err.message);
      }
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      status: true,
      hours,
      totalFound: allOrders.length,
      totalAfterRegionFilter: regionFiltered.length,
      totalInsideWindow: windowFiltered.length,
      windowStart: now.toISOString(),
      windowEnd: end.toISOString(),
      orders: enriched
    });
  } catch (err) {
    console.error('[orders] proxy error:', err);
    return res.status(err.status || 502).json({ error: err.message || 'Could not reach orders API', upstream: err.upstream || null });
  }
}


function isOrderInsideWindow(order, startMs, endMs) {
  const orderMs = getOrderWindowStartMs(order);
  if (!Number.isFinite(orderMs)) return false;
  return orderMs >= startMs && orderMs <= endMs;
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

function parseSkipcartDateMs(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;

  const raw = String(value).trim();
  if (!raw) return NaN;

  // Skipcart commonly sends both "2026-05-12T18:36:00" and
  // "2026-05-12T18:36:00Z". Prefer the explicit value, then try appending Z
  // so date-only/no-zone values are still compared consistently on Vercel.
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
    delWindowStart: order.DelWindowStart || order.DelWindowStartString || '',
    delWindowEnd: order.DelWindowEnd || order.DelWindowEndString || '',
    driverId: order.DriverId || null,
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
