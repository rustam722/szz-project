// ═══════════════════════════════════════════════
// NSPD.JS — поиск участка в НСПД + буфер+поиск
// ═══════════════════════════════════════════════

'use strict';

let nspdPlotGeoJSON = null;
let nspdPlotLayer   = null;
let nspdBufLayer    = null;

// Заполняем поля широта/долгота при клике на карту
map.on('click', e => {
  const latEl = document.getElementById('nspd-lat');
  const lonEl = document.getElementById('nspd-lon');
  if (latEl) latEl.value = e.latlng.lat.toFixed(6);
  if (lonEl) lonEl.value = e.latlng.lng.toFixed(6);
});

// Перехватываем clearAll чтобы убирать НСПД-слои тоже
const _nspdOrigClearAll = window.clearAll;
window.clearAll = function () {
  _nspdRemoveLayers();
  nspdPlotGeoJSON = null;
  const info = document.getElementById('nspd-plot-info');
  if (info) info.innerHTML = '';
  const btn = document.getElementById('btn-nspd-buffer');
  if (btn) btn.disabled = true;
  if (typeof _nspdOrigClearAll === 'function') _nspdOrigClearAll();
};

function _nspdRemoveLayers() {
  if (nspdPlotLayer) { map.removeLayer(nspdPlotLayer); nspdPlotLayer = null; }
  if (nspdBufLayer)  { map.removeLayer(nspdBufLayer);  nspdBufLayer  = null; }
}

// ── Найти участок в НСПД по координатам ─────────
async function nspdFindPlot() {
  const lat = parseFloat(document.getElementById('nspd-lat').value);
  const lon = parseFloat(document.getElementById('nspd-lon').value);
  if (isNaN(lat) || isNaN(lon)) { setSt('Введите координаты для поиска', 'err'); return; }

  if (!_proxyMode) {
    const ok = await _detectProxy();
    if (!ok) { setSt('Прокси не запущен — запусти proxy.py', 'err'); return; }
  }

  const btn  = document.getElementById('btn-nspd-find');
  const info = document.getElementById('nspd-plot-info');
  btn.disabled = true;
  info.innerHTML = '';
  setSt('Поиск участка в НСПД…', 'spin');

  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 30000);
    const r = await fetch(`${LOCAL_PROXY}/nspd-find-plot`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ lat, lon }),
      signal:  ctrl.signal,
    }).finally(() => clearTimeout(tid));

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `Ошибка ${r.status}`);
    }

    const feat = await r.json();
    nspdPlotGeoJSON = feat;

    _nspdRemoveLayers();
    nspdPlotLayer = L.geoJSON(feat, {
      style: { color: '#388bfd', fillColor: '#388bfd', fillOpacity: 0.3, weight: 2 },
    }).addTo(map);
    map.fitBounds(nspdPlotLayer.getBounds(), { padding: [40, 40] });

    const cn = feat.properties?.['Кадастровый номер'] || 'Участок найден';
    info.innerHTML = `<span class="nspd-chip ok">✓ ${cn}</span>`;
    document.getElementById('btn-nspd-buffer').disabled = false;
    setSt(`Участок найден: ${cn}`, 'ok');
  } catch (e) {
    info.innerHTML = `<span class="nspd-chip err">✗ ${e.message}</span>`;
    setSt(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── Создать буфер и найти ЗУ внутри ─────────────
async function nspdCreateBuffer() {
  if (!nspdPlotGeoJSON) return;
  const meters = parseFloat(document.getElementById('nspd-buffer-m').value);
  if (isNaN(meters) || meters <= 0) { setSt('Укажите корректный размер буфера', 'err'); return; }

  if (!_proxyMode) {
    const ok = await _detectProxy();
    if (!ok) { setSt('Прокси не запущен — запусти proxy.py', 'err'); return; }
  }

  const btn = document.getElementById('btn-nspd-buffer');
  btn.disabled = true;
  setSt('Создание буфера и поиск участков…', 'spin');
  setProgress(0);

  try {
    // Буфер через turf.js
    const bufFeat = turf.buffer(turf.feature(nspdPlotGeoJSON.geometry), meters / 1000, {
      units: 'kilometers', steps: 64,
    });

    if (nspdBufLayer) map.removeLayer(nspdBufLayer);
    nspdBufLayer = L.geoJSON(bufFeat, {
      style: { color: '#f0883e', fill: false, weight: 2.5, dashArray: '10 6' },
    }).addTo(map);

    setProgress(20);
    setSt('Поиск участков в буфере…', 'spin');

    // Запрос к прокси /pkk с контуром буфера
    const sq     = JSON.stringify(bufFeat.geometry);
    const params = new URLSearchParams({ sq });
    const ctrl   = new AbortController();
    const tid    = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(`${LOCAL_PROXY}/pkk?${params}`, { signal: ctrl.signal })
      .finally(() => clearTimeout(tid));

    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const features = data.features || [];

    setProgress(80);

    // Конвертируем в формат foundParcels
    const parsed = features.map(f => {
      const a = f.attrs   || {};
      const g = f.geometry || {};
      const c = f.center  || {};
      return {
        cn:       a.cn || '—',
        addr:     a.address   || '',
        cat:      a.category_type || '',
        util:     '',
        area:     a.area_value ? `${a.area_value} ${a.area_unit || 'м²'}` : '',
        zone:     '',
        lat:      c.y,
        lon:      c.x,
        inP:      true,
        geometry: g,
      };
    }).filter(p => p.lat !== undefined && p.lon !== undefined);

    // Очищаем предыдущие метки и выводим новые
    clearMarkers();
    foundParcels = [];
    parsed.forEach(p => addParcelLayer(p));
    foundParcels = parsed;

    // Обновляем счётчик и таблицу результатов
    renderResults(parsed, []);
    document.getElementById('res-cnt').textContent      = parsed.length;
    document.getElementById('btn-export').disabled      = !parsed.length;
    document.getElementById('btn-export-word').disabled = !parsed.length;

    map.fitBounds(nspdBufLayer.getBounds(), { padding: [20, 20] });
    setProgress(null);
    setSt(`Найдено ${parsed.length} участков в буфере`, 'ok');
  } catch (e) {
    setProgress(null);
    setSt(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}
