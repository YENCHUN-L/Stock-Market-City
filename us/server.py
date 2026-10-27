#!/usr/bin/env python3
"""StockBS market city backend: keeps an S&P 1500 snapshot fresh and serves it to the three.js page.

Run:  python3 server.py  [--port 8000] [--interval 10800]
"""
import argparse
import gzip
import json
import os
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import investors
import sp500

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")
SYMBOL_RE = re.compile(r"^[A-Z0-9\-]{1,10}$")

market = None


def updater_loop(interval):
    while True:
        try:
            market.refresh()
        except Exception as e:  # e.g. offline: keep serving the cached snapshot
            print(f"[update] failed: {e}", flush=True)
        print(f"[update] done: {market.progress['done']} tickers, "
              f"{len(market.progress['errors'])} errors", flush=True)
        time.sleep(interval)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC_DIR, **kw)

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        # The S&P 1500 snapshot is ~1 MB of JSON; gzip makes it a fraction of that.
        gz = "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 1024
        if gz:
            body = gzip.compress(body, 5)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client went away (reload/closed tab) before the response finished

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/market":
            return self._json(market.snapshot())
        m = re.match(r"^/api/history/([^/]+)$", p)
        if m:
            sym = m.group(1).upper()
            bars = sp500.load_prices(DATA_DIR, sym) if SYMBOL_RE.match(sym) else None
            if not bars:
                return self._json({"error": "unknown symbol"}, 404)
            market.snapshot()  # make sure the fair-value trends are built
            return self._json({"sym": sym, "bars": bars, "fair": market.history.get(sym, []),
                               "investors": investors.adjust_timeline(market.inv_timeline.get(sym, {}), bars)})
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] == "/api/refresh":
            threading.Thread(target=market.refresh, kwargs={"force": True}, daemon=True).start()
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)


def main():
    global market
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--interval", type=int, default=10800, help="seconds between data refreshes")
    ap.add_argument("--sec-agent", default=os.environ.get("STOCKBS_SEC_AGENT"),
                    help='contact User-Agent for SEC 13F downloads, e.g. "Your Name you@example.com" '
                         "(or set STOCKBS_SEC_AGENT); without it the famous-investor view is off")
    args = ap.parse_args()
    market = sp500.Market(DATA_DIR, price_max_age=args.interval, sec_agent=args.sec_agent)
    threading.Thread(target=updater_loop, args=(args.interval,), daemon=True).start()
    print(f"USmarket city at http://{args.host}:{args.port}  (refresh every {args.interval}s)", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
