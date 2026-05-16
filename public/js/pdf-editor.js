// ═══════════════════════════════════════════════
// PDF-EDITOR.JS — фотошоп-редактор поверх карты
// ═══════════════════════════════════════════════
//
// Архитектура:
//  • #pdf-editor — fullscreen overlay
//  • #pdf-canvas — A4 контейнер, масштабируется через CSS transform
//  • #pdf-map    — Leaflet карта ВНУТРИ canvas (не снаружи!)
//  • .ps-obj     — абсолютно позиционированные объекты поверх карты
//  • Drag/resize через PointerEvents (надёжнее чем mouse)
//  • Состояние сохраняется в localStorage
// ═══════════════════════════════════════════════

'use strict';

// ── Состояние ────────────────────────────────────
let pdfObjects   = [];   // массив объектов
let pdfSelId     = null; // id выбранного
let pdfTool      = 'select';
let pdfObjCnt    = 0;
let pdfOrientation = 'landscape'; // 'portrait' | 'landscape'
let pdfMap       = null; // отдельная карта внутри pdf-canvas
let _drawGhost   = null;
let _drawStart   = null;
let pdfMapSat    = false; // спутник/схема для pdf-карты
let pdfMapDrag   = false; // режим перемещения карты
let _pdfTile     = null;  // текущий тайловый слой pdf-карты

// ── Snap / Align ──────────────────────────────────
let _snapGuides  = [];    // активные направляющие
let _snapEnabled = true;  // включён ли магнит
const SNAP_DIST  = 10;    // пикселей для притяжения

// ── Инсет-карты (лупа) ───────────────────────────
const _insetMaps = {};    // id → L.map

// ── Слои полигонов на pdf-карте ──────────────────
let _pdfGeoLayers = [];   // GeoJSON-слои на pdfMap (чтобы перерисовывать при смене проекта)

// ── Undo / Redo ───────────────────────────────────
let _undoStack   = [];
let _redoStack   = [];

// ── Multi-select ──────────────────────────────────
let pdfSelIds    = [];   // все выбранные объекты
let _groupCounter = 0;

// ── Copy / Paste ──────────────────────────────────
let _clipboard   = null;

// ── Canvas zoom ───────────────────────────────────
let _zoomMul     = 1.0;

// ── Grid ──────────────────────────────────────────
let _gridEnabled = false;
let _gridSnap    = false;
const _gridSize  = 20;

// ── Path drawing ──────────────────────────────────
let _pathDraft    = null;   // { type, pts, freehand }
let _pathGhostSvg = null;   // SVG-превью пути

const CANVAS_W_L = 1123; // landscape
const CANVAS_H_L = 794;
const CANVAS_W_P = 794;  // portrait
const CANVAS_H_P = 1123;

// ── Вход/выход ───────────────────────────────────
function enterPdfMode() {
  const editor = document.getElementById('pdf-editor');
  editor.style.display = 'flex';

  // Строим интерфейс редактора
  _buildEditorUI();

  // Инициализируем карту внутри pdf-canvas (если ещё не создана)
  if (!pdfMap) _initPdfMap();
  else _refreshPdfMapLayers(); // При повторном открытии — обновить слои проекта

  // Восстанавливаем объекты из localStorage
  _loadState();

  // Если объектов нет — добавляем стандартные
  if (pdfObjects.length === 0) _addDefaultObjects();

  _applyOrientation();
  _renderAll();
  _renderLayersList();
  _renderProps();
  _initCanvasZoomWheel();
  _initCanvasDrawing();
  _initPathDrawing();
  _initRubberBand();
  _initSidebarResize();

  setSt('Режим редактора PDF — выбирай объекты и настраивай', 'ok');
}

function exitPdfMode() {
  _saveState();
  document.getElementById('pdf-editor').style.display = 'none';
  setSt('Выход из редактора PDF', 'ok');
}

// ── Инициализация карты внутри pdf-canvas ────────
function _initPdfMap() {
  // Создаём div карты внутри #pdf-canvas
  const canvas = document.getElementById('pdf-canvas');
  const mapDiv = document.createElement('div');
  mapDiv.id = 'pdf-map';
  canvas.insertBefore(mapDiv, canvas.firstChild);

  // Копируем центр/зум основной карты
  const center = map.getCenter();
  const zoom   = map.getZoom();

  pdfMap = L.map('pdf-map', {
    center, zoom,
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    keyboard: false,
    attributionControl: false,
  });

  // Та же подложка что на основной карте
  pdfMapSat = useSat;
  if (useSat) {
    _pdfTile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19 });
  } else {
    _pdfTile = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 });
  }
  _pdfTile.addTo(pdfMap);

  // Копируем слои (полигоны)
  _pdfGeoLayers = [];
  mapLayers.forEach(l => {
    if (l.layer && l.layer.toGeoJSON) {
      try {
        const geo   = l.layer.toGeoJSON();
        const style = l._psStyle || { color: l.color, fillColor: l.color, fillOpacity: l.type === 'szz' ? 0.1 : 0.15, weight: 2 };
        const gl = L.geoJSON(geo, { style: () => style }).addTo(pdfMap);
        _pdfGeoLayers.push(gl);
      } catch(e) {}
    }
  });

  // Масштаб
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(pdfMap);

  // При изменении зума/позиции — обновляем объекты масштаба
  pdfMap.on('zoomend moveend', () => {
    setTimeout(() => {
      pdfObjects.filter(o => o.type === 'scale').forEach(obj => {
        const el = document.getElementById(obj.id);
        if (el) _renderObjContent(el, obj);
      });
    }, 120);
  });
}

// ── Обновить слои полигонов на pdf-карте (при смене проекта) ──
function _refreshPdfMapLayers() {
  if (!pdfMap) return;
  // Удаляем старые GeoJSON-слои
  _pdfGeoLayers.forEach(gl => { try { pdfMap.removeLayer(gl); } catch(e) {} });
  _pdfGeoLayers = [];
  // Добавляем текущие
  mapLayers.forEach(l => {
    if (l.layer && l.layer.toGeoJSON) {
      try {
        const geo   = l.layer.toGeoJSON();
        const style = l._psStyle || { color: l.color, fillColor: l.color, fillOpacity: l.type === 'szz' ? 0.1 : 0.15, weight: 2 };
        const gl = L.geoJSON(geo, { style: () => style }).addTo(pdfMap);
        _pdfGeoLayers.push(gl);
      } catch(e) {}
    }
  });
  // Перецентрировать на активный слой если есть
  const valid = mapLayers.filter(l => l.layer && l.layer.getBounds);
  if (valid.length) {
    let bounds = valid[0].layer.getBounds();
    valid.slice(1).forEach(l => bounds.extend(l.layer.getBounds()));
    try { pdfMap.fitBounds(bounds, { padding: [24, 24] }); } catch(e) {}
  }
  setTimeout(() => { if (pdfMap) pdfMap.invalidateSize(); }, 150);
}

// Быстрое обновление fillOpacity без пересоздания слоёв (для toggleFills)
function _refreshPdfMapLayersWithOpacity() {
  if (!pdfMap || !_pdfGeoLayers.length) return;
  _pdfGeoLayers.forEach((gl, i) => {
    const l = mapLayers[mapLayers.length - 1 - i] ?? mapLayers[i]; // учитываем порядок unshift
    if (!l) return;
    const fo = l._tempFillOpacity ?? (l._psStyle?.fillOpacity ?? (l.type === 'szz' ? 0.1 : 0.15));
    try { gl.setStyle({ fillOpacity: fo }); } catch(e) {}
  });
}

// ═══════════════════════════════════════════════════
// ── ИНСТРУМЕНТЫ РИСОВАНИЯ ПУТИ ──────────────────
// ═══════════════════════════════════════════════════

// ── Вспомогательные функции пути ─────────────────
function _updatePathBBox(obj) {
  const pts = obj.data.pts || [];
  if (!pts.length) return;
  const pad = 24;
  let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
  pts.forEach(p => { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); });
  obj.data.x = minX - pad;
  obj.data.y = minY - pad;
  obj.data.w = Math.max(maxX - minX + pad*2, 10);
  obj.data.h = Math.max(maxY - minY + pad*2, 10);
}

function _catmullToBezierLocal(pts, closed) {
  if (pts.length < 2) return '';
  const ext = closed
    ? [pts[pts.length-1], ...pts, pts[0], pts[1]]
    : [pts[0], ...pts, pts[pts.length-1]];
  let d = `M ${ext[1].x} ${ext[1].y}`;
  for (let i = 1; i < ext.length - 2; i++) {
    const p0=ext[i-1], p1=ext[i], p2=ext[i+1], p3=ext[i+2];
    const cp1x = p1.x + (p2.x-p0.x)/6, cp1y = p1.y + (p2.y-p0.y)/6;
    const cp2x = p2.x - (p3.x-p1.x)/6, cp2y = p2.y - (p3.y-p1.y)/6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x} ${p2.y}`;
  }
  if (closed) d += ' Z';
  return d;
}

// Алгоритм Ramer-Douglas-Peucker для упрощения фриханда
function _simplifyPath(pts, tolerance) {
  if (pts.length <= 2) return pts;
  function perpDist(pt, a, b) {
    const dx=b.x-a.x, dy=b.y-a.y, len=Math.sqrt(dx*dx+dy*dy)||1;
    return Math.abs(dx*(a.y-pt.y)-(a.x-pt.x)*dy)/len;
  }
  function rdp(points, s, e, eps) {
    let maxD=0, idx=0;
    for (let i=s+1;i<e;i++) { const d=perpDist(points[i],points[s],points[e]); if(d>maxD){maxD=d;idx=i;} }
    if (maxD>eps) return [...rdp(points,s,idx,eps), ...rdp(points,idx,e,eps)];
    return [points[e]];
  }
  return [pts[0], ...rdp(pts, 0, pts.length-1, tolerance)];
}

// ── Рендер SVG объектов ───────────────────────────
function _renderPathSvg(obj) {
  const d = obj.data;
  const pts = d.pts || [];
  if (pts.length < 2) return '<svg style="width:100%;height:100%"></svg>';
  const lx = d.x, ly = d.y;
  const localPts = pts.map(p => `${(p.x-lx).toFixed(1)},${(p.y-ly).toFixed(1)}`).join(' ');
  const fill = d.closed && d.bg && d.bg !== 'transparent' ? d.bg : 'none';
  const tag  = d.closed ? 'polygon' : 'polyline';
  return `<svg width="${d.w}" height="${d.h}" viewBox="0 0 ${d.w} ${d.h}" style="overflow:visible;display:block;pointer-events:none">
    <${tag} points="${localPts}" fill="${fill}" stroke="${d.strokeColor}" stroke-width="${d.strokeW}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function _renderBezierSvg(obj) {
  const d = obj.data;
  const pts = d.pts || [];
  if (pts.length < 2) return '<svg style="width:100%;height:100%"></svg>';
  const lx = d.x, ly = d.y;
  const localPts = pts.map(p => ({ x: p.x-lx, y: p.y-ly }));
  const pathD = _catmullToBezierLocal(localPts, d.closed);
  const fill  = d.closed && d.bg && d.bg !== 'transparent' ? d.bg : 'none';
  return `<svg width="${d.w}" height="${d.h}" viewBox="0 0 ${d.w} ${d.h}" style="overflow:visible;display:block;pointer-events:none">
    <path d="${pathD}" fill="${fill}" stroke="${d.strokeColor}" stroke-width="${d.strokeW}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ── Звезда — 5 лучей ──────────────────────────────
function _starPoints(w, h, sw) {
  const cx = w / 2, cy = h / 2;
  const outerR = Math.min(cx, cy) - sw / 2;
  const innerR = outerR * 0.42;
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const ang = (i * Math.PI * 2 / 10) - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    pts.push(`${(cx + r * Math.cos(ang)).toFixed(1)},${(cy + r * Math.sin(ang)).toFixed(1)}`);
  }
  return pts.join(' ');
}

// ── SVG-рендер для примитивных фигур ─────────────
function _renderShapeContent(obj) {
  const d = obj.data;
  const sw = d.strokeW || 0;
  const dash = d.strokeDash ? ` stroke-dasharray="${d.strokeDash}"` : '';
  const fill = (d.bg && d.bg !== 'transparent') ? d.bg : 'none';
  const stroke = (d.strokeColor && d.strokeColor !== 'transparent' && sw > 0) ? d.strokeColor : 'none';
  const strokeAttr = stroke !== 'none' ? ` stroke="${stroke}" stroke-width="${sw}"${dash}` : '';
  const w = Math.max(d.w, 2), h = Math.max(d.h, 2);

  let innerSvg = '';
  if (obj.type === 'ellipse') {
    const cx = w / 2, cy = h / 2;
    const rx = Math.max(0.5, cx - sw / 2), ry = Math.max(0.5, cy - sw / 2);
    innerSvg = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"${strokeAttr}/>`;
  } else if (obj.type === 'line') {
    const my = h / 2;
    innerSvg = `<line x1="0" y1="${my}" x2="${w}" y2="${my}" stroke="${stroke !== 'none' ? stroke : d.strokeColor || '#ef4444'}" stroke-width="${sw || 2}"${dash} stroke-linecap="round"/>`;
  } else if (obj.type === 'triangle') {
    const pts = `${w/2},${sw/2} ${w-sw/2},${h-sw/2} ${sw/2},${h-sw/2}`;
    innerSvg = `<polygon points="${pts}" fill="${fill}"${strokeAttr}/>`;
  } else if (obj.type === 'diamond') {
    const pts = `${w/2},${sw/2} ${w-sw/2},${h/2} ${w/2},${h-sw/2} ${sw/2},${h/2}`;
    innerSvg = `<polygon points="${pts}" fill="${fill}"${strokeAttr}/>`;
  } else if (obj.type === 'star') {
    innerSvg = `<polygon points="${_starPoints(w, h, sw)}" fill="${fill}"${strokeAttr}/>`;
  } else { // rect
    const r = d.radius || 0;
    innerSvg = `<rect x="${sw/2}" y="${sw/2}" width="${Math.max(0,w-sw)}" height="${Math.max(0,h-sw)}" rx="${r}" ry="${r}" fill="${fill}"${strokeAttr}/>`;
  }

  const textContent = ['rect','ellipse'].includes(obj.type) && (d.content !== undefined)
    ? `<div class="ps-text-content" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:${d.textAlign==='left'?'flex-start':d.textAlign==='right'?'flex-end':'center'};padding:4px 8px;white-space:pre-wrap;word-break:break-word;pointer-events:none;user-select:none">${d.content || ''}</div>`
    : '';

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;inset:0;pointer-events:none;overflow:visible">${innerSvg}</svg>${textContent}`;
}

function _renderCalloutHtml(obj) {
  const d = obj.data;
  // tx/ty — положение хвоста в локальных координатах объекта
  const tx = (d.tailX ?? 0) - d.x;
  const ty = (d.tailY ?? 0) - d.y;
  const w  = d.w, h = d.h;
  // Точка крепления хвоста к боксу (ближайший край)
  const ax = Math.max(10, Math.min(w-10, tx));
  const ay = Math.max(10, Math.min(h-10, ty));
  const nx = ty-ay, ny = -(tx-ax), len = Math.sqrt(nx*nx+ny*ny)||1, tw=10;
  const p1 = `${(ax+nx/len*tw/2).toFixed(1)},${(ay+ny/len*tw/2).toFixed(1)}`;
  const p2 = `${(ax-nx/len*tw/2).toFixed(1)},${(ay-ny/len*tw/2).toFixed(1)}`;
  const r  = d.radius||8;
  return `<div style="position:absolute;inset:0;pointer-events:none">
    <svg style="position:absolute;inset:0;overflow:visible;width:${w}px;height:${h}px;pointer-events:none">
      <polygon points="${p1} ${tx.toFixed(1)},${ty.toFixed(1)} ${p2}" fill="${d.bg}" stroke="${d.strokeColor}" stroke-width="${d.strokeW}" stroke-linejoin="round"/>
      <rect x="0" y="0" width="${w}" height="${h}" fill="${d.bg}" stroke="${d.strokeColor}" stroke-width="${d.strokeW}" rx="${r}"/>
    </svg>
    <div class="callout-text-inner" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:6px 12px;font-size:${d.fontSize}px;color:${d.color};font-family:${d.fontFamily};font-weight:${d.fontWeight};word-break:break-word;z-index:1;pointer-events:none;user-select:none">${d.content||'Выноска'}</div>
  </div>`;
}

