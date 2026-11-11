// ═══════════════════════════════════════════════
// MAP.JS — карта, рисование, управление слоями
// ═══════════════════════════════════════════════

'use strict';

// ── Глобальное состояние ────────────────────────
let map, osm, sat;
let tool     = 'poly';
let polyPts  = [];
let polyLine = null;
let polyMkrs = [];
let mapLayers    = [];
let activeLayerId = null;
let draggedLayerIdx = null;
let useSat   = false;
let parcelMkrs = [];
let foundParcels = [];
let zoomRectActive = false, zoomRectDrawing = false, zoomRectStart = {};

const CATEGORIES = {
  '003001000000': 'Земли с/х назначения',
  '003002000000': 'Земли населённых пунктов',
  '003003000000': 'Земли промышленности и иного специального назначения',
  '003004000000': 'Земли особо охраняемых территорий',
  '003005000000': 'Земли лесного фонда',
  '003006000000': 'Земли водного фонда',
  '003007000000': 'Земли запаса',
};

// ── Инициализация карты ─────────────────────────
function initMap() {
  map = L.map('map', {
    center: [62.0, 74.0],
    zoom: 10,
    zoomControl: true,
    wheelPxPerZoomLevel: 80,   // чуть плавнее обычный зум
    zoomSnap: 0.1,             // шаг зума 0.1 (вместо 1)
    zoomDelta: 0.5,            // кнопки +/- тоже плавнее
  });

  // Alt + колесо → очень плавное приближение/отдаление
  document.getElementById('map').addEventListener('wheel', e => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    map.setZoom(map.getZoom() + delta, { animate: true });
  }, { passive: false, capture: true });

  osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);

  sat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: '© Esri', maxZoom: 19 }
  );

  // Клик на карту
  map.on('click', e => {
    if (document.getElementById('pdf-editor').style.display !== 'none') return;
    if (zoomRectActive) return;
    if (tool === 'poly') addPolyPt(e.latlng.lat, e.latlng.lng);
  });

  // Двойной клик — замкнуть полигон
  map.on('dblclick', e => {
    if (document.getElementById('pdf-editor').style.display !== 'none') return;
    if (tool === 'poly' && polyPts.length >= 3) {
      L.DomEvent.stopPropagation(e);
      closePoly();
    }
  });

  // Leaflet scale
  L.control.scale({ imperial: false }).addTo(map);
  _initMapKeyboard();

  // Координаты курсора в правом нижнем углу
  const coordsDiv = document.createElement('div');
  coordsDiv.id = 'map-coords';
  document.getElementById('map-wrapper').appendChild(coordsDiv);
  map.on('mousemove', e => {
    coordsDiv.textContent = `${e.latlng.lat.toFixed(6)}°  ${e.latlng.lng.toFixed(6)}°`;
  });
  map.on('mouseout', () => { coordsDiv.textContent = ''; });

  initZoomRect();
}

// ── Инструменты ─────────────────────────────────
function setTool(t) {
  tool = t;
  ['poly', 'coords'].forEach(x => {
    const btn = document.getElementById('t-' + x);
    const pnl = document.getElementById('params-' + x);
    if (btn) btn.classList.toggle('active', x === t);
    if (pnl) pnl.style.display = x === t ? 'block' : 'none';
  });
  if (t !== 'poly') finishPolyDraw();
}

// ── Рисование полигона ──────────────────────────
function addPolyPt(lat, lon) {
  polyPts.push([lat, lon]);
  const m = L.circleMarker([lat, lon], {
    radius: 5, color: '#3b82f6',
    fillColor: '#0e1117', fillOpacity: 1, weight: 2,
  }).addTo(map);
  polyMkrs.push(m);

  if (polyLine) map.removeLayer(polyLine);
  if (polyPts.length > 1) {
    polyLine = L.polyline([...polyPts, polyPts[0]], {
      color: '#3b82f6', weight: 1.5, dashArray: '4,4',
    }).addTo(map);
  }

  document.getElementById('btn-close-poly').disabled = polyPts.length < 3;
  setSt(`Рисование: ${polyPts.length} вершин (двойной клик — завершить)`);
}

function closePoly() {
  if (polyPts.length < 3) return;
  const pts = [...polyPts];
  finishPolyDraw();

  const cfg = getStyleCfg();
  const ll  = pts.map(p => L.latLng(p[0], p[1]));
  const layer = L.polygon(ll, {
    color: '#f59e0b', weight: cfg.parcelW,
    fillColor: '#f59e0b', fillOpacity: 0.15,
    dashArray: dashByType(cfg.lineType),
  }).addTo(map);

  addMapLayer('parcel', `Участок ${mapLayers.filter(l => l.type === 'parcel').length + 1}`, pts, layer);
  map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  setSt('Участок построен. Теперь постройте СЗЗ.', 'ok');
}

