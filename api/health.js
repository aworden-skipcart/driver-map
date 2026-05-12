// /api/health.js
//
// GET /api/health
// Verifies the SKIPCART_APPTOKEN env var is loaded without leaking its value.

export default function handler(req, res) {
  const token = (process.env.SKIPCART_APPTOKEN || '').trim();
  return res.status(200).json({
    ok: true,
    apptokenLoaded: !!token,
    apptokenLength: token.length,
    apptokenPrefix: token.slice(0, 8),
    nodeVersion: process.version,
    region: process.env.VERCEL_REGION || 'unknown'
  });
}