// ── Выноска с полочкой (GIS-style leader) ────────
function _renderLeaderHtml(obj) {
  const d = obj.data;
  const w = d.w, h = d.h;
  const sw = d.strokeW || 1.5;
  const color = d.strokeColor || '#0f172a';
  const bg = (d.bg && d.bg !== 'transparent') ? d.bg : 'transparent';

  // Tail point in local coordinates (may be outside bbox)
  const tx = (d.tailX ?? d.x + w / 2) - d.x;
  const ty = (d.tailY ?? d.y + h + 60) - d.y;

  // Shelf sits at the BOTTOM edge of bbox
  const shelfY = h - sw;

  // Pick shelf anchor: end closest to tail
  const dLeft  = Math.hypot(tx - 0, ty - shelfY);
  const dRight = Math.hypot(tx - w, ty - shelfY);
  const anchorX = dLeft <= dRight ? 0 : w;

  // Direction from anchor to tail
  const ang = Math.atan2(ty - shelfY, tx - anchorX);
  const ahl = 9;
  // Filled arrowhead triangle
  const ax1x = (tx - ahl * Math.cos(ang - 0.38)).toFixed(1);
  const ax1y = (ty - ahl * Math.sin(ang - 0.38)).toFixed(1);
  const ax2x = (tx - ahl * Math.cos(ang + 0.38)).toFixed(1);
  const ax2y = (ty - ahl * Math.sin(ang + 0.38)).toFixed(1);

  const rad = d.radius || 0;
  return `<div style="position:absolute;inset:0;pointer-events:none;overflow:visible">
    <svg style="position:absolute;left:0;top:0;overflow:visible;pointer-events:none" width="${w}" height="${h}">
      <!-- Фон текстового блока -->
      ${bg !== 'transparent' ? `<rect x="0" y="0" width="${w}" height="${shelfY}" fill="${bg}" rx="${rad}"/>` : ''}
      <!-- Полочка -->
      <line x1="0" y1="${shelfY}" x2="${w}" y2="${shelfY}" stroke="${color}" stroke-width="${sw}"/>
      <!-- Выноска от конца полочки к острию -->
      <line x1="${anchorX}" y1="${shelfY}" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${color}" stroke-width="${sw}"/>
      <!-- Наконечник -->
      <polygon points="${tx.toFixed(1)},${ty.toFixed(1)} ${ax1x},${ax1y} ${ax2x},${ax2y}" fill="${color}"/>
    </svg>
    <div class="leader-text-inner" style="
      position:absolute;left:0;right:0;top:0;bottom:${sw + 2}px;
      display:flex;align-items:flex-end;
      padding:3px 8px;
      font-size:${d.fontSize}px;color:${d.color};
      font-family:${d.fontFamily};font-weight:${d.fontWeight};
      font-style:${d.fontStyle||'normal'};
      text-align:${d.textAlign||'left'};
      pointer-events:none;user-select:none;
      white-space:pre-wrap;word-break:break-word;
      -webkit-text-stroke:${(d.textStrokeW>0)?`${d.textStrokeW}px ${d.textStrokeColor}`:'0'};
    ">${d.content||'Подпись объекта'}</div>
  </div>`;
}

// ── Хендлы точек пути ─────────────────────────────
function _renderPathHandles(el, obj) {
  const pts = obj.data.pts || [];
  pts.forEach((pt, idx) => {
    const h = document.createElement('div');
    h.className = `ps-handle ps-path-pt${idx===0?' ps-path-first':''}`;
    h.style.left = (pt.x - obj.data.x - 6) + 'px';
    h.style.top  = (pt.y - obj.data.y - 6) + 'px';
    el.appendChild(h);
    h.addEventListener('pointerdown', e => _onPathPtDrag(e, obj, idx));
  });
  // Ручка поворота
  const rEl = document.createElement('div');
  rEl.className = 'ps-handle ps-rotate-handle';
  el.appendChild(rEl);
  rEl.addEventListener('pointerdown', e => _onRotateStart(e, obj));
}

