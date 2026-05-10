#!/usr/bin/env python3
"""
Local proxy for szz_finder_v3.html.

Default mode uses local `pynspd-main` client (recommended for blocked NSPD/PKK setups).
Fallback mode proxies upstream `/api/features/1`.

Run:
  python3 proxy.py

Optional environment variables:
  HOST=127.0.0.1
  PORT=8765
  USE_PYNSPD=1
  PYNSPD_SRC_PATH=/Users/.../pynspd-main/src
  PYNSPD_CLIENT_PROXY=http://user:pass@host:port
  PYNSPD_CLIENT_DNS_RESOLVE=0

  # Fallback upstream mode (USE_PYNSPD=0)
  PKK_API_URL=https://pkk.rosreestr.ru/api/features/1
  NSPD_COOKIE=...
  NSPD_AUTHORIZATION=...
  PROXY_USER_AGENT=...
  NSPD_SSL_VERIFY=1
"""
from __future__ import annotations

import json
import os
import ssl
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen


HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8765"))
PKK_API_URL = os.getenv("PKK_API_URL", "https://pkk.rosreestr.ru/api/features/1")
TIMEOUT_SECONDS = 30
SSL_VERIFY = os.getenv("NSPD_SSL_VERIFY", "1").strip() not in {"0", "false", "False", "no", "NO"}
USE_PYNSPD = os.getenv("USE_PYNSPD", "1").strip() not in {"0", "false", "False", "no", "NO"}
PYNSPD_FALLBACK_UPSTREAM = os.getenv("PYNSPD_FALLBACK_UPSTREAM", "1").strip() not in {
    "0",
    "false",
    "False",
    "no",
    "NO",
}
PYNSPD_SRC_PATH = os.getenv(
    "PYNSPD_SRC_PATH",
    str(Path(__file__).resolve().parent.parent / "pynspd-main" / "src"),
)

DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)


def build_upstream_headers() -> Dict[str, str]:
    headers = {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": os.getenv("PROXY_USER_AGENT", DEFAULT_UA),
        # Sometimes NSPD/PKK checks browser context.
        "Referer": "https://pkk.rosreestr.ru/",
        "Origin": "https://pkk.rosreestr.ru",
    }

    cookie = os.getenv("NSPD_COOKIE", "").strip()
    if cookie:
        headers["Cookie"] = cookie

    auth = os.getenv("NSPD_AUTHORIZATION", "").strip()
    if auth:
        headers["Authorization"] = auth

    return headers


def ensure_latin1_header(name: str, value: str) -> str:
    try:
        value.encode("latin-1")
    except UnicodeEncodeError as exc:
        raise ValueError(
            f"Header {name} contains non-latin characters. "
            "Paste raw Cookie/Authorization exactly from browser request headers."
        ) from exc
    return value


def build_ssl_context() -> ssl.SSLContext:
    if SSL_VERIFY:
        return ssl.create_default_context()
    return ssl._create_unverified_context()


def looks_like_placeholder(value: str) -> bool:
    v = value.strip().lower()
    return (
        not v
        or "..." in v
        or "ваша_" in v
        or "реальная_cookie_строка" in v
        or "bearer ..." in v
    )


def _load_pynspd():
    src_path = Path(PYNSPD_SRC_PATH)
    if not src_path.exists():
        raise RuntimeError(
            f"pynspd src not found at {src_path}. "
            "Set PYNSPD_SRC_PATH to .../pynspd-main/src"
        )
    if str(src_path) not in sys.path:
        sys.path.insert(0, str(src_path))

    try:
        from shapely import Polygon
        from pynspd import Nspd
    except Exception as exc:
        raise RuntimeError(
            "Cannot import pynspd/shapely. Install dependencies:\n"
            "  pip install -e /Users/rustam/Downloads/pynspd-main"
        ) from exc

    return Nspd, Polygon


