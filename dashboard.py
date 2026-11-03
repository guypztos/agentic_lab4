"""Local browser server; atomic full snapshots make reconnects gap-free."""
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).parent / 'web'


class Dashboard(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.headers.get('Host', '').split(':')[0] not in ('127.0.0.1', 'localhost'):
            self.send_error(403)
            return
        if self.path == '/events':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            version = -1
            try:
                while True:
                    with self.server.store.condition:
                        if version == self.server.store.version:
                            self.server.store.condition.wait(15)
                        payload = self.server.store.snapshot() if version != self.server.store.version else None
                        version = self.server.store.version
                    message = f'id: {self.server.store.session}:{version}\ndata: {payload}\n\n' if payload else ': heartbeat\n\n'
                    self.wfile.write(message.encode())
                    self.wfile.flush()
            except (OSError, ConnectionError):
                return
        else:
            files = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
            if self.path not in files:
                self.send_error(404)
                return
            name, mime = files[self.path]
            body = (ROOT / name).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', mime + '; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)