function _onPathPtDrag(e, obj, idx) {
  e.stopPropagation(); e.preventDefault();
  _pushUndo();
  const el = document.getElementById(obj.id);
  el.setPointerCapture(e.pointerId);
  const canvas = document.getElementById('pdf-canvas');

  function onMove(ev) {
    const rect = canvas.getBoundingClientRect();
    let nx = (ev.clientX - rect.left) * (canvas.offsetWidth  / rect.width);
    let ny = (ev.clientY - rect.top)  * (canvas.offsetHeight / rect.height);
    if (_gridSnap) { nx = Math.round(nx/_gridSize)*_gridSize; ny = Math.round(ny/_gridSize)*_gridSize; }
    obj.data.pts[idx] = { x: Math.round(nx), y: Math.round(ny) };
    _updatePathBBox(obj);
    el.style.left = obj.data.x+'px'; el.style.top = obj.data.y+'px';
    el.style.width = obj.data.w+'px'; el.style.height = obj.data.h+'px';
    _renderObjContent(el, obj); _updateHandles(el, obj);
  }
  function onUp() {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

function _renderCalloutHandles(el, obj) {
  // Хендл хвоста выноски
  const h = document.createElement('div');
  h.className = 'ps-handle ps-callout-tail';
  h.style.left = ((obj.data.tailX||0) - obj.data.x - 8) + 'px';
  h.style.top  = ((obj.data.tailY||0) - obj.data.y - 8) + 'px';
  h.title = 'Переместить острие выноски';
  el.appendChild(h);
  h.addEventListener('pointerdown', e => _onCalloutTailDrag(e, obj));
}

function _onCalloutTailDrag(e, obj) {
  e.stopPropagation(); e.preventDefault();
  _pushUndo();
  const el = document.getElementById(obj.id);
  el.setPointerCapture(e.pointerId);
  const canvas = document.getElementById('pdf-canvas');

  function onMove(ev) {
    const rect = canvas.getBoundingClientRect();
    obj.data.tailX = Math.round((ev.clientX - rect.left) * (canvas.offsetWidth  / rect.width));
    obj.data.tailY = Math.round((ev.clientY - rect.top)  * (canvas.offsetHeight / rect.height));
    _renderObjContent(el, obj); _updateHandles(el, obj);
  }
  function onUp() {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

// ── Ghost-превью пути ─────────────────────────────
function _showPathGhost() {
  const canvas = document.getElementById('pdf-canvas');
  if (document.getElementById('path-ghost-svg')) return;
  _pathGhostSvg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  _pathGhostSvg.id = 'path-ghost-svg';
  _pathGhostSvg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5000;overflow:visible';
  canvas.appendChild(_pathGhostSvg);
}

function _updatePathGhost(curX, curY) {
  if (!_pathGhostSvg || !_pathDraft) return;
  const pts   = [...(_pathDraft.pts||[]), { x:curX, y:curY }];
  const color = ({ bezier:'#8b5cf6', 'polygon-shape':'#22c55e', callout:'#f59e0b' })[pdfTool] || '#3b82f6';

  let lineEl = '';
  if (pdfTool === 'bezier' && pts.length >= 2) {
    lineEl = `<path d="${_catmullToBezierLocal(pts,false)}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="6,3" stroke-linecap="round"/>`;
  } else if (pdfTool === 'callout' && _pathDraft.pts.length === 1) {
    const t = _pathDraft.pts[0];
    lineEl = `<line x1="${t.x}" y1="${t.y}" x2="${curX}" y2="${curY}" stroke="${color}" stroke-width="2" stroke-dasharray="6,3"/>
              <circle cx="${t.x}" cy="${t.y}" r="5" fill="${color}"/>`;
  } else {
    const pStr = pts.map(p=>`${p.x},${p.y}`).join(' ');
    lineEl = `<polyline points="${pStr}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="6,3" stroke-linecap="round"/>`;
  }

  const dots = (_pathDraft.pts||[]).map((p,i) =>
    `<circle cx="${p.x}" cy="${p.y}" r="${i===0?7:4}" fill="${i===0?'#22c55e':color}" stroke="white" stroke-width="2"/>`
  ).join('');

  _pathGhostSvg.innerHTML = lineEl + dots;
}

function _clearPathGhost() {
  if (_pathGhostSvg) { _pathGhostSvg.remove(); _pathGhostSvg = null; }
  _pathDraft = null;
}

function _finishPath(closed) {
  if (!_pathDraft || (_pathDraft.pts||[]).length < 2) { _clearPathGhost(); return; }
  let pts = _pathDraft.pts;
  if (_pathDraft.freehand) pts = _simplifyPath(pts, 4);

  const type = (_pathDraft.type === 'polygon-shape' || _pathDraft.type === 'freehand') ? 'path' : _pathDraft.type;
  const isClosed = closed || _pathDraft.type === 'polygon-shape';
  const color = ({ bezier:'#8b5cf6', path:'#3b82f6' })[type] || '#3b82f6';
  const fill  = isClosed ? hexToRgba(color, 0.12) : 'transparent';

  const pad=24;
  let minX=pts[0].x, maxX=pts[0].x, minY=pts[0].y, maxY=pts[0].y;
  pts.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});

  _clearPathGhost();
  _pushUndo();
  createPdfObj(type, {
    pts, closed:isClosed,
    x:minX-pad, y:minY-pad, w:Math.max(maxX-minX+pad*2,10), h:Math.max(maxY-minY+pad*2,10),
    strokeColor:color, bg:fill,
    content: '__' + type + '__',
    name: isClosed ? 'Фигура' : type==='bezier' ? 'Кривая' : 'Путь',
  });
  setPdfTool('select');
}

// ── Инициализация рисования пути в canvas ─────────
function _initPathDrawing() {
  const canvas = document.getElementById('pdf-canvas');
  // Защита от повторной привязки при каждом enterPdfMode()
  if (canvas._pathDrawingBound) return;
  canvas._pathDrawingBound = true;
  const PATH_TOOLS = ['path','bezier','polygon-shape','freehand','callout'];

  // Клик — добавить точку (только для не-фриханд)
  canvas.addEventListener('click', e => {
    if (!PATH_TOOLS.includes(pdfTool) || pdfTool==='freehand') return;
    if (e.target.closest('.ps-obj') && !e.target.closest('#path-ghost-svg')) return;
    const rect  = canvas.getBoundingClientRect();
    const sx    = canvas.offsetWidth/rect.width, sy = canvas.offsetHeight/rect.height;
    const x = Math.round((e.clientX-rect.left)*sx);
    const y = Math.round((e.clientY-rect.top)*sy);

    if (pdfTool === 'callout') {
      if (!_pathDraft) {
        _pathDraft = { type:'callout', pts:[{x,y}] };
        _showPathGhost();
      } else {
        // Второй клик — создать выноску
        const tailPt = _pathDraft.pts[0];
        _clearPathGhost();
        _pushUndo();
        createPdfObj('callout', { tailX:tailPt.x, tailY:tailPt.y, x:x-80, y:y-28, w:160, h:56, name:'Выноска' });
        setPdfTool('select');
      }
      return;
    }

    if (!_pathDraft) {
      _pathDraft = { type:pdfTool, pts:[{x,y}] };
      _showPathGhost();
    } else {
      // Кликнули рядом с первой точкой → замкнуть (polygon-shape)
      const fp = _pathDraft.pts[0];
      if (['polygon-shape'].includes(pdfTool) && _pathDraft.pts.length >= 3
          && Math.hypot(x-fp.x, y-fp.y) < 18) {
        _finishPath(true); return;
      }
      _pathDraft.pts.push({x,y});
      _updatePathGhost(x, y);
    }
  });

  // Двойной клик — завершить путь
  canvas.addEventListener('dblclick', e => {
    if (!PATH_TOOLS.includes(pdfTool) || pdfTool==='freehand' || pdfTool==='callout') return;
    if (!_pathDraft || _pathDraft.pts.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    // Двойной клик добавляет дублирующую точку через одиночный click — удаляем её
    if (_pathDraft.pts.length >= 2) _pathDraft.pts.pop();
    _finishPath(pdfTool === 'polygon-shape');
  });

  // Движение мыши — ghost
  canvas.addEventListener('pointermove', e => {
    if (!_pathDraft || _pathDraft.freehand) return;
    const rect = canvas.getBoundingClientRect();
    _updatePathGhost(
      (e.clientX-rect.left)*(canvas.offsetWidth/rect.width),
      (e.clientY-rect.top) *(canvas.offsetHeight/rect.height)
    );
  });
}

// ═══════════════════════════════════════════════════
// ── ПОВОРОТ ОБЪЕКТА ──────────────────────────────
// ═══════════════════════════════════════════════════

// ── Поворот объекта ───────────────────────────────
function _onRotateStart(e, obj) {
  e.stopPropagation();
  e.preventDefault();
  _pushUndo();
  const el = document.getElementById(obj.id);
  el.setPointerCapture(e.pointerId);

  function getCenterPage() {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  const c0 = getCenterPage();
  const a0 = Math.atan2(e.clientY - c0.y, e.clientX - c0.x) * 180 / Math.PI;
  const r0 = obj.data.rotation || 0;

  function onMove(ev) {
    const c = getCenterPage();
    const a = Math.atan2(ev.clientY - c.y, ev.clientX - c.x) * 180 / Math.PI;
    let nr = r0 + a - a0;
    if (ev.shiftKey) nr = Math.round(nr / 15) * 15;
    obj.data.rotation = Math.round(nr * 10) / 10;
    el.style.transform = `rotate(${obj.data.rotation}deg)`;
    const ri = document.getElementById('pp-rotation');
    if (ri) ri.value = obj.data.rotation;
  }
  function onUp() {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

// ── Copy / Paste ──────────────────────────────────
function copyPdfObj() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  _clipboard = { type: obj.type, name: obj.name, data: JSON.parse(JSON.stringify(obj.data)) };
  setSt('Скопировано ✓', 'ok');
}

function pastePdfObj() {
  if (!_clipboard) { setSt('Буфер пуст', 'err'); return; }
  _pushUndo();
  createPdfObj(_clipboard.type, {
    ..._clipboard.data,
    x: (_clipboard.data.x || 0) + 24,
    y: (_clipboard.data.y || 0) + 24,
    name: _clipboard.name,
  });
  setSt('Вставлено ✓', 'ok');
}

// ── Canvas zoom ───────────────────────────────────
function zoomCanvas(delta) {
  _zoomMul = Math.max(0.25, Math.min(3, _zoomMul + delta));
  _applyOrientation();
  if (pdfMap) setTimeout(() => pdfMap.invalidateSize(), 300);
  Object.values(_insetMaps).forEach(m => setTimeout(() => m.invalidateSize(), 300));
}

function _initCanvasZoomWheel() {
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (wrap._zoomWheelBound) return;
  wrap._zoomWheelBound = true;
  wrap.addEventListener('wheel', e => {
    // Колесо по фону холста — зум редактора
    if (e.target.closest('#pdf-map') || e.target.closest('.inset-leaflet') || e.target.closest('.ps-obj')) return;
    e.preventDefault();
    const step = e.altKey ? 0.03 : 0.1; // Alt = плавный зум
    zoomCanvas(e.deltaY < 0 ? step : -step);
  }, { passive: false });
}

// ── Ресайз панели инструментов ────────────────────
function _initSidebarResize() {
  const handle  = document.getElementById('pdf-resize-handle');
  const sidebar = document.getElementById('pdf-sidebar');
  if (!handle || !sidebar) return;
  if (handle._resizeBound) return;
  handle._resizeBound = true;

  let startX = 0, startW = 0;

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    startX = e.clientX;
    startW = sidebar.offsetWidth;

    function onMove(ev) {
      // Тянем влево → панель шире; вправо → уже
      const delta = startX - ev.clientX;
      const newW  = Math.max(180, Math.min(600, startW + delta));
      sidebar.style.width = newW + 'px';
      // Перерисовать масштаб холста
      _applyOrientation();
      if (pdfMap) pdfMap.invalidateSize();
    }
    function onUp() {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      // Финальный пересчёт
      setTimeout(() => {
        _applyOrientation();
        if (pdfMap) pdfMap.invalidateSize();
        Object.values(_insetMaps).forEach(m => m.invalidateSize());
      }, 50);
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// ── Grid ──────────────────────────────────────────
function toggleGrid() {
  _gridEnabled = !_gridEnabled;
  // Сетка рендерится через оверлей (поверх карты), не через background canvas
  let ov = document.getElementById('pdf-grid-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'pdf-grid-overlay';
    ov.className = 'no-export'; // скрыть при экспорте
    ov.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2';
    document.getElementById('pdf-canvas').appendChild(ov);
  }
  ov.style.display = _gridEnabled ? 'block' : 'none';
  const btn = document.getElementById('grid-btn');
  if (btn) btn.classList.toggle('active', _gridEnabled);
}

function toggleGridSnap() {
  _gridSnap = !_gridSnap;
  const btn = document.getElementById('grid-snap-btn');
  if (btn) btn.classList.toggle('active', _gridSnap);
}

// ── Context menu ──────────────────────────────────
function _showContextMenu(e, obj) {
  e.preventDefault();
  _hideContextMenu();
  const menu = document.createElement('div');
  menu.id = 'pdf-ctx-menu';
  menu.innerHTML = `
    <div class="ctx-item" onclick="copyPdfObj();_hideContextMenu()">📋 Копировать</div>
    <div class="ctx-item" onclick="pastePdfObj();_hideContextMenu()">📌 Вставить</div>
    <div class="ctx-item" onclick="duplicatePdfObj();_hideContextMenu()">⧉ Дублировать</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="movePdfObjUp();_hideContextMenu()">↑ На передний план</div>
    <div class="ctx-item" onclick="movePdfObjDown();_hideContextMenu()">↓ На задний план</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="alignPdfObj('left');_hideContextMenu()">⬛◁ По левому краю</div>
    <div class="ctx-item" onclick="alignPdfObj('cx');_hideContextMenu()">◁⬛▷ По центру гор.</div>
    <div class="ctx-item" onclick="alignPdfObj('cy');_hideContextMenu()">△⬛▽ По центру вер.</div>
    <div class="ctx-item" onclick="alignPdfObj('right');_hideContextMenu()">▷⬛ По правому краю</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="toggleLockPdfObj();_hideContextMenu()">${obj.locked?'🔓 Разблокировать':'🔒 Заблокировать'}</div>
    <div class="ctx-item danger" onclick="deletePdfObj();_hideContextMenu()">🗑 Удалить</div>
  `;
  menu.style.cssText = `position:fixed;left:${Math.min(e.clientX, window.innerWidth-180)}px;top:${Math.min(e.clientY, window.innerHeight-300)}px;z-index:99999`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', _hideContextMenu, { once: true }), 10);
}

function _hideContextMenu() {
  const m = document.getElementById('pdf-ctx-menu');
  if (m) m.remove();
}

// ── Стрелка-объект ────────────────────────────────
function _arrowHtml(obj) {
  const d = obj.data;
  const color = d.strokeColor || '#ef4444';
  const sw = d.strokeW || 3;
  const dir = d.arrowDir || 'end';
  const uid = obj.id.replace(/\W/g, '');
  const w = Math.max(d.w || 200, 40), h = Math.max(d.h || 30, 12);
  const my = h / 2;
  const x1 = (dir === 'start' || dir === 'both') ? sw * 4 : sw;
  const x2 = w - ((dir === 'end'   || dir === 'both') ? sw * 4 : sw);
  return `<svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block;pointer-events:none">
    <defs>
      <marker id="ae${uid}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0,10 3.5,0 7" fill="${color}"/></marker>
      <marker id="as${uid}" markerWidth="10" markerHeight="7" refX="1" refY="3.5" orient="auto-start-reverse"><polygon points="0 0,10 3.5,0 7" fill="${color}"/></marker>
    </defs>
    <line x1="${x1}" y1="${my}" x2="${x2}" y2="${my}" stroke="${color}" stroke-width="${sw}"
      ${dir==='end'  ||dir==='both'?`marker-end="url(#ae${uid})"`:''}
      ${dir==='start'||dir==='both'?`marker-start="url(#as${uid})"`:''}/>
  </svg>`;
}

// ── Экспорт PNG ───────────────────────────────────
async function exportPng() {
  const btn = document.getElementById('pdf-save-btn');
  if (btn) { btn.textContent = '⏳ PNG…'; btn.disabled = true; }
  selectPdfObj(null);
  const hiddenEls = _hideExportOverlays();
  const canvas = document.getElementById('pdf-canvas');
  // Сбрасываем CSS transform чтобы карта не смещалась при захвате
  const savedTransform = canvas.style.transform;
  canvas.style.transform = 'none';
  canvas.style.transformOrigin = 'top left';
  if (pdfMap) pdfMap.invalidateSize(false);
  Object.values(_insetMaps).forEach(m => { try { m.invalidateSize(false); } catch(e){} });
  await new Promise(r => setTimeout(r, 250));
  try {
    const snap = await html2canvas(canvas, {
      useCORS: true, allowTaint: false,
      scale: window.devicePixelRatio * 2,
      backgroundColor: '#ffffff',
      ignoreElements: el => el.classList && (el.classList.contains('ps-handle') || el.classList.contains('no-export')),
    });
    const a = document.createElement('a');
    const al = getActiveLayer();
    a.download = `${(al ? al.name : 'map').replace(/[^\wа-яА-Я]/g,'_')}_${new Date().toISOString().slice(0,10)}.png`;
    a.href = snap.toDataURL('image/png');
    a.click();
    setSt('PNG сохранён ✓', 'ok');
  } catch(err) { setSt('Ошибка PNG: ' + err.message, 'err'); }
  // Восстанавливаем transform
  canvas.style.transform = savedTransform;
  canvas.style.transformOrigin = 'center center';
  if (pdfMap) pdfMap.invalidateSize(false);
  Object.values(_insetMaps).forEach(m => { try { m.invalidateSize(false); } catch(e){} });
  _showExportOverlays(hiddenEls);
  if (btn) { btn.textContent = '🖼 PNG'; btn.disabled = false; }
}

// Скрыть элементы управления картами перед экспортом
function _hideExportOverlays() {
  const hidden = [];
  document.querySelectorAll('#pdf-map .leaflet-control-container').forEach(el => {
    hidden.push({ el, display: el.style.display }); el.style.display = 'none';
  });
  document.querySelectorAll('.inset-leaflet .leaflet-control-container, .no-export').forEach(el => {
    hidden.push({ el, display: el.style.display }); el.style.display = 'none';
  });
  return hidden;
}

function _showExportOverlays(hidden) {
  hidden.forEach(({ el, display }) => { el.style.display = display; });
}

// ── Snap / Притяжение ─────────────────────────────
function _clearSnapGuides() {
  _snapGuides.forEach(g => g.remove());
  _snapGuides = [];
}

function _showGuide(dir, pos) {
  const canvas = document.getElementById('pdf-canvas');
  const g = document.createElement('div');
  g.className = 'snap-guide snap-guide-' + dir;
  if (dir === 'v') { g.style.cssText = `position:absolute;left:${pos}px;top:0;width:1px;height:100%;background:#f97316;opacity:.8;pointer-events:none;z-index:9999`; }
  else             { g.style.cssText = `position:absolute;top:${pos}px;left:0;height:1px;width:100%;background:#f97316;opacity:.8;pointer-events:none;z-index:9999`; }
  canvas.appendChild(g);
  _snapGuides.push(g);
}

function _snapObject(obj, nx, ny) {
  const canvas = document.getElementById('pdf-canvas');
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  const d = obj.data;

  // Сначала — grid snap
  if (_gridSnap) {
    nx = Math.round(nx / _gridSize) * _gridSize;
    ny = Math.round(ny / _gridSize) * _gridSize;
  }

  if (!_snapEnabled) {
    // Даже без snap — не даём выйти за страницу
    return {
      x: Math.max(0, Math.min(W - d.w, nx)),
      y: Math.max(0, Math.min(H - d.h, ny)),
    };
  }

  _clearSnapGuides();

  // ── Цели для snap по X ──────────────────────────
  // Формат: { val, offset } — когда левый_край + offset == val → snap
  // offset=0: левый край объекта, offset=w/2: центр, offset=w: правый край
  const targetsX = [
    // Края и центр страницы
    { val: 0,              offset: 0      },   // левый → к левому краю
    { val: W,              offset: d.w    },   // правый → к правому краю
    { val: Math.round(W/2),offset: d.w/2  },   // центр
    { val: 0,              offset: d.w    },   // правый → к левому краю (у стены)
    { val: W,              offset: 0      },   // левый → к правому краю
  ];
  const targetsY = [
    { val: 0,              offset: 0      },
    { val: H,              offset: d.h    },
    { val: Math.round(H/2),offset: d.h/2  },
    { val: 0,              offset: d.h    },
    { val: H,              offset: 0      },
  ];

  // Цели от других объектов
  pdfObjects.filter(o => o.id !== obj.id && o.visible).forEach(o => {
    const od = o.data;
    // Выравнивание краёв — левый к левому, правый к правому, и т.д.
    targetsX.push(
      { val: od.x,                   offset: 0     },  // левый → левый
      { val: od.x,                   offset: d.w   },  // правый → левый
      { val: od.x + od.w,            offset: 0     },  // левый → правый
      { val: od.x + od.w,            offset: d.w   },  // правый → правый
      { val: od.x + od.w/2,          offset: d.w/2 },  // центр → центр
    );
    targetsY.push(
      { val: od.y,                   offset: 0     },
      { val: od.y,                   offset: d.h   },
      { val: od.y + od.h,            offset: 0     },
      { val: od.y + od.h,            offset: d.h   },
      { val: od.y + od.h/2,          offset: d.h/2 },
    );
  });

  let sx = nx, sy = ny;
  let snappedX = false, snappedY = false;

  for (const { val, offset } of targetsX) {
    if (!snappedX && Math.abs(nx + offset - val) < SNAP_DIST) {
      sx = Math.round(val - offset);
      _showGuide('v', val);
      snappedX = true;
    }
  }
  for (const { val, offset } of targetsY) {
    if (!snappedY && Math.abs(ny + offset - val) < SNAP_DIST) {
      sy = Math.round(val - offset);
      _showGuide('h', val);
      snappedY = true;
    }
  }

  // Жёсткий clamp — объект не выходит за страницу
  sx = Math.max(0, Math.min(W - d.w, sx));
  sy = Math.max(0, Math.min(H - d.h, sy));

  return { x: sx, y: sy };
}

// ── Выравнивание объектов ─────────────────────────
function alignPdfObj(dir) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.locked) return;
  const canvas = document.getElementById('pdf-canvas');
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  const d = obj.data;
  _pushUndo();
  switch(dir) {
    case 'left':   d.x = 0; break;
    case 'cx':     d.x = Math.round(W / 2 - d.w / 2); break;
    case 'right':  d.x = Math.round(W - d.w); break;
    case 'top':    d.y = 0; break;
    case 'cy':     d.y = Math.round(H / 2 - d.h / 2); break;
    case 'bottom': d.y = Math.round(H - d.h); break;
  }
  const el = document.getElementById(obj.id);
  if (el) { el.style.left = d.x + 'px'; el.style.top = d.y + 'px'; }
  _syncPropsAll();
  _saveState();
}

// ── Undo / Redo ───────────────────────────────────
function _pushUndo() {
  _undoStack.push(JSON.stringify(pdfObjects.map(o => ({ ...o, data: { ...o.data, imgSrc: o.data.imgSrc ? '[img]' : '' } }))));
  if (_undoStack.length > 40) _undoStack.shift();
  _redoStack = [];
}

function undoPdf() {
  if (!_undoStack.length) return;
  _redoStack.push(JSON.stringify(pdfObjects.map(o => ({ ...o, data: { ...o.data, imgSrc: o.data.imgSrc ? '[img]' : '' } }))));
  _restoreState(JSON.parse(_undoStack.pop()));
  setSt('Отменено ↩', 'ok');
}

function redoPdf() {
  if (!_redoStack.length) return;
  _undoStack.push(JSON.stringify(pdfObjects.map(o => ({ ...o, data: { ...o.data, imgSrc: o.data.imgSrc ? '[img]' : '' } }))));
  _restoreState(JSON.parse(_redoStack.pop()));
  setSt('Повторено ↪', 'ok');
}

function _restoreState(saved) {
  // Удалить inset карты
  Object.keys(_insetMaps).forEach(id => { try { _insetMaps[id].remove(); } catch(e) {} delete _insetMaps[id]; });
  pdfObjects = saved.map(o => ({ ...o, data: { ...OBJ_DEFAULTS[o.type] || OBJ_DEFAULTS.rect, ...o.data } }));
  pdfSelId = null;
  _renderAll();
  _renderLayersList();
  _renderProps();
  _saveState();
}

// ── Лупа — вставка увеличенного фрагмента ────────
function addPdfInset() {
  const W = pdfOrientation === 'landscape' ? CANVAS_W_L : CANVAS_W_P;
  const H = pdfOrientation === 'landscape' ? CANVAS_H_L : CANVAS_H_P;
  _pushUndo();
  createPdfObj('inset', { x: Math.round(W / 2 - 170), y: Math.round(H / 2 - 115), w: 340, h: 230, name: 'Лупа' });
  setPdfTool('select');
}

function _initInsetMap(el, obj) {
  if (_insetMaps[obj.id]) return; // уже создана
  const mapDiv = document.createElement('div');
  mapDiv.className = 'inset-leaflet';
  mapDiv.id = 'imap_' + obj.id;
  mapDiv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:0;border-radius:inherit';
  el.appendChild(mapDiv);

  const center = pdfMap ? pdfMap.getCenter() : map.getCenter();
  const zoom   = Math.min(19, (pdfMap ? pdfMap.getZoom() : map.getZoom()) + (obj.data.insetZoom || 2));

  const imap = L.map('imap_' + obj.id, {
    center, zoom,
    zoomControl: false,        // плюсы/минусы убраны (мешают при экспорте)
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: false,
    attributionControl: false,
  });

  (pdfMapSat
    ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19 })
    : L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 })
  ).addTo(imap);

  mapLayers.forEach(l => {
    if (l.layer && l.layer.toGeoJSON) {
      try {
        const geo   = l.layer.toGeoJSON();
        const style = l._psStyle || { color: l.color, fillColor: l.color, fillOpacity: l.type === 'szz' ? 0.1 : 0.15, weight: 3 };
        L.geoJSON(geo, { style: () => style }).addTo(imap);
      } catch(e) {}
    }
  });

  // Бейдж "Фрагмент" — только в редакторе, скрыт при экспорте
  const badge = document.createElement('div');
  badge.className = 'inset-badge no-export';
  badge.style.cssText = 'position:absolute;top:4px;left:4px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;padding:2px 6px;border-radius:3px;z-index:500;pointer-events:none';
  badge.textContent = '🔍 Лупа';
  mapDiv.appendChild(badge);

  _insetMaps[obj.id] = imap;
  setTimeout(() => imap.invalidateSize(), 150);

  // Стоп всплытие событий (чтоб не мешал drag объекта)
  mapDiv.addEventListener('pointerdown', e => e.stopPropagation());
}

// ── Управление картой внутри PDF ─────────────────
function togglePdfMapSat() {
  if (!pdfMap) return;
  if (_pdfTile) pdfMap.removeLayer(_pdfTile);
  pdfMapSat = !pdfMapSat;
  const satUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const osmUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  _pdfTile = L.tileLayer(pdfMapSat ? satUrl : osmUrl, { maxZoom:19 });
  _pdfTile.addTo(pdfMap);
  // Синхронизируем тайловый слой всех лупа-карт
  Object.entries(_insetMaps).forEach(([id, imap]) => {
    imap.eachLayer(l => { if (l instanceof L.TileLayer) imap.removeLayer(l); });
    L.tileLayer(pdfMapSat ? satUrl : osmUrl, { maxZoom:19 }).addTo(imap);
  });
  const btn = document.getElementById('pdf-sat-btn');
  if (btn) { btn.textContent = pdfMapSat ? '🗺 Схема' : '🛰 Спутник'; btn.classList.toggle('active', pdfMapSat); }
}

function togglePdfMapDrag() {
  if (!pdfMap) return;
  pdfMapDrag = !pdfMapDrag;
  const mapEl = document.getElementById('pdf-map');
  if (pdfMapDrag) {
    pdfMap.dragging.enable();
    pdfMap.scrollWheelZoom.enable();
    pdfMap.doubleClickZoom.enable();
    pdfMap.touchZoom.enable();
    if (mapEl) { mapEl.style.cursor = 'grab'; mapEl.style.pointerEvents = ''; }
    setPdfTool('select');
    setSt('Режим перемещения карты — двигай и масштабируй колесом мыши', 'ok');
  } else {
    pdfMap.dragging.disable();
    pdfMap.scrollWheelZoom.disable();
    pdfMap.doubleClickZoom.disable();
    pdfMap.touchZoom.disable();
    if (mapEl) { mapEl.style.cursor = ''; }
    setSt('Карта зафиксирована', 'ok');
  }
  const btn = document.getElementById('pdf-drag-btn');
  if (btn) { btn.textContent = pdfMapDrag ? '🔒 Зафикс.' : '✋ Двигать'; btn.classList.toggle('active', pdfMapDrag); }
}

function fitPdfMapToLayer() {
  if (!pdfMap) return;
  const targets = getActiveLayer()
    ? [getActiveLayer()]
    : mapLayers;
  const valid = targets.filter(l => l.layer && l.layer.getBounds);
  if (!valid.length) { setSt('Нет слоёв для позиционирования', 'err'); return; }
  let bounds = valid[0].layer.getBounds();
  valid.slice(1).forEach(l => bounds.extend(l.layer.getBounds()));
  pdfMap.fitBounds(bounds, { padding: [24, 24] });
  setSt('Карта PDF центрирована на участке ✓', 'ok');
}

// ── UI редактора ──────────────────────────────────
function _buildEditorUI() {
  _buildLeftToolbar();
  _buildToolbar();    // правый сайдбар — доп. контролы
  _buildActions();
}

// ── Левый тулбар (инструменты, как в Photoshop) ──
function _buildLeftToolbar() {
  const tb = document.getElementById('pdf-left-toolbar');
  if (!tb) return;
  const T = (t) => pdfTool === t ? 'class="ps-ltool active"' : 'class="ps-ltool"';
  tb.innerHTML = `
    <button class="ps-ltool" data-tip="Отменить (Ctrl+Z)" onclick="undoPdf()" style="font-size:14px">↩</button>
    <button class="ps-ltool" data-tip="Повторить (Ctrl+Y)" onclick="redoPdf()" style="font-size:14px">↪</button>
    <div class="ps-ltool-sep"></div>
    <button ${T('select')} id="pst-select" data-tip="Выбрать (V)" onclick="setPdfTool('select')" style="font-size:17px">↖</button>
    <div class="ps-ltool-sep"></div>
    <button ${T('text')} id="pst-text" data-tip="Текст (T)" onclick="setPdfTool('text')" style="font-weight:700">T</button>
    <button ${T('rect')} id="pst-rect" data-tip="Прямоугольник (R)" onclick="setPdfTool('rect')">▭</button>
    <button ${T('ellipse')} id="pst-ellipse" data-tip="Эллипс (E)" onclick="setPdfTool('ellipse')">◯</button>
    <button ${T('line')} id="pst-line" data-tip="Линия (L)" onclick="setPdfTool('line')">╱</button>
    <button class="ps-ltool" id="pst-image" data-tip="Изображение" onclick="document.getElementById('ps-image-upload').click()">🖼</button>
    <div class="ps-ltool-sep"></div>
    <button ${T('path')} id="pst-path" data-tip="Перо — прямые (P) | 2×клик = завершить" onclick="setPdfTool('path')" style="font-size:17px">✒</button>
    <button ${T('bezier')} id="pst-bezier" data-tip="Безье (B) | 2×клик = завершить" onclick="setPdfTool('bezier')" style="font-size:16px">〰</button>
    <button ${T('freehand')} id="pst-freehand" data-tip="Карандаш (F)" onclick="setPdfTool('freehand')" style="font-size:16px">✏</button>
    <button ${T('polygon-shape')} id="pst-polygon-shape" data-tip="Многоугольник" onclick="setPdfTool('polygon-shape')" style="font-size:15px">⬠</button>
    <div class="ps-ltool-sep"></div>
    <button ${T('callout')} id="pst-callout" data-tip="Выноска-облако — 1й клик=острие, 2й=бокс" onclick="setPdfTool('callout')" style="font-size:16px">💬</button>
    <button ${T('leader')} id="pst-leader" data-tip="Выноска с полочкой — клик на объект, потяни к тексту" onclick="setPdfTool('leader')" style="font-size:15px">⌐</button>
    <div class="ps-ltool-sep"></div>
    <button class="ps-ltool" data-tip="Треугольник" onclick="setPdfTool('triangle-shape')" style="font-size:15px">△</button>
    <button class="ps-ltool" data-tip="Ромб" onclick="setPdfTool('diamond-shape')" style="font-size:15px">◇</button>
    <button class="ps-ltool" data-tip="Звезда" onclick="setPdfTool('star-shape')" style="font-size:14px">★</button>
    <div class="ps-ltool-sep"></div>
    <button class="ps-ltool" data-tip="Легенда" onclick="addPdfLegend()">≡</button>
    <button class="ps-ltool" data-tip="Масштаб" onclick="addPdfScale()" style="font-size:13px">📏</button>
    <button class="ps-ltool" data-tip="Стрелка севера" onclick="addPdfNorth()" style="font-size:13px">🧭</button>
    <button class="ps-ltool" data-tip="Стрелка-указатель" onclick="createPdfObj('arrow',{name:'Стрелка'})">➡</button>
    <button class="ps-ltool" data-tip="Лупа — фрагмент карты" onclick="addPdfInset()" style="font-size:16px">🔍</button>
    <div class="ps-ltool-sep"></div>
    <button class="ps-ltool" data-tip="Группировать (Ctrl+G)" onclick="groupPdfObjs()" style="font-size:11px">⊞G</button>
    <button class="ps-ltool" data-tip="Разгруппировать (Ctrl+Shift+G)" onclick="ungroupPdfObjs()" style="font-size:10px">⊟G</button>
    <button class="ps-ltool" data-tip="Выбрать все (Ctrl+A)" onclick="selectAllPdfObjs()" style="font-size:11px">⊡A</button>
  `;
}

// ── Правый сайдбар — доп. контролы ───────────────
function _buildToolbar() {
  const tb = document.getElementById('pdf-toolbar');
  tb.innerHTML = `
    <div style="display:flex;gap:2px;width:100%;align-items:center">
      <button class="ps-align-btn" style="font-size:15px" onclick="zoomCanvas(-0.15)" title="Уменьшить">−</button>
      <button class="ps-align-btn" style="flex:2;font-size:10px" onclick="_zoomMul=1;_applyOrientation()" title="Сбросить">⊙ ${Math.round(_zoomMul*100)}%</button>
      <button class="ps-align-btn" style="font-size:15px" onclick="zoomCanvas(0.15)" title="Увеличить">+</button>
    </div>
    <div style="display:flex;gap:2px;width:100%;margin-top:2px">
      <button class="ps-align-btn" id="grid-btn" style="${_gridEnabled?'color:#60a5fa;border-color:#60a5fa':''}" onclick="toggleGrid()">⊞ Сетка</button>
      <button class="ps-align-btn" id="grid-snap-btn" style="${_gridSnap?'color:#60a5fa;border-color:#60a5fa':''}" onclick="toggleGridSnap()">🧲 к сетке</button>
    </div>
    <div class="pdf-orient-row" style="width:100%;margin-top:4px">
      <button class="orient-btn ${pdfOrientation==='landscape'?'active':''}" onclick="setPdfOrientation('landscape')">⇄ Альбом</button>
      <button class="orient-btn ${pdfOrientation==='portrait' ?'active':''}" onclick="setPdfOrientation('portrait')">⇅ Книжн.</button>
    </div>
    <div style="width:100%;padding:4px 0 2px">
      <label style="font-size:10px;color:#4b5563;display:flex;align-items:center;gap:5px;cursor:pointer;margin-bottom:3px">
        <input type="checkbox" id="snap-toggle" ${_snapEnabled?'checked':''} onchange="_snapEnabled=this.checked"> 🧲 Магнит
      </label>
      <label style="font-size:10px;color:#4b5563;display:flex;align-items:center;gap:5px;cursor:pointer;margin-bottom:3px">
        <input type="checkbox" id="pdf-no-fill-szz" onchange="toggleFills()"> Убрать заливку СЗЗ
      </label>
      <label style="font-size:10px;color:#4b5563;display:flex;align-items:center;gap:5px;cursor:pointer">
        <input type="checkbox" id="pdf-no-fill-zu"  onchange="toggleFills()"> Убрать заливку ЗУ
      </label>
    </div>
    <div style="display:flex;gap:2px;width:100%;flex-wrap:wrap;margin-top:2px">
      <button class="ps-align-btn" title="По левому краю"  onclick="alignPdfObj('left')">⬛◁</button>
      <button class="ps-align-btn" title="По центру (гор)" onclick="alignPdfObj('cx')">◁⬛▷</button>
      <button class="ps-align-btn" title="По правому краю" onclick="alignPdfObj('right')">▷⬛</button>
      <button class="ps-align-btn" title="По верху"        onclick="alignPdfObj('top')">△⬛</button>
      <button class="ps-align-btn" title="По центру (вер)" onclick="alignPdfObj('cy')">△⬛▽</button>
      <button class="ps-align-btn" title="По низу"         onclick="alignPdfObj('bottom')">▽⬛</button>
    </div>
  `;
  const sb = document.getElementById('pdf-sat-btn');
  if (sb) { sb.textContent = pdfMapSat ? '🗺 Схема' : '🛰 Спутник'; sb.classList.toggle('active', pdfMapSat); }
  const db = document.getElementById('pdf-drag-btn');
  if (db) { db.textContent = pdfMapDrag ? '🔒 Зафикс.' : '✋ Двигать'; db.classList.toggle('active', pdfMapDrag); }
}

function _buildActions() {
  // Кнопки PDF/PNG/Карта теперь в #pdf-sidebar-header (всегда видны)
  // Здесь только скрытый anchor для pdf-save-btn id (используется в renderPdf/exportPng)
  const existing = document.getElementById('pdf-save-btn');
  if (!existing) {
    const phantom = document.createElement('span');
    phantom.id = 'pdf-save-btn';
    phantom.style.display = 'none';
    document.getElementById('pdf-actions').appendChild(phantom);
  }
  document.getElementById('pdf-actions').style.display = 'none'; // прячем пустую зону
}

// ── Ориентация ────────────────────────────────────
function setPdfOrientation(o) {
  pdfOrientation = o;
  _applyOrientation();
  _buildLeftToolbar();
  _buildToolbar();
  _buildActions();
  setTimeout(() => { if (pdfMap) pdfMap.invalidateSize(); }, 350);
}

function _applyOrientation() {
  const canvas = document.getElementById('pdf-canvas');
  canvas.className = pdfOrientation;
  const W = pdfOrientation === 'landscape' ? CANVAS_W_L : CANVAS_W_P;
  const H = pdfOrientation === 'landscape' ? CANVAS_H_L : CANVAS_H_P;

  // Масштабируем чтобы влезло в окно с отступами
  const wrap = document.getElementById('pdf-canvas-wrap');
  const maxW = wrap.clientWidth  - 48;
  const maxH = wrap.clientHeight - 48;
  const scale = Math.min(maxW / W, maxH / H, 1) * _zoomMul;
  canvas.style.transform = `scale(${scale})`;
  canvas.style.transformOrigin = 'center center';
}

// ── Инструменты ───────────────────────────────────
function setPdfTool(t) {
  // Прерываем активное рисование пути при смене инструмента
  if (_pathDraft) _clearPathGhost();
  pdfTool = t;
  document.querySelectorAll('[id^="pst-"]').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('pst-' + t);
  if (btn) btn.classList.add('active');
  const canvas = document.getElementById('pdf-canvas');
  canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';

  // Когда активен инструмент рисования — #pdf-map не должен перехватывать события мыши,
  // иначе поиск target.closest('#pdf-map') блокирует pointerdown на canvas
  const mapEl = document.getElementById('pdf-map');
  if (mapEl) {
    const isDrawing = t !== 'select' && t !== 'image';
    mapEl.style.pointerEvents = isDrawing ? 'none' : '';
  }
}

// ── Создание объекта ──────────────────────────────
const OBJ_DEFAULTS = {
  text:    { w:220, h:52,  bg:'rgba(255,255,255,0.90)', color:'#0f172a', fontSize:18, fontFamily:'Segoe UI', fontWeight:'700', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:6,   shadow:false, strokeColor:'transparent', strokeW:0, content:'Заголовок', textShadow:false, textStrokeColor:'transparent', textStrokeW:0 },
  rect:    { w:160, h:90,  bg:'rgba(59,130,246,0.12)',  color:'#1e40af', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:4,   shadow:false, strokeColor:'#3b82f6',     strokeW:2, content:'',          textShadow:false, textStrokeColor:'transparent', textStrokeW:0 },
  ellipse: { w:140, h:90,  bg:'rgba(34,197,94,0.12)',   color:'#166534', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:999, shadow:false, strokeColor:'#22c55e',     strokeW:2, content:'',          textShadow:false, textStrokeColor:'transparent', textStrokeW:0 },
  line:    { w:200, h:4,   bg:'transparent',             color:'transparent', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#ef4444', strokeW:4, content:'', textShadow:false, textStrokeColor:'transparent', textStrokeW:0 },
  legend:  { w:240, h:130, bg:'rgba(255,255,255,0.95)', color:'#0f172a', fontSize:13, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'left',   radius:8,   shadow:false, strokeColor:'transparent', strokeW:0, content:'__legend__', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, legendStyle:0 },
  scale:   { w:170, h:52,  bg:'rgba(255,255,255,0.88)', color:'#0f172a', fontSize:12, fontFamily:'Segoe UI', fontWeight:'700', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:4,   shadow:false, strokeColor:'transparent', strokeW:0, content:'__scale__',  textShadow:false, textStrokeColor:'transparent', textStrokeW:0 },
  north:   { w:60,  h:60,  bg:'transparent',            color:'#0f172a', fontSize:10, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0,   shadow:false, strokeColor:'transparent', strokeW:0, content:'__north__',  textShadow:false, textStrokeColor:'transparent', textStrokeW:0, northStyle:0 },
  image:   { w:160, h:100, bg:'transparent',             color:'transparent', fontSize:12, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'transparent', strokeW:0, content:'',           textShadow:false, textStrokeColor:'transparent', textStrokeW:0, imgSrc:'' },
  inset:   { w:340, h:230, bg:'#ffffff',                color:'#0f172a',     fontSize:11, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:4, shadow:false, strokeColor:'#334155',     strokeW:2, content:'__inset__',  textShadow:false, textStrokeColor:'transparent', textStrokeW:0, insetZoom:0 },
  arrow:   { w:200, h:30,  bg:'transparent',            color:'transparent', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#ef4444',     strokeW:3, content:'__arrow__',  textShadow:false, textStrokeColor:'transparent', textStrokeW:0, arrowDir:'end', rotation:0 },
  path:    { x:0,   y:0,  w:200, h:100, pts:[], closed:false, bg:'transparent', color:'transparent', fontSize:12, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#3b82f6', strokeW:3, content:'__path__',   textShadow:false, textStrokeColor:'transparent', textStrokeW:0, rotation:0 },
  bezier:  { x:0,   y:0,  w:200, h:100, pts:[], closed:false, bg:'transparent', color:'transparent', fontSize:12, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#8b5cf6', strokeW:3, content:'__bezier__', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, rotation:0 },
  callout:  { x:200, y:200, w:160, h:56, tailX:120, tailY:320, bg:'rgba(255,255,255,0.95)', color:'#0f172a', fontSize:13, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:8, shadow:false, strokeColor:'#334155', strokeW:2, content:'Выноска',    textShadow:false, textStrokeColor:'transparent', textStrokeW:0, rotation:0 },
  leader:   { x:200, y:120, w:180, h:48, tailX:290, tailY:240, bg:'transparent', color:'#0f172a', fontSize:13, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'left', radius:0, shadow:false, strokeColor:'#0f172a', strokeW:1.5, content:'Подпись', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, rotation:0 },
  triangle: { w:120, h:100, bg:'rgba(251,191,36,0.18)', color:'transparent', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#f59e0b', strokeW:2, content:'', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, strokeDash:'', opacity:1 },
  diamond:  { w:100, h:130, bg:'rgba(167,139,250,0.18)', color:'transparent', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#a78bfa', strokeW:2, content:'', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, strokeDash:'', opacity:1 },
  star:     { w:120, h:120, bg:'rgba(251,191,36,0.22)', color:'transparent', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#f59e0b', strokeW:2, content:'', textShadow:false, textStrokeColor:'transparent', textStrokeW:0, strokeDash:'', opacity:1 },
};

function _typeName(type) {
  return { text:'Текст', rect:'Прямоугольник', ellipse:'Эллипс', line:'Линия', legend:'Легенда', scale:'Масштаб', north:'Стрелка С', image:'Изображение', inset:'Лупа', arrow:'Стрелка', path:'Путь', bezier:'Кривая', callout:'Выноска', leader:'Выноска-полочка', triangle:'Треугольник', diamond:'Ромб', star:'Звезда' }[type] || type;
}

function createPdfObj(type, overrides = {}) {
  const canvas = document.getElementById('pdf-canvas');
  const W = canvas.offsetWidth || CANVAS_W_L;
  const H = canvas.offsetHeight || CANVAS_H_L;
  const defaults = OBJ_DEFAULTS[type] || OBJ_DEFAULTS.rect;
  const d = Object.assign({}, defaults, { x: Math.round(W/2 - defaults.w/2), y: Math.round(H/2 - defaults.h/2) }, overrides);

  const id  = 'pobj_' + (pdfObjCnt++);
  const obj = { id, type, name: overrides.name || _typeName(type), locked: false, visible: true, data: d };
  pdfObjects.unshift(obj);

  _renderObj(obj);
  selectPdfObj(id);
  _renderLayersList();
  _saveState();
  return obj;
}

// ── Рендер одного объекта ─────────────────────────
function _renderObj(obj) {
  const canvas = document.getElementById('pdf-canvas');
  let el = document.getElementById(obj.id);
  if (!el) {
    el = document.createElement('div');
    el.id = obj.id;
    el.className = 'ps-obj ps-obj-' + obj.type;
    canvas.appendChild(el);
    _attachObjEvents(el, obj);
  }

  const d = obj.data;
  const _svgShapes = ['rect','ellipse','line','triangle','diamond','star'];
  const _isSvgType = ['path','bezier','north','callout','leader',..._svgShapes].includes(obj.type);

  // Тень
  let shadowVal = 'none';
  if (d.shadow && !_svgShapes.includes(obj.type)) {
    const sx = d.shadowX !== undefined ? d.shadowX : 4;
    const sy = d.shadowY !== undefined ? d.shadowY : 4;
    const sb = d.shadowBlur !== undefined ? d.shadowBlur : 14;
    const sc = d.shadowColor || 'rgba(0,0,0,0.22)';
    shadowVal = `${sx}px ${sy}px ${sb}px ${sc}`;
  }

  // Transform: поворот + flip
  const transforms = [];
  if (d.rotation) transforms.push(`rotate(${d.rotation}deg)`);
  if (d.flipX)    transforms.push('scaleX(-1)');
  if (d.flipY)    transforms.push('scaleY(-1)');
  const transformVal = transforms.length ? transforms.join(' ') : 'none';

  el.style.cssText = `
    position:absolute;
    left:${d.x}px; top:${d.y}px;
    width:${d.w}px; height:${d.h}px;
    background:${_isSvgType ? 'transparent' : d.bg};
    border-radius:${_isSvgType ? '0' : d.radius}px;
    border:${_isSvgType ? 'none' : d.strokeW > 0 ? `${d.strokeW}px solid ${d.strokeColor}` : 'none'};
    box-shadow:${shadowVal};
    overflow:${_isSvgType ? 'visible' : 'hidden'};
    color:${d.color};
    font-size:${d.fontSize}px;
    font-family:${d.fontFamily};
    font-weight:${d.fontWeight};
    font-style:${d.fontStyle};
    text-decoration:${d.textDecoration};
    text-align:${d.textAlign};
    line-height:${d.lineHeight || 1.4};
    letter-spacing:${d.letterSpacing || 0}px;
    display:${obj.visible ? 'flex' : 'none'};
    align-items:center;
    justify-content:${d.textAlign==='left'?'flex-start':d.textAlign==='right'?'flex-end':'center'};
    box-sizing:border-box;
    cursor:${obj.locked ? 'not-allowed' : pdfTool==='select' ? 'grab' : 'crosshair'};
    z-index:${100 + pdfObjects.indexOf(obj)};
    opacity:${d.opacity !== undefined ? d.opacity : 1};
    text-shadow:${d.textShadow ? '1px 1px 0 #fff,-1px -1px 0 #fff,1px -1px 0 #fff,-1px 1px 0 #fff' : 'none'};
    -webkit-text-stroke:${(d.textStrokeW > 0) ? `${d.textStrokeW}px ${d.textStrokeColor || '#000'}` : '0'};
    padding:${d.type==='legend' ? '12px' : d.type==='scale' ? '5px 10px' : d.type==='text' ? '6px 12px' : '0'};
    user-select:none;
    transform:${transformVal};
    transform-origin:center center;
  `;
  el.classList.toggle('ps-selected', pdfSelIds.includes(obj.id));

  // Контент
  _renderObjContent(el, obj);

  // Хендлы изменения размера (только для выбранного)
  _updateHandles(el, obj);
}

function _renderObjContent(el, obj) {
  const d = obj.data;
  if (d.content === '__legend__') { el.innerHTML = _legendHtml(d); return; }
  if (d.content === '__scale__')  { el.innerHTML = _scaleHtml(d);  return; }
  if (d.content === '__north__')  { el.innerHTML = _northHtml(d);  return; }
  if (d.content === '__inset__')  { _initInsetMap(el, obj); if (_insetMaps[obj.id]) setTimeout(() => _insetMaps[obj.id].invalidateSize(), 80); return; }
  if (d.content === '__arrow__')  { el.innerHTML = _arrowHtml(obj); return; }
  if (d.content === '__path__')   { el.innerHTML = _renderPathSvg(obj);   return; }
  if (d.content === '__bezier__') { el.innerHTML = _renderBezierSvg(obj); return; }
  if (obj.type  === 'callout')    { el.innerHTML = _renderCalloutHtml(obj); return; }
  if (obj.type  === 'leader')     { el.innerHTML = _renderLeaderHtml(obj);  return; }
  if (['rect','ellipse','line','triangle','diamond','star'].includes(obj.type)) {
    el.innerHTML = _renderShapeContent(obj); return;
  }
  if (d.type === 'image' && d.imgSrc) {
    el.innerHTML = `<img src="${d.imgSrc}" style="width:100%;height:100%;object-fit:contain;border-radius:${d.radius}px;pointer-events:none">`;
    return;
  }
  // Текст — span с contenteditable
  el.innerHTML = `<span class="ps-text-content" style="width:100%;text-align:inherit;pointer-events:none;white-space:pre-wrap;word-break:break-word">${d.content || ''}</span>`;
}

function _legendHtml(d) {
  const sty = d.legendStyle || 0;
  const fs = d.fontSize || 13;
  const fc = d.color || '#0f172a';
  const layers = mapLayers.filter(l => l.visible);
  const parcels = foundParcels.filter(p => p.inP).length;

  // Build items array
  const items = layers.map(l => ({
    bg: hexToRgba(l.color, l.type === 'szz' ? 0.12 : 0.2),
    brd: l.type === 'szz' ? 'dashed' : 'solid',
    color: l.color, name: l.name,
  }));
  if (parcels) {
    items.push({ bg:'rgba(34,197,94,0.25)',  brd:'solid', color:'#16a34a', name:'ЗУ внутри СЗЗ' });
    items.push({ bg:'rgba(245,158,11,0.25)', brd:'solid', color:'#b45309', name:'ЗУ на пересечении' });
  }

  const swatch = (it, sz=16) =>
    `<div style="width:${sz}px;height:${sz}px;flex-shrink:0;background:${it.bg};border:2px ${it.brd} ${it.color};border-radius:2px"></div>`;

  if (sty === 0) { // Стиль 1: Классический с заголовком
    let h = `<div style="padding:4px 0 2px;font-size:${fs+1}px;font-weight:700;color:${fc};border-bottom:1px solid ${fc}30;margin-bottom:4px">Условные обозначения</div>`;
    items.forEach(it => { h += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">${swatch(it)}<span style="font-size:${fs}px;color:${fc}">${it.name}</span></div>`; });
    return `<div style="padding:8px 10px;width:100%;box-sizing:border-box">${h}</div>`;
  }
  if (sty === 1) { // Стиль 2: Рамки вокруг каждой строки
    let h = `<div style="font-size:${fs}px;font-weight:700;color:${fc};margin-bottom:6px">Легенда</div>`;
    items.forEach(it => { h += `<div style="display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:4px;border:1px solid ${it.color}40;margin-bottom:2px">${swatch(it)}<span style="font-size:${fs}px;color:${fc}">${it.name}</span></div>`; });
    return `<div style="padding:8px;width:100%;box-sizing:border-box">${h}</div>`;
  }
  if (sty === 2) { // Стиль 3: Минимальный (нет фона)
    let h = '';
    items.forEach(it => { h += `<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px"><div style="width:24px;height:3px;background:${it.color};flex-shrink:0"></div><span style="font-size:${fs}px;color:${fc}">${it.name}</span></div>`; });
    return `<div style="padding:6px 8px;width:100%;box-sizing:border-box">${h}</div>`;
  }
  if (sty === 3) { // Стиль 4: Горизонтальный компактный
    let h = '';
    items.forEach(it => { h += `<div style="display:inline-flex;align-items:center;gap:4px;margin:0 8px 4px 0">${swatch(it,12)}<span style="font-size:${fs-1}px;color:${fc}">${it.name}</span></div>`; });
    return `<div style="padding:6px 8px;width:100%;box-sizing:border-box;display:flex;flex-wrap:wrap">${h}</div>`;
  }
  return `<div style="padding:8px">${items.map(it => `<div style="display:flex;gap:5px;align-items:center;margin-bottom:3px">${swatch(it)}<span style="font-size:${fs}px;color:${fc}">${it.name}</span></div>`).join('')}</div>`;
}

function _scaleHtml(d) {
  // Читаем актуальный масштаб из pdf-карты (а не из основной)
  const scEl = document.querySelector('#pdf-map .leaflet-control-scale-line');
  const text = scEl ? scEl.innerHTML : (document.querySelector('.leaflet-control-scale-line')?.innerHTML || '100 м');
  const w    = scEl ? scEl.style.width : '80px';
  return `<div class="ps-scale-content" style="color:${d.color}">
    <span style="font-size:${d.fontSize}px;font-weight:700">${text}</span>
    <div class="ps-scale-bar" style="width:${w};border-top:2px solid ${d.color};border-left:2px solid ${d.color};border-right:2px solid ${d.color};height:5px;margin-top:2px"></div>
  </div>`;
}

function _northHtml(d) {
  const c = d.color || '#0f172a';
  const bg = (d.bg && d.bg !== 'transparent') ? d.bg : '#fff';
  const s = d.northStyle || 0;
  const svgs = [
    // 0: Classic split needle
    `<polygon points="20,3 25,35 20,28 15,35" fill="${c}"/>
     <polygon points="20,3 25,35 20,28 15,35" fill="${bg}" clip-path="url(#nh0)"/>
     <defs><clipPath id="nh0"><rect x="20" y="0" width="20" height="40"/></clipPath></defs>
     <text x="20" y="15" font-size="9" font-weight="bold" fill="${c}" text-anchor="middle">С</text>`,
    // 1: Compass needle with circle
    `<circle cx="20" cy="20" r="16" fill="none" stroke="${c}" stroke-width="1.5"/>
     <polygon points="20,4 24,20 20,16 16,20" fill="${c}"/>
     <polygon points="20,36 24,20 20,24 16,20" fill="${bg}" stroke="${c}" stroke-width="1"/>
     <text x="20" y="10" font-size="7" font-weight="bold" fill="${c}" text-anchor="middle">С</text>`,
    // 2: Simple N arrow
    `<line x1="20" y1="36" x2="20" y2="8" stroke="${c}" stroke-width="2"/>
     <polygon points="20,4 26,16 20,13 14,16" fill="${c}"/>
     <text x="20" y="13" font-size="8" font-weight="bold" fill="${bg}" text-anchor="middle">С</text>`,
    // 3: Cross compass rose
    `<polygon points="20,2 23,17 20,14 17,17" fill="${c}"/>
     <polygon points="20,38 23,23 20,26 17,23" fill="${bg}" stroke="${c}" stroke-width="1"/>
     <polygon points="2,20 17,17 14,20 17,23" fill="${bg}" stroke="${c}" stroke-width="1"/>
     <polygon points="38,20 23,17 26,20 23,23" fill="${bg}" stroke="${c}" stroke-width="1"/>
     <text x="20" y="12" font-size="7" font-weight="bold" fill="${c}" text-anchor="middle">С</text>`,
    // 4: Star 8-point
    `<polygon points="20,2 22,16 28,10 22,18 38,20 22,22 28,30 22,24 20,38 18,24 12,30 18,22 2,20 18,18 12,10 18,16" fill="${c}" opacity="0.85"/>
     <circle cx="20" cy="20" r="3" fill="${bg}"/>
     <text x="20" y="10" font-size="6" font-weight="bold" fill="${bg}" text-anchor="middle">С</text>`,
    // 5: Military style
    `<rect x="18" y="6" width="4" height="28" fill="${c}" rx="1"/>
     <polygon points="20,2 27,12 13,12" fill="${c}"/>
     <text x="20" y="8" font-size="7" font-weight="bold" fill="${bg}" text-anchor="middle">С</text>`,
    // 6: Minimal line + N
    `<line x1="20" y1="32" x2="20" y2="12" stroke="${c}" stroke-width="1.5"/>
     <text x="20" y="11" font-size="11" font-weight="bold" font-family="serif" fill="${c}" text-anchor="middle">С</text>
     <circle cx="20" cy="32" r="2.5" fill="${c}"/>`,
    // 7: Traditional cartographic
    `<polygon points="20,3 26,38 20,30 14,38" fill="${c}"/>
     <polygon points="20,3 14,38 20,30 26,38" fill="${bg}" stroke="${c}" stroke-width="0.5"/>
     <circle cx="20" cy="20" r="2" fill="${c}"/>
     <text x="20" y="29" font-size="6" font-weight="bold" fill="${c}" text-anchor="middle">С</text>`,
    // 8: Circle badge
    `<circle cx="20" cy="24" r="14" fill="${bg}" stroke="${c}" stroke-width="1.5"/>
     <polygon points="20,4 23,20 20,17 17,20" fill="${c}"/>
     <text x="20" y="34" font-size="9" font-weight="bold" fill="${c}" text-anchor="middle">С</text>`,
    // 9: Double chevron
    `<polyline points="14,30 20,6 26,30" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round"/>
     <polyline points="14,38 20,14 26,38" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round" opacity="0.5"/>
     <text x="20" y="10" font-size="7" font-weight="bold" fill="${c}" text-anchor="middle">С</text>`,
  ];
  return `<svg class="ps-north-svg" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">${svgs[s] || svgs[0]}</svg>`;
}

// ── Хендлы изменения размера ──────────────────────
const HANDLES = ['nw','n','ne','e','se','s','sw','w'];

function _updateHandles(el, obj) {
  el.querySelectorAll('.ps-handle').forEach(h => h.remove());
  if (obj.id !== pdfSelId || obj.locked) return;

  // Путь/кривая — редактирование точек
  if (['path','bezier'].includes(obj.type)) {
    _renderPathHandles(el, obj); return;
  }
  // Выноска / Полочка — хендл хвоста + стандартные
  if (obj.type === 'callout' || obj.type === 'leader') {
    _renderCalloutHandles(el, obj);
  }

  // Стандартные resize-хендлы
  HANDLES.forEach(h => {
    const hEl = document.createElement('div');
    hEl.className = 'ps-handle';
    hEl.dataset.h = h;
    el.appendChild(hEl);
    hEl.addEventListener('pointerdown', e => _onResizeStart(e, obj, h));
  });

  // Ручка поворота
  const rEl = document.createElement('div');
  rEl.className = 'ps-handle ps-rotate-handle';
  rEl.title = 'Поворот (Shift = шаг 15°)';
  el.appendChild(rEl);
  rEl.addEventListener('pointerdown', e => _onRotateStart(e, obj));
}

// ── Pointer Events для drag/resize ───────────────
function _attachObjEvents(el, obj) {
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('ps-handle')) return;
    if (pdfTool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();

    // Shift+click — добавить / убрать из мультивыбора
    if (e.shiftKey) {
      selectPdfObj(obj.id, true);
      return;
    }

    // Если кликнули на объект не из текущего выбора — переключить на него
    if (!pdfSelIds.includes(obj.id)) selectPdfObj(obj.id);

    // Проверка группы — если есть groupId, выбираем всю группу
    const gid = obj.data.groupId;
    if (gid && !e.shiftKey) {
      const groupIds = pdfObjects.filter(o => o.data.groupId === gid).map(o => o.id);
      if (groupIds.length > 1) {
        pdfSelIds = groupIds;
        pdfSelId  = obj.id;
        pdfObjects.forEach(o => {
          const oe = document.getElementById(o.id); if (!oe) return;
          oe.classList.toggle('ps-selected', pdfSelIds.includes(o.id));
          _updateHandles(oe, o);
        });
        _updateMultiSelBox(); _renderProps(); _renderLayersList();
      }
    }

    if (obj.locked) return;

    // Drag — сохраняем начальные позиции всех выбранных объектов
    _pushUndo();
    const startX = e.clientX, startY = e.clientY;
    const origPos = new Map();
    pdfSelIds.forEach(sid => {
      const so = pdfObjects.find(x => x.id === sid); if (!so) return;
      origPos.set(sid, {
        x: so.data.x, y: so.data.y,
        pts: so.data.pts ? so.data.pts.map(p => ({...p})) : null,
        tailX: so.data.tailX, tailY: so.data.tailY,
      });
    });
    el.setPointerCapture(e.pointerId);

    function onMove(ev) {
      const canvas = document.getElementById('pdf-canvas');
      const rect   = canvas.getBoundingClientRect();
      const scaleX = canvas.offsetWidth  / rect.width;
      const scaleY = canvas.offsetHeight / rect.height;
      const rawDX  = Math.round((ev.clientX - startX) * scaleX);
      const rawDY  = Math.round((ev.clientY - startY) * scaleY);

      // Snap только для основного объекта
      const orig0 = origPos.get(obj.id);
      if (!orig0) return;
      const snapped = _snapObject(obj, orig0.x + rawDX, orig0.y + rawDY);
      const dx = snapped.x - orig0.x, dy = snapped.y - orig0.y;

      pdfSelIds.forEach(sid => {
        const so = pdfObjects.find(x => x.id === sid); if (!so || so.locked) return;
        const orig = origPos.get(sid); if (!orig) return;
        so.data.x = orig.x + dx;
        so.data.y = orig.y + dy;
        if (orig.pts)              so.data.pts  = orig.pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
        if (orig.tailX !== undefined) { so.data.tailX = orig.tailX + dx; so.data.tailY = orig.tailY + dy; }
        const se = document.getElementById(sid); if (!se) return;
        se.style.left = so.data.x + 'px';
        se.style.top  = so.data.y + 'px';
        if (['path','bezier','callout'].includes(so.type)) { _renderObjContent(se, so); _updateHandles(se, so); }
        if (_insetMaps[sid]) _insetMaps[sid].invalidateSize();
      });
      _syncPropsXY();
      _updateMultiSelBox();
    }
    function onUp() {
      _clearSnapGuides();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      _saveState();
    }
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  });

  // Правый клик — контекстное меню
  el.addEventListener('contextmenu', e => {
    if (pdfTool !== 'select') return;
    selectPdfObj(obj.id);
    _showContextMenu(e, obj);
  });

  // Двойной клик — редактировать текст
  el.addEventListener('dblclick', e => {
    if (obj.locked) return;
    e.stopPropagation();

    // Выноска / Выноска-полочка — редактировать текст
    if (obj.type === 'callout' || obj.type === 'leader') {
      const sel = obj.type === 'callout' ? '.callout-text-inner' : '.leader-text-inner';
      const div = el.querySelector(sel);
      if (!div) return;
      div.style.pointerEvents = 'auto';
      div.style.userSelect = 'text';
      div.contentEditable = 'true';
      div.focus();
      const range = document.createRange();
      range.selectNodeContents(div);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      div.onblur = () => {
        div.contentEditable = 'false';
        div.style.pointerEvents = 'none';
        div.style.userSelect = 'none';
        obj.data.content = div.textContent;
        _saveState();
      };
      return;
    }

    // Обычный текст
    const span = el.querySelector('.ps-text-content');
    if (!span) return;
    span.style.pointerEvents = 'auto';
    span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    span.onblur = () => {
      span.contentEditable = 'false';
      span.style.pointerEvents = 'none';
      obj.data.content = span.textContent;
      _saveState();
    };
  });
}

function _onResizeStart(e, obj, handle) {
  e.stopPropagation();
  e.preventDefault();
  const el = document.getElementById(obj.id);
  const startX = e.clientX, startY = e.clientY;
  const ox = obj.data.x, oy = obj.data.y;
  const ow = obj.data.w, oh = obj.data.h;

  el.setPointerCapture(e.pointerId);

  const canvas = document.getElementById('pdf-canvas');
  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.offsetWidth  / rect.width;
  const scaleY = canvas.offsetHeight / rect.height;

  const aspect = ow / Math.max(oh, 1);

  function onMove(ev) {
    const dx = (ev.clientX - startX) * scaleX;
    const dy = (ev.clientY - startY) * scaleY;
    let nx = ox, ny = oy, nw = ow, nh = oh;

    if (handle.includes('e'))  nw = Math.max(40, ow + dx);
    if (handle.includes('s'))  nh = Math.max(20, oh + dy);
    if (handle.includes('w')) { nx = ox + dx; nw = Math.max(40, ow - dx); }
    if (handle.includes('n')) { ny = oy + dy; nh = Math.max(20, oh - dy); }

    // Shift = пропорциональный масштаб (aspect ratio lock)
    if (ev.shiftKey) {
      if (handle.includes('e') || handle.includes('w')) nh = Math.max(20, nw / aspect);
      else nh = Math.max(20, nh), nw = Math.max(40, nh * aspect);
    }

    obj.data.x = Math.round(nx); obj.data.y = Math.round(ny);
    obj.data.w = Math.round(nw); obj.data.h = Math.round(nh);
    el.style.left = obj.data.x+'px'; el.style.top = obj.data.y+'px';
    el.style.width = obj.data.w+'px'; el.style.height = obj.data.h+'px';
    _renderObjContent(el, obj);
    _syncPropsAll();
  }
  function onUp() {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    _saveState();
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

// ── Draw tool (рисование на канвасе) ─────────────
function _initCanvasDrawing() {
  const canvas = document.getElementById('pdf-canvas');
  if (!canvas || canvas._canvasDrawBound) return;
  canvas._canvasDrawBound = true;

  canvas.addEventListener('pointerdown', e => {
    if (['select','image'].includes(pdfTool)) return;
    if (pdfMapDrag) return;
    if (e.target.closest('#pdf-map')) return;
    if (e.target.classList.contains('ps-obj') || e.target.closest('.ps-obj')) return;
    // Path-инструменты работают через click/dblclick, кроме freehand
    if (['path','bezier','polygon-shape','callout'].includes(pdfTool)) return;
    // Freehand — начинаем запись
    if (pdfTool === 'freehand') {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.offsetWidth/rect.width, sy = canvas.offsetHeight/rect.height;
      const x = Math.round((e.clientX-rect.left)*sx);
      const y = Math.round((e.clientY-rect.top)*sy);
      _pathDraft = { type:'freehand', pts:[{x,y}], freehand:true };
      _showPathGhost();
      canvas.setPointerCapture(e.pointerId);
      const mmFree = ev => {
        const rr = canvas.getBoundingClientRect();
        _pathDraft.pts.push({ x:Math.round((ev.clientX-rr.left)*(canvas.offsetWidth/rr.width)), y:Math.round((ev.clientY-rr.top)*(canvas.offsetHeight/rr.height)) });
        _updatePathGhost(_pathDraft.pts[_pathDraft.pts.length-1].x, _pathDraft.pts[_pathDraft.pts.length-1].y);
      };
      const muFree = () => { canvas.removeEventListener('pointermove',mmFree); canvas.removeEventListener('pointerup',muFree); _finishPath(false); };
      canvas.addEventListener('pointermove', mmFree);
      canvas.addEventListener('pointerup', muFree);
      return;
    }
    e.preventDefault();

    // Позиция внутри pdf-canvas с учётом scale
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.offsetWidth  / rect.width;
    const scaleY = canvas.offsetHeight / rect.height;
    _drawStart = {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };

    _drawGhost = document.createElement('div');
    _drawGhost.id = 'ps-draw-ghost';
    _drawGhost.style.cssText = `left:${_drawStart.x}px;top:${_drawStart.y}px;width:0;height:0`;
    canvas.appendChild(_drawGhost);
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', e => {
    if (!_drawGhost || !_drawStart) return;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.offsetWidth  / rect.width;
    const scaleY = canvas.offsetHeight / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;
    const x  = Math.min(cx, _drawStart.x), y = Math.min(cy, _drawStart.y);
    const w  = Math.abs(cx - _drawStart.x), h = pdfTool === 'line' ? 4 : Math.abs(cy - _drawStart.y);
    _drawGhost.style.left = x+'px'; _drawGhost.style.top = y+'px';
    _drawGhost.style.width = w+'px'; _drawGhost.style.height = h+'px';
  });

  canvas.addEventListener('pointerup', e => {
    if (!_drawGhost || !_drawStart) return;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.offsetWidth  / rect.width;
    const scaleY = canvas.offsetHeight / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;
    const x  = Math.min(cx, _drawStart.x), y = Math.min(cy, _drawStart.y);
    const w  = Math.max(40, Math.abs(cx - _drawStart.x));
    const h  = pdfTool === 'line' ? 4 : Math.max(20, Math.abs(cy - _drawStart.y));

    _drawGhost.remove(); _drawGhost = null; _drawStart = null;

    if (w < 8 && h < 8) { // просто клик
      if (pdfTool === 'text') {
        createPdfObj('text', { x: Math.round(cx - 110), y: Math.round(cy - 26) });
      } else if (pdfTool === 'leader') {
        // Клик = острие (arrowhead). Полочка автоматически над ним
        const bw = 170, bh = 46;
        const bx = Math.round(cx - bw / 2);
        const by = Math.round(cy - bh - 60);
        createPdfObj('leader', { x: bx, y: by, w: bw, h: bh,
          tailX: Math.round(cx), tailY: Math.round(cy) });
      }
    } else if (pdfTool === 'leader') {
      // Drag = область текстового блока. Острие под центром
      createPdfObj('leader', { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
        tailX: Math.round(x + w / 2), tailY: Math.round(y + h + 60) });
    } else if (pdfTool === 'triangle-shape') {
      createPdfObj('triangle', { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), name:'Треугольник' });
    } else if (pdfTool === 'diamond-shape') {
      createPdfObj('diamond', { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), name:'Ромб' });
    } else if (pdfTool === 'star-shape') {
      createPdfObj('star', { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), name:'Звезда' });
    } else {
      createPdfObj(pdfTool, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    }
    setPdfTool('select');
  });

  // Клик по пустому месту — снять выделение (если rubber band не сработал)
  canvas.addEventListener('click', e => {
    if (_rubberBandHandled) { _rubberBandHandled = false; return; }
    if (e.target === canvas || e.target.id === 'pdf-map') {
      selectPdfObj(null);
    }
  });
}

// ── Rubber band (резиновый прямоугольник выбора) ──
function _initRubberBand() {
  const canvas = document.getElementById('pdf-canvas');
  if (!canvas || canvas._rubberBound) return;
  canvas._rubberBound = true;

  let _rs = null, _rb = null;

  canvas.addEventListener('pointerdown', e => {
    if (pdfTool !== 'select' || pdfMapDrag) return;
    if (e.target.closest('.ps-obj') || e.target.closest('#pdf-map')) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.offsetWidth / rect.width, sy = canvas.offsetHeight / rect.height;
    _rs = { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
    _rb = document.createElement('div');
    _rb.style.cssText = `position:absolute;border:1.5px dashed #60a5fa;background:rgba(96,165,250,0.07);pointer-events:none;z-index:9997;left:${_rs.x}px;top:${_rs.y}px;width:0;height:0`;
    canvas.appendChild(_rb);
    canvas.setPointerCapture(e.pointerId);

    function onMove(ev) {
      if (!_rb || !_rs) return;
      const r = canvas.getBoundingClientRect();
      const cx = (ev.clientX - r.left) * (canvas.offsetWidth / r.width);
      const cy = (ev.clientY - r.top)  * (canvas.offsetHeight / r.height);
      const x = Math.min(cx, _rs.x), y = Math.min(cy, _rs.y);
      Object.assign(_rb.style, { left: x+'px', top: y+'px', width: Math.abs(cx-_rs.x)+'px', height: Math.abs(cy-_rs.y)+'px' });
    }
    function onUp(ev) {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      if (!_rb || !_rs) return;
      _rb.remove(); _rb = null;
      const r = canvas.getBoundingClientRect();
      const cx = (ev.clientX - r.left) * (canvas.offsetWidth / r.width);
      const cy = (ev.clientY - r.top)  * (canvas.offsetHeight / r.height);
      const x = Math.min(cx, _rs.x), y = Math.min(cy, _rs.y);
      const w = Math.abs(cx - _rs.x), h = Math.abs(cy - _rs.y);
      _rs = null;
      if (w < 6 && h < 6) { if (!ev.shiftKey) selectPdfObj(null); return; }
      const ids = pdfObjects.filter(o => {
        if (!o.visible || o.locked) return false;
        const d = o.data;
        return d.x < x + w && d.x + d.w > x && d.y < y + h && d.y + d.h > y;
      }).map(o => o.id);
      if (!ids.length) { if (!ev.shiftKey) selectPdfObj(null); return; }
      if (ev.shiftKey) { ids.forEach(id => { if (!pdfSelIds.includes(id)) pdfSelIds.push(id); }); }
      else { pdfSelIds = ids; }
      pdfSelId = pdfSelIds[0] || null;
      pdfObjects.forEach(o => {
        const oe = document.getElementById(o.id); if (!oe) return;
        oe.classList.toggle('ps-selected', pdfSelIds.includes(o.id));
        _updateHandles(oe, o);
      });
      _rubberBandHandled = true;
      _updateMultiSelBox(); _renderProps(); _renderLayersList();
    }
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
  });
}

// ── Выделение ─────────────────────────────────────
function selectPdfObj(id, addToSel = false) {
  if (!addToSel) {
    pdfSelIds = id ? [id] : [];
    pdfSelId  = id;
  } else if (id) {
    const idx = pdfSelIds.indexOf(id);
    if (idx > -1) {
      pdfSelIds.splice(idx, 1);
      pdfSelId = pdfSelIds.length ? pdfSelIds[pdfSelIds.length - 1] : null;
    } else {
      pdfSelIds.push(id);
      pdfSelId = id;
    }
  }

  pdfObjects.forEach(obj => {
    const el = document.getElementById(obj.id);
    if (!el) return;
    el.classList.toggle('ps-selected', pdfSelIds.includes(obj.id));
    _updateHandles(el, obj);
    el.style.cursor = obj.locked ? 'not-allowed' : pdfTool === 'select' ? 'grab' : 'crosshair';
  });
  _updateMultiSelBox();
  _renderProps();
  _renderLayersList();
}

function _updateMultiSelBox() {
  let box = document.getElementById('pdf-multi-sel-box');
  if (pdfSelIds.length <= 1) { if (box) box.style.display = 'none'; return; }
  if (!box) {
    box = document.createElement('div');
    box.id = 'pdf-multi-sel-box';
    box.style.cssText = 'position:absolute;border:2px dashed #60a5fa;pointer-events:none;z-index:9998;opacity:0.75;border-radius:2px;';
    const canvas = document.getElementById('pdf-canvas');
    if (canvas) canvas.appendChild(box);
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pdfSelIds.forEach(sid => {
    const o = pdfObjects.find(x => x.id === sid); if (!o) return;
    const d = o.data;
    minX = Math.min(minX, d.x); minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x + d.w); maxY = Math.max(maxY, d.y + d.h);
  });
  const pad = 5;
  Object.assign(box.style, {
    left: (minX - pad) + 'px', top: (minY - pad) + 'px',
    width: (maxX - minX + pad*2) + 'px', height: (maxY - minY + pad*2) + 'px',
    display: 'block',
  });
}

// ── Действия с объектами ──────────────────────────
function deletePdfObj() {
  if (!pdfSelIds.length) return;
  _pushUndo();
  const toDelete = [...pdfSelIds];
  toDelete.forEach(id => {
    if (_insetMaps[id]) { try { _insetMaps[id].remove(); } catch(e) {} delete _insetMaps[id]; }
    const el = document.getElementById(id);
    if (el) el.remove();
  });
  pdfObjects = pdfObjects.filter(o => !toDelete.includes(o.id));
  pdfSelId   = null;
  pdfSelIds  = [];
  const box = document.getElementById('pdf-multi-sel-box');
  if (box) box.style.display = 'none';
  _renderLayersList(); _renderProps(); _saveState();
}

function duplicatePdfObj() {
  if (!pdfSelId) return;
  const src = pdfObjects.find(o => o.id === pdfSelId);
  if (!src) return;
  createPdfObj(src.type, { ...deepClone(src.data), x: src.data.x + 18, y: src.data.y + 18, name: src.name + ' копия' });
}

function toggleLockPdfObj() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  obj.locked = !obj.locked;
  _renderObj(obj); _renderLayersList(); _saveState();
}

function movePdfObjUp() {
  const idx = pdfObjects.findIndex(o => o.id === pdfSelId);
  if (idx <= 0) return;
  [pdfObjects[idx-1], pdfObjects[idx]] = [pdfObjects[idx], pdfObjects[idx-1]];
  _renderAll(); _renderLayersList(); _saveState();
}

function movePdfObjDown() {
  const idx = pdfObjects.findIndex(o => o.id === pdfSelId);
  if (idx < 0 || idx >= pdfObjects.length-1) return;
  [pdfObjects[idx+1], pdfObjects[idx]] = [pdfObjects[idx], pdfObjects[idx+1]];
  _renderAll(); _renderLayersList(); _saveState();
}

// ── Flip (зеркальное отражение) ───────────────────
function flipPdfObj(axis) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.locked) return;
  _pushUndo();
  if (axis === 'h') obj.data.flipX = !obj.data.flipX;
  else              obj.data.flipY = !obj.data.flipY;
  _renderObj(obj); _renderProps(); _saveState();
}

// ── Группировка ───────────────────────────────────
function groupPdfObjs() {
  if (pdfSelIds.length < 2) { setSt('Выбери 2+ объекта (Shift+клик)', 'err'); return; }
  _pushUndo();
  const gid = 'grp_' + (++_groupCounter);
  pdfSelIds.forEach(id => {
    const o = pdfObjects.find(x => x.id === id);
    if (o) o.data.groupId = gid;
  });
  _renderLayersList(); _saveState();
  setSt('Объекты сгруппированы (' + pdfSelIds.length + ' шт.) ✓', 'ok');
}

function ungroupPdfObjs() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || !obj.data.groupId) { setSt('Нет группировки', 'err'); return; }
  _pushUndo();
  const gid = obj.data.groupId;
  pdfObjects.forEach(o => { if (o.data.groupId === gid) delete o.data.groupId; });
  _renderLayersList(); _saveState();
  setSt('Группировка отменена ✓', 'ok');
}

// ── Выбрать все объекты ───────────────────────────
function selectAllPdfObjs() {
  pdfSelIds = pdfObjects.filter(o => o.visible && !o.locked).map(o => o.id);
  pdfSelId  = pdfSelIds[0] || null;
  pdfObjects.forEach(o => {
    const e = document.getElementById(o.id); if (!e) return;
    e.classList.toggle('ps-selected', pdfSelIds.includes(o.id));
    _updateHandles(e, o);
  });
  _updateMultiSelBox(); _renderProps(); _renderLayersList();
}

const PDF_FONTS = [
  'Segoe UI','Arial','Times New Roman','Georgia','Courier New','Tahoma','Verdana',
  'Impact','Trebuchet MS','Arial Black','Comic Sans MS','Calibri','Cambria',
  'Consolas','Palatino Linotype','Garamond','Century Gothic','Franklin Gothic Medium',
  'Lucida Console','Lucida Sans Unicode','Arial Narrow','Book Antiqua',
  'PT Sans','PT Serif','Roboto','Open Sans','Lato','Montserrat','Oswald','Nunito',
];

// ── Панель свойств ────────────────────────────────
function _renderProps() {
  const panel = document.getElementById('pdf-props-panel');
  if (!pdfSelId) {
    panel.innerHTML = '<div class="pp-title">⚙ Свойства</div><div class="pp-empty">Выберите объект</div>';
    return;
  }
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  const d = obj.data;

  const bgHex = _rgbaToHex(d.bg);
  const alpha  = _rgbaAlpha(d.bg);
  const showText = ['text','callout','leader','rect','ellipse'].includes(obj.type);
  const isNorth  = obj.type === 'north';
  const isLegend = obj.type === 'legend';

  const fontOpts = PDF_FONTS.map(f => `<option ${d.fontFamily===f?'selected':''}>${f}</option>`).join('');

  panel.innerHTML = `
    <div class="pp-title">⚙ <span style="color:#60a5fa;text-transform:none">${obj.name}</span></div>
    <div class="pp-body">

      ${isNorth ? `
      <div class="pp-row">
        <span class="pp-lbl">Стиль</span>
        <div style="display:flex;gap:2px;flex-wrap:wrap;flex:1">
          ${[0,1,2,3,4,5,6,7,8,9].map(i=>`<button onclick="applyNorthStyle(${i})" style="width:26px;height:26px;font-size:9px;border-radius:3px;border:1px solid ${(d.northStyle||0)===i?'#60a5fa':'#1f2937'};background:${(d.northStyle||0)===i?'#1a2d50':'#161b27'};color:${(d.northStyle||0)===i?'#60a5fa':'#6b7280'};cursor:pointer">${i+1}</button>`).join('')}
        </div>
      </div>
      <div class="pp-sep"></div>` : ''}

      ${isLegend ? `
      <div class="pp-row">
        <span class="pp-lbl">Стиль</span>
        <div style="display:flex;gap:3px;flex:1">
          ${['Классика','Рамки','Мин.','Горизонт.'].map((n,i)=>`<button onclick="applyLegendStyle(${i})" style="flex:1;padding:3px 2px;font-size:9px;border-radius:4px;border:1px solid ${(d.legendStyle||0)===i?'#60a5fa':'#1f2937'};background:${(d.legendStyle||0)===i?'#1a2d50':'#161b27'};color:${(d.legendStyle||0)===i?'#60a5fa':'#6b7280'};cursor:pointer">${n}</button>`).join('')}
        </div>
      </div>
      <div class="pp-sep"></div>` : ''}

      <div class="pp-row">
        <span class="pp-lbl">X / Y</span>
        <input class="pp-inp-sm" type="number" id="pp-x" value="${Math.round(d.x)}" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-y" value="${Math.round(d.y)}" oninput="applyPdfProp()">
        <span style="font-size:9px;color:#4b5563">px</span>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Ш / В</span>
        <input class="pp-inp-sm" type="number" id="pp-w" value="${Math.round(d.w)}" min="20" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-h" value="${Math.round(d.h)}" min="10" oninput="applyPdfProp()">
        <span style="font-size:9px;color:#4b5563">px</span>
      </div>
      <div class="pp-sep"></div>

      <!-- Быстрая заливка -->
      <div class="pp-row">
        <span class="pp-lbl">Заливка</span>
        <input class="pp-color" type="color" id="pp-bg" value="${bgHex}" oninput="applyPdfProp()" style="width:32px;height:32px">
        <input class="pp-slider" type="range" id="pp-alpha" min="0" max="100" value="${Math.round(alpha*100)}" oninput="applyPdfProp()">
        <span id="pp-alpha-val" style="font-size:10px;color:#6b7280;min-width:28px">${Math.round(alpha*100)}%</span>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Контур</span>
        <input class="pp-color" type="color" id="pp-stroke" value="${d.strokeColor==='transparent'?'#334155':d.strokeColor}" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-sw" value="${d.strokeW}" min="0" max="20" oninput="applyPdfProp()">
        <span style="font-size:9px;color:#4b5563">px</span>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Пунктир</span>
        <select class="pp-inp" id="pp-dash" onchange="applyPdfProp()" style="font-size:10px">
          <option value="" ${!d.strokeDash?'selected':''}>— Сплошная</option>
          <option value="8,4" ${d.strokeDash==='8,4'?'selected':''}>- - - Пунктир</option>
          <option value="3,5" ${d.strokeDash==='3,5'?'selected':''}>··· Точки</option>
          <option value="12,4,3,4" ${d.strokeDash==='12,4,3,4'?'selected':''}>-·- Штрих-пунктир</option>
        </select>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Прозрачн.</span>
        <input class="pp-slider" type="range" id="pp-opacity" min="0" max="100" value="${Math.round((d.opacity!==undefined?d.opacity:1)*100)}" oninput="applyPdfProp()">
        <span id="pp-opacity-val" style="font-size:10px;color:#6b7280;min-width:28px">${Math.round((d.opacity!==undefined?d.opacity:1)*100)}%</span>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Тень</span>
        <input type="checkbox" id="pp-shadow" ${d.shadow?'checked':''} onchange="applyPdfProp()">
        <input class="pp-color" type="color" id="pp-shadow-color" value="${d.shadowColor||'#000000'}" oninput="applyPdfProp()" style="width:28px;height:28px">
        <input class="pp-inp-sm" type="number" id="pp-shadow-x" value="${d.shadowX||4}" min="-40" max="40" oninput="applyPdfProp()" style="width:32px" title="X">
        <input class="pp-inp-sm" type="number" id="pp-shadow-y" value="${d.shadowY||4}" min="-40" max="40" oninput="applyPdfProp()" style="width:32px" title="Y">
        <input class="pp-inp-sm" type="number" id="pp-shadow-blur" value="${d.shadowBlur||14}" min="0" max="60" oninput="applyPdfProp()" style="width:32px" title="Blur">
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Отразить</span>
        <button class="pp-sbtn" onclick="flipPdfObj('h')" title="Горизонтально" style="${d.flipX?'border-color:#60a5fa;color:#60a5fa':''}">↔ Г</button>
        <button class="pp-sbtn" onclick="flipPdfObj('v')" title="Вертикально" style="${d.flipY?'border-color:#60a5fa;color:#60a5fa':''}">↕ В</button>
      </div>

      ${showText ? `
      <div class="pp-sep"></div>
      <div class="pp-row">
        <span class="pp-lbl">Шрифт</span>
        <select class="pp-inp" id="pp-font" onchange="applyPdfProp()">${fontOpts}</select>
        <input class="pp-inp-sm" type="number" id="pp-fsize" value="${d.fontSize}" min="6" max="120" oninput="applyPdfProp()" style="width:42px">
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Стиль</span>
        <div class="pp-style-btns">
          <button class="pp-sbtn ${d.fontWeight==='700'?'active':''}" onclick="togglePdfFontStyle('bold')" style="font-weight:700">B</button>
          <button class="pp-sbtn ${d.fontStyle==='italic'?'active':''}" onclick="togglePdfFontStyle('italic')" style="font-style:italic">I</button>
          <button class="pp-sbtn ${d.textDecoration==='underline'?'active':''}" onclick="togglePdfFontStyle('underline')" style="text-decoration:underline">U</button>
          <select class="pp-inp" id="pp-align" onchange="applyPdfProp()" style="flex:1;font-size:11px;padding:2px">
            <option value="left"   ${d.textAlign==='left'   ?'selected':''}>← Лево</option>
            <option value="center" ${d.textAlign==='center' ?'selected':''}>↔ Центр</option>
            <option value="right"  ${d.textAlign==='right'  ?'selected':''}>→ Право</option>
          </select>
        </div>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Цвет</span>
        <input class="pp-color" type="color" id="pp-color" value="${d.color === 'transparent' ? '#000000' : d.color}" oninput="applyPdfProp()">
        <span class="pp-lbl" style="margin-left:4px">Тень</span>
        <input type="checkbox" id="pp-tshadow" ${d.textShadow?'checked':''} onchange="applyPdfProp()">
        <span class="pp-lbl" style="margin-left:4px">Обв.</span>
        <input class="pp-color" type="color" id="pp-tsc" value="${(d.textStrokeColor && d.textStrokeColor !== 'transparent') ? d.textStrokeColor : '#000000'}" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-tsw" value="${d.textStrokeW || 0}" min="0" max="10" oninput="applyPdfProp()" style="width:34px">
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Межстрочн.</span>
        <input class="pp-slider" type="range" id="pp-lh" min="80" max="300" value="${Math.round((d.lineHeight||1.4)*100)}" oninput="applyPdfProp()">
        <span id="pp-lh-val" style="font-size:10px;color:#6b7280;min-width:28px">${Math.round((d.lineHeight||1.4)*100)}%</span>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Кернинг</span>
        <input class="pp-inp-sm" type="number" id="pp-spacing" value="${d.letterSpacing||0}" min="-5" max="30" step="0.5" oninput="applyPdfProp()" style="width:44px">
        <span style="font-size:9px;color:#4b5563">px</span>
      </div>
      ` : ''}

      <div class="pp-sep"></div>
      <div class="pp-row">
        <span class="pp-lbl">Скругл.</span>
        <input class="pp-slider" type="range" id="pp-radius" min="0" max="200" value="${d.radius||0}" oninput="applyPdfProp()">
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Поворот</span>
        <input class="pp-slider" type="range" id="pp-rotation" min="-180" max="180" value="${d.rotation||0}" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-rotation-val" value="${d.rotation||0}" min="-180" max="180" style="width:44px" oninput="document.getElementById('pp-rotation').value=this.value;applyPdfProp()">
        <button style="font-size:10px;padding:2px 5px;border:1px solid #374151;border-radius:4px;background:#1f2937;color:#94a3b8;cursor:pointer;margin-left:2px" onclick="_resetRotation()">↺</button>
      </div>
      <div class="pp-sep"></div>
      <div class="pp-style-btns">
        <button class="pp-sbtn" onclick="duplicatePdfObj()" title="Дублировать">⧉</button>
        <button class="pp-sbtn" onclick="toggleLockPdfObj()" title="${obj.locked?'Разблокировать':'Заблокировать'}">${obj.locked?'🔓':'🔒'}</button>
        <button class="pp-sbtn danger" onclick="deletePdfObj()" title="Удалить">🗑</button>
      </div>
    </div>
  `;
}

function applyNorthStyle(s) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  obj.data.northStyle = s;
  _renderObj(obj); _renderProps(); _saveState();
}
function applyLegendStyle(s) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  obj.data.legendStyle = s;
  _renderObj(obj); _renderProps(); _saveState();
}

function _syncPropsXY() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  const ex = document.getElementById('pp-x'), ey = document.getElementById('pp-y');
  if (ex) ex.value = Math.round(obj.data.x);
  if (ey) ey.value = Math.round(obj.data.y);
}
function _syncPropsAll() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  const d = obj.data;
  const ids = { 'pp-x': Math.round(d.x), 'pp-y': Math.round(d.y), 'pp-w': Math.round(d.w), 'pp-h': Math.round(d.h) };
  Object.entries(ids).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = val; });
}

