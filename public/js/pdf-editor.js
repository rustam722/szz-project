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

// ── Undo / Redo ───────────────────────────────────
let _undoStack   = [];
let _redoStack   = [];

// ── Copy / Paste ──────────────────────────────────
let _clipboard   = null;

// ── Canvas zoom ───────────────────────────────────
let _zoomMul     = 1.0;

// ── Grid ──────────────────────────────────────────
let _gridEnabled = false;
let _gridSnap    = false;
const _gridSize  = 20;

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

  // Восстанавливаем объекты из localStorage
  _loadState();

  // Если объектов нет — добавляем стандартные
  if (pdfObjects.length === 0) _addDefaultObjects();

  _applyOrientation();
  _renderAll();
  _renderLayersList();
  _renderProps();
  _initCanvasZoomWheel();

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
  mapLayers.forEach(l => {
    if (l.layer && l.layer.toGeoJSON) {
      try {
        const geo   = l.layer.toGeoJSON();
        const style = l._psStyle || { color: l.color, fillColor: l.color, fillOpacity: l.type === 'szz' ? 0.1 : 0.15, weight: 2 };
        L.geoJSON(geo, { style: () => style }).addTo(pdfMap);
      } catch(e) {}
    }
  });

  // Масштаб
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(pdfMap);
}

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
    zoomCanvas(e.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });
}

// ── Grid ──────────────────────────────────────────
function toggleGrid() {
  _gridEnabled = !_gridEnabled;
  document.getElementById('pdf-canvas').classList.toggle('show-grid', _gridEnabled);
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
  btn.textContent = '⏳ PNG…'; btn.disabled = true;
  selectPdfObj(null);
  const lc = document.querySelector('#pdf-map .leaflet-control-container');
  if (lc) lc.style.display = 'none';
  const canvas = document.getElementById('pdf-canvas');
  try {
    const snap = await html2canvas(canvas, {
      useCORS: true, allowTaint: false,
      scale: window.devicePixelRatio * 2,
      backgroundColor: '#ffffff',
      ignoreElements: el => el.classList && el.classList.contains('ps-handle'),
    });
    const a = document.createElement('a');
    const al = getActiveLayer();
    a.download = `${(al ? al.name : 'map').replace(/[^\wа-яА-Я]/g,'_')}_${new Date().toISOString().slice(0,10)}.png`;
    a.href = snap.toDataURL('image/png');
    a.click();
    setSt('PNG сохранён ✓', 'ok');
  } catch(err) { setSt('Ошибка PNG: ' + err.message, 'err'); }
  if (lc) lc.style.display = '';
  btn.textContent = '💾 Сохранить PDF'; btn.disabled = false;
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
  if (!_snapEnabled) return { x: nx, y: ny };
  _clearSnapGuides();
  const canvas = document.getElementById('pdf-canvas');
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  const d = obj.data;

  // Опорные точки объекта
  const pts = [
    { ox: nx,              oy: ny },
    { ox: nx + d.w / 2,   oy: ny + d.h / 2 },
    { ox: nx + d.w,        oy: ny + d.h },
  ];

  // Цели: центр и края холста
  const snapX = [0, Math.round(W / 2), W];
  const snapY = [0, Math.round(H / 2), H];

  // Цели от других объектов
  pdfObjects.filter(o => o.id !== obj.id && o.visible).forEach(o => {
    snapX.push(o.data.x, Math.round(o.data.x + o.data.w / 2), o.data.x + o.data.w);
    snapY.push(o.data.y, Math.round(o.data.y + o.data.h / 2), o.data.y + o.data.h);
  });

  let sx = nx, sy = ny;
  const offsets = [0, d.w / 2, d.w];

  for (let i = 0; i < 3; i++) {
    for (const tv of snapX) {
      if (Math.abs(nx + offsets[i] - tv) < SNAP_DIST) { sx = Math.round(tv - offsets[i]); _showGuide('v', tv); break; }
    }
    for (const tv of snapY) {
      if (Math.abs(ny + offsets[i] - tv) < SNAP_DIST) { sy = Math.round(tv - offsets[i]); _showGuide('h', tv); break; }
    }
  }
  // Snap to grid
  if (_gridSnap) {
    sx = Math.round(sx / _gridSize) * _gridSize;
    sy = Math.round(sy / _gridSize) * _gridSize;
  }

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
    zoomControl: true,
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

  // Рамка-уголок "лупа"
  const badge = document.createElement('div');
  badge.style.cssText = 'position:absolute;top:4px;left:4px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;padding:2px 6px;border-radius:3px;z-index:500;pointer-events:none';
  badge.textContent = '🔍 Фрагмент';
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
  _pdfTile = pdfMapSat
    ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19 })
    : L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 });
  _pdfTile.addTo(pdfMap);
  const btn = document.getElementById('pdf-sat-btn');
  if (btn) { btn.textContent = pdfMapSat ? '🗺 Схема' : '🛰 Спутник'; btn.classList.toggle('active', pdfMapSat); }
}