function finishPolyDraw() {
  polyPts = [];
  polyMkrs.forEach(m => map.removeLayer(m));
  polyMkrs = [];
  if (polyLine) { map.removeLayer(polyLine); polyLine = null; }
  document.getElementById('btn-close-poly').disabled = true;
}

function undoPolyPt() {
  if (!polyPts.length) return;
  polyPts.pop();
  const m = polyMkrs.pop();
  if (m) map.removeLayer(m);
  if (polyLine) map.removeLayer(polyLine);
  if (polyPts.length > 1) {
    polyLine = L.polyline([...polyPts, polyPts[0]], {
      color: '#3b82f6', weight: 1.5, dashArray: '4,4',
    }).addTo(map);
  } else { polyLine = null; }
  document.getElementById('btn-close-poly').disabled = polyPts.length < 3;
  setSt(`Рисование: ${polyPts.length} вершин`);
}

// ── Из координат ─────────────────────────────────
function buildFromCoords() {
  const raw = document.getElementById('coords-input').value.trim();
  if (!raw) return;

  // Парсим пары чисел (разделитель: пробел / запятая / точка с запятой / таб)
  const pairs = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/[\s,;]+/);
    if (parts.length >= 2) {
      const a = parseFloat(parts[0]), b = parseFloat(parts[1]);
      if (!isNaN(a) && !isNaN(b)) pairs.push([a, b]);
    }
  }
  if (pairs.length < 3) { setSt('Нужно минимум 3 точки', 'err'); return; }

  // Автоопределение CRS и конвертация → WGS-84
  const result = autoConvertCoords(pairs);

  if (!result.ok) {
    setSt(result.msg, 'err');
    _setCoordsHint(result.msg, 'err');
    return;
  }

  const pts = result.pts;
  const cfg = getStyleCfg();
  const ll  = pts.map(p => L.latLng(p[0], p[1]));
  const layer = L.polygon(ll, {
    color: '#f59e0b', weight: cfg.parcelW,
    fillColor: '#f59e0b', fillOpacity: 0.15,
  }).addTo(map);

  addMapLayer('parcel', `Участок ${mapLayers.filter(l => l.type === 'parcel').length + 1}`, pts, layer);
  map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  document.getElementById('coords-input').value = '';

  const crsLabel = { wgs84: 'WGS-84', sk42: 'СК-42 → WGS-84', msk: 'МСК' }[result.crs] || result.crs;
  setSt(`Построен участок из ${pts.length} точек (${crsLabel})`, 'ok');
  _setCoordsHint(`✓ ${crsLabel}, ${pts.length} точек`, 'ok');
}

/** Обновляет подсказку под полем координат */
function _setCoordsHint(msg, type) {
  let hint = document.getElementById('coords-crs-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'coords-crs-hint';
    hint.style.cssText = 'font-size:11px;margin-top:4px;padding:3px 6px;border-radius:4px;';
    const btn = document.querySelector('#params-coords .btn');
    if (btn) btn.parentNode.insertBefore(hint, btn);
  }
  const colors = { ok: '#16a34a', err: '#dc2626', info: '#6b7280' };
  const bg     = { ok: '#f0fdf4', err: '#fef2f2', info: '#f1f5f9' };
  hint.textContent  = msg;
  hint.style.color  = colors[type] || colors.info;
  hint.style.background = bg[type] || bg.info;
  hint.style.display = 'block';
}

// ── Генерация СЗЗ ────────────────────────────────
function generateSzz() {
  const al = getActiveLayer();
  if (!al || al.type !== 'parcel') { setSt('Выбери слой ЗУ', 'err'); return; }

  const cfg = getStyleCfg();
  const ring = al.poly.map(p => [p[1], p[0]]);
  ring.push(ring[0]);
  const poly   = turf.polygon([ring]);
  const buf    = turf.buffer(poly, cfg.buffer / 1000, { units: 'kilometers', steps: 64 });
  const bufPts = buf.geometry.coordinates[0].map(c => [c[1], c[0]]);

  const layer = L.polygon(bufPts.map(p => L.latLng(p[0], p[1])), {
    color: '#c084fc', weight: cfg.szzW,
    fillColor: '#c084fc', fillOpacity: 0.1,
    dashArray: dashByType(cfg.lineType),
  }).addTo(map);

  addMapLayer('szz', `СЗЗ ${cfg.buffer}м`, bufPts, layer, al.id);
  setSt(`СЗЗ ${cfg.buffer}м построена`, 'ok');
}