function applyPdfProp() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj || obj.locked) return;
  const d = obj.data;

  d.x = parseInt(document.getElementById('pp-x')?.value) || d.x;
  d.y = parseInt(document.getElementById('pp-y')?.value) || d.y;
  d.w = parseInt(document.getElementById('pp-w')?.value) || d.w;
  d.h = parseInt(document.getElementById('pp-h')?.value) || d.h;

  if (document.getElementById('pp-font'))   d.fontFamily = document.getElementById('pp-font').value;
  if (document.getElementById('pp-fsize'))  d.fontSize   = parseInt(document.getElementById('pp-fsize').value) || 14;
  if (document.getElementById('pp-align'))  d.textAlign  = document.getElementById('pp-align').value;
  if (document.getElementById('pp-tshadow'))d.textShadow = document.getElementById('pp-tshadow').checked;
  if (document.getElementById('pp-color'))  d.color      = document.getElementById('pp-color').value;
  if (document.getElementById('pp-tsc') && document.getElementById('pp-tsw')) {
    const tsw = parseInt(document.getElementById('pp-tsw').value) || 0;
    d.textStrokeW     = tsw;
    d.textStrokeColor = tsw > 0 ? document.getElementById('pp-tsc').value : 'transparent';
  }

  const bgEl = document.getElementById('pp-bg'), alphaEl = document.getElementById('pp-alpha');
  if (bgEl && alphaEl) {
    const alpha = parseInt(alphaEl.value) / 100;
    d.bg = hexToRgba(bgEl.value, alpha);
    const av = document.getElementById('pp-alpha-val');
    if (av) av.textContent = Math.round(alpha * 100) + '%';
  }

  const sw = parseInt(document.getElementById('pp-sw')?.value) || 0;
  const sc = document.getElementById('pp-stroke')?.value || '#334155';
  d.strokeW = sw;
  d.strokeColor = (['path','bezier','triangle','diamond','star','rect','ellipse','line'].includes(obj.type) || sw > 0) ? sc : 'transparent';
  d.strokeDash  = document.getElementById('pp-dash')?.value || '';
  if (document.getElementById('pp-radius')) d.radius = parseInt(document.getElementById('pp-radius').value) || 0;

  // Shadow
  if (document.getElementById('pp-shadow')) {
    d.shadow      = document.getElementById('pp-shadow').checked;
    d.shadowColor = document.getElementById('pp-shadow-color')?.value || 'rgba(0,0,0,0.22)';
    d.shadowX     = parseInt(document.getElementById('pp-shadow-x')?.value) || 4;
    d.shadowY     = parseInt(document.getElementById('pp-shadow-y')?.value) || 4;
    d.shadowBlur  = parseInt(document.getElementById('pp-shadow-blur')?.value) || 14;
  }

  // Opacity
  const opEl = document.getElementById('pp-opacity');
  if (opEl) {
    d.opacity = parseInt(opEl.value) / 100;
    const ov = document.getElementById('pp-opacity-val');
    if (ov) ov.textContent = Math.round(d.opacity * 100) + '%';
  }

  // Line-height & letter-spacing
  const lhEl = document.getElementById('pp-lh');
  if (lhEl) {
    d.lineHeight = parseInt(lhEl.value) / 100;
    const lhv = document.getElementById('pp-lh-val');
    if (lhv) lhv.textContent = lhEl.value + '%';
  }
  const spEl = document.getElementById('pp-spacing');
  if (spEl) d.letterSpacing = parseFloat(spEl.value) || 0;

  if (document.getElementById('pp-rotation')) {
    d.rotation = parseFloat(document.getElementById('pp-rotation').value) || 0;
    const rv = document.getElementById('pp-rotation-val');
    if (rv) rv.value = d.rotation;
  }

  _renderObj(obj);
  _saveState();
}

