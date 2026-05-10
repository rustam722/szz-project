'use strict';
function initApp() {
  initMap();
  checkProxy();
  _initCanvasDrawing();
  setTool('poly');
  updateButtons();
  map.on('moveend zoomend', () => updatePdfOverlays());
  _initMainSidebarResize();
  window.addEventListener('resize', debounce(() => {
    if (document.getElementById('pdf-editor').style.display !== 'none') {
      _applyOrientation();
      if (pdfMap) pdfMap.invalidateSize();
    } else {
      map.invalidateSize();
    }
  }, 200));
}

// ── Ресайз левой панели на главной странице ──────
function _initMainSidebarResize() {
  const handle  = document.getElementById('main-resize-handle');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;

  let startX = 0, startW = 0;

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    startX = e.clientX;
    startW = sidebar.offsetWidth;

    function onMove(ev) {
      const newW = Math.max(200, Math.min(600, startW + (ev.clientX - startX)));
      sidebar.style.width = newW + 'px';
      map.invalidateSize();
    }
    function onUp() {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      map.invalidateSize();
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// Запускаем сразу без авторизации
document.addEventListener('DOMContentLoaded', () => initApp());