// ── Вырезать исходный ЗУ из СЗЗ ─────────────────
function cutSourceParcel() {
  // Ищем активный слой СЗЗ
  const szzLayer = mapLayers.find(l => l.id === activeLayerId && l.type === 'szz')
                || mapLayers.find(l => l.type === 'szz');
  if (!szzLayer) { setSt('Нет слоя СЗЗ — сначала постройте СЗЗ', 'err'); return; }

  // Исходный ЗУ — родительский слой СЗЗ или первый parcel
  const parcelLayer = mapLayers.find(l => l.id === szzLayer.parentId && l.type === 'parcel')
                   || mapLayers.find(l => l.type === 'parcel');
  if (!parcelLayer) { setSt('Нет исходного ЗУ для вырезания', 'err'); return; }

  try {
    // Строим turf-полигоны (координаты в [lon, lat])
    const szzRing = szzLayer.poly.map(p => [p[1], p[0]]);
    if (szzRing[0][0] !== szzRing[szzRing.length-1][0]) szzRing.push([...szzRing[0]]);
    const parcelRing = parcelLayer.poly.map(p => [p[1], p[0]]);
    if (parcelRing[0][0] !== parcelRing[parcelRing.length-1][0]) parcelRing.push([...parcelRing[0]]);

    const szzTurf    = turf.polygon([szzRing]);
    const parcelTurf = turf.polygon([parcelRing]);

    // Вычитаем ЗУ из СЗЗ (turf v6 API)
    const result = turf.difference(szzTurf, parcelTurf);
    if (!result) { setSt('Участок не пересекается с СЗЗ', 'err'); return; }

    // Удаляем старый слой СЗЗ с карты
    map.removeLayer(szzLayer.layer);
    const idx = mapLayers.findIndex(l => l.id === szzLayer.id);
    if (idx !== -1) mapLayers.splice(idx, 1);

    // Создаём новый слой с вырезанной геометрией
    const cfg = getStyleCfg();
    const newLayer = L.geoJSON(result, {
      style: {
        color: '#c084fc', weight: cfg.szzW,
        fillColor: '#c084fc', fillOpacity: 0.1,
        dashArray: dashByType(cfg.lineType),
      },
    }).addTo(map);

    // poly для совместимости (берём первый контур)
    const newPoly = result.geometry.coordinates[0].map(c => [c[1], c[0]]);
    addMapLayer('szz', szzLayer.name + ' (вырез.)', newPoly, newLayer, szzLayer.parentId);

    setSt('Исходный ЗУ вырезан из СЗЗ ✓', 'ok');
  } catch(e) {
    setSt('Ошибка вырезания: ' + e.message, 'err');
  }
}

// ── Управление слоями ────────────────────────────
function addMapLayer(type, name, poly, leafletLayer, parentId = null) {
  const id = Date.now();
  const colors = { parcel: '#f59e0b', szz: '#c084fc' };
  const defColor = colors[type] || '#3b82f6';
  // Захватываем реальный стиль из только что созданного слоя Leaflet
  const lo = leafletLayer.options || {};
  const _psStyle = {
    fillColor:   lo.fillColor   ?? defColor,
    color:       lo.color       ?? defColor,
    fillOpacity: lo.fillOpacity ?? (type === 'szz' ? 0.10 : 0.15),
    opacity:     lo.opacity     ?? 1,
    weight:      lo.weight      ?? 2,
    dashArray:   lo.dashArray   ?? null,
  };
  const layer = { id, type, name, poly, layer: leafletLayer, visible: true, parentId,
                  color: lo.color ?? defColor, _psStyle };
  mapLayers.unshift(layer);
  activeLayerId = id;
  renderLayers();
  updateButtons();
  updatePdfOverlays();
  return layer;
}

function getActiveLayer() {
  return mapLayers.find(l => l.id === activeLayerId);
}

function getStyleCfg() {
  return {
    buffer:  parseFloat(document.getElementById('szz-buffer-m').value) || 1000,
    szzW:    parseFloat(document.getElementById('szz-line-width').value) || 3,
    parcelW: parseFloat(document.getElementById('parcel-line-width').value) || 2,
    lineType: document.getElementById('szz-line-type').value,
  };
}

function dashByType(t) {
  // Значения должны совпадать с option value в lp-dash select
  return t === 'dashed' ? '8,5' : t === 'dotted' ? '2,6' : null;
}

