"""Serve web/ for the local demo with caching off, so students always get the latest JS."""
import functools
import http.server
import sys
from pathlib import Path


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    bind = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    web = Path(__file__).resolve().parent.parent / "web"
    handler = functools.partial(NoCacheHandler, directory=str(web))
    http.server.ThreadingHTTPServer((bind, 8000), handler).serve_forever()
