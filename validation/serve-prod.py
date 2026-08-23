"""Serve dist/ locally with the exact headers vercel.json will send.

Testing the production build without the real Content-Security-Policy
would prove nothing: a CSP that blocks the OCR worker or the WASM core
only shows up once it is actually applied.

Run:  python validation/serve-prod.py [port]
"""

import http.server
import json
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4180

with open(os.path.join(ROOT, "vercel.json"), encoding="utf-8") as f:
    config = json.load(f)

GLOBAL_HEADERS = [
    (h["key"], h["value"])
    for rule in config["headers"]
    if rule["source"] == "/(.*)"
    for h in rule["headers"]
]


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        for key, value in GLOBAL_HEADERS:
            self.send_header(key, value)
        super().end_headers()

    def translate_path(self, path):
        resolved = super().translate_path(path.split("?")[0])
        # SPA fallback, the way a static host would do it.
        if not os.path.exists(resolved) and "." not in os.path.basename(resolved):
            return os.path.join(os.getcwd(), "index.html")
        return resolved

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.chdir(os.path.join(ROOT, "dist"))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"serving dist/ with production headers on http://127.0.0.1:{PORT}")
        httpd.serve_forever()
