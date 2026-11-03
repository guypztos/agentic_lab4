"""Thread-safe, session-memory capture and incremental SSE interpretation."""
import base64
import codecs
import json
import threading
import uuid
from datetime import datetime, timezone


def decoded(body):
    try:
        return json.loads(body)
    except (ValueError, UnicodeError):
        return None


def safe_headers(headers):
    return {k: ('[redacted]' if any(s in k.lower() for s in ('authorization', 'api-key', 'cookie', 'token', 'secret')) else v) for k, v in headers.items()}


class Store:
    def __init__(self):
        self.condition = threading.Condition(threading.RLock())
        self.session = str(uuid.uuid4())
        self.version = 0
        self.cards = []

    def changed(self):
        self.version += 1
        self.condition.notify_all()

    def create(self, method, path, headers, body):
        with self.condition:
            data = decoded(body)
            scope = next((v for k, v in headers.items() if k.lower() in ('session_id', 'session-id', 'conversation_id', 'x-conversation-id')), None)
            if not scope and isinstance(data, dict):
                scope = data.get('conversation_id') or data.get('conversation')
            card = dict(id=len(self.cards)+1, arrival=datetime.now(timezone.utc).isoformat(), method=method,
                        path=path, headers=safe_headers(headers), request=body.decode('utf-8', 'replace'),
                        request_base64=base64.b64encode(body).decode(), data=data, scope=str(scope) if scope else None,
                        state='awaiting reply', status=None, response='', response_base64='', events=[], diagnostics=[])
            self.cards.append(card)
            self.changed()
            return card

    def update(self, card, **fields):
        with self.condition:
            card.update(fields)
            self.changed()

    def snapshot(self):
        # Serialize under lock, never hold the lock while writing to a browser.
        with self.condition:
            return json.dumps(dict(session=self.session, version=self.version, cards=self.cards), ensure_ascii=False)


class Stream:
    def __init__(self, store, card, sse):
        self.store, self.card, self.sse = store, card, sse
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.pending = ''
        self.raw = bytearray()
        self.terminal = False

    def feed(self, chunk, final=False):
        self.raw.extend(chunk)
        text = self.decoder.decode(chunk, final=final)
        with self.store.condition:
            self.card['response'] += text
            self.card['response_base64'] = base64.b64encode(self.raw).decode()
            if self.sse:
                self.pending += text
                # Normalize CRLF only after a full line has arrived.
                self.pending = self.pending.replace('\r\n', '\n')
                while '\n\n' in self.pending:
                    frame, self.pending = self.pending.split('\n\n', 1)
                    self.event(frame)
                if final and self.pending.strip():
                    self.event(self.pending)
                    self.card['diagnostics'].append('Stream ended with an unterminated SSE event; raw content is retained.')
            self.store.changed()

    def event(self, frame):
        lines = [line[5:].lstrip(' ') for line in frame.split('\n') if line.startswith('data:')]
        if not lines:
            return
        raw = '\n'.join(lines)
        event = decoded(raw)
        self.card['events'].append(event if event is not None else {'unparsed_data': raw})
        if event is None and raw != '[DONE]':
            self.card['diagnostics'].append('An upstream event was not valid JSON. Its original data remains in the full response.')
        if raw == '[DONE]' or isinstance(event, dict) and event.get('type') in ('response.completed', 'response.failed', 'response.incomplete', 'message_stop'):
            self.terminal = True
        if isinstance(event, dict) and event.get('type') in ('error', 'response.failed', 'response.incomplete'):
            self.card['diagnostics'].append('Upstream reported a model error or incomplete response. Inspect the captured event.')
            self.card['state'] = 'failed'