function togglePdfMapDrag() {
  if (!pdfMap) return;
  pdfMapDrag = !pdfMapDrag;
  if (pdfMapDrag) {
    pdfMap.dragging.enable();
    pdfMap.scrollWheelZoom.enable();
    pdfMap.doubleClickZoom.enable();
    pdfMap.touchZoom.enable();
    document.getElementById('pdf-map').style.cursor = 'grab';
    setSt('Режим перемещения карты — двигай и масштабируй колесом мыши', 'ok');
  } else {
    pdfMap.dragging.disable();
    pdfMap.scrollWheelZoom.disable();
    pdfMap.doubleClickZoom.disable();
    pdfMap.touchZoom.disable();
    document.getElementById('pdf-map').style.cursor = '';
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
  _buildToolbar();
  _buildActions();
}

function _buildToolbar() {
  const tb = document.getElementById('pdf-toolbar');
  tb.innerHTML = `
    <button class="ps-tool ${pdfTool==='select'?'active':''}" id="pst-select" data-tip="Выбрать (V)" onclick="setPdfTool('select')">↖</button>
    <button class="ps-tool" data-tip="Отменить (Ctrl+Z)" onclick="undoPdf()" style="font-size:13px">↩</button>
    <button class="ps-tool" data-tip="Повторить (Ctrl+Y)" onclick="redoPdf()" style="font-size:13px">↪</button>
    <div class="ps-tool-sep"></div>
    <button class="ps-tool ${pdfTool==='text'   ?'active':''}" id="pst-text"    data-tip="Текст (T)"         onclick="setPdfTool('text')">T</button>
    <button class="ps-tool ${pdfTool==='rect'   ?'active':''}" id="pst-rect"    data-tip="Прямоугольник (R)" onclick="setPdfTool('rect')">▭</button>
    <button class="ps-tool ${pdfTool==='ellipse'?'active':''}" id="pst-ellipse" data-tip="Эллипс (E)"        onclick="setPdfTool('ellipse')">◯</button>
    <button class="ps-tool ${pdfTool==='line'   ?'active':''}" id="pst-line"    data-tip="Линия (L)"         onclick="setPdfTool('line')">╱</button>
    <button class="ps-tool" id="pst-image" data-tip="Изображение (I)" onclick="document.getElementById('ps-image-upload').click()">🖼</button>
    <div class="ps-tool-sep"></div>
    <button class="ps-tool" data-tip="Легенда"           onclick="addPdfLegend()">≡</button>
    <button class="ps-tool" data-tip="Масштаб"           onclick="addPdfScale()">📏</button>
    <button class="ps-tool" data-tip="Стрелка севера"    onclick="addPdfNorth()">🧭</button>
    <button class="ps-tool" data-tip="Стрелка-указатель" onclick="createPdfObj('arrow',{name:'Стрелка'})">➡</button>
    <button class="ps-tool" data-tip="Лупа — увеличенный фрагмент карты" onclick="addPdfInset()" style="font-size:16px">🔍</button>
    <div class="ps-tool-sep" style="flex-basis:100%;height:0"></div>
    <div style="width:100%;padding:3px 2px 2px;font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.5px">🔎 Масштаб холста</div>
    <div style="display:flex;gap:2px;width:100%;align-items:center">
      <button class="ps-align-btn" style="font-size:15px" onclick="zoomCanvas(-0.15)" title="Уменьшить">−</button>
      <button class="ps-align-btn" style="flex:2;font-size:10px" onclick="_zoomMul=1;_applyOrientation()" title="Сбросить">⊙ ${Math.round(_zoomMul*100)}%</button>
      <button class="ps-align-btn" style="font-size:15px" onclick="zoomCanvas(0.15)" title="Увеличить">+</button>
    </div>
    <div style="display:flex;gap:2px;width:100%;margin-top:2px">
      <button class="ps-align-btn" id="grid-btn" style="${_gridEnabled?'color:#60a5fa;border-color:#60a5fa':''}" onclick="toggleGrid()" title="Сетка">⊞ Сетка</button>
      <button class="ps-align-btn" id="grid-snap-btn" style="${_gridSnap?'color:#60a5fa;border-color:#60a5fa':''}" onclick="toggleGridSnap()" title="Привязка к сетке">🧲 к сетке</button>
    </div>
    <div class="ps-tool-sep" style="flex-basis:100%;height:0"></div>
    <div style="width:100%;padding:3px 2px 2px;font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.5px">⬛ Выравнивание</div>
    <div style="display:flex;gap:2px;width:100%;flex-wrap:wrap">
      <button class="ps-align-btn" title="По левому краю"  onclick="alignPdfObj('left')">⬛◁</button>
      <button class="ps-align-btn" title="По центру (гор)" onclick="alignPdfObj('cx')">◁⬛▷</button>
      <button class="ps-align-btn" title="По правому краю" onclick="alignPdfObj('right')">▷⬛</button>
      <button class="ps-align-btn" title="По верху"        onclick="alignPdfObj('top')">△⬛</button>
      <button class="ps-align-btn" title="По центру (вер)" onclick="alignPdfObj('cy')">△⬛▽</button>
      <button class="ps-align-btn" title="По низу"         onclick="alignPdfObj('bottom')">▽⬛</button>
    </div>
    <label style="font-size:10px;color:#4b5563;display:flex;align-items:center;gap:5px;cursor:pointer;margin-top:3px;width:100%">
      <input type="checkbox" id="snap-toggle" ${_snapEnabled?'checked':''} onchange="_snapEnabled=this.checked"> 🧲 Магнит
    </label>
    <div class="ps-tool-sep" style="flex-basis:100%;height:0"></div>
    <div class="pdf-orient-row" style="width:100%;margin-top:3px">
      <button class="orient-btn ${pdfOrientation==='landscape'?'active':''}" onclick="setPdfOrientation('landscape')">⇄ Альбомная</button>
      <button class="orient-btn ${pdfOrientation==='portrait' ?'active':''}" onclick="setPdfOrientation('portrait')">⇅ Книжная</button>
    </div>
    <div style="padding:4px 0 2px;width:100%">
      <label style="font-size:10px;color:#4b5563;display:flex;align-items:center;gap:5px;cursor:pointer;margin-bottom:3px">
        <input type="checkbox" id="pdf-no-fill-szz" onchange="toggleFills()"> Убрать заливку СЗЗ
      </label>
      <label style="font-size:10px;color:#4b5563;display:flex;align-items:center;gap:5px;cursor:pointer">
        <input type="checkbox" id="pdf-no-fill-zu"  onchange="toggleFills()"> Убрать заливку ЗУ
      </label>
    </div>
    <div class="ps-tool-sep" style="flex-basis:100%;height:0;margin:4px 0 2px"></div>
    <div style="width:100%;font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.6px;padding:0 2px 3px">🗺 Настройка карты</div>
    <button class="pdf-map-ctrl ${pdfMapSat?'active':''}" id="pdf-sat-btn"
            onclick="togglePdfMapSat()" title="Переключить спутник / схему">
      ${pdfMapSat ? '🗺 Схема' : '🛰 Спутник'}
    </button>
    <button class="pdf-map-ctrl ${pdfMapDrag?'active':''}" id="pdf-drag-btn"
            onclick="togglePdfMapDrag()" title="Двигать и масштабировать карту внутри PDF">
      ${pdfMapDrag ? '🔒 Зафикс.' : '✋ Двигать'}
    </button>
    <button class="pdf-map-ctrl" onclick="fitPdfMapToLayer()" title="Авто-позиционирование на активном участке">
      🎯 На участок
    </button>
  `;
}

function _buildActions() {
  document.getElementById('pdf-actions').innerHTML = `
    <button class="pdf-save-btn" id="pdf-save-btn" onclick="renderPdf()">💾 Сохранить PDF</button>
    <button class="pdf-save-btn" style="background:#1e3a20;border-color:#22c55e;color:#4ade80;margin-top:4px" onclick="exportPng()">🖼 Сохранить PNG</button>
    <button class="pdf-exit-btn" onclick="exitPdfMode()">✕ Выйти из редактора</button>
  `;
}

// ── Ориентация ────────────────────────────────────
function setPdfOrientation(o) {
  pdfOrientation = o;
  _applyOrientation();
  _buildToolbar(); // обновить кнопки
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
  pdfTool = t;
  document.querySelectorAll('.ps-tool[id^="pst-"]').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('pst-' + t);
  if (btn) btn.classList.add('active');
  const canvas = document.getElementById('pdf-canvas');
  canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
}

// ── Создание объекта ──────────────────────────────
const OBJ_DEFAULTS = {
  text:    { w:220, h:52,  bg:'rgba(255,255,255,0.90)', color:'#0f172a', fontSize:18, fontFamily:'Segoe UI', fontWeight:'700', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:6,   shadow:true,  strokeColor:'transparent', strokeW:0, content:'Заголовок', textShadow:false },
  rect:    { w:160, h:90,  bg:'rgba(59,130,246,0.12)',  color:'#1e40af', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:4,   shadow:false, strokeColor:'#3b82f6',     strokeW:2, content:'',          textShadow:false },
  ellipse: { w:140, h:90,  bg:'rgba(34,197,94,0.12)',   color:'#166534', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:999, shadow:false, strokeColor:'#22c55e',     strokeW:2, content:'',          textShadow:false },
  line:    { w:200, h:4,   bg:'transparent',             color:'transparent', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#ef4444', strokeW:4, content:'', textShadow:false },
  legend:  { w:240, h:130, bg:'rgba(255,255,255,0.95)', color:'#0f172a', fontSize:13, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'left',   radius:8,   shadow:true,  strokeColor:'transparent', strokeW:0, content:'__legend__', textShadow:false },
  scale:   { w:170, h:52,  bg:'rgba(255,255,255,0.88)', color:'#0f172a', fontSize:12, fontFamily:'Segoe UI', fontWeight:'700', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:4,   shadow:true,  strokeColor:'transparent', strokeW:0, content:'__scale__',  textShadow:false },
  north:   { w:60,  h:60,  bg:'rgba(255,255,255,0.82)', color:'#0f172a', fontSize:10, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:50,  shadow:true,  strokeColor:'transparent', strokeW:0, content:'__north__',  textShadow:false },
  image:   { w:160, h:100, bg:'transparent',             color:'transparent', fontSize:12, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'transparent', strokeW:0, content:'',           textShadow:false, imgSrc:'' },
  inset:   { w:340, h:230, bg:'#ffffff',                color:'#0f172a',     fontSize:11, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:4, shadow:true,  strokeColor:'#334155',     strokeW:2, content:'__inset__',  textShadow:false, insetZoom:0 },
  arrow:   { w:200, h:30,  bg:'transparent',            color:'transparent', fontSize:14, fontFamily:'Segoe UI', fontWeight:'400', fontStyle:'normal', textDecoration:'none', textAlign:'center', radius:0, shadow:false, strokeColor:'#ef4444',     strokeW:3, content:'__arrow__',  textShadow:false, arrowDir:'end', rotation:0 },
};

function _typeName(type) {
  return { text:'Текст', rect:'Прямоугольник', ellipse:'Эллипс', line:'Линия', legend:'Легенда', scale:'Масштаб', north:'Стрелка С', image:'Изображение', inset:'Лупа', arrow:'Стрелка' }[type] || type;
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
  el.style.cssText = `
    position:absolute;
    left:${d.x}px; top:${d.y}px;
    width:${d.w}px; height:${d.h}px;
    background:${d.bg};
    border-radius:${d.radius}px;
    border:${d.strokeW > 0 ? `${d.strokeW}px solid ${d.strokeColor}` : 'none'};
    box-shadow:${d.shadow ? '0 4px 14px rgba(0,0,0,0.18)' : 'none'};
    color:${d.color};
    font-size:${d.fontSize}px;
    font-family:${d.fontFamily};
    font-weight:${d.fontWeight};
    font-style:${d.fontStyle};
    text-decoration:${d.textDecoration};
    text-align:${d.textAlign};
    display:${obj.visible ? 'flex' : 'none'};
    align-items:center;
    justify-content:${d.textAlign==='left'?'flex-start':d.textAlign==='right'?'flex-end':'center'};
    overflow:hidden;
    box-sizing:border-box;
    cursor:${obj.locked ? 'not-allowed' : pdfTool==='select' ? 'grab' : 'crosshair'};
    z-index:${100 + pdfObjects.indexOf(obj)};
    text-shadow:${d.textShadow ? '1px 1px 0 #fff,-1px -1px 0 #fff,1px -1px 0 #fff,-1px 1px 0 #fff' : 'none'};
    padding:${d.type==='legend' ? '12px' : d.type==='scale' ? '5px 10px' : d.type==='text' ? '6px 12px' : '0'};
    user-select:none;
    transform:${d.rotation ? `rotate(${d.rotation}deg)` : 'none'};
    transform-origin:center center;
  `;
  el.classList.toggle('ps-selected', obj.id === pdfSelId);

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
  if (d.type === 'image' && d.imgSrc) {
    el.innerHTML = `<img src="${d.imgSrc}" style="width:100%;height:100%;object-fit:contain;border-radius:${d.radius}px;pointer-events:none">`;
    return;
  }
  // Текст — span с contenteditable
  el.innerHTML = `<span class="ps-text-content" style="width:100%;text-align:inherit;pointer-events:none;white-space:pre-wrap;word-break:break-word">${d.content || ''}</span>`;
}

function _legendHtml(d) {
  let html = `<div class="ps-legend-content"><div class="ps-legend-title" style="font-size:${d.fontSize+1}px;color:${d.color}">Условные обозначения:</div>`;
  mapLayers.filter(l => l.visible).forEach(l => {
    const bg  = hexToRgba(l.color, l.type === 'szz' ? 0.12 : 0.2);
    const brd = l.type === 'szz' ? 'dashed' : 'solid';
    html += `<div class="ps-legend-row"><div class="ps-legend-swatch" style="background:${bg};border:2px ${brd} ${l.color}"></div>
      <span style="font-size:${d.fontSize}px;color:${d.color}">${l.name}</span></div>`;
  });
  if (foundParcels.filter(p => p.inP).length) {
    html += `<div class="ps-legend-row"><div class="ps-legend-swatch" style="background:rgba(34,197,94,0.25);border:2px solid #16a34a"></div>
      <span style="font-size:${d.fontSize}px;color:${d.color}">ЗУ внутри СЗЗ</span></div>`;
    html += `<div class="ps-legend-row"><div class="ps-legend-swatch" style="background:rgba(245,158,11,0.25);border:2px solid #b45309"></div>
      <span style="font-size:${d.fontSize}px;color:${d.color}">ЗУ на пересечении</span></div>`;
  }
  return html + '</div>';
}

function _scaleHtml(d) {
  const sc   = document.querySelector('.leaflet-control-scale-line');
  const text = sc ? sc.innerHTML : '100 м';
  const w    = sc ? sc.style.width : '80px';
  return `<div class="ps-scale-content" style="color:${d.color}">
    <span style="font-size:${d.fontSize}px;font-weight:700">${text}</span>
    <div class="ps-scale-bar" style="width:${w};color:${d.color}"></div>
  </div>`;
}

function _northHtml(d) {
  return `<svg class="ps-north-svg" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <polygon points="20,4 27,36 20,29 13,36" fill="${d.color}" opacity="0.9"/>
    <text x="20" y="23" font-family="${d.fontFamily}" font-size="9" font-weight="bold"
          fill="${d.bg !== 'transparent' ? d.bg : '#fff'}" text-anchor="middle" dominant-baseline="middle">С</text>
  </svg>`;
}

// ── Хендлы изменения размера ──────────────────────
const HANDLES = ['nw','n','ne','e','se','s','sw','w'];

function _updateHandles(el, obj) {
  // Удаляем старые
  el.querySelectorAll('.ps-handle').forEach(h => h.remove());
  if (obj.id !== pdfSelId || obj.locked) return;

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
    if (e.target.classList.contains('ps-handle')) return; // handled separately
    if (pdfTool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();

    // Выбрать
    if (pdfSelId !== obj.id) selectPdfObj(obj.id);
    if (obj.locked) return;

    // Drag
    _pushUndo();
    const startX = e.clientX, startY = e.clientY;
    const ox = obj.data.x,    oy = obj.data.y;
    el.setPointerCapture(e.pointerId);

    function onMove(ev) {
      // Учитываем scale канваса
      const canvas = document.getElementById('pdf-canvas');
      const rect   = canvas.getBoundingClientRect();
      const scaleX = canvas.offsetWidth  / rect.width;
      const scaleY = canvas.offsetHeight / rect.height;
      const nx = Math.round(ox + (ev.clientX - startX) * scaleX);
      const ny = Math.round(oy + (ev.clientY - startY) * scaleY);
      const snapped = _snapObject(obj, nx, ny);
      obj.data.x = snapped.x;
      obj.data.y = snapped.y;
      el.style.left = obj.data.x + 'px';
      el.style.top  = obj.data.y + 'px';
      _syncPropsXY();
      // Инвалидируем inset если есть
      if (_insetMaps[obj.id]) _insetMaps[obj.id].invalidateSize();
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
    const span = el.querySelector('.ps-text-content');
    if (!span) return;
    e.stopPropagation();
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

  function onMove(ev) {
    const dx = (ev.clientX - startX) * scaleX;
    const dy = (ev.clientY - startY) * scaleY;
    let nx = ox, ny = oy, nw = ow, nh = oh;

    if (handle.includes('e'))  nw = Math.max(40, ow + dx);
    if (handle.includes('s'))  nh = Math.max(20, oh + dy);
    if (handle.includes('w')) { nx = ox + dx; nw = Math.max(40, ow - dx); }
    if (handle.includes('n')) { ny = oy + dy; nh = Math.max(20, oh - dy); }

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

  canvas.addEventListener('pointerdown', e => {
    if (pdfTool === 'select' || pdfTool === 'image') return;
    if (pdfMapDrag) return; // в режиме перемещения — отдаём управление Leaflet
    if (e.target.closest('#pdf-map')) return; // клик по карте — не рисуем
    if (e.target.classList.contains('ps-obj') || e.target.closest('.ps-obj')) return;
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

    if (w < 8 && h < 8) { // просто клик — текст
      if (pdfTool === 'text') {
        createPdfObj('text', { x: Math.round(cx - 110), y: Math.round(cy - 26) });
      }
    } else {
      createPdfObj(pdfTool, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    }
    setPdfTool('select');
  });

  // Клик по пустому месту — снять выделение
  canvas.addEventListener('click', e => {
    if (e.target === canvas || e.target.id === 'pdf-map') {
      selectPdfObj(null);
    }
  });
}

// ── Выделение ─────────────────────────────────────
function selectPdfObj(id) {
  pdfSelId = id;
  pdfObjects.forEach(obj => {
    const el = document.getElementById(obj.id);
    if (!el) return;
    el.classList.toggle('ps-selected', obj.id === id);
    _updateHandles(el, obj);
    el.style.cursor = obj.locked ? 'not-allowed' : pdfTool === 'select' ? 'grab' : 'crosshair';
  });
  _renderProps();
  _renderLayersList();
}

// ── Действия с объектами ──────────────────────────
function deletePdfObj() {
  if (!pdfSelId) return;
  _pushUndo();
  // Убиваем inset-карту если есть
  if (_insetMaps[pdfSelId]) {
    try { _insetMaps[pdfSelId].remove(); } catch(e) {}
    delete _insetMaps[pdfSelId];
  }
  const el = document.getElementById(pdfSelId);
  if (el) el.remove();
  pdfObjects = pdfObjects.filter(o => o.id !== pdfSelId);
  pdfSelId   = null;
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
  const showText = ['text','legend','scale','north'].includes(d.type);

  panel.innerHTML = `
    <div class="pp-title">⚙ Свойства: <span style="color:#60a5fa;text-transform:none">${obj.name}</span></div>
    <div class="pp-body">
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

      ${showText ? `
      <div class="pp-row">
        <span class="pp-lbl">Шрифт</span>
        <select class="pp-inp" id="pp-font" onchange="applyPdfProp()">
          ${['Segoe UI','Arial','Times New Roman','Georgia','Courier New','Tahoma','Verdana']
            .map(f => `<option ${d.fontFamily===f?'selected':''}>${f}</option>`).join('')}
        </select>
        <input class="pp-inp-sm" type="number" id="pp-fsize" value="${d.fontSize}" min="6" max="120" oninput="applyPdfProp()" style="width:42px">
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Стиль</span>
        <div class="pp-style-btns">
          <button class="pp-sbtn ${d.fontWeight==='700'?'active':''}" id="pp-bold"   onclick="togglePdfFontStyle('bold')"      style="font-weight:700">B</button>
          <button class="pp-sbtn ${d.fontStyle==='italic'?'active':''}" id="pp-ital" onclick="togglePdfFontStyle('italic')"     style="font-style:italic">I</button>
          <button class="pp-sbtn ${d.textDecoration==='underline'?'active':''}" id="pp-ul" onclick="togglePdfFontStyle('underline')" style="text-decoration:underline">U</button>
          <select class="pp-inp" id="pp-align" onchange="applyPdfProp()" style="flex:1;font-size:11px;padding:2px">
            <option value="left"   ${d.textAlign==='left'   ?'selected':''}>← Лево</option>
            <option value="center" ${d.textAlign==='center' ?'selected':''}>↔ Центр</option>
            <option value="right"  ${d.textAlign==='right'  ?'selected':''}>→ Право</option>
          </select>
        </div>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Цвет текста</span>
        <input class="pp-color" type="color" id="pp-color" value="${d.color === 'transparent' ? '#000000' : d.color}" oninput="applyPdfProp()">
        <span class="pp-lbl" style="margin-left:6px">Тень текста</span>
        <input type="checkbox" id="pp-tshadow" ${d.textShadow?'checked':''} onchange="applyPdfProp()">
      </div>
      ` : ''}

      <div class="pp-sep"></div>
      <div class="pp-row">
        <span class="pp-lbl">Фон</span>
        <input class="pp-color" type="color" id="pp-bg" value="${bgHex}" oninput="applyPdfProp()">
        <input class="pp-slider" type="range" id="pp-alpha" min="0" max="100" value="${Math.round(alpha*100)}" oninput="applyPdfProp()">
        <span id="pp-alpha-val" style="font-size:10px;color:#6b7280;min-width:28px">${Math.round(alpha*100)}%</span>
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Обводка</span>
        <input class="pp-color" type="color" id="pp-stroke" value="${d.strokeColor==='transparent'?'#334155':d.strokeColor}" oninput="applyPdfProp()">
        <input class="pp-inp-sm" type="number" id="pp-sw" value="${d.strokeW}" min="0" max="20" oninput="applyPdfProp()">
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Скругление</span>
        <input class="pp-slider" type="range" id="pp-radius" min="0" max="100" value="${d.radius}" oninput="applyPdfProp()">
        <span class="pp-lbl" style="margin-left:5px">Тень блока</span>
        <input type="checkbox" id="pp-shadow" ${d.shadow?'checked':''} onchange="applyPdfProp()">
      </div>
      <div class="pp-row">
        <span class="pp-lbl">Поворот °</span>
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

  const bgEl = document.getElementById('pp-bg'), alphaEl = document.getElementById('pp-alpha');
  if (bgEl && alphaEl) {
    const alpha = parseInt(alphaEl.value) / 100;
    d.bg = hexToRgba(bgEl.value, alpha);
    const av = document.getElementById('pp-alpha-val');
    if (av) av.textContent = Math.round(alpha * 100) + '%';
  }

  const sw = parseInt(document.getElementById('pp-sw')?.value) || 0;
  const sc = document.getElementById('pp-stroke')?.value || '#334155';
  d.strokeW     = sw;
  d.strokeColor = sw > 0 ? sc : 'transparent';
  if (document.getElementById('pp-radius')) d.radius = parseInt(document.getElementById('pp-radius').value) || 0;
  if (document.getElementById('pp-shadow')) d.shadow = document.getElementById('pp-shadow').checked;
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
          const icon = { text:'T', rect:'▭', ellipse:'◯', line:'╱', legend:'≡', scale:'📏', north:'🧭', image:'🖼', inset:'🔍', arrow:'➡' }[obj.type] || '?';
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
  pdfObjects = saved.filter(o => o.data.content !== '[img]').map(o => ({
    ...o,
    data: { ...OBJ_DEFAULTS[o.type] || OBJ_DEFAULTS.rect, ...o.data }
  }));
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
  if (e.key === 'Escape') selectPdfObj(null);
  if ((e.ctrlKey||e.metaKey) && e.key==='d') { e.preventDefault(); duplicatePdfObj(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='z') { e.preventDefault(); undoPdf(); }
  if ((e.ctrlKey||e.metaKey) && (e.key==='y' || (e.shiftKey && e.key==='Z'))) { e.preventDefault(); redoPdf(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='c') { e.preventDefault(); copyPdfObj(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='v') { e.preventDefault(); pastePdfObj(); }

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
  btn.textContent = '⏳ Генерация…'; btn.disabled = true;

  // Убираем выделение
  selectPdfObj(null);

  // Скрываем UI-элементы Leaflet
  const lc = document.querySelector('#pdf-map .leaflet-control-container');
  if (lc) lc.style.display = 'none';

  const canvas = document.getElementById('pdf-canvas');
  const isLand = pdfOrientation === 'landscape';

  try {
    const scale = window.devicePixelRatio * 2;
    const snap  = await html2canvas(canvas, {
      useCORS: true,
      allowTaint: false,
      scale,
      backgroundColor: '#ffffff',
      width:  canvas.offsetWidth,
      height: canvas.offsetHeight,
      ignoreElements: el => el.classList && el.classList.contains('ps-handle'),
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

  if (lc) lc.style.display = '';
  btn.textContent = '💾 Сохранить PDF';
  btn.disabled = false;
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
