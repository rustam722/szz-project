// ═══════════════════════════════════════════════
// SEARCH.JS — поиск участков через ПКК Росреестр
// ═══════════════════════════════════════════════

'use strict';

// ── Прокси ───────────────────────────────────────
// Локальный proxy.py на 127.0.0.1:8765
// Запуск: двойной клик на «Запустить прокси.command»

const LOCAL_PROXY = 'http://127.0.0.1:8767';

// 'local' | null
let _proxyMode = null;

async function _detectProxy() {
  try {
    const r = await fetchSafe(`${LOCAL_PROXY}/ping`, 2000);
    if (!r.ok) return false;
    const d = await r.json();
    if (d && d.ok) { _proxyMode = 'local'; return true; }
  } catch(e) {}
  _proxyMode = null;
  return false;
}

async function checkProxy() {
  const dot   = document.getElementById('proxy-dot');
  const label = document.getElementById('proxy-label');
  dot.className = 'proxy-dot';
  label.textContent = 'Проверяю…';
  const ok = await _detectProxy();
  if (ok) {
    dot.className = 'proxy-dot ok';
    label.textContent = 'Прокси запущен ✓';
  } else {
    dot.className = 'proxy-dot err';
    label.textContent = 'Прокси не запущен — запусти proxy.py';
  }
}

async function fetchTile(minLat, maxLat, minLon, maxLon) {
  if (!_proxyMode) {
    if (!await _detectProxy()) throw new Error('Прокси не запущен — запусти proxy.py');
  }
  const sq = JSON.stringify({
    type: 'Polygon',
    coordinates: [[[minLon,minLat],[maxLon,minLat],[maxLon,maxLat],[minLon,maxLat],[minLon,minLat]]]
  });
  const params = new URLSearchParams({ sq, limit: 400, tolerance: 2, resultType: 2 });
  const r = await fetchSafe(`${LOCAL_PROXY}/pkk?${params}`, 30000);
  if (!r.ok) { _proxyMode = null; throw new Error(`HTTP ${r.status}`); }
  const data = await r.json();
  return data.features || [];
}

