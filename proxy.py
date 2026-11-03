#!/usr/bin/env python3
"""Local streaming reverse proxy with a session-memory browser dashboard.

See README.md for startup and Codex routing commands.
"""

from __future__ import annotations

import argparse
import http.client
import json
import threading
from capture import Store, Stream, safe_headers
from dashboard import Dashboard
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

# Headers that describe one hop of the connection, not the message. They are
# never forwarded. `accept-encoding` is dropped too, so the API answers in plain
# text and what we print is readable.
SKIP = {
    "host", "connection", "keep-alive", "transfer-encoding", "te", "trailers",
    "upgrade", "proxy-authorization", "proxy-authenticate", "accept-encoding",
    "content-length",
}

UPSTREAM = "https://api.anthropic.com"


def stamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


class Tap(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # we print our own lines

    def do_POST(self) -> None:
        self.relay()

    def do_GET(self) -> None:
        self.relay()

    def do_HEAD(self) -> None:
        self.relay()

    def relay(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""

        store = self.server.store
        card = store.create(self.command, self.path, dict(self.headers), body)
        print(f"[{stamp()}] #{card['id']} >>> {self.command} {self.path}", flush=True)
        target = urlsplit(UPSTREAM)
        conn_cls = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        upstream = conn_cls(target.netloc, timeout=10)
        started = False
        stream = None
        try:
            upstream.connect()
            upstream.sock.settimeout(600)
            excluded = SKIP | {v.strip().lower() for v in self.headers.get('Connection', '').split(',')}
            headers = {k: v for k, v in self.headers.items() if k.lower() not in excluded}
            upstream.request(self.command, target.path.rstrip("/") + self.path, body=body or None, headers=headers)
            reply = upstream.getresponse()
            store.update(card, status=reply.status, state='streaming', response_headers=safe_headers(dict(reply.getheaders())))
            self.send_response(reply.status, reply.reason)
            excluded = SKIP | {v.strip().lower() for v in reply.getheader('Connection', '').split(',')}
            for name, value in reply.getheaders():
                if name.lower() not in excluded:
                    self.send_header(name, value)
            self.send_header('Connection', 'close')
            self.end_headers()
            started = True
            content_type = reply.getheader('Content-Type')
            stream = Stream(store, card, None if content_type is None else
                            'text/event-stream' in content_type.lower())
            count = 0
            if self.command != 'HEAD':
                while chunk := reply.read1(4096):
                    count += len(chunk)
                    # Forward first; capture interpretation never waits for a full reply.
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    stream.feed(chunk)
            stream.feed(b'', final=True)
            expected = reply.getheader('Content-Length')
            if self.command != 'HEAD' and expected is not None and count != int(expected):
                raise OSError('Upstream closed before the declared response length arrived')
            if stream.sse and self.command != 'HEAD' and not stream.terminal:
                raise OSError('Upstream event stream ended without a completion event')
            if reply.status >= 400:
                card['diagnostics'].append(f'Upstream returned HTTP {reply.status} {reply.reason}. Captured error body is available below.')
            store.update(card, state='failed' if reply.status >= 400 or card['state'] == 'failed' else 'completed')
        except (OSError, http.client.HTTPException, ValueError) as error:
            if stream:
                stream.feed(b'', final=True)
            store.update(card, state='failed', diagnostics=card['diagnostics'] + [
                ('Response interrupted (upstream or harness connection): ' if started else 'Could not obtain an upstream reply: ') + str(error)])
            if not started:
                self.send_error(502, 'Proxy could not obtain an upstream reply')
        finally:
            upstream.close()
            self.close_connection = True


def main() -> None:
    global UPSTREAM
    parser = argparse.ArgumentParser(description="Print and forward an agent's API traffic.")
    parser.add_argument("--port", type=int, default=8041)
    parser.add_argument("--upstream", default=UPSTREAM, help="where to forward (default: the Anthropic API)")
    parser.add_argument("--dashboard-port", type=int, default=8042)
    args = parser.parse_args()
    UPSTREAM = args.upstream.rstrip("/")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Tap)
    store = Store()
    server.store = store
    dashboard = ThreadingHTTPServer(("127.0.0.1", args.dashboard_port), Dashboard)
    dashboard.daemon_threads = True
    dashboard.store = store
    threading.Thread(target=dashboard.serve_forever, daemon=True).start()
    print(f"Dashboard: http://127.0.0.1:{args.dashboard_port}")
    print(f"proxy listening on http://localhost:{args.port}  ->  {UPSTREAM}")
    print(f"run the agent with:  ANTHROPIC_BASE_URL=http://localhost:{args.port} claude")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        dashboard.shutdown()
        dashboard.server_close()
        server.server_close()


if __name__ == "__main__":
    main()