function _resetRotation() {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  obj.data.rotation = 0;
  _renderObj(obj);
  _renderProps();
  _saveState();
}

function togglePdfFontStyle(style) {
  const obj = pdfObjects.find(o => o.id === pdfSelId);
  if (!obj) return;
  const d = obj.data;
  if (style === 'bold')      d.fontWeight      = d.fontWeight === '700' ? '400' : '700';
  if (style === 'italic')    d.fontStyle       = d.fontStyle === 'italic' ? 'normal' : 'italic';
  if (style === 'underline') d.textDecoration  = d.textDecoration === 'underline' ? 'none' : 'underline';
  _renderObj(obj);
  _renderProps();
  _saveState();
}

// ── Панель слоёв ──────────────────────────────────
function _renderLayersList() {
  const panel = document.getElementById('pdf-layers-panel');
  panel.innerHTML = `
    <div class="pl-header">
      <span>🗂 Объекты</span>
      <div class="pl-order-btns">
        <button class="pl-order-btn" onclick="movePdfObjUp()" title="Вверх">↑</button>
        <button class="pl-order-btn" onclick="movePdfObjDown()" title="Вниз">↓</button>
      </div>
    </div>
    <div class="pl-list" id="pl-list-inner">
      ${pdfObjects.length === 0
        ? '<div class="pl-empty">Нет объектов.<br>Используй инструменты выше.</div>'
        : pdfObjects.map(obj => {
          const icon = { text:'T', rect:'▭', ellipse:'◯', line:'╱', legend:'≡', scale:'📏', north:'🧭', image:'🖼', inset:'🔍', arrow:'➡', path:'✒', bezier:'〰', callout:'💬' }[obj.type] || '?';
          return `<div class="pl-item ${obj.id===pdfSelId?'selected':''} ${obj.locked?'locked':''}"
                       onclick="selectPdfObj('${obj.id}')">
            <span class="pl-vis" onclick="togglePdfObjVis(event,'${obj.id}')">${obj.visible?'👁':'🙈'}</span>
            <div class="pl-thumb">${icon}</div>
            <span class="pl-name">${obj.name}</span>
            ${obj.locked ? '<span class="pl-lock">🔒</span>' : ''}
          </div>`;
        }).join('')
      }
    </div>
  `;
}

