#!/usr/bin/env python3
"""
СЗЗ Инструмент — десктоп приложение
Прокси + сайт в одном .app
"""
import base64, json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# ── Пути ─────────────────────────────────────────
if getattr(sys, "frozen", False):
    BASE = Path(sys.executable).resolve().parent.parent / "Resources"
else:
    BASE = Path(__file__).resolve().parent

SITE_DIR   = BASE / "public"
PYNSPD_SRC = str(BASE.parent / "pynspd-main" / "src")
if PYNSPD_SRC not in sys.path:
    sys.path.insert(0, PYNSPD_SRC)

PROXY_PORT = 8767
SITE_PORT  = 8768

# ── Прокси-сервер ────────────────────────────────
class ProxyHandler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status); self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        query = urlsplit(self.path).query

        if path == "/ping":
            self._json(200, {"ok": True, "proxy": "szz-app"}); return

        if path != "/pkk":
            self._json(404, {"error": "not found"}); return

        qs     = parse_qs(query, keep_blank_values=True)
        sq_raw = qs.get("sq", [""])[-1]
        bbox   = qs.get("bbox", [""])[-1]

        try:
            from shapely import Polygon as SP
            from pynspd import Nspd

            if sq_raw:
                sq    = json.loads(sq_raw)
                shell = [(float(x), float(y)) for x, y in sq["coordinates"][0]]
            elif bbox:
                a, b, c, d = [float(v) for v in bbox.split(",")]
                shell = [(a,b),(c,b),(c,d),(a,d),(a,b)]
            else:
                self._json(400, {"error": "sq or bbox required"}); return

            contour = SP(shell)
            if not contour.is_valid: contour = contour.buffer(0)

            rows = []
            with Nspd(client_timeout=30, client_retries=2, trust_env=True) as nspd:
                for f in (nspd.search_landplots_in_contour(contour) or []):
                    p  = f.properties.options
                    cn = getattr(p, "cad_num", "") or ""
                    av = getattr(p, "specified_area", None) or getattr(p, "declared_area", None)
                    ct = f.geometry.to_shape().centroid
                    rows.append({
                        "attrs":    {"cn": cn, "id": cn,
                                     "address":   getattr(p, "readable_address", "") or "",
                                     "area_value": str(av) if av else "",
                                     "area_unit":  "м²" if av else ""},
                        "center":   {"x": ct.x, "y": ct.y},
                        "geometry": f.geometry.model_dump(mode="json", by_alias=True),
                    })

            body = json.dumps({"features": rows}, ensure_ascii=False).encode()
            self.send_response(200); self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)

        except Exception as e:
            self._json(502, {"error": str(e)})

    def do_POST(self):
        path = urlsplit(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except Exception:
            self._json(400, {"error": "invalid JSON"}); return

        if path == "/nspd-find-plot":
            self._nspd_find_plot(body)
        else:
            self._json(404, {"error": "not found"})

    def _nspd_find_plot(self, data):
        try:
            lat = float(data.get("lat", ""))
            lon = float(data.get("lon", ""))
        except (ValueError, TypeError):
            self._json(400, {"error": "lat and lon required"}); return
        try:
            from pynspd import Nspd
            from shapely.geometry import mapping as geom_mapping
            with Nspd(client_timeout=30, client_retries=2, trust_env=True) as nspd:
                result = nspd.search_landplots_at_coords(lat, lon)
            if not result:
                self._json(404, {"error": "Участок не найден по указанным координатам"}); return
            feat = result[0] if isinstance(result, list) else result
            geom_shape = feat.geometry.to_shape()
            p = feat.properties.options
            props = {}
            cn = getattr(p, "cad_num", "") or ""
            if cn:   props["Кадастровый номер"] = cn
            addr = getattr(p, "readable_address", "") or ""
            if addr: props["Адрес"] = addr
            av = getattr(p, "specified_area", None) or getattr(p, "declared_area", None)
            if av:   props["Площадь"] = f"{av} м²"
            self._json(200, {
                "type": "Feature",
                "geometry": geom_mapping(geom_shape),
                "properties": props,
            })
        except Exception as e:
            self._json(500, {"error": str(e)})

    def log_message(self, *args): pass  # тихий режим


# ── HTTP-сервер для сайта ────────────────────────
class SiteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE_DIR), **kwargs)
    def log_message(self, *args): pass


def _start_server(handler, port):
    ThreadingHTTPServer.allow_reuse_address = True
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ── JS API (доступно через window.pywebview.api) ──
class JsApi:
    """Методы, вызываемые из JavaScript через pywebview."""

    def save_file(self, filename: str, data_b64: str) -> str | None:
        """Открывает диалог сохранения и записывает файл."""
        import tkinter as tk
        from tkinter import filedialog
        ext = os.path.splitext(filename)[1] or ''
        filetypes = [('Все файлы', '*.*')]
        if ext == '.xlsx': filetypes = [('Excel', '*.xlsx')] + filetypes
        elif ext == '.docx': filetypes = [('Word', '*.docx')] + filetypes
        elif ext == '.csv':  filetypes = [('CSV', '*.csv')]  + filetypes

        root = tk.Tk(); root.withdraw(); root.attributes('-topmost', True)
        path = filedialog.asksaveasfilename(
            parent=root,
            defaultextension=ext,
            initialfile=filename,
            filetypes=filetypes,
        )
        root.destroy()
        if not path:
            return None
        try:
            data = base64.b64decode(data_b64)
            with open(path, 'wb') as f:
                f.write(data)
            return path
        except Exception as e:
            print(f'[api] save_file error: {e}')
            return None


# ── Запуск ───────────────────────────────────────
if __name__ == "__main__":
    import webview

    # Стартуем оба сервера
    _start_server(ProxyHandler, PROXY_PORT)
    _start_server(SiteHandler,  SITE_PORT)

    # Открываем нативное окно
    webview.create_window(
        "СЗЗ Инструмент",
        f"http://127.0.0.1:{SITE_PORT}",
        width=1280,
        height=820,
        min_size=(900, 600),
        js_api=JsApi(),
    )
    webview.start()
