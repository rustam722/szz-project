// ═══════════════════════════════════════════════
// UTILS.JS — общие утилиты
// ═══════════════════════════════════════════════

'use strict';

// ── Статус бар ──────────────────────────────────
function setSt(msg, type = '') {
  const el = document.getElementById('status-bar');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-bar' + (type ? ' ' + type : '');
}

// ── Прогресс бар ────────────────────────────────
function setProgress(pct) {
  const bar  = document.getElementById('progress-bar');
  const fill = document.getElementById('progress-fill');
  if (!bar || !fill) return;
  if (pct === null || pct === undefined) {
    bar.style.display = 'none';
    fill.style.width  = '0%';
  } else {
    bar.style.display = 'block';
    fill.style.width  = Math.min(100, pct) + '%';
  }
}

// ── Hex → rgba ──────────────────────────────────
function hexToRgba(hex, alpha = 1) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c+c).join('');
  const r = parseInt(hex.slice(0,2),16);
  const g = parseInt(hex.slice(2,4),16);
  const b = parseInt(hex.slice(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Bbox из массива [lat,lon] ────────────────────
function getBBox(pts) {
  const lats = pts.map(p => p[0]);
  const lons = pts.map(p => p[1]);
  return {
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
    minLon: Math.min(...lons), maxLon: Math.max(...lons),
  };
}

// ── Point-in-polygon ─────────────────────────────
function pip(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > lon) !== (yj > lon)) && (lat < (xj-xi)*(lon-yi)/(yj-yi)+xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Безопасный fetch с таймаутом ────────────────
function fetchSafe(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const tid   = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { signal: ctrl.signal })
    .finally(() => clearTimeout(tid));
}

// ── Направление по азимуту ──────────────────────
function bearingToDir(deg) {
  if (deg < 22.5  || deg >= 337.5) return 'На север от объекта';
  if (deg < 67.5)                   return 'На северо-восток от объекта';
  if (deg < 112.5)                  return 'На восток от объекта';
  if (deg < 157.5)                  return 'На юго-восток от объекта';
  if (deg < 202.5)                  return 'На юг от объекта';
  if (deg < 247.5)                  return 'На юго-запад от объекта';
  if (deg < 292.5)                  return 'На запад от объекта';
  return 'На северо-запад от объекта';
}

function getBearing(lat, lon, cLat, cLon) {
  const dLon = lon - cLon, dLat = lat - cLat;
  return ((Math.atan2(dLon, dLat) * 180 / Math.PI) + 360) % 360;
}

// ── Deep clone ──────────────────────────────────
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── localStorage helpers ─────────────────────────
const Store = {
  set(key, val) {
    try { localStorage.setItem('szztool_' + key, JSON.stringify(val)); } catch(e) {}
  },
  get(key, def = null) {
    try {
      const v = localStorage.getItem('szztool_' + key);
      return v !== null ? JSON.parse(v) : def;
    } catch(e) { return def; }
  },
  del(key) {
    try { localStorage.removeItem('szztool_' + key); } catch(e) {}
  }
};

// ── Debounce ─────────────────────────────────────
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ══════════════════════════════════════════════════
// КОНВЕРТАЦИЯ КООРДИНАТ — СК-42 / МСК → WGS-84
// ══════════════════════════════════════════════════

/**
 * Обратная проекция Гаусса-Крюгера (СК-42 / Пулково-1942).
 * Алгоритм Снайдера (Map Projections – A Working Manual, eq. 8-17..8-22).
 *
 * @param {number} X  — северинг (northing), м
 * @param {number} Y  — востинг с номером зоны (easting), м  (вида ZZZZZZZ)
 * @returns {[number,number]|null}  [широта°, долгота°] или null при ошибке
 */
function _sk42ToWgs84(X, Y) {
  // Эллипсоид Красовского 1940
  const a   = 6378245.0;
  const e2  = 0.00669342162297;   // e² (первый эксцентриситет²)
  const ep2 = e2 / (1 - e2);      // e'² (второй эксцентриситет²)

  // Номер зоны и редуцированный восток
  const zone = Math.floor(Y / 1e6);
  if (zone < 1 || zone > 32) return null;
  const L0 = (zone * 6 - 3) * Math.PI / 180;  // центральный меридиан, рад
  const y  = Y - zone * 1e6 - 5e5;             // восток от ЦМ, м (может быть < 0)
  const x  = X;                                 // северинг, м

  // 1. Широта подошвенной точки φ₁ из меридиональной дуги x
  const e1    = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const e1_2  = e1 * e1, e1_3 = e1_2 * e1, e1_4 = e1_3 * e1;
  const Mcoef = a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256);
  const mu    = x / Mcoef;

  const phi1 = mu
    + (3 * e1 / 2      - 27 * e1_3 / 32  ) * Math.sin(2 * mu)
    + (21 * e1_2 / 16  - 55 * e1_4 / 32  ) * Math.sin(4 * mu)
    + (151 * e1_3 / 96                    ) * Math.sin(6 * mu)
    + (1097 * e1_4 / 512                  ) * Math.sin(8 * mu);

  // 2. φ и λ из φ₁ и y
  const sinP = Math.sin(phi1), cosP = Math.cos(phi1), tanP = sinP / cosP;
  const N1  = a / Math.sqrt(1 - e2 * sinP * sinP);
  const R1  = a * (1 - e2) / Math.pow(1 - e2 * sinP * sinP, 1.5);
  const T1  = tanP * tanP;
  const C1  = ep2 * cosP * cosP;
  const D   = y / N1;
  const D2 = D*D, D3 = D2*D, D4 = D3*D, D5 = D4*D, D6 = D5*D;

  const phi = phi1 - (N1 * tanP / R1) * (
      D2 / 2
    - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*ep2)            * D4 / 24
    + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*ep2 - 3*C1*C1) * D6 / 720
  );

  const lam = L0 + (
      D
    - (1 + 2*T1 + C1)                                        * D3 / 6
    + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*ep2 + 24*T1*T1)       * D5 / 120
  ) / cosP;

  const lat = phi * 180 / Math.PI;
  const lon = lam * 180 / Math.PI;

  // Валидация (диапазон РФ и ближнего зарубежья)
  if (lat < 38 || lat > 83 || lon < 18 || lon > 196) return null;
  return [lat, lon];
}