function togglePdfObjVis(e, id) {
  e.stopPropagation();
  const obj = pdfObjects.find(o => o.id === id);
  if (!obj) return;
  obj.visible = !obj.visible;
  const el = document.getElementById(id);
  if (el) el.style.display = obj.visible ? 'flex' : 'none';
  _renderLayersList();
  _saveState();
}

// ── Рендер всех объектов ──────────────────────────
function _renderAll() {
  // Удаляем все объекты; для инсетов сначала убиваем Leaflet-карту
  document.querySelectorAll('.ps-obj').forEach(el => {
    if (_insetMaps[el.id]) {
      try { _insetMaps[el.id].remove(); } catch(e) {}
      delete _insetMaps[el.id];
    }
    el.remove();
  });
  pdfObjects.forEach(obj => _renderObj(obj));
}

// ── Стандартные объекты ───────────────────────────
function _addDefaultObjects() {
  const al = getActiveLayer();
  const title = al ? `Карта объекта: ${al.name}` : 'Схема расположения земельных участков';
  createPdfObj('text',   { x:20, y:16, w:460, h:46, content: title, name:'Заголовок', fontWeight:'700' });
  addPdfLegend();
  addPdfScale();
  addPdfNorth();
  selectPdfObj(null);
}

function addPdfLegend() {
  const W = pdfOrientation === 'landscape' ? CANVAS_W_L : CANVAS_W_P;
  const H = pdfOrientation === 'landscape' ? CANVAS_H_L : CANVAS_H_P;
  createPdfObj('legend', { x:14, y:H-160, w:240, h:140, name:'Легенда' });
  setPdfTool('select');
}
function addPdfScale() {
  const W = pdfOrientation === 'landscape' ? CANVAS_W_L : CANVAS_W_P;
  const H = pdfOrientation === 'landscape' ? CANVAS_H_L : CANVAS_H_P;
  createPdfObj('scale', { x:W-190, y:H-66, name:'Масштаб' });
  setPdfTool('select');
}
function addPdfNorth() {
  const W = pdfOrientation === 'landscape' ? CANVAS_W_L : CANVAS_W_P;
  createPdfObj('north', { x:W-76, y:16, name:'Стрелка С' });
  setPdfTool('select');
}