async function searchParcels() {
  const al = getActiveLayer();
  if (!al || al.type !== 'szz') { setSt('Выбери слой СЗЗ', 'err'); return; }

  const szzPoly = al.poly;
  const btn = document.getElementById('btn-search');
  btn.disabled = true;
  clearMarkers();
  foundParcels = [];
  document.getElementById('res-list').innerHTML = '';
  document.getElementById('btn-export').disabled = true;
  document.getElementById('btn-export-word').disabled = true;
  document.getElementById('res-cnt').textContent = '0';

  if (!_proxyMode) {
    const ok = await _detectProxy();
    if (!ok) {
      setSt('Сервер недоступен — попробуй позже', 'err');
      btn.disabled = false; return;
    }
  }

  let szzTurf;
  try {
    const ring = szzPoly.map(p => [p[1], p[0]]);
    if (ring[0][0] !== ring[ring.length-1][0]) ring.push([...ring[0]]);
    szzTurf = turf.polygon([ring]);
  } catch(e) {
    setSt('Ошибка геометрии СЗЗ', 'err'); btn.disabled = false; return;
  }

  const bb   = getBBox(szzPoly);
  const sz   = Math.max(bb.maxLat - bb.minLat, bb.maxLon - bb.minLon);
  const TILE = sz < 0.03 ? 0.015 : sz < 0.1 ? 0.04 : 0.08;
  const latS = Math.max(1, Math.ceil((bb.maxLat - bb.minLat) / TILE));
  const lonS = Math.max(1, Math.ceil((bb.maxLon - bb.minLon) / TILE));
  const total = latS * lonS;

  setSt(`Запрашиваю ПКК (${total} тайл${total===1?'':total<5?'а':'ов'})…`, 'spin');
  setProgress(0);

  const seen = new Set();
  let   all  = [];
  let   done = 0;

  for (let i = 0; i < latS; i++) {
    for (let j = 0; j < lonS; j++) {
      const tla  = bb.minLat + i * (bb.maxLat - bb.minLat) / latS;
      const tla2 = bb.minLat + (i+1) * (bb.maxLat - bb.minLat) / latS;
      const tlo  = bb.minLon + j * (bb.maxLon - bb.minLon) / lonS;
      const tlo2 = bb.minLon + (j+1) * (bb.maxLon - bb.minLon) / lonS;
      try {
        const feats = await fetchTile(tla, tla2, tlo, tlo2);
        for (const f of feats) {
          const cn = f?.attrs?.cn || f?.attrs?.id || '';
          if (cn && !seen.has(cn)) { seen.add(cn); all.push(f); }
        }
      } catch(e) {
        setSt(`Ошибка: ${e.message}`, 'err');
        setProgress(null); btn.disabled = false; return;
      }
      done++;
      setProgress(Math.round(done / total * 75));
      setSt(`Тайл ${done}/${total} — получено: ${all.length}`, 'spin');
      if (total > 1) await new Promise(r => setTimeout(r, 200));
    }
  }

  setSt(`Проверяю геометрию (${all.length} объектов)…`, 'spin');
  setProgress(82);
  await new Promise(r => setTimeout(r, 30));

  const inside = [], cross = [], margin = 0.002;

  for (const f of all) {
    const a  = f?.attrs || {};
    const cn = a.cn || a.id || '—';
    const g = f.geometry || {}, c = f.center || {};
    let cLat, cLon;
    if (c.x && c.y) { cLon = c.x; cLat = c.y; }
    else if (g.type === 'Point') { cLon = g.coordinates[0]; cLat = g.coordinates[1]; }
    else if (g.type === 'Polygon' && g.coordinates?.[0]) {
      const r = g.coordinates[0];
      cLon = r.reduce((s,p)=>s+p[0],0)/r.length;
      cLat = r.reduce((s,p)=>s+p[1],0)/r.length;
    } else if (g.type === 'MultiPolygon' && g.coordinates?.[0]?.[0]) {
      const r = g.coordinates[0][0];
      cLon = r.reduce((s,p)=>s+p[0],0)/r.length;
      cLat = r.reduce((s,p)=>s+p[1],0)/r.length;
    }
    if (cLat === undefined) continue;
    if (cLat < bb.minLat-margin || cLat > bb.maxLat+margin ||
        cLon < bb.minLon-margin || cLon > bb.maxLon+margin) continue;

    const addr = a.address || a.readable_address || '';
    const rawCat = String(a.category_type || '');
    const cat  = CATEGORIES[rawCat] || rawCat || '';
    const util = a.util_by_doc || a.utilization || '';
    const area = a.area_value  ? `${a.area_value} ${a.area_unit || 'м²'}` : '';
    const zone = a.fp || a.functional_zone || '';

    let status = 'out';
    try {
      const hasGeom = g.type && g.type !== 'Point' && g.coordinates;
      if (hasGeom) {
        const pt = g.type === 'Polygon' ? turf.polygon(g.coordinates) : turf.multiPolygon(g.coordinates);
        if (turf.booleanContains(szzTurf, pt)) {
          status = 'inside';
        } else if (turf.booleanIntersects(szzTurf, pt)) {
          try {
            const inter = turf.intersect(turf.featureCollection([szzTurf, pt]));
            status = (inter && turf.area(inter)/turf.area(pt) >= 0.01) ? 'cross' : 'out';
          } catch { status = 'cross'; }
        }
      } else {
        status = pip(cLat, cLon, szzPoly) ? 'inside' : 'out';
      }
    } catch { status = pip(cLat, cLon, szzPoly) ? 'inside' : 'out'; }

    const record = { cn, addr, cat, util, area, zone, lat: cLat, lon: cLon, inP: status === 'inside', geometry: g };
    if (status === 'inside') inside.push(record);
    else if (status === 'cross') cross.push(record);
  }

  setProgress(100);
  foundParcels = [...inside, ...cross];
  inside.forEach(addParcelLayer);
  cross.forEach(addParcelLayer);
  toggleFills();
  renderResults(inside, cross);
  setProgress(null);
  document.getElementById('btn-export').disabled      = !foundParcels.length;
  document.getElementById('btn-export-word').disabled = !foundParcels.length;
  btn.disabled = false;
  setSt(`✓ Внутри: ${inside.length} ЗУ | Пересечение: ${cross.length} ЗУ`, 'ok');
}

function renderResults(inside, cross) {
  const list = document.getElementById('res-list');
  document.getElementById('res-cnt').textContent = inside.length;
  if (!inside.length && !cross.length) {
    list.innerHTML = '<div class="empty">🔎 ЗУ не найдено</div>'; return;
  }
  let html = '';
  if (inside.length) {
    html += `<div class="res-section-hdr inside">✓ Внутри СЗЗ — ${inside.length} уч.</div>`;
    html += inside.map(parcelCard).join('');
  }
  if (cross.length) {
    html += `<div class="res-section-hdr cross">⚠ Пересечение — ${cross.length} уч.</div>`;
    html += cross.map(parcelCard).join('');
  }
  list.innerHTML = html;
}

function parcelCard(r) {
  return `<div class="pcard" id="card-${r.cn.replace(/\W/g,'_')}" onclick="highlightParcel('${r.cn}')">
    <div class="pcn">${r.cn}</div>
    <div class="paddr">${r.addr || 'адрес не указан'}</div>
    <div class="ptags">
      <span class="tag ${r.inP?'tin':'tcrs'}">${r.inP?'✓ внутри':'⚠ пересечение'}</span>
      ${r.area?`<span class="tag tmuted">${r.area}</span>`:''}
    </div>
  </div>`;
}
