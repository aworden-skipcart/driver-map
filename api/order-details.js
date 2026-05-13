// /api/order-details.js
// GET /api/order-details?orderId=7726733 or ?jobId=6206455
// Required header: X-Usertoken: <JWT from /api/auth>

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

  const orderId = String(req.query?.orderId || '').trim();
  const jobId = String(req.query?.jobId || '').trim();
  if (!orderId && !jobId) return res.status(400).json({ error: 'orderId or jobId is required' });

  try {
    const now = new Date();
    // A driver's "current order" value can linger in the map feed after the work is over.
    // Keep the lookup window tight so yesterday's completed work does not get treated as active.
    const start = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const raw = await searchOrder({ orderId, jobId, start, end, appToken: APPTOKEN, userToken });
    if (!raw) {
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.status(200).json({ status: false, stale: true, reason: 'stale_current_order', error: 'Order not found in active lookup window' });
    }

    const effectiveJobId = raw.JobId || raw.jobId || jobId;
    const [stepsResult, jobDetailsResult, paymentResult] = await Promise.all([
      effectiveJobId ? fetchSteps(effectiveJobId, APPTOKEN, userToken) : { result: null, error: null },
      effectiveJobId ? fetchJobDetails(effectiveJobId, APPTOKEN, userToken) : { result: null, error: null },
      effectiveJobId ? fetchPaymentDetails(effectiveJobId, APPTOKEN, userToken) : { result: null, error: null }
    ]);

    const errors = [stepsResult.error, jobDetailsResult.error, paymentResult.error].filter(Boolean).join(' | ') || null;
    const order = normalizeOrder(raw, stepsResult.result, jobDetailsResult.result, paymentResult.result, errors);
    const relevance = getCurrentOrderRelevance(order, now);
    if (!relevance.active) {
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.status(200).json({
        status: false,
        stale: true,
        error: relevance.reason || 'Current order is no longer active',
        reason: 'stale_current_order',
        order
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ status: true, order });
  } catch (err) {
    console.error('[order-details] proxy error:', err);
    return res.status(err.status || 502).json({ error: err.message || 'Could not load order details', upstream: err.upstream || null });
  }
}

async function searchOrder({ orderId, jobId, start, end, appToken, userToken }) {
  const filters = {
    customers: [],
    orderstatus: [],
    orders: orderId ? [{ orderId: String(orderId) }] : [],
    partners: [],
    drivers: [],
    lastEvents: [],
    deliverywindowrange: { delwindowStartAt: start.toISOString(), delwindowEndAt: end.toISOString() },
    jobs: jobId ? [{ jobsId: Number(jobId) || jobId }] : [],
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

  const json = await upstreamJson('https://live.skipcart.com/dash-api/v2api/Orders/search', {
    method: 'POST',
    headers: makeHeaders(appToken, userToken, true),
    body: JSON.stringify({ filters, pageindex: 1, pagesize: '10', sortColumn: 'DelWindowStart', sortDirection: 'asc' })
  });
  const rows = json?.Result?.OrderData || json?.result?.orderData || [];
  if (!rows.length) return null;
  if (orderId) return rows.find(r => String(r.OrderId || r.orderId) === String(orderId)) || rows[0];
  if (jobId) return rows.find(r => String(r.JobId || r.jobId) === String(jobId)) || rows[0];
  return rows[0];
}

async function fetchSteps(jobId, appToken, userToken) {
  try {
    const json = await upstreamJson(`https://live.skipcart.com/dash-api/v2api/steps/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: makeHeaders(appToken, userToken, false)
    });
    return { result: json?.Result || json?.result || null, error: null };
  } catch (err) {
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
    return { result: null, error: `payment: ${err.message}` };
  }
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
    partnerCode: order.PartnerCode || order.partnerCode || '',
    regionName: order.RegionName || '',
    zoneName: order.ZoneName || '',
    delWindowStart: normalizeSkipcartDateString(order.DelWindowStartString, order.DelWindowStart, pickupTask?.scheduled_at),
    delWindowEnd: normalizeSkipcartDateString(order.DelWindowEndString, order.DelWindowEnd, dropoffTask?.scheduled_at),
    driverId: assignedDriverId,
    driverName: assignedDriverName,
    carrierDriverName: firstCarrier?.CarrierDriverName || '',
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

function getCurrentOrderRelevance(order, now = new Date()) {
  const status = String(order?.orderStatus || '').toLowerCase();
  if (/delivered|cancelled|canceled|complete|completed/.test(status)) {
    return { active: false, reason: 'Current order already appears complete.' };
  }

  const nowMs = now.getTime();
  const startMs = parseDateMs(order?.delWindowStart || order?.pickup?.scheduledAt);
  const endMs = parseDateMs(order?.delWindowEnd || order?.dropoff?.scheduledAt || order?.delWindowStart || order?.pickup?.scheduledAt);

  // Allow a small post-window buffer for jobs that are still being wrapped up, but do not
  // surface old jobs from stale driver feed values.
  const postWindowBufferMs = 2 * 60 * 60 * 1000;
  const futureBufferMs = 24 * 60 * 60 * 1000;

  if (Number.isFinite(endMs) && endMs < nowMs - postWindowBufferMs) {
    return { active: false, reason: 'Current order window has already passed.' };
  }
  if (Number.isFinite(startMs) && startMs > nowMs + futureBufferMs) {
    return { active: false, reason: 'Current order is outside the active dispatch window.' };
  }
  return { active: true };
}

function parseDateMs(value) {
  if (!value) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?$/.test(raw) ? raw + 'Z' : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : NaN;
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