/**
 * Пытается распознать пару чисел как СК-42 и вернуть {x, y, zone}.
 * Перебирает оба варианта порядка (X,Y) и (Y,X).
 */
function _tryParseSk42(a, b) {
  for (const [x, y] of [[a, b], [b, a]]) {
    const zone = Math.floor(y / 1e6);
    if (zone < 1 || zone > 32) continue;
    const yMod = y % 1e6;
    if (yMod < 50000 || yMod > 950000) continue;   // 50-950 км от ЦМ → разумно
    if (x < 3_000_000 || x > 9_500_000) continue;  // ~27°N – ~86°N
    return { x, y, zone };
  }
  return null;
}

/**
 * Определяет CRS по набору пар координат.
 * @returns {'wgs84'|'sk42'|'msk'|'unknown'}
 */
function detectCRS(pairs) {
  if (!pairs.length) return 'unknown';
  const [a, b] = pairs[0];

  // WGS-84: оба значения в градусном диапазоне
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return 'wgs84';
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return 'wgs84';

  // СК-42: можно извлечь зону из одного из значений
  if (_tryParseSk42(a, b)) return 'sk42';

  // МСК и прочие проекционные: большие числа без распознанной зоны
  if (Math.max(Math.abs(a), Math.abs(b)) > 1000) return 'msk';

  return 'unknown';
}

/**
 * Главная функция: автоопределение + конвертация в WGS-84.
 * @param {Array<[number,number]>} pairs
 * @returns {{ pts: [number,number][], crs: string, ok: boolean, msg: string }}
 */
function autoConvertCoords(pairs) {
  const crs = detectCRS(pairs);

  if (crs === 'wgs84') {
    // Гарантируем порядок [lat, lon]
    const pts = pairs.map(([a, b]) => {
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [a, b];
      if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return [b, a];
      return [a, b];
    });
    return { pts, crs: 'wgs84', ok: true, msg: 'WGS-84' };
  }

  if (crs === 'sk42') {
    const pts = [];
    for (const [a, b] of pairs) {
      const parsed = _tryParseSk42(a, b);
      if (!parsed) return { pts: [], crs, ok: false,
        msg: 'Не удалось разобрать пару СК-42. Проверьте координаты.' };
      const wgs = _sk42ToWgs84(parsed.x, parsed.y);
      if (!wgs) return { pts: [], crs, ok: false,
        msg: `СК-42 → WGS-84: точка вне допустимого диапазона (X=${parsed.x}, Y=${parsed.y}).` };
      pts.push(wgs);
    }
    return { pts, crs: 'sk42', ok: true, msg: `СК-42 зона ${Math.floor(pairs[0][1] > pairs[0][0] ? pairs[0][1] : pairs[0][0]) / 1e6 | 0} → WGS-84` };
  }

  if (crs === 'msk') {
    return { pts: [], crs: 'msk', ok: false,
      msg: 'Похоже на МСК — автоопределение зоны невозможно. Преобразуй в СК-42 или WGS-84 заранее (например, через CS2CS / ГИС).' };
  }

  return { pts: [], crs: 'unknown', ok: false,
    msg: 'Формат не распознан. Ожидается WGS-84 (градусы) или СК-42 (метры, Y содержит номер зоны).' };
}