function renderLayers() {
  // Синхронизируем с открытым именованным проектом, иначе новые/удалённые
  // слои теряются при повторном открытии проекта — loadProject() берёт
  // старую сохранённую версию.
  if (typeof window._autoSaveCurrentProject === 'function') window._autoSaveCurrentProject();

  const box = document.getElementById('layer-box');
  if (!mapLayers.length) {
    box.innerHTML = '<div class="empty">Нет слоёв. Нарисуй участок.</div>';
    showLayerProps(null);
    return;
  }

  box.innerHTML = mapLayers.map((l, idx) => {
    const style    = l._psStyle || {};
    const fillOp   = Math.round((style.fillOpacity ?? (l.type === 'szz' ? 0.10 : 0.15)) * 100);
    const thumbBg  = hexToRgba(l.color, fillOp / 100);
    const borderSt = l.type === 'szz' ? 'dashed' : 'solid';
    return `<div class="li-row ${l.id === activeLayerId ? 'active' : ''}"
                 tabindex="0" draggable="true"
                 ondragstart="onLayerDragStart(event,${idx})"
                 ondragend="onLayerDragEnd(event)"
                 ondragover="onLayerDragOver(event)"
                 ondragleave="onLayerDragLeave(event)"
                 ondrop="onLayerDrop(event,${idx})"
                 onclick="selectLayer(${l.id})"
                 onkeydown="handleLayerKey(event,${l.id})">
      <input type="checkbox" class="li-chk" ${l.visible ? 'checked' : ''}
             onclick="toggleVis(event,${l.id})" title="Видимость">
      <div class="li-thumb" style="background:${thumbBg};border:2px ${borderSt} ${l.color}"></div>
      <span class="li-type ${l.type === 'szz' ? 't-szz' : ''}">${l.type === 'parcel' ? 'ЗУ' : 'СЗЗ'}</span>
      <span class="li-name" id="lname-${l.id}"
            contenteditable="false"
            onblur="saveLayerName(${l.id})"
            onkeydown="handleNameKey(event,${l.id})"
            ondblclick="startRename(${l.id})">${l.name}</span>
      <span class="li-fillpct">${fillOp}%</span>
      <span class="li-del" onclick="deleteLayer(event,${l.id})" title="Удалить">✕</span>
    </div>`;
  }).join('');
}

function selectLayer(id) {
  activeLayerId = id;
  renderLayers();
  updateButtons();
  const l = mapLayers.find(l => l.id === id) || null;
  showLayerProps(l);
  _updatePolyOpsPanel(l);
}

function showLayerProps(l) {
  const panel = document.getElementById('layer-props-panel');
  if (!l) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  document.getElementById('layer-props-name').textContent = l.name;

  const s = l._psStyle || {};
  document.getElementById('lp-fill-color').value   = l.color || '#f59e0b';
  document.getElementById('lp-stroke-color').value = l.color || '#f59e0b';
  const fo = Math.round((s.fillOpacity ?? (l.type === 'szz' ? 0.1 : 0.15)) * 100);
  document.getElementById('lp-fill-opacity').value = fo;
  document.getElementById('lp-fill-val').textContent = fo + '%';
  const so = Math.round((s.opacity ?? 1) * 100);
  document.getElementById('lp-stroke-opacity').value = so;
  document.getElementById('lp-stroke-val').textContent = so + '%';
  const w = s.weight ?? 2;
  document.getElementById('lp-weight').value = w;
  document.getElementById('lp-weight-val').textContent = w + 'px';
  document.getElementById('lp-dash').value = s.dashArray ?? '';
}

function applyLayerProps() {
  const al = getActiveLayer();
  if (!al || !al.layer) return;

  const fo  = parseInt(document.getElementById('lp-fill-opacity').value) / 100;
  const so  = parseInt(document.getElementById('lp-stroke-opacity').value) / 100;
  const w   = parseInt(document.getElementById('lp-weight').value);
  const dash = document.getElementById('lp-dash').value;
  const fc  = document.getElementById('lp-fill-color').value;
  const sc  = document.getElementById('lp-stroke-color').value;

  document.getElementById('lp-fill-val').textContent   = Math.round(fo * 100) + '%';
  document.getElementById('lp-stroke-val').textContent = Math.round(so * 100) + '%';
  document.getElementById('lp-weight-val').textContent = w + 'px';

  const newStyle = { fillColor: fc, color: sc, fillOpacity: fo, opacity: so, weight: w, dashArray: dash || null };
  al._psStyle = newStyle;
  al.color    = fc;
  if (al.layer.setStyle) al.layer.setStyle(newStyle);
  renderLayers();
}

// Drag-reorder
function onLayerDragStart(e, idx) {
  draggedLayerIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => e.target.style.opacity = '0.4', 0);
}
function onLayerDragEnd(e) {
  e.target.style.opacity = '1';
  document.querySelectorAll('.li-row').forEach(el => el.classList.remove('drag-over'));
}
function onLayerDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function onLayerDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function onLayerDrop(e, dropIdx) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (draggedLayerIdx === null || draggedLayerIdx === dropIdx) return;
  const moved = mapLayers.splice(draggedLayerIdx, 1)[0];
  mapLayers.splice(dropIdx, 0, moved);
  draggedLayerIdx = null;
  renderLayers();
}

