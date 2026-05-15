// /api/orders.js
//
// GET /api/orders?mode=unassigned&hours=12&regionId=58
// GET /api/orders?mode=in-progress&regionId=58
// GET /api/orders?mode=completed&regionId=58
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

  const modeRaw = String(req.query?.mode || 'unassigned').toLowerCase();
  const mode = ['unassigned', 'in-progress', 'completed'].includes(modeRaw) ? modeRaw : 'unassigned';
  const modeConfig = ORDER_MODE_CONFIG[mode] || ORDER_MODE_CONFIG.unassigned;

  const hoursRaw = Number(req.query?.hours || 12);
  const hours = [12, 24].includes(hoursRaw) ? hoursRaw : 12;

  const regionIdRaw = req.query?.regionId;
  const regionId = regionIdRaw !== undefined && regionIdRaw !== '' ? Number(regionIdRaw) : null;
  if (regionId !== null && (!Number.isInteger(regionId) || regionId < 0 || regionId > 9999)) {
    return res.status(400).json({ error: 'Invalid regionId' });
  }

  const now = new Date();
  const centralDay = getCentralDayRange(now);
  const start = mode === 'unassigned' ? now : centralDay.start;
  const end = mode === 'unassigned' ? new Date(now.getTime() + hours * 60 * 60 * 1000) : centralDay.end;
  // Pull a small buffer beyond the visible order window so conflict detection can
  // catch scheduled drivers up to 1 hour after the selected order's window end.
  const scheduledEnd = new Date(end.getTime() + 2 * 60 * 60 * 1000);
  const windowStartMs = start.getTime();
  const windowEndMs = end.getTime();
  const scheduledEndMs = scheduledEnd.getTime();
  const pageSize = 75;
  const maxPages = 8; // hard cap safety; 600 rows per status before enrichment

  try {
    const requestedRegionName = REGION_NAMES[String(regionId)] || '';

    const primaryRawSets = await Promise.all(modeConfig.primaryStatuses.map(statusName => (
      fetchOrdersByStatus({ statusName, start, end, pageSize, maxPages, appToken: APPTOKEN, userToken })
    )));
    const primaryRaw = mergeByKey(
      primaryRawSets.flat(),
      row => String(row.OrderId || row.orderId || row.JobId || row.jobId || JSON.stringify(row).slice(0, 80))
    );

    let scheduledRaw = [];
    if (mode === 'unassigned') {
      scheduledRaw = await fetchOrdersByStatus({ statusName: 'Scheduled', start, end: scheduledEnd, pageSize, maxPages, appToken: APPTOKEN, userToken });

      // Some Skipcart views expose scheduled rows even when orderstatus is blank
      // but do not always honor a Scheduled status filter consistently. Fallback
      // to an unfiltered status search and keep only scheduled rows by response data.
      if (!scheduledRaw.length) {
        const unfiltered = await fetchOrdersByStatus({ statusName: null, start, end: scheduledEnd, pageSize, maxPages, appToken: APPTOKEN, userToken });
        scheduledRaw = unfiltered.filter(o => /scheduled/i.test(String(o.OrderStatus || o.orderStatus || '')));
      }
    }

    const primaryRegionFiltered = requestedRegionName
      ? primaryRaw.filter(o => String(o.RegionName || '').toLowerCase() === requestedRegionName.toLowerCase())
      : primaryRaw;
    const scheduledRegionFiltered = requestedRegionName
      ? scheduledRaw.filter(o => String(o.RegionName || '').toLowerCase() === requestedRegionName.toLowerCase())
      : scheduledRaw;

    const primaryWindowFiltered = primaryRegionFiltered.filter(order => isOrderStartInsideWindow(order, windowStartMs, windowEndMs));
    const scheduledWindowFiltered = mode === 'unassigned'
      ? scheduledRegionFiltered.filter(order => orderOverlapsWindow(order, windowStartMs, scheduledEndMs))
      : [];

    const [primaryEnriched, scheduledEnriched] = await Promise.all([
      enrichOrders(primaryWindowFiltered, APPTOKEN, userToken),
      enrichOrders(scheduledWindowFiltered, APPTOKEN, userToken)
    ]);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      status: true,
      mode,
      modeLabel: modeConfig.label,
      statuses: modeConfig.primaryStatuses,
      hours: mode === 'unassigned' ? hours : null,
      dateLabel: mode === 'unassigned' ? null : centralDay.label,
      totalFound: primaryRaw.length,
      scheduledTotalFound: scheduledRaw.length,
      totalAfterRegionFilter: primaryRegionFiltered.length,
      scheduledAfterRegionFilter: scheduledRegionFiltered.length,
      totalInsideWindow: primaryWindowFiltered.length,
      scheduledInsideWindow: scheduledWindowFiltered.length,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      scheduledWindowEnd: mode === 'unassigned' ? scheduledEnd.toISOString() : null,
      orders: primaryEnriched,
      scheduledOrders: scheduledEnriched
    });
  } catch (err) {
    console.error('[orders] proxy error:', err);
    return res.status(err.status || 502).json({ error: err.message || 'Could not reach orders API', upstream: err.upstream || null });
  }
}


