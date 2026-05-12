// /api/update-order-fee.js
//
// POST /api/update-order-fee
// Required header: X-Usertoken: <JWT from /api/auth>
// Body: { jobId, amountToAdd }
//
// Adds to the job's OtherFee using DeliveryPaymentDetails + UpdateJobFee.
// Safety guard: a single update cannot add more than $30.00.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const APPTOKEN = (process.env.SKIPCART_APPTOKEN || '').trim();
  if (!APPTOKEN) {
    console.error('[update-order-fee] SKIPCART_APPTOKEN is not set');
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
  const amountToAdd = cleanMoney(body?.amountToAdd);
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  if (!Number.isFinite(amountToAdd) || amountToAdd <= 0) {
    return res.status(400).json({ error: 'Amount to add must be greater than $0.00' });
  }
  if (amountToAdd > 30) {
    return res.status(400).json({ error: 'Cannot add more than $30.00 to an order' });
  }

  try {
    const headers = makeHeaders(APPTOKEN, userToken, false);
    const before = await fetchPaymentDetails(jobId, headers);
    const oldOtherFee = asNumber(before?.otherfee) || 0;
    const oldTotal = asNumber(before?.total) || 0;
    const newOtherFee = round2(oldOtherFee + amountToAdd);
    const expectedNewTotal = round2(oldTotal + amountToAdd);
    const orders = buildOrdersPayload(before?.ordersdata);

    const payload = {
      JobId: String(jobId),
      OtherFee: newOtherFee.toFixed(2),
      OldOtherFee: oldOtherFee.toFixed(2),
      IsManualFeesUpdate: true,
      IsRescheduleDelivery: false,
      Orders: orders
    };

    const updateJson = await upstreamJson('https://live.skipcart.com/dash-api/v1api/Jobs/UpdateJobFee', {
      method: 'POST',
      headers: makeHeaders(APPTOKEN, userToken, true),
      body: JSON.stringify(payload)
    });

    const ok = updateJson?.Status === true || updateJson?.status === true;
    if (!ok) {
      return res.status(400).json({
        error: updateJson?.Message || updateJson?.message || 'UpdateJobFee rejected by Skipcart',
        reason: 'upstream_business_rule',
        upstream: updateJson
      });
    }

    const after = await fetchPaymentDetails(jobId, headers).catch(() => null);
    return res.status(200).json({
      status: true,
      message: `Added $${amountToAdd.toFixed(2)} to Other Fee`,
      jobId: String(jobId),
      amountAdded: amountToAdd,
      oldOtherFee,
      newOtherFee,
      oldTotal,
      expectedNewTotal,
      paymentDetails: normalizePaymentDetails(after || before),
      upstream: updateJson
    });
  } catch (err) {
    console.error('[update-order-fee] proxy error:', err);
    return res.status(err.status || 502).json({ error: err.message || 'Could not update Other Fee', upstream: err.upstream || null });
  }
}

function makeHeaders(appToken, userToken, isJson) {
  const headers = {
    'AppToken': appToken,
    'UserToken': userToken,
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://live.skipcart.com',
    'Referer': 'https://live.skipcart.com/'
  };
  if (isJson) headers['Content-Type'] = 'application/json';
  return headers;
}

async function fetchPaymentDetails(jobId, headers) {
  const json = await upstreamJson(`https://live.skipcart.com/dash-api/v1api/Jobs/DeliveryPaymentDetails/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers
  });
  const result = json?.Result || json?.result || null;
  if (!result) throw new Error('Could not fetch DeliveryPaymentDetails for Job ' + jobId);
  return result;
}

function buildOrdersPayload(ordersdata) {
  if (!Array.isArray(ordersdata)) return [];
  return ordersdata.map(o => ({
    id: String(o?.orderid ?? o?.OrderId ?? o?.id ?? ''),
    partner_order_id: '',
    market: null,
    cost_of_goods: '0',
    number_of_bags: null,
    tip: Number(asNumber(o?.tip) || 0).toFixed(2)
  })).filter(o => o.id);
}

function normalizePaymentDetails(payment) {
  return {
    total: asNullableNumber(payment?.total),
    otherFee: asNullableNumber(payment?.otherfee),
    totalMiles: asNullableNumber(payment?.totalmiles),
    mileageFee: asNullableNumber(payment?.mileagefee),
    totalTip: asNullableNumber(payment?.totaltip),
    postTips: asNullableNumber(payment?.posttips),
    cancellationFee: asNullableNumber(payment?.cancellationfee),
    currencySymbol: payment?.currencysymbol || '$',
    raw: payment
  };
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

function cleanInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanMoney(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? round2(n) : NaN;
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

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