function handleLayerKey(e, id) {
  if (e.key === ' ' && e.target.classList.contains('li-row')) { e.preventDefault(); startRename(id); }
}
function startRename(id) {
  const span = document.getElementById('lname-' + id);
  if (!span) return;
  span.contentEditable = 'true';
  span.focus();
  document.execCommand('selectAll', false, null);
}
function handleNameKey(e, id) {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  if (e.key === ' ') e.stopPropagation();
}
function saveLayerName(id) {
  const span = document.getElementById('lname-' + id);
  const l    = mapLayers.find(x => x.id === id);
  if (l && span) {
    l.name = span.textContent.trim() || (l.type === 'parcel' ? 'Участок' : 'СЗЗ');
    span.contentEditable = 'false';
    span.textContent = l.name;
  }
}
function toggleVis(e, id) {
  e.stopPropagation();
  const l = mapLayers.find(x => x.id === id);
  if (l) { l.visible = e.target.checked; l.visible ? map.addLayer(l.layer) : map.removeLayer(l.layer); }
}
function deleteLayer(e, id) {
  e.stopPropagation();
  mapLayers.filter(x => x.parentId === id).forEach(c => _removeLayer(c.id));
  _removeLayer(id);
  renderLayers(); updateButtons();
  setSt('Слой удалён', 'ok');
}
function _removeLayer(id) {
  const idx = mapLayers.findIndex(x => x.id === id);
  if (idx > -1) {
    const l = mapLayers[idx];
    if (map.hasLayer(l.layer)) map.removeLayer(l.layer);
    mapLayers.splice(idx, 1);
    if (activeLayerId === id) activeLayerId = mapLayers.length ? mapLayers[0].id : null;
  }
}
function clearAll() {
  mapLayers.forEach(l => { if (map.hasLayer(l.layer)) map.removeLayer(l.layer); });
  mapLayers = []; activeLayerId = null;
  clearMarkers(); finishPolyDraw(); polyPts = [];
  foundParcels = [];
  renderLayers(); updateButtons();
  document.getElementById('res-cnt').textContent = '0';
  document.getElementById('res-list').innerHTML = '<div class="empty">📍 Здесь появятся<br>кадастровые номера ЗУ</div>';
  setProgress(null);
  setSt('Всё очищено', 'ok');
}
function clearMarkers() {
  parcelMkrs.forEach(p => { if (map.hasLayer(p.layer)) map.removeLayer(p.layer); });
  parcelMkrs = [];
}
function updateButtons() {
  const al = getActiveLayer();
  document.getElementById('btn-gen-szz').disabled  = !(al && al.type === 'parcel');
  document.getElementById('btn-search').disabled   = !(al && al.type === 'szz');
  const hasSzz = mapLayers.some(l => l.type === 'szz');
  const cutBtn = document.getElementById('btn-cut-source');
  if (cutBtn) cutBtn.disabled = !hasSzz;
}
function fitActive() {
  const al = getActiveLayer();
  if (al && al.layer && al.layer.getBounds) map.fitBounds(al.layer.getBounds(), { padding: [40,40] });
}

// ── Подложка ─────────────────────────────────────
function toggleSat() {
  useSat = !useSat;
  const btn = document.getElementById('sat-btn');
  if (useSat) { map.removeLayer(osm); sat.addTo(map); btn.title = 'Схема'; btn.textContent = '🗺'; }
  else         { map.removeLayer(sat); osm.addTo(map); btn.title = 'Спутник'; btn.textContent = '🛰'; }
}

// ── Zoom rect ────────────────────────────────────
function initZoomRect() {
  const overlay = document.getElementById('zoom-rect-overlay');
  const wrapper = document.getElementById('map-wrapper');

  wrapper.addEventListener('mousedown', e => {
    if (!zoomRectActive) return;
    if (e.target.closest('.leaflet-control')) return;
    e.preventDefault();
    const rect = wrapper.getBoundingClientRect();
    zoomRectStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    zoomRectDrawing = true;
    Object.assign(overlay.style, { display: 'block', left: zoomRectStart.x+'px', top: zoomRectStart.y+'px', width: '0', height: '0' });
  });

  document.addEventListener('mousemove', e => {
    if (!zoomRectDrawing) return;
    const rect = wrapper.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const x = Math.min(cx, zoomRectStart.x), y = Math.min(cy, zoomRectStart.y);
    overlay.style.left = x+'px'; overlay.style.top = y+'px';
    overlay.style.width = Math.abs(cx-zoomRectStart.x)+'px';
    overlay.style.height = Math.abs(cy-zoomRectStart.y)+'px';
  });

  document.addEventListener('mouseup', e => {
    if (!zoomRectDrawing) return;
    zoomRectDrawing = false;
    overlay.style.display = 'none';
    const rect = wrapper.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const x1 = Math.min(cx, zoomRectStart.x), y1 = Math.min(cy, zoomRectStart.y);
    const x2 = Math.max(cx, zoomRectStart.x), y2 = Math.max(cy, zoomRectStart.y);
    if (Math.abs(x2-x1) > 10 && Math.abs(y2-y1) > 10) {
      const sw = map.containerPointToLatLng(L.point(x1, y2));
      const ne = map.containerPointToLatLng(L.point(x2, y1));
      map.fitBounds([[sw.lat, sw.lng],[ne.lat, ne.lng]]);
    }
    toggleZoomRect();
  });
}