const ORDER_MODE_CONFIG = {
  unassigned: { label: 'Unassigned', primaryStatuses: ['New'] },
  'in-progress': { label: 'In Progress', primaryStatuses: ['Scheduled', 'Confirmed', 'Out For Delivery'] },
  completed: { label: 'Completed', primaryStatuses: ['Delivered'] }
};

function mergeByKey(items, keyFn) {
  const map = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, item);
  }
  return [...map.values()];
}

function getCentralDayRange(now = new Date()) {
  const timeZone = 'America/Chicago';
  const parts = getTimeZoneParts(now, timeZone);
  const start = zonedTimeToUtc(timeZone, parts.year, parts.month, parts.day, 0, 0, 0);
  const end = zonedTimeToUtc(timeZone, parts.year, parts.month, parts.day + 1, 0, 0, 0);
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZoneName: 'short'
  }).format(now);
  return { start, end, label };
}

function getTimeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? 0 : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function getTimeZoneOffsetMs(timeZone, date) {
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedTimeToUtc(timeZone, year, month, day, hour, minute, second) {
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  let offset = getTimeZoneOffsetMs(timeZone, utc);
  utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset);
  offset = getTimeZoneOffsetMs(timeZone, utc);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset);
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
  return mapLimit(orders, 5, async (order) => {
    const jobId = order.JobId || order.jobId;
    if (!jobId) return normalizeOrder(order, null, null, null);

    const [stepsResult, jobDetailsResult, paymentResult] = await Promise.all([
      fetchSteps(jobId, appToken, userToken),
      fetchJobDetails(jobId, appToken, userToken),
      fetchPaymentDetails(jobId, appToken, userToken)
    ]);

    const errors = [stepsResult.error, jobDetailsResult.error, paymentResult.error].filter(Boolean).join(' | ') || null;
    return normalizeOrder(order, stepsResult.result, jobDetailsResult.result, paymentResult.result, errors);
  });
}

async function fetchSteps(jobId, appToken, userToken) {
  try {
    const json = await upstreamJson(`https://live.skipcart.com/dash-api/v2api/steps/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: makeHeaders(appToken, userToken, false)
    });
    return { result: json?.Result || json?.result || null, error: null };
  } catch (err) {
    console.error('[orders] steps enrichment failed', jobId, err.message);
    return { result: null, error: `steps: ${err.message}` };
  }
}

async function fetchJobDetails(jobId, appToken, userToken) {
  try {
    const json = await upstreamJson('https://live.skipcart.com/dash-api/v1api/Jobs/search', {
      method: 'POST',
      headers: makeHeaders(appToken, userToken, true),
      body: JSON.stringify({ filters: { jobs: [{ jobsId: Number(jobId) || jobId }] } })
    });
    return { result: json?.Result || json?.result || null, error: null };
  } catch (err) {
    console.error('[orders] job details enrichment failed', jobId, err.message);
    return { result: null, error: `job details: ${err.message}` };
  }
}

async function fetchPaymentDetails(jobId, appToken, userToken) {
  try {
    const json = await upstreamJson(`https://live.skipcart.com/dash-api/v1api/Jobs/DeliveryPaymentDetails/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: makeHeaders(appToken, userToken, false)
    });
    return { result: json?.Result || json?.result || null, error: null };
  } catch (err) {
    console.error('[orders] payment enrichment failed', jobId, err.message);
    return { result: null, error: `payment: ${err.message}` };
  }
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

  // Skipcart order-window values represent UTC. Some fields include a trailing
  // Z, while others are timezone-less ISO strings. Parse the timezone-less
  // order windows as UTC so filtering and conflict math match dispatch.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?$/.test(raw)) {
    const asUtc = Date.parse(raw + 'Z');
    if (Number.isFinite(asUtc)) return asUtc;
  }

  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;

  return NaN;
}

function normalizeSkipcartDateString(...values) {
  for (const value of values) {
    if (!value) continue;
    const raw = String(value).trim();
    if (!raw) continue;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?$/.test(raw)) return raw + 'Z';
    return raw;
  }
  return '';
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