class Handler(BaseHTTPRequestHandler):
    def _set_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _send_json(self, status: int, payload: Dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._set_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        self.send_response(204)
        self._set_cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        parsed = urlsplit(self.path)
        path = parsed.path

        if path == "/ping":
            self._send_json(200, {"ok": True, "proxy": "running"})
            return

        if path != "/pkk":
            self._send_json(404, {"ok": False, "error": "Unknown route"})
            return

        try:
            data, status = self._proxy_pkk(parsed.query)
            self.send_response(status)
            self._set_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:  # keep response JSON for frontend diagnostics
            print(f"[proxy] request failed: {type(exc).__name__}: {exc}")
            self._send_json(502, {"ok": False, "error": str(exc)})

    def _proxy_pkk(self, raw_query: str) -> Tuple[bytes, int]:
        if USE_PYNSPD:
            try:
                return self._proxy_pkk_via_pynspd(raw_query)
            except Exception as exc:
                print(f"[proxy] pynspd failed: {type(exc).__name__}: {exc}")
                if PYNSPD_FALLBACK_UPSTREAM:
                    print("[proxy] fallback to upstream mode")
                    return self._proxy_pkk_via_upstream(raw_query)
                raise
        return self._proxy_pkk_via_upstream(raw_query)

    def _proxy_pkk_via_pynspd(self, raw_query: str) -> Tuple[bytes, int]:
        Nspd, Polygon = _load_pynspd()
        incoming = parse_qs(raw_query, keep_blank_values=True)
        sq_raw = incoming.get("sq", [""])[-1]
        bbox_raw = incoming.get("bbox", [""])[-1]

        if sq_raw:
            # Polygon mode: sq={"type":"Polygon","coordinates":[...]}
            sq = json.loads(sq_raw)
            rings = sq.get("coordinates")
            if not rings or not rings[0]:
                raise ValueError("Invalid sq polygon coordinates")
            shell = [(float(lon), float(lat)) for lon, lat in rings[0]]
        elif bbox_raw:
            # Bbox mode: bbox=minLon,minLat,maxLon,maxLat  (from search.js tiles)
            parts = [float(v) for v in bbox_raw.split(",")]
            if len(parts) != 4:
                raise ValueError("Invalid bbox, expected minLon,minLat,maxLon,maxLat")
            minLon, minLat, maxLon, maxLat = parts
            shell = [
                (minLon, minLat), (maxLon, minLat),
                (maxLon, maxLat), (minLon, maxLat), (minLon, minLat),
            ]
        else:
            raise ValueError("Missing required query param: sq or bbox")

        contour = Polygon(shell)
        if not contour.is_valid:
            contour = contour.buffer(0)
        if contour.is_empty:
            raise ValueError("Contour became empty after validation")

        proxy_url = os.getenv("PYNSPD_CLIENT_PROXY")
        dns_resolve = os.getenv("PYNSPD_CLIENT_DNS_RESOLVE", "1").lower() in {"1", "true"}
        rows = []
        with Nspd(
            client_timeout=TIMEOUT_SECONDS,
            client_retries=2,
            client_proxy=proxy_url,
            client_dns_resolve=dns_resolve,
            trust_env=True,
        ) as nspd:
            feats = nspd.search_landplots_in_contour(contour) or []
            for feat in feats:
                props = feat.properties.options
                cad_num = getattr(props, "cad_num", None) or getattr(props, "cn", None) or ""
                addr = getattr(props, "readable_address", "") or ""
                area_val = getattr(props, "specified_area", None) or getattr(props, "declared_area", None)
                area = str(area_val) if area_val is not None else ""
                center = feat.geometry.to_shape().centroid
                rows.append(
                    {
                        "attrs": {
                            "cn": cad_num,
                            "id": cad_num,
                            "address": addr,
                            "area_value": area,
                            "area_unit": "м²" if area else "",
                            "category_type": "Земельный участок",
                        },
                        "center": {"x": center.x, "y": center.y},
                        "geometry": feat.geometry.model_dump(mode="json", by_alias=True),
                    }
                )

        body = json.dumps({"features": rows}, ensure_ascii=False).encode("utf-8")
        print(f"[proxy] pynspd features={len(rows)}")
        return body, 200

    def _proxy_pkk_via_upstream(self, raw_query: str) -> Tuple[bytes, int]:
        incoming = parse_qs(raw_query, keep_blank_values=True)
        normalized = {k: v[-1] for k, v in incoming.items() if v}

        # Support bbox=minLon,minLat,maxLon,maxLat (from search.js tiles)
        if "bbox" in normalized and "sq" not in normalized:
            parts = [float(v) for v in normalized.pop("bbox").split(",")]
            if len(parts) != 4:
                raise ValueError("Invalid bbox, expected minLon,minLat,maxLon,maxLat")
            minLon, minLat, maxLon, maxLat = parts
            # Translate to PKK upstream format
            normalized.update({
                "text": "",
                "tolerance": "4",
                "limit": normalized.get("limit", "400"),
                "skip": "0",
                "inBbox": "1",
                "bbox": f"{minLon},{minLat},{maxLon},{maxLat}",
                "bboxSr": "4326",
                "resultSr": "4326",
                "returnGeometry": "true",
                "returnAttributes": "true",
            })
        elif "sq" not in normalized:
            raise ValueError("Missing required query param: sq or bbox")

        query = urlencode(normalized)
        upstream = f"{PKK_API_URL}?{query}"
        headers = build_upstream_headers()
        for hk in ("Cookie", "Authorization", "User-Agent", "Referer", "Origin", "Accept"):
            if hk in headers:
                headers[hk] = ensure_latin1_header(hk, headers[hk])
        req = Request(upstream, headers=headers, method="GET")
        ssl_ctx = build_ssl_context()

        try:
            with urlopen(req, timeout=TIMEOUT_SECONDS, context=ssl_ctx) as resp:
                body = resp.read()
                print(f"[proxy] upstream status={resp.status}, bytes={len(body)}")
                return body, int(resp.status)
        except HTTPError as err:
            body = err.read()
            print(f"[proxy] upstream HTTP error={err.code}, bytes={len(body) if body else 0}")
            if body:
                return body, int(err.code)
            return (
                json.dumps(
                    {"ok": False, "error": f"Upstream HTTP {err.code}"},
                    ensure_ascii=False,
                ).encode("utf-8"),
                int(err.code),
            )
        except URLError as err:
            raise RuntimeError(f"Upstream not reachable: {err.reason}") from err

    def log_message(self, format: str, *args) -> None:
        # Compact logs in terminal.
        print(f"[proxy] {self.address_string()} - {format % args}")


def main() -> None:
    print(f"Starting local proxy on http://{HOST}:{PORT}")
    print(f"Mode: {'pynspd' if USE_PYNSPD else 'upstream'}")
    if USE_PYNSPD:
        print(f"PYNSPD_SRC_PATH: {PYNSPD_SRC_PATH}")
        print(f"PYNSPD_FALLBACK_UPSTREAM: {'on' if PYNSPD_FALLBACK_UPSTREAM else 'off'}")
    else:
        print(f"Upstream API: {PKK_API_URL}")
        if os.getenv("NSPD_COOKIE"):
            print("NSPD_COOKIE: set")
        else:
            print("NSPD_COOKIE: not set")
        print(f"SSL verify: {'on' if SSL_VERIFY else 'off'}")
    cookie = os.getenv("NSPD_COOKIE", "")
    auth = os.getenv("NSPD_AUTHORIZATION", "")
    if not USE_PYNSPD and looks_like_placeholder(cookie):
        print("Warning: NSPD_COOKIE looks like placeholder, set real browser cookie.")
    if not USE_PYNSPD and auth and looks_like_placeholder(auth):
        print("Warning: NSPD_AUTHORIZATION looks like placeholder.")
    if not USE_PYNSPD and not SSL_VERIFY:
        print("Warning: SSL verification disabled (NSPD_SSL_VERIFY=0).")
    print("Tip: keep this terminal busy with proxy; run other commands in a new terminal tab.")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