function toggleZoomRect() {
  zoomRectActive = !zoomRectActive;
  const btn = document.getElementById('zoom-rect-btn');
  btn.classList.toggle('active', zoomRectActive);
  document.getElementById('map').style.cursor = zoomRectActive ? 'crosshair' : '';
}

// ── Навигатор по ЗУ ──────────────────────────────
function openParcelNav() {
  const nav = document.getElementById('parcel-nav');
  const sel = document.getElementById('parcel-nav-select');
  sel.innerHTML = '<option value="">— выбрать —</option>';

  if (mapLayers.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'Слои карты';
    mapLayers.forEach(l => {
      const o = document.createElement('option');
      o.value = 'layer_' + l.id;
      o.textContent = (l.type === 'szz' ? 'СЗЗ' : 'ЗУ') + ' — ' + l.name;
      grp.appendChild(o);
    });
    sel.appendChild(grp);
  }
  if (foundParcels.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'Найденные ЗУ ПКК';
    foundParcels.forEach(p => {
      const o = document.createElement('option');
      o.value = 'parcel_' + p.cn;
      o.textContent = p.cn + (p.inP ? ' ✓' : ' ⚠');
      grp.appendChild(o);
    });
    sel.appendChild(grp);
  }

  nav.style.display = 'flex';
}

function navToParcel(val) {
  if (!val) return;
  if (val.startsWith('layer_')) {
    const id = parseInt(val.replace('layer_', ''));
    const l  = mapLayers.find(x => x.id === id);
    if (l && l.layer && l.layer.getBounds) {
      map.fitBounds(l.layer.getBounds(), { padding: [40,40] });
      selectLayer(id);
    }
  } else if (val.startsWith('parcel_')) {
    highlightParcel(val.replace('parcel_', ''));
  }
}

// ── Подсветка / выбор участка ─────────────────────
function highlightParcel(cn) { selectParcel(cn); }

let selectedParcelCn = null;

function selectParcel(cn) {
  if (selectedParcelCn && selectedParcelCn !== cn) {
    const prev = parcelMkrs.find(x => x.cn === selectedParcelCn);
    if (prev && prev.layer && prev.layer.setStyle) prev.layer.setStyle(prev.origStyle);
    const prevCard = document.getElementById('card-' + selectedParcelCn.replace(/\W/g,'_'));
    if (prevCard) prevCard.classList.remove('selected');
  }
  selectedParcelCn = cn;
  const pm = parcelMkrs.find(x => x.cn === cn);
  if (pm && pm.layer) {
    const bounds = pm.layer.getBounds ? pm.layer.getBounds() : pm.layer.getLatLng().toBounds(100);
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17 });
    if (pm.layer.setStyle) pm.layer.setStyle({ ...pm.origStyle, color: '#3b82f6', weight: 3.5, fillOpacity: 0.45 });
  }
  const card = document.getElementById('card-' + cn.replace(/\W/g,'_'));
  if (card) { card.classList.add('selected'); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  const p = foundParcels.find(x => x.cn === cn);
  if (p) showParcelInfo(p);
}

function closeParcelInfo() {
  const panel = document.getElementById('parcel-info-panel');
  if (panel) panel.style.display = 'none';
  if (selectedParcelCn) {
    const pm = parcelMkrs.find(x => x.cn === selectedParcelCn);
    if (pm && pm.layer && pm.layer.setStyle) pm.layer.setStyle(pm.origStyle);
    const card = document.getElementById('card-' + selectedParcelCn.replace(/\W/g,'_'));
    if (card) card.classList.remove('selected');
    selectedParcelCn = null;
  }
}