function normalizeOrder(order, stepsResult, jobDetailsResult, paymentResult, enrichError) {
  const stops = Array.isArray(stepsResult?.stops) ? stepsResult.stops : [];
  const pickup = stops.find(s => (s.tasks || []).some(t => String(t.task_type || '').toLowerCase() === 'pickup')) || null;
  const dropoff = stops.find(s => (s.tasks || []).some(t => ['drop','dropoff','delivery'].includes(String(t.task_type || '').toLowerCase()))) || null;
  const pickupTask = pickup?.tasks?.find(t => String(t.task_type || '').toLowerCase() === 'pickup') || null;
  const dropoffTask = dropoff?.tasks?.[0] || null;
  const carrierDetails = Array.isArray(order.CarriersOrdersDetails) ? order.CarriersOrdersDetails : [];
  const firstCarrier = carrierDetails[0] || null;
  const firstCarrierDriver = Array.isArray(firstCarrier?.Drivers) ? firstCarrier.Drivers[0] : null;
  const assignedDriverId = order.DriverId || order.driverId || firstCarrier?.DriverId || firstCarrier?.driverId || null;
  const jobDetails = Array.isArray(jobDetailsResult?.JobData) ? jobDetailsResult.JobData[0] : null;
  const jobOrders = Array.isArray(jobDetails?.orders) ? jobDetails.orders : [];
  const matchedJobOrder = jobOrders.find(jo => String(jo.id || jo.orderid || jo.OrderId || '') === String(order.OrderId || order.orderId || '')) || jobOrders[0] || null;
  const orderCost = sumMoney(jobOrders.map(jo => jo?.cost_of_goods ?? jo?.CostOfGoods ?? jo?.CostOfGood));
  const driverTotalPay = asNumber(paymentResult?.total ?? jobDetails?.totalamount);
  const pickupLat = pickup ? Number(pickup.latitude) : NaN;
  const pickupLng = pickup ? Number(pickup.longitude) : NaN;
  const dropoffLat = dropoff ? Number(dropoff.latitude) : NaN;
  const dropoffLng = dropoff ? Number(dropoff.longitude) : NaN;
  const distanceMiles = distanceMilesBetween(pickupLat, pickupLng, dropoffLat, dropoffLng);
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
    delWindowStart: normalizeSkipcartDateString(order.DelWindowStartString, order.DelWindowStart, pickupTask?.scheduled_at),
    delWindowEnd: normalizeSkipcartDateString(order.DelWindowEndString, order.DelWindowEnd, dropoffTask?.scheduled_at),
    driverId: assignedDriverId,
    driverName: assignedDriverName,
    carrierDriverName: firstCarrier?.CarrierDriverName || '',
    carrierDeliveryId: firstCarrier?.CarrierDeliveryId || '',
    lastEvent: order.LastEvent || '',
    orderCost: Number.isFinite(orderCost) ? orderCost : null,
    orderCostCurrency: '$',
    orderTip: asNullableNumber(matchedJobOrder?.tip),
    distanceMiles: Number.isFinite(distanceMiles) ? distanceMiles : null,
    driverTotalPay: asNullableNumber(driverTotalPay),
    driverTotalPayCurrency: paymentResult?.currencysymbol || '$',
    driverPayBreakdown: paymentResult ? {
      totalMiles: asNullableNumber(paymentResult.totalmiles),
      mileageFee: asNullableNumber(paymentResult.mileagefee),
      totalTip: asNullableNumber(paymentResult.totaltip),
      otherFee: asNullableNumber(paymentResult.otherfee),
      postTips: asNullableNumber(paymentResult.posttips),
      cancellationFee: asNullableNumber(paymentResult.cancellationfee)
    } : null,
    pickup: pickup ? {
      address: pickup.address || '',
      lat: pickupLat,
      lng: pickupLng,
      entityName: pickupTask?.entity?.name || pickupTask?.entity?.brand_name || order.BrandName || '',
      phone: pickupTask?.entity?.phone || '',
      scheduledAt: normalizeSkipcartDateString(pickupTask?.scheduled_at),
      status: pickup.status || pickupTask?.Status || ''
    } : null,
    dropoff: dropoff ? {
      address: dropoff.address || '',
      lat: dropoffLat,
      lng: dropoffLng,
      customerName: dropoffTask?.entity?.customer_name || '',
      phone: dropoffTask?.entity?.customer_phonenumber || '',
      scheduledAt: normalizeSkipcartDateString(dropoffTask?.scheduled_at),
      status: dropoff.status || dropoffTask?.Status || ''
    } : null,
    stops,
    stepsError: enrichError || null
  };
}


function distanceMilesBetween(lat1, lng1, lat2, lng2) {
  const nums = [lat1, lng1, lat2, lng2].map(Number);
  if (nums.some(n => !Number.isFinite(n))) return NaN;
  const [aLat, aLng, bLat, bLng] = nums;
  const R = 3958.7613;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}


function asNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function asNullableNumber(value) {
  const n = asNumber(value);
  return Number.isFinite(n) ? n : null;
}

function sumMoney(values) {
  let total = 0;
  let found = false;
  for (const value of values || []) {
    const n = asNumber(value);
    if (Number.isFinite(n)) {
      total += n;
      found = true;
    }
  }
  return found ? total : NaN;
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
