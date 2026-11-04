# Live Agent Traffic Dashboard

Standard-library Python proxy and browser dashboard. The application uses Python 3 (3.10+) and its standard library; no third-party packages are required. A modern browser is required for the dashboard. Node.js is optional for the automated JavaScript interpretation test, not required to run the dashboard. No build step, database, or installation downloads are required.

## Setup and start (Ubuntu / WSL)

The working directory is `/home/rotem/ai-course/lab4`. In the server terminal, run:

```bash
cd /home/rotem/ai-course/lab4
python3 -u proxy.py --port 8041 --dashboard-port 8042 --upstream https://chatgpt.com/backend-api/codex
```

Open **http://127.0.0.1:8042/** in your browser (including a Windows browser with WSL localhost forwarding enabled). Both servers bind to `127.0.0.1`. Port 8041 receives Codex API traffic and forwards it to the configured upstream; port 8042 serves the dashboard. Ignore the server's Claude startup hint for this Codex setup.

Stop the server with **Ctrl+C**. Restart it after Python code changes. Captured history is held in memory and resets on restart.

## Validated live Codex test

Use your existing Codex CLI installation and ChatGPT login. In a separate Ubuntu terminal, run:

```bash
cd /home/rotem/ai-course/lab4
codex exec --sandbox read-only \
  -c 'model_provider="course_proxy"' \
  -c 'model_providers.course_proxy.name="Course proxy"' \
  -c 'model_providers.course_proxy.base_url="http://127.0.0.1:8041"' \
  -c 'model_providers.course_proxy.requires_openai_auth=true' \
  "Use a shell command to read /home/rotem/ai-course/lab4-prep/sample.txt and show its exact contents. Do not modify any files."
```

The test file already exists in the separate prep folder at `/home/rotem/ai-course/lab4-prep/sample.txt`; no file creation is needed. These per-invocation overrides route the course proxy provider through port 8041 using existing OpenAI authentication, without editing Codex configuration. The provider sends `/responses` to the proxy, which forwards it to `https://chatgpt.com/backend-api/codex/responses`.

This captures routed HTTP traffic only; other Codex network destinations and local tool execution are outside its visibility. WebSocket forwarding is not supported; clients must use HTTP streaming.

## Implemented

- Newest-first request/reply cards with stable IDs, arrival times, HTTP status, lifecycle, diagnostic errors, and in-place streaming updates.
- Instruction views include system/developer input messages; definitions have their own section. All input items retain order, labels, full JSON, and unknown fields.
- Incremental UTF-8/SSE parsing, model text deltas, Responses function/custom tool calls, Anthropic tool blocks, and common message tool call/result formats. Full original bodies, parsed events, and lossless base64 bytes remain available, even for malformed data.
- Scoped logical call/result pairing, including later-request results and repeated historical references. Missing scope/IDs and conflicting values are explicitly labeled. Pairing uses protocol identifiers, never tool name/arguments. No execution-time inference.
- In-memory session history with atomic SSE snapshots, reconnect recovery, no eviction, and a fresh session identity on restart. Browser disconnection does not stop capture. Expanded views and reading anchors are restored on updates; a visible control returns to newest traffic.
- Local assets, English labels, preserved message language, left-to-right JSON, no analytics or disk capture. Transport credential headers are redacted in captures; originals still forward upstream. Body content is intentionally fully inspectable and may contain sensitive information.

## Checks

```bash
cd /home/rotem/ai-course/lab4
python3 -m py_compile proxy.py capture.py dashboard.py
python3 -m unittest discover -s tests -v
git diff --check
```

Tests cover byte-preserving mocked forwarding, credential forwarding/redaction, session snapshots, malformed/unknown events, and SSE/UTF-8 split one byte at a time. Socket integration tests exercise overlapping requests, early streaming, HTTP errors, refused connections, interrupted SSE, static UI delivery, and reconnect snapshots. They skip with an explicit reason if the environment prohibits sockets.

Latest manual test result in this Ubuntu WSL environment: nine tests passed, and one JavaScript interpretation test was skipped because no JavaScript runtime was available.

Manual browser validation: a live Codex request completed with HTTP 200, and its final reply containing `PINEAPPLE` appeared in the interpreted **Model response** area after the SSE fix.

These results do not establish that every acceptance criterion has passed.

## Remaining validation and limitations

Further acceptance validation includes inspecting a local tool's later result, refreshing mid-stream, disconnecting/reconnecting the browser feed, and inspecting an older expanded item as overlapping traffic arrives. Browser scroll/focus restoration and live tool rendering still need broader validation.

There is no reliable history/new-item boundary in many payloads; the dashboard explicitly labels the combined section instead of guessing. Cross-request tool reconciliation requires an explicit `session_id` / conversation header or conversation field. Without one, calls remain scoped to the capture and cannot be safely reconciled across requests. Unknown protocols remain available in full capture but may lack a rich interpretation. In particular, Chat Completions delta tool calls are not incrementally interpreted, and compressed upstream bodies are retained but not decompressed for interpretation (Accept-Encoding is stripped on forwarding).

Full snapshots and body reserialization favor a simple, gap-free first build over scale. History never evicts and can exhaust memory; large captures can cause UI delays. Reading position restoration is best effort during layout changes and needs browser verification. Requests use Content-Length as in the original proxy; chunked uploads and WebSocket upgrades are unsupported. A timeout is reported after 600 seconds without upstream data. SSE EOF without a recognized completion marker is reported as interrupted, even if an unfamiliar protocol considers EOF normal.

Search, status/tool/item-type filters, a light/dark theme toggle, and folding of repeated history are implemented in the browser only (see SPEC.md, "Visual iteration"). Statistics, export, disk persistence, and remote access are not implemented.