function showParcelInfo(p) {
  const panel = document.getElementById('parcel-info-panel');
  if (!panel) return;
  const badge = p.inP
    ? '<span class="pi-badge inside">✓ Внутри СЗЗ</span>'
    : '<span class="pi-badge cross">⚠ Касается СЗЗ</span>';
  const row = (key, val, cls = '') => val
    ? `<div class="pi-row"><div class="pi-key">${key}</div><div class="pi-val${cls?' '+cls:''}">${val}</div></div>`
    : '';
  const sec = (title) => `<div class="pi-section">${title}</div>`;
  panel.innerHTML = `
    <div class="pi-header">
      <div class="pi-title-block">
        <div class="pi-type">Земельный участок</div>
        <div class="pi-cn">${p.cn}</div>
        ${badge}
      </div>
      <button class="pi-close" onclick="closeParcelInfo()" title="Закрыть">✕</button>
    </div>
    <div class="pi-body">
      ${sec('Расположение')}
      ${row('Кадастровый квартал', p.kvartal, 'mono')}
      ${row('Адрес', p.addr || 'не указан')}
      ${row('Координаты центра', p.lat ? `${p.lat.toFixed(6)}°, ${p.lon.toFixed(6)}°` : '')}
      ${sec('Характеристики')}
      ${row('Площадь', p.area)}
      ${row('Дата постановки на учёт', p.date_cn)}
      ${row('Статус', p.status)}
      ${row('Категория земель', p.cat)}
      ${row('Вид разрешённого использования', p.util)}
      ${row('Форма собственности', p.ownership)}
      ${row('Функциональная зона', p.zone)}
      ${p.cad_cost || p.cad_unit ? sec('Кадастровая оценка') : ''}
      ${row('Кадастровая стоимость', p.cad_cost, 'cost')}
      ${row('Удельный показатель', p.cad_unit)}
    </div>
    <div class="pi-footer">
      <a class="pi-link" href="https://nspd.gov.ru/map?thematic=PKK" target="_blank" rel="noopener">Открыть на карте НСПД ↗</a>
    </div>`;
  panel.style.display = 'flex';
}

function addParcelLayer(p) {
  let layer;
  const tip = p.cn + (p.addr ? '\n' + p.addr : '');
  if (p.geometry && p.geometry.type && p.geometry.type !== 'Point') {
    try {
      const coords = p.geometry.type === 'Polygon'
        ? p.geometry.coordinates[0].map(c => [c[1], c[0]])
        : p.geometry.coordinates[0][0].map(c => [c[1], c[0]]);
      const style = p.inP
        ? { color: '#16a34a', fillColor: '#22c55e', fillOpacity: 0.25, weight: 2 }
        : { color: '#b45309', fillColor: '#f59e0b', fillOpacity: 0.2, weight: 2 };
      layer = L.polygon(coords, style)
        .bindTooltip(tip, { sticky: true, className: 'parcel-tip' })
        .on('click', e => { L.DomEvent.stopPropagation(e); selectParcel(p.cn); })
        .addTo(map);
      parcelMkrs.push({ cn: p.cn, layer, origStyle: { ...style } });
      return;
    } catch(e) {}
  }
  // fallback — маркер
  const color = p.inP ? '#22c55e' : '#f59e0b';
  const origStyle = { color, fillColor: color, fillOpacity: 0.5, weight: 2 };
  layer = L.circleMarker([p.lat, p.lon], { radius: 6, ...origStyle })
    .bindTooltip(tip, { sticky: true })
    .on('click', e => { L.DomEvent.stopPropagation(e); selectParcel(p.cn); })
    .addTo(map);
  parcelMkrs.push({ cn: p.cn, layer, origStyle });
}

