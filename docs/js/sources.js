// ═══════════════════════════════════════════════
// SOURCES.JS — Источники выбросов и шума
// ═══════════════════════════════════════════════
'use strict';

let _sources = [];
let _srcLayerGroup = null;

const SRC_ICONS = {
  emission: '💨', noise: '🔊', radiation: '☢',
  vibration: '📳', other: '📌',
};
const SRC_COLORS = {
  emission: '#ef4444', noise: '#f59e0b', radiation: '#8b5cf6',
  vibration: '#06b6d4', other: '#6b7280',
};
const SHAPE_LABELS = {
  point: '◉ Точечный', line: '— Линейный', area: '▭ Площадной',
};

function _initSources() {
  if (!_srcLayerGroup) {
    _srcLayerGroup = L.layerGroup().addTo(map);
  }
  try {
    const saved = JSON.parse(localStorage.getItem('szztool_sources') || '[]');
    _sources = saved;
    _sources.forEach(s => _drawSource(s));
  } catch(e) {}
}

function _saveSources() {
  localStorage.setItem('szztool_sources', JSON.stringify(
    _sources.map(({ layers: _, ...rest }) => rest)
  ));
}

function _drawSource(s) {
  if (!_srcLayerGroup) return;
  const color = s.color || SRC_COLORS[s.type] || '#6b7280';
  const layers = [];
  const srcNum = _sources.indexOf(s) + 1;

  // Определяем геометрию: явное поле shape или по координатам (совместимость)
  const shape = s.shape || (
    (s.lat3 != null && s.lon3 != null) ? 'line' :
    (s.lat2 != null && s.lon2 != null) ? 'line' : 'point'
  );

  // Крест-маркер на точку источника + подпись номера (как в Эколог ГИС)
  function addCross(lat, lon) {
    const popup = `<b>${s.name}</b><br>${SRC_ICONS[s.type] || ''} ${s.type}${s.radius ? '<br>R = ' + s.radius + ' м' : ''}`;
    const crossSvg = [
      '<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">',
      `<line x1="9" y1="1" x2="9" y2="17" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`,
      `<line x1="1" y1="9" x2="17" y2="9" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`,
      `<circle cx="9" cy="9" r="2.5" fill="${color}"/>`,
      '</svg>',
    ].join('');

    layers.push(
      L.marker([lat, lon], {
        icon: L.divIcon({ className: '', html: crossSvg, iconSize: [18, 18], iconAnchor: [9, 9] }),
        zIndexOffset: 100,
      }).bindPopup(popup).addTo(_srcLayerGroup)
    );

    // Номер источника справа от крестика
    layers.push(
      L.marker([lat, lon], {
        icon: L.divIcon({
          className: '',
          html: `<span style="font-size:11px;font-weight:700;color:${color};` +
                `text-shadow:0 0 2px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,0.9);` +
                `white-space:nowrap;pointer-events:none">${srcNum}</span>`,
          iconSize: [0, 0],
          iconAnchor: [-11, 8],
        }),
        interactive: false,
        zIndexOffset: 101,
      }).addTo(_srcLayerGroup)
    );
  }

  if (shape === 'area' && s.lat2 != null && s.lon2 != null) {
    // Площадной источник — прямоугольник по двум угловым точкам
    const corners = [
      [s.lat,  s.lon], [s.lat,  s.lon2],
      [s.lat2, s.lon2], [s.lat2, s.lon],
    ];
    const popup = `<b>${s.name}</b><br>▭ Площадной | ${SRC_ICONS[s.type] || ''} ${s.type}`;
    layers.push(
      L.polygon(corners, { color, fillColor: color, fillOpacity: 0, weight: 2, opacity: 1 })
        .bindPopup(popup).addTo(_srcLayerGroup)
    );
    // Крест в центре прямоугольника
    addCross((s.lat + s.lat2) / 2, (s.lon + s.lon2) / 2);

  } else if (shape === 'line' && s.lat3 != null && s.lon3 != null) {
    // Линейный трёхточечный
    layers.push(
      L.polyline([[s.lat, s.lon], [s.lat2, s.lon2], [s.lat3, s.lon3]], {
        color, weight: 2.5, opacity: 1,
      }).addTo(_srcLayerGroup)
    );
    if (s.radius > 0) {
      try {
        const g = turf.lineString([[s.lon, s.lat], [s.lon2, s.lat2], [s.lon3, s.lat3]]);
        layers.push(L.geoJSON(turf.buffer(g, s.radius / 1000, { units: 'kilometers' }), {
          style: { color, fillColor: color, fillOpacity: 0, weight: 2, opacity: 1 }
        }).addTo(_srcLayerGroup));
      } catch(e) {}
    }

  } else if (shape === 'line' && s.lat2 != null && s.lon2 != null) {
    // Линейный двухточечный
    layers.push(
      L.polyline([[s.lat, s.lon], [s.lat2, s.lon2]], {
        color, weight: 2.5, opacity: 1,
      }).addTo(_srcLayerGroup)
    );
    if (s.radius > 0) {
      try {
        const g = turf.lineString([[s.lon, s.lat], [s.lon2, s.lat2]]);
        layers.push(L.geoJSON(turf.buffer(g, s.radius / 1000, { units: 'kilometers' }), {
          style: { color, fillColor: color, fillOpacity: 0, weight: 2, opacity: 1 }
        }).addTo(_srcLayerGroup));
      } catch(e) {}
    }

  } else {
    // Точечный — крест + геодезический круг через turf.circle (точные координаты)
    addCross(s.lat, s.lon);
    if (s.radius > 0) {
      try {
        const circ = turf.circle([s.lon, s.lat], s.radius / 1000, { steps: 64, units: 'kilometers' });
        layers.push(L.geoJSON(circ, {
          style: { color, fillColor: color, fillOpacity: 0, weight: 2, opacity: 1 }
        }).addTo(_srcLayerGroup));
      } catch(e) {}
    }
  }

  s.layers = layers;
}

