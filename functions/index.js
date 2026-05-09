/**
 * Firebase Cloud Functions — прокси для ПКК Росреестра
 * Заменяет локальный proxy.py
 *
 * Эндпоинты:
 *   GET /api/pkk?bbox=lon1,lat1,lon2,lat2&limit=400
 *   GET /api/ping
 *   GET /api/feature?cn=89:05:030707:1234   (детали по кн)
 */

const functions = require('firebase-functions');
const fetch     = require('node-fetch');
const cors      = require('cors')({ origin: true });

// ── PKK Росреестра — базовые URL ─────────────────
const PKK_BASE   = 'https://pkk.rosreestr.ru/api/features/1';
const PKK_SEARCH = 'https://pkk.rosreestr.ru/api/features';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Referer':    'https://pkk.rosreestr.ru/',
  'Accept':     'application/json, text/plain, */*',
};

// ── Главный обработчик ────────────────────────────
exports.api = functions
  .region('europe-west1')          // ближайший к России регион
  .runWith({ timeoutSeconds: 60, memory: '256MB' })
  .https.onRequest((req, res) => {
    cors(req, res, () => handleRequest(req, res));
  });

async function handleRequest(req, res) {
  const path = req.path || '/';

  // ── /api/ping ──────────────────────────────────
  if (path === '/ping' || path === '/api/ping') {
    return res.json({ ok: true, ts: Date.now() });
  }

  // ── /api/pkk?bbox=...&limit=... ────────────────
  if (path === '/pkk' || path === '/api/pkk') {
    const { bbox, limit = 400 } = req.query;
    if (!bbox) return res.status(400).json({ error: 'bbox required' });

    const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(Number);
    if ([minLon, minLat, maxLon, maxLat].some(isNaN)) {
      return res.status(400).json({ error: 'invalid bbox' });
    }

    try {
      const url = `${PKK_SEARCH}/1?` + new URLSearchParams({
        text:          '',
        tolerance:     '4',
        limit:         String(Math.min(parseInt(limit), 400)),
        skip:          '0',
        inBbox:        '1',
        bbox:          `${minLon},${minLat},${maxLon},${maxLat}`,
        bboxSr:        '4326',
        resultSr:      '4326',
        returnGeometry: 'true',
        returnAttributes: 'true',
        returnPaging:  'false',
      });

      const r    = await fetch(url, { headers: HEADERS, timeout: 30000 });
      const data = await r.json();

      // Нормализуем ответ ПКК
      const features = (data.features || []).map(f => ({
        attrs:    f.attrs || f.attributes || {},
        center:   f.center || null,
        geometry: f.geometry || null,
        id:       f.id || f.attrs?.cn || '',
      }));

      res.setHeader('Cache-Control', 'public, max-age=300'); // кэш 5 мин
      return res.json({ features, total: features.length });

    } catch (e) {
      functions.logger.error('PKK fetch error:', e);
      return res.status(502).json({ error: 'PKK unavailable', message: e.message });
    }
  }

  // ── /api/feature?cn=... ────────────────────────
  if (path === '/feature' || path === '/api/feature') {
    const { cn } = req.query;
    if (!cn) return res.status(400).json({ error: 'cn required' });

    try {
      const url = `${PKK_BASE}/${encodeURIComponent(cn)}`;
      const r   = await fetch(url, { headers: HEADERS, timeout: 15000 });
      const data = await r.json();
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.json(data.feature || data);
    } catch (e) {
      return res.status(502).json({ error: 'PKK unavailable', message: e.message });
    }
  }

  return res.status(404).json({ error: 'not found' });
}