// ── Клавиатура (главная карта) ───────────────────
function _initMapKeyboard() {
  document.addEventListener('keydown', e => {
    if (document.getElementById('pdf-editor').style.display !== 'none') return;
    if (e.target.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveProject(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoPolyPt(); return; }
    if (e.key === 'Escape') { finishPolyDraw(); setSt('Рисование отменено', ''); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey) {
      const al = getActiveLayer();
      if (al) deleteLayer({ stopPropagation: () => {} }, al.id);
      return;
    }
    if (e.key === 'f' || e.key === 'F') { fitActive(); return; }
    if (e.key === 'g' || e.key === 'G') {
      if (!document.getElementById('btn-gen-szz').disabled) generateSzz();
      return;
    }
  });
}

// ── Вспомогательная функция Turf polygon ─────────
function _turfPoly(l) {
  const ring = l.poly.map(p => [p[1], p[0]]);
  ring.push(ring[0]);
  return turf.polygon([ring]);
}

// ── Операции с полигонами ─────────────────────────
function _applyPolyOp(opName, resultCoords, l1, l2, color) {
  if (!resultCoords) { setSt('Результат операции пуст', 'err'); return; }
  const coords = resultCoords.map(c => [c[1], c[0]]);
  const ll = coords.map(p => L.latLng(p[0], p[1]));
  const style = { color, weight: 2, fillColor: color, fillOpacity: 0.18 };
  const layer = L.polygon(ll, style).addTo(map);
  addMapLayer(l1.type, `${l1.name} ${opName} ${l2.name}`, coords, layer);
  map.fitBounds(layer.getBounds(), { padding: [30, 30] });
}

function polyUnion() {
  const al = getActiveLayer();
  const sel2Id = parseInt(document.getElementById('poly-op-select')?.value);
  const l2 = mapLayers.find(l => l.id === sel2Id);
  if (!al || !l2) { setSt('Выбери активный слой и второй слой', 'err'); return; }
  try {
    const res = turf.union(_turfPoly(al), _turfPoly(l2));
    if (!res) { setSt('Объединение невозможно', 'err'); return; }
    const ring = res.geometry.type === 'MultiPolygon'
      ? res.geometry.coordinates[0][0]
      : res.geometry.coordinates[0];
    _applyPolyOp('∪', ring, al, l2, al.color);
    setSt(`Объединение: ${al.name} ∪ ${l2.name}`, 'ok');
  } catch(e) { setSt('Ошибка объединения: ' + e.message, 'err'); }
}

function polyDifference() {
  const al = getActiveLayer();
  const sel2Id = parseInt(document.getElementById('poly-op-select')?.value);
  const l2 = mapLayers.find(l => l.id === sel2Id);
  if (!al || !l2) { setSt('Выбери активный слой и второй слой', 'err'); return; }
  try {
    const res = turf.difference(_turfPoly(al), _turfPoly(l2));
    if (!res) { setSt('Нет разности — полигоны не пересекаются?', 'err'); return; }
    const ring = res.geometry.type === 'MultiPolygon'
      ? res.geometry.coordinates[0][0]
      : res.geometry.coordinates[0];
    _applyPolyOp('−', ring, al, l2, al.color);
    setSt(`Вычитание: ${al.name} − ${l2.name}`, 'ok');
  } catch(e) { setSt('Ошибка вычитания: ' + e.message, 'err'); }
}

function polyIntersect() {
  const al = getActiveLayer();
  const sel2Id = parseInt(document.getElementById('poly-op-select')?.value);
  const l2 = mapLayers.find(l => l.id === sel2Id);
  if (!al || !l2) { setSt('Выбери активный слой и второй слой', 'err'); return; }
  try {
    const res = turf.intersect(_turfPoly(al), _turfPoly(l2));
    if (!res) { setSt('Полигоны не пересекаются', 'err'); return; }
    const ring = res.geometry.type === 'MultiPolygon'
      ? res.geometry.coordinates[0][0]
      : res.geometry.coordinates[0];
    _applyPolyOp('∩', ring, al, l2, '#22c55e');
    setSt(`Пересечение: ${al.name} ∩ ${l2.name}`, 'ok');
  } catch(e) { setSt('Ошибка пересечения: ' + e.message, 'err'); }
}

function _updatePolyOpsPanel(l) {
  const panel = document.getElementById('poly-ops-panel');
  if (!panel) return;
  if (!l) { panel.style.display = 'none'; return; }
  const others = mapLayers.filter(x => x.id !== l.id);
  if (!others.length) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const sel = document.getElementById('poly-op-select');
  if (sel) {
    sel.innerHTML = others.map(x =>
      `<option value="${x.id}">[${x.type === 'szz' ? 'СЗЗ' : 'ЗУ'}] ${x.name}</option>`
    ).join('');
  }
}

function toggleFills() {
  const hideSzz = document.getElementById('pdf-no-fill-szz')?.checked ?? false;
  const hideZu  = document.getElementById('pdf-no-fill-zu')?.checked  ?? false;
  mapLayers.forEach(l => {
    if (l.layer && l.layer.setStyle) {
      const s = l._psStyle || {};
      const def = l.type === 'szz' ? 0.1 : 0.15;
      const fo  = l.type === 'szz' ? (hideSzz ? 0 : (s.fillOpacity ?? def)) : (hideZu ? 0 : (s.fillOpacity ?? def));
      l.layer.setStyle({ fillOpacity: fo });
    }
  });
  // Обновить и слои на PDF-карте
  if (typeof _refreshPdfMapLayers === 'function') {
    // Временно применяем fillOpacity к _psStyle для передачи в refresh
    mapLayers.forEach(l => {
      const s = l._psStyle || {};
      const def = l.type === 'szz' ? 0.1 : 0.15;
      const fo  = l.type === 'szz' ? (hideSzz ? 0 : (s.fillOpacity ?? def)) : (hideZu ? 0 : (s.fillOpacity ?? def));
      l._tempFillOpacity = fo;
    });
    _refreshPdfMapLayersWithOpacity();
    mapLayers.forEach(l => { delete l._tempFillOpacity; });
  }
}
