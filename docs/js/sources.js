// ═══════════════════════════════════════════════
// SOURCES.JS — Источники выбросов и шума
// ═══════════════════════════════════════════════
'use strict';

let _sources = [];          // { id, name, type, lat, lon, lat2, lon2, radius, color, layers[] }
let _srcLayerGroup = null;  // L.layerGroup на карте

const SRC_ICONS = {
  emission: '💨', noise: '🔊', radiation: '☢',
  vibration: '📳', other: '📌',
};
const SRC_COLORS = {
  emission: '#ef4444', noise: '#f59e0b', radiation: '#8b5cf6',
  vibration: '#06b6d4', other: '#6b7280',
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
  const clean = _sources.map(s => {
    const { layers: _, ...rest } = s;
    return rest;
  });
  localStorage.setItem('szztool_sources', JSON.stringify(clean));
}

function _drawSource(s) {
  if (!_srcLayerGroup) return;
  const color = s.color || SRC_COLORS[s.type] || '#6b7280';
  const layers = [];

  if (s.lat2 && s.lon2 && s.lat3 && s.lon3) {
    // Линейный источник
    const line = L.polyline([[s.lat, s.lon], [s.lat2, s.lon2], [s.lat3, s.lon3]], {
      color, weight: 3, opacity: 0.8,
    }).addTo(_srcLayerGroup);
    layers.push(line);
    if (s.radius > 0) {
      try {
        const lineGeo = turf.lineString([[s.lon, s.lat],[s.lon2, s.lat2],[s.lon3, s.lat3]]);
        const buf = turf.buffer(lineGeo, s.radius / 1000, { units: 'kilometers' });
        const poly = L.geoJSON(buf, {
          style: { color, fillColor: color, fillOpacity: 0.15, weight: 1.5, dashArray: '6,4' }
        }).addTo(_srcLayerGroup);
        layers.push(poly);
      } catch(e) {}
    }
  } else if (s.lat2 && s.lon2) {
    // Двухточечный линейный
    const line = L.polyline([[s.lat, s.lon], [s.lat2, s.lon2]], {
      color, weight: 3, opacity: 0.8,
    }).addTo(_srcLayerGroup);
    layers.push(line);
    if (s.radius > 0) {
      try {
        const lineGeo = turf.lineString([[s.lon, s.lat],[s.lon2, s.lat2]]);
        const buf = turf.buffer(lineGeo, s.radius / 1000, { units: 'kilometers' });
        L.geoJSON(buf, {
          style: { color, fillColor: color, fillOpacity: 0.15, weight: 1.5, dashArray: '6,4' }
        }).addTo(_srcLayerGroup);
      } catch(e) {}
    }
  } else {
    // Точечный источник
    const icon = L.divIcon({
      html: `<div style="width:28px;height:28px;border-radius:50%;background:${color};border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:14px;box-sizing:border-box">${SRC_ICONS[s.type] || '📌'}</div>`,
      className: '',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const marker = L.marker([s.lat, s.lon], { icon })
      .bindPopup(`<b>${s.name}</b><br>${SRC_ICONS[s.type]} ${s.type}${s.radius ? '<br>Радиус: '+s.radius+' м' : ''}`)
      .addTo(_srcLayerGroup);
    layers.push(marker);
    if (s.radius > 0) {
      const circle = L.circle([s.lat, s.lon], {
        radius: s.radius, color, fillColor: color,
        fillOpacity: 0.12, weight: 1.5, dashArray: '6,4',
      }).addTo(_srcLayerGroup);
      layers.push(circle);
    }
  }
  s.layers = layers;
}

function _clearSourceLayers(s) {
  (s.layers || []).forEach(l => { try { _srcLayerGroup.removeLayer(l); } catch(e) {} });
  s.layers = [];
}

// ── Модал ────────────────────────────────────────
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

window.addSource = () => {
  const name   = document.getElementById('src-name').value.trim() || ('Источник ' + (_sources.length + 1));
  const type   = document.getElementById('src-type').value;
  const lat    = parseFloat(document.getElementById('src-lat').value);
  const lon    = parseFloat(document.getElementById('src-lon').value);
  const lat2   = parseFloat(document.getElementById('src-lat2').value) || null;
  const lon2   = parseFloat(document.getElementById('src-lon2').value) || null;
  const lat3   = parseFloat(document.getElementById('src-lat3').value) || null;
  const lon3   = parseFloat(document.getElementById('src-lon3').value) || null;
  const radius = parseFloat(document.getElementById('src-radius').value) || 0;
  const color  = document.getElementById('src-color').value;

  if (!lat || !lon) { alert('Введите координаты точки (lat, lon)'); return; }

  const s = {
    id: 'src_' + Date.now(),
    name, type, lat, lon,
    lat2: lat2 || null, lon2: lon2 || null,
    lat3: lat3 || null, lon3: lon3 || null,
    radius, color,
  };
  _sources.push(s);
  _drawSource(s);
  _saveSources();
  map.panTo([lat, lon]);
  setSt(`Источник «${name}» добавлен`, 'ok');
  // Сбросить форму
  ['src-name','src-lat','src-lon','src-lat2','src-lon2','src-lat3','src-lon3','src-radius']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
};

function _renderSourcesList() {
  const body = document.getElementById('src-list-body');
  if (!_sources.length) {
    body.innerHTML = '<div style="text-align:center;color:var(--tx2);padding:20px">Нет источников</div>';
    return;
  }
  body.innerHTML = _sources.map(s => `
    <div class="src-item">
      <span class="src-item-icon">${SRC_ICONS[s.type] || '📌'}</span>
      <div style="flex:1;min-width:0">
        <div class="src-item-name">${s.name}</div>
        <div class="src-item-meta">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}${s.radius ? ' | r=' + s.radius + 'м' : ''}</div>
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
  const pts = _sources.map(s => [s.lat, s.lon]);
  map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
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
    const name   = cols[0] || ('Источник ' + (_sources.length + 1));
    const rawType = (cols[1] || 'other').toLowerCase();
    const typeMap = { выброс:'emission', emission:'emission', noise:'noise', шум:'noise',
      радиация:'radiation', radiation:'radiation', вибрация:'vibration', vibration:'vibration' };
    const type  = typeMap[rawType] || 'other';
    const lat   = parseFloat(cols[2]);
    const lon   = parseFloat(cols[3]);
    if (isNaN(lat) || isNaN(lon)) return;

    let lat2=null, lon2=null, lat3=null, lon3=null, radius=0;
    if (cols.length >= 7) {
      // 4-coord linear: name, type, lat1, lon1, lat2, lon2, width
      lat2   = parseFloat(cols[4]) || null;
      lon2   = parseFloat(cols[5]) || null;
      radius = parseFloat(cols[6]) || 0;
    } else if (cols.length >= 5) {
      radius = parseFloat(cols[4]) || 0;
    }

    const color = SRC_COLORS[type] || '#6b7280';
    const s = { id:'src_'+Date.now()+'_'+added, name, type, lat, lon, lat2, lon2, lat3, lon3, radius, color };
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