function _clearSourceLayers(s) {
  (s.layers || []).forEach(l => { try { _srcLayerGroup.removeLayer(l); } catch(e) {} });
  s.layers = [];
}

// ── Переключение вида формы по геометрии ──────────
window.srcShapeChange = () => {
  const shape = document.getElementById('src-shape').value;
  document.getElementById('src-pt2-row').style.display    = shape !== 'point' ? 'block' : 'none';
  document.getElementById('src-pt3-row').style.display    = shape === 'line'  ? 'block' : 'none';
  document.getElementById('src-radius-row').style.display = shape === 'area'  ? 'none'  : 'grid';
  document.getElementById('src-pt1-label').textContent = shape === 'area'
    ? 'Угол 1 — SW (юго-запад):' : 'Координаты источника (WGS-84 или СК-42):';
  document.getElementById('src-pt2-label').textContent = shape === 'area'
    ? 'Угол 2 — NE (северо-восток):' : 'Точка 2:';
};

// ── Модал ─────────────────────────────────────────
window.openSourcesModal = () => {
  _initSources();
  document.getElementById('sources-modal').style.display = 'flex';
  srcTab('add');
};
window.closeSourcesModal = () => {
  document.getElementById('sources-modal').style.display = 'none';
};

window.srcTab = (tab) => {
  ['add','list','import'].forEach(t => {
    document.getElementById('src-panel-' + t).style.display = t === tab ? 'block' : 'none';
    const btn = document.getElementById('src-tab-' + t);
    if (btn) {
      btn.style.borderColor = t === tab ? '#f59e0b' : '';
      btn.style.color = t === tab ? '#fbbf24' : '';
    }
  });
  if (tab === 'list') _renderSourcesList();
};

function _normLatLon(a, b) {
  if (isNaN(a) || isNaN(b)) return null;
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [a, b];
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return [b, a];
  const sk = _tryParseSk42(a, b);
  if (sk) return _sk42ToWgs84(sk.x, sk.y);
  return null;
}

window.addSource = () => {
  const name  = document.getElementById('src-name').value.trim() || ('ИЗА ' + (_sources.length + 1));
  const type  = document.getElementById('src-type').value;
  const shape = document.getElementById('src-shape').value;
  const color = document.getElementById('src-color').value;

  const a1 = parseFloat(document.getElementById('src-lat').value);
  const b1 = parseFloat(document.getElementById('src-lon').value);
  if (isNaN(a1) || isNaN(b1)) { alert('Введите координаты точки 1'); return; }
  const p1 = _normLatLon(a1, b1);
  if (!p1) { alert('Координаты точки 1 не распознаны (WGS-84 или СК-42)'); return; }

  let p2 = null, p3 = null, radius = 0;

  if (shape !== 'point') {
    const a2 = parseFloat(document.getElementById('src-lat2').value);
    const b2 = parseFloat(document.getElementById('src-lon2').value);
    if (isNaN(a2) || isNaN(b2)) { alert('Введите координаты точки 2'); return; }
    p2 = _normLatLon(a2, b2);
    if (!p2) { alert('Координаты точки 2 не распознаны'); return; }
  }

  if (shape === 'line') {
    const a3 = parseFloat(document.getElementById('src-lat3').value);
    const b3 = parseFloat(document.getElementById('src-lon3').value);
    if (!isNaN(a3) && !isNaN(b3)) p3 = _normLatLon(a3, b3);
    radius = parseFloat(document.getElementById('src-radius').value) || 0;
  } else if (shape === 'point') {
    radius = parseFloat(document.getElementById('src-radius').value) || 0;
  }

  const s = {
    id: 'src_' + Date.now(),
    name, type, shape,
    lat: p1[0], lon: p1[1],
    lat2: p2 ? p2[0] : null, lon2: p2 ? p2[1] : null,
    lat3: p3 ? p3[0] : null, lon3: p3 ? p3[1] : null,
    radius, color,
  };
  _sources.push(s);
  _drawSource(s);
  _saveSources();
  map.panTo([p1[0], p1[1]]);
  setSt(`Источник «${name}» добавлен`, 'ok');

  ['src-name','src-lat','src-lon','src-lat2','src-lon2','src-lat3','src-lon3','src-radius']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('src-shape').value = 'point';
  srcShapeChange();
};