// ── Изображение ───────────────────────────────────
function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    createPdfObj('image', { imgSrc: ev.target.result, w:180, h:120, name: file.name.slice(0,20) });
    setPdfTool('select');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// ── Сохранение состояния ──────────────────────────
function _saveState() {
  try {
    const state = pdfObjects.map(obj => ({
      id:      obj.id,
      type:    obj.type,
      name:    obj.name,
      locked:  obj.locked,
      visible: obj.visible,
      data:    { ...obj.data, imgSrc: obj.data.imgSrc ? '[img]' : '' }, // не сохраняем base64
    }));
    Store.set('pdfObjects', state);
    Store.set('pdfOrientation', pdfOrientation);
  } catch(e) {}
}

function _loadState() {
  const saved = Store.get('pdfObjects', []);
  pdfOrientation = Store.get('pdfOrientation', 'landscape');
  // Восстанавливаем объекты без изображений (base64 не сериализуем)
  pdfObjects = saved.filter(o => o.type && o.data).map(o => ({
    ...o,
    data: { ...OBJ_DEFAULTS[o.type] || OBJ_DEFAULTS.rect, ...o.data }
  }));
  // Чтобы новые объекты не конфликтовали по id
  const maxCnt = pdfObjects.reduce((m, o) => {
    const n = parseInt((o.id || '').replace('pobj_', '')) || 0;
    return Math.max(m, n + 1);
  }, pdfObjCnt);
  pdfObjCnt = maxCnt;
}

