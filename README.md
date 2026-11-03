# Live Agent Traffic Dashboard

Standard-library Python proxy and browser dashboard. Requires Python 3.10+ and a modern browser. No pip packages, Node, build step, database, or installation downloads are required.

## Install and start (Ubuntu / WSL)

From this checkout:

```bash
cd /home/rotem/ai-course/lab4
python3 --version
python3 proxy.py --port 8041 --dashboard-port 8042 --upstream https://chatgpt.com/backend-api
```

Open **http://127.0.0.1:8042/** in your browser (including a Windows browser with WSL localhost forwarding enabled). Both servers bind to `127.0.0.1`. Port 8041 forwards API traffic; port 8042 serves only the dashboard. Ctrl+C stops the session and clears its memory history.

## Route Codex with ChatGPT login

Use your existing Codex CLI installation and ChatGPT login. If necessary, authenticate normally first, before enabling proxy routing:

```bash
codex login
```

In a second WSL terminal, start Codex with a per-invocation override:

```bash
cd /home/rotem/ai-course/lab4
codex -c 'chatgpt_base_url="http://127.0.0.1:8041"'
```

Keep the built-in OpenAI provider and existing ChatGPT login. The upstream above deliberately ends in `/backend-api`, so a Codex request to `/codex/responses` forwards to `/backend-api/codex/responses`. Do not add `/codex` to both the upstream and the incoming path. This command does not edit your configuration. Launch Codex normally to stop routing through the proxy.

The [official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `chatgpt_base_url`; behavior varies with CLI version and managed policy. The exact routing command still needs validation against the installed CLI in your environment. A successful run should create a `/codex/responses` card before completion. If your version sends `/responses` instead, restart the proxy with `--upstream https://chatgpt.com/backend-api/codex`. A 404 card exposes the actual incoming path. This captures routed HTTP traffic only; other Codex network destinations and local tool execution are outside its visibility. WebSocket forwarding is not supported; clients must use HTTP streaming.

For the original Anthropic route:

```bash
python3 proxy.py --port 8041 --dashboard-port 8042
```

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8041 claude
```

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

During this implementation: four offline tests passed; three socket integration tests skipped because the execution sandbox prohibits socket creation. Python compilation and whitespace checks passed. There is no installed browser or JavaScript runtime here, so browser interaction and the complete real-Codex round trip were not executed.

## Remaining validation and limitations

Run the socket tests on WSL, then validate real Codex traffic: submit a prompt that requests a local tool, inspect its later result, refresh mid-stream, disconnect/reconnect the browser feed, and inspect an older expanded item as overlapping traffic arrives. Browser scroll/focus restoration, live tool rendering, and real authentication routing remain unverified acceptance criteria.

There is no reliable history/new-item boundary in many payloads; the dashboard explicitly labels the combined section instead of guessing. Cross-request tool reconciliation requires an explicit `session_id` / conversation header or conversation field. Without one, calls remain scoped to the capture and cannot be safely reconciled across requests. Unknown protocols remain available in full capture but may lack a rich interpretation. In particular, Chat Completions delta tool calls are not incrementally interpreted, and compressed upstream bodies are retained but not decompressed for interpretation (Accept-Encoding is stripped on forwarding).

Full snapshots and body reserialization favor a simple, gap-free first build over scale. History never evicts and can exhaust memory; large captures can cause UI delays. Reading position restoration is best effort during layout changes and needs browser verification. Requests use Content-Length as in the original proxy; chunked uploads and WebSocket upgrades are unsupported. A timeout is reported after 600 seconds without upstream data. SSE EOF without a recognized completion marker is reported as interrupted, even if an unfamiliar protocol considers EOF normal.

Optional search, filters, statistics, export, disk persistence, and remote access are not implemented. SPEC.md is unchanged.
