'use strict';
function initApp() {
  initMap();
  checkProxy();
  _initCanvasDrawing();
  setTool('poly');
  updateButtons();
  map.on('moveend zoomend', () => updatePdfOverlays());
  window.addEventListener('resize', debounce(() => {
    if (document.getElementById('pdf-editor').style.display !== 'none') {
      _applyOrientation();
      if (pdfMap) pdfMap.invalidateSize();
    }
  }, 200));
}