// ── Хелперы для цветов ────────────────────────────
function _rgbaToHex(color) {
  if (!color || color === 'transparent') return '#ffffff';
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return color.startsWith('#') ? color : '#ffffff';
  return '#' + [m[1],m[2],m[3]].map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
}
function _rgbaAlpha(color) {
  if (!color || color === 'transparent') return 0;
  const m = color.match(/[\d.]+\)$/);
  return m ? parseFloat(m[0]) : 1;
}

// ── Клавиатура ────────────────────────────────────
document.addEventListener('keydown', e => {
  if (document.getElementById('pdf-editor').style.display === 'none') return;
  if (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === 'Delete' || e.key === 'Backspace') deletePdfObj();
  if (e.key === 'v' || e.key === 'V') setPdfTool('select');
  if (e.key === 't' || e.key === 'T') setPdfTool('text');
  if (e.key === 'r' || e.key === 'R') setPdfTool('rect');
  if (e.key === 'e' || e.key === 'E') setPdfTool('ellipse');
  if (e.key === 'l' || e.key === 'L') setPdfTool('line');
  if (e.key === 'p' || e.key === 'P') setPdfTool('path');
  if (e.key === 'b' || e.key === 'B') setPdfTool('bezier');
  if (e.key === 'f' || e.key === 'F') setPdfTool('freehand');
  if (e.key === 'Escape') { _clearPathGhost(); selectPdfObj(null); setPdfTool('select'); }
  if ((e.ctrlKey||e.metaKey) && e.key==='d') { e.preventDefault(); duplicatePdfObj(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='z') { e.preventDefault(); undoPdf(); }
  if ((e.ctrlKey||e.metaKey) && (e.key==='y' || (e.shiftKey && e.key==='Z'))) { e.preventDefault(); redoPdf(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='c') { e.preventDefault(); copyPdfObj(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='v') { e.preventDefault(); pastePdfObj(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='a') { e.preventDefault(); selectAllPdfObjs(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='g' && e.shiftKey)  { e.preventDefault(); ungroupPdfObjs(); }
  else if ((e.ctrlKey||e.metaKey) && e.key==='g')           { e.preventDefault(); groupPdfObjs(); }

  // Стрелки — двигать объект
  if (pdfSelId && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
    const obj = pdfObjects.find(o => o.id === pdfSelId);
    if (obj && !obj.locked) {
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft')  obj.data.x -= step;
      if (e.key === 'ArrowRight') obj.data.x += step;
      if (e.key === 'ArrowUp')    obj.data.y -= step;
      if (e.key === 'ArrowDown')  obj.data.y += step;
      const el = document.getElementById(obj.id);
      if (el) { el.style.left = obj.data.x+'px'; el.style.top = obj.data.y+'px'; }
      _syncPropsXY();
      e.preventDefault();
    }
  }
});

// ── Экспорт PDF ───────────────────────────────────
async function renderPdf() {
  const btn = document.getElementById('pdf-save-btn');
  if (btn) { btn.textContent = '⏳…'; btn.disabled = true; }

  selectPdfObj(null);
  const hiddenEls = _hideExportOverlays();
  const canvas = document.getElementById('pdf-canvas');
  const isLand = pdfOrientation === 'landscape';

  // Сбрасываем transform чтобы карта не смещалась при захвате
  const savedTransform = canvas.style.transform;
  canvas.style.transform = 'none';
  canvas.style.transformOrigin = 'top left';
  if (pdfMap) pdfMap.invalidateSize(false);
  Object.values(_insetMaps).forEach(m => { try { m.invalidateSize(false); } catch(e){} });
  await new Promise(r => setTimeout(r, 250));

  try {
    const scale = window.devicePixelRatio * 2;
    const snap  = await html2canvas(canvas, {
      useCORS: true,
      allowTaint: false,
      scale,
      backgroundColor: '#ffffff',
      ignoreElements: el => el.classList && (el.classList.contains('ps-handle') || el.classList.contains('no-export')),
    });

    const imgData = snap.toDataURL('image/jpeg', 0.94);
    const { jsPDF } = window.jspdf;
    const pdfW = isLand ? 297 : 210;
    const pdfH = isLand ? 210 : 297;
    const doc  = new jsPDF({ orientation: isLand ? 'l' : 'p', unit: 'mm', format: 'a4' });
    doc.addImage(imgData, 'JPEG', 0, 0, pdfW, pdfH);

    const al    = getActiveLayer();
    const fname = (al ? al.name : 'map').replace(/[^а-яa-z0-9_\s]/gi,'_').slice(0,40);
    doc.save(`${fname}_${new Date().toISOString().slice(0,10)}.pdf`);
    setSt('PDF сохранён ✓', 'ok');
  } catch(e) {
    alert('Ошибка генерации PDF: ' + e.message);
    console.error(e);
  }

  // Восстанавливаем transform
  canvas.style.transform = savedTransform;
  canvas.style.transformOrigin = 'center center';
  if (pdfMap) pdfMap.invalidateSize(false);
  Object.values(_insetMaps).forEach(m => { try { m.invalidateSize(false); } catch(e){} });
  _showExportOverlays(hiddenEls);
  if (btn) { btn.textContent = '💾 PDF'; btn.disabled = false; }
}

// ── stub для совместимости ────────────────────────
function updatePdfOverlays() {
  if (document.getElementById('pdf-editor').style.display !== 'none') {
    pdfObjects.filter(o => ['legend','scale'].includes(o.type)).forEach(obj => {
      const el = document.getElementById(obj.id);
      if (el) _renderObjContent(el, obj);
    });
  }
}
