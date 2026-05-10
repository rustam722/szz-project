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