function _renderSourcesList() {
  const body = document.getElementById('src-list-body');
  if (!_sources.length) {
    body.innerHTML = '<div style="text-align:center;color:var(--tx2);padding:20px">Нет источников</div>';
    return;
  }
  body.innerHTML = _sources.map((s, i) => `
    <div class="src-item">
      <span class="src-item-icon">${SRC_ICONS[s.type] || '📌'}</span>
      <div style="flex:1;min-width:0">
        <div class="src-item-name">${i + 1}. ${s.name}</div>
        <div class="src-item-meta">${SHAPE_LABELS[s.shape || 'point']} &nbsp;${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}${s.radius ? ' | R=' + s.radius + ' м' : ''}</div>
      </div>
      <button class="src-del" onclick="deleteSource('${s.id}')">✕</button>
    </div>`).join('');
}

window.deleteSource = (id) => {
  const s = _sources.find(x => x.id === id);
  if (s) _clearSourceLayers(s);
  _sources = _sources.filter(x => x.id !== id);
  _saveSources();
  _renderSourcesList();
};

window.clearAllSources = () => {
  if (!confirm('Удалить все источники?')) return;
  _sources.forEach(s => _clearSourceLayers(s));
  _sources = [];
  _saveSources();
  _renderSourcesList();
};

window.fitSourcesBounds = () => {
  if (!_sources.length) return;
  map.fitBounds(L.latLngBounds(_sources.map(s => [s.lat, s.lon])), { padding: [40, 40] });
};

// ── CSV импорт ────────────────────────────────────
window.importSourcesCSV = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById('src-csv-text').value = ev.target.result;
    importSourcesText();
  };
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';
};

window.importSourcesText = () => {
  const text = document.getElementById('src-csv-text').value.trim();
  if (!text) { alert('Вставьте данные CSV'); return; }
  const lines = text.split('\n').filter(l => l.trim());
  let added = 0;
  lines.forEach(line => {
    const cols = line.split(/[;,\t]/).map(c => c.trim());
    if (cols.length < 4) return;
    const name = cols[0] || ('ИЗА ' + (_sources.length + 1));
    const rawType = (cols[1] || 'other').toLowerCase();
    const typeMap = {
      выброс:'emission', emission:'emission',
      noise:'noise', шум:'noise',
      радиация:'radiation', radiation:'radiation',
      вибрация:'vibration', vibration:'vibration',
    };
    const type = typeMap[rawType] || 'other';
    const p1 = _normLatLon(parseFloat(cols[2]), parseFloat(cols[3]));
    if (!p1) return;

    let shape = 'point', lat2=null, lon2=null, lat3=null, lon3=null, radius=0;
    if (cols.length >= 7) {
      const p2 = _normLatLon(parseFloat(cols[4]), parseFloat(cols[5]));
      if (p2) { lat2 = p2[0]; lon2 = p2[1]; shape = 'line'; }
      radius = parseFloat(cols[6]) || 0;
    } else if (cols.length >= 5) {
      radius = parseFloat(cols[4]) || 0;
    }

    const [lat, lon] = p1;
    const color = SRC_COLORS[type] || '#6b7280';
    const s = { id:'src_'+Date.now()+'_'+added, name, type, shape, lat, lon, lat2, lon2, lat3, lon3, radius, color };
    _sources.push(s);
    _drawSource(s);
    added++;
  });
  _saveSources();
  if (added > 0) {
    fitSourcesBounds();
    setSt(`Импортировано ${added} источников`, 'ok');
    srcTab('list');
  } else {
    alert('Не удалось распознать источники. Проверьте формат CSV.');
  }
};
