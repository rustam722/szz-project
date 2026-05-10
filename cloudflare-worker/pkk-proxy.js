/**
 * Cloudflare Worker — прокси для ПКК Росреестра
 * Деплой: https://workers.cloudflare.com
 * Бесплатный план: 100 000 запросов/день
 *
 * Эндпоинты:
 *   GET /ping
 *   GET /pkk?bbox=minLon,minLat,maxLon,maxLat&limit=400
 */

const PKK_BASE = 'https://pkk.rosreestr.ru/api/features/1';

const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Referer':    'https://pkk.rosreestr.ru/',
  'Origin':     'https://pkk.rosreestr.ru',
  'Accept':     'application/json, text/plain, */*',
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // /ping — проверка работоспособности
    if (url.pathname === '/ping') {
      return Response.json({ ok: true, proxy: 'cloudflare-worker' }, { headers: CORS });
    }

    // /pkk?bbox=minLon,minLat,maxLon,maxLat&limit=400
    if (url.pathname === '/pkk') {
      const bbox  = url.searchParams.get('bbox');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '400'), 400);

      if (!bbox) {
        return Response.json({ error: 'bbox required' }, { status: 400, headers: CORS });
      }

      const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(Number);
      if ([minLon, minLat, maxLon, maxLat].some(isNaN)) {
        return Response.json({ error: 'invalid bbox' }, { status: 400, headers: CORS });
      }

      const params = new URLSearchParams({
        text:             '',
        tolerance:        '4',
        limit:            String(limit),
        skip:             '0',
        inBbox:           '1',
        bbox:             `${minLon},${minLat},${maxLon},${maxLat}`,
        bboxSr:           '4326',
        resultSr:         '4326',
        returnGeometry:   'true',
        returnAttributes: 'true',
      });

      const upstream = `${PKK_BASE}?${params}`;

      try {
        const resp = await fetch(upstream, {
          headers: UPSTREAM_HEADERS,
          cf: { cacheTtl: 300, cacheEverything: true },
        });

        const data = await resp.json();
        const features = (data.features || []).map(f => ({
          attrs:    f.attrs || f.attributes || {},
          center:   f.center || null,
          geometry: f.geometry || null,
          id:       f.id || f.attrs?.cn || '',
        }));

        return Response.json({ features, total: features.length }, {
          headers: {
            ...CORS,
            'Cache-Control': 'public, max-age=300',
          },
        });

      } catch (e) {
        return Response.json(
          { error: 'PKK unavailable', message: e.message },
          { status: 502, headers: CORS }
        );
      }
    }

    return Response.json({ error: 'not found' }, { status: 404, headers: CORS });
  },
};
