# Week 4 — Live Agent Traffic Dashboard

## Purpose and scope

Build a browser dashboard during the lab to inspect live traffic between the coding agent's harness and the model through the provided `proxy.py`. The environment is Ubuntu in WSL, using Codex with a ChatGPT login. This preparation task produces only this specification; dashboard implementation, dependencies, routing configuration, and proxy changes belong to the lab.

## Existing proxy: verified baseline

`proxy.py` is a standard-library threaded reverse proxy bound to `127.0.0.1` (port 8041 by default). It handles GET, POST, and HEAD. It reads request bodies using Content-Length, prints request metadata and bodies (pretty-printing valid JSON), and forwards the method, path, and body to the configured upstream. The upstream base path is prepended to the incoming path. It filters hop-specific headers, Content-Length, and Accept-Encoding; the HTTP client supplies necessary transport headers. Authorization and x-api-key values are abbreviated in terminal output, but forwarded credentials are retained.

Replies preserve upstream status and eligible headers. Response body chunks are immediately forwarded and flushed to the harness and decoded for terminal display. HEAD has no forwarded body. Connections to clients close after the reply. Initial upstream connection failures produce a logged error and HTTP 502; later stream failures have no comprehensive structured error handling. Concurrent terminal output can interleave.

The default upstream and startup hint target Anthropic/Claude. A Codex upstream override is supported (`https://chatgpt.com/backend-api/codex`). Basic Codex routing through the proxy with a ChatGPT login has already been validated in this environment: Codex read `sample.txt` using `cat`, and the tool call and matching `custom_tool_call_output` were identified in the proxy log. This validates the basic connection and visibility of call/result traffic. The browser dashboard and live browser updates still require implementation and validation during the lab. The proxy only sees traffic actually routed through it, not local tool execution itself.

The proxy currently has no browser UI, browser SSE endpoint, structured capture store, stable request IDs, model-event parser, tool matching, replay, or search. These are future lab work. Its streamed upstream response is separate from the planned server-to-browser SSE feed. Bodies are relayed without intentional rewriting; transport headers are not forwarded unchanged. Terminal-decoded chunks are not a lossless substitute for structured capture.

## Mandatory requirements

1. Show every captured request and its reply live in a grouped card, ordered by request arrival with newest requests first. Concurrent requests must remain correctly associated. Update the existing card as its reply arrives; do not create a new card for each chunk.
2. Clearly label request identity, arrival time, method/path, response status, and lifecycle: awaiting reply, streaming, completed, or failed. A failed or interrupted request must remain inspectable.
3. Separate request sections for instructions, tool definitions, conversation history, and new messages/items. Show all captured system/developer instructions, including developer messages within `input`, not only a top-level `instructions` field. Tool definitions describe available tools and must look distinct from actual tool invocations.
4. Show the model's reply text and requested tool calls as the response streams. Retain the complete captured response for inspection, including events or fields that cannot yet be interpreted.
5. Display each tool call beside its matching result, including results first seen in a later request. Support `custom_tool_call` and `custom_tool_call_output` linked by `call_id`, as well as other call/result formats present in captured traffic. Preserve tool names, arguments or custom input, and full result content.
6. Results may contain several content blocks, nested JSON, and plain text. Preserve block order and original content. Pretty-print valid JSON without replacing the original captured value. Unknown item types must remain visible and inspectable.
7. Every message/item must open to its full captured content. Long text is collapsible; JSON is readable; request sections have clear boundaries. Full request and response inspection must remain available alongside interpreted views. Never silently truncate content.
8. User prompts, model replies, tool calls, tool results, instructions, and definitions must be distinguishable through labels and visual treatment, not color alone.
9. Keep the conversation understandable as traffic accumulates. Repeated historical appearances of a call/result are not new executions. Keep them visible in each request's full history but identify them as repeated appearances and link them to the corresponding logical call/result. Do not infer tool execution time from capture time.
10. Preserve the user's reading position when new cards or streamed content arrive. Provide a visible new-traffic indication and an action to return to the newest traffic. Within each card, preserve conversation/item order.
11. Explain upstream HTTP errors, connection failures, interrupted responses, malformed/unknown payloads, and browser live-feed disconnections in plain language. Distinguish upstream failures from dashboard-feed failures. Show available diagnostic details without hiding the captured messages.
12. Retain captured history in server memory for the running session. Browser refreshes must recover existing cards and resume live updates without gaps or duplicate cards. Server restart begins an empty session; disk persistence is not required. Do not silently evict history within a session.
13. When an upstream response lacks Content-Type but contains clearly identifiable SSE framing, recognize and interpret its events incrementally for display, including readable model text and tool-call items. Do not classify ordinary JSON or plain text as SSE merely because Content-Type is absent. Preserve original captured headers and response bytes exactly; display-only inference must not add or rewrite headers, alter bytes, or change forwarding behavior.

## Next iteration: evidence and workflow

The first from-scratch home build is saved in commit `936f877`. After that build, the workflow switched to editing the existing code to fix the specific observed parsing defect while preserving the already tested forwarding behavior. This specification update defines that next iteration; it does not implement the fix.

All seven local tests passed outside the agent sandbox, and a real Codex file-reading request succeeded through the proxy. Separately, the manual live-capture diagnostic found that capture #5 was `POST /responses`, completed with HTTP 200, and had no Content-Type response header. Its captured body contained SSE framing beginning with `event: response.created` and a JSON `data:` line, but the capture contained zero parsed events and the dashboard displayed no interpreted model reply. This parsing finding comes from the manual live-capture diagnostic, not from the passing automated tests.

The new acceptance checks below for missing Content-Type and SSE regression coverage have not passed yet and remain pending validation.

## Agreed design choices and reasons

| Choice | Reason |
| --- | --- |
| Grouped request/reply cards, newest first | Makes live activity visible while keeping each exchange together. |
| SSE from server to browser | Fits one-way live delivery of captures and lifecycle updates. This is distinct from parsing upstream model streaming events. |
| Server-memory session history | Keeps refreshes useful without requiring a database or disk persistence. |
| Stable reading position plus return-to-newest control | Allows inspection of older messages while traffic continues. |
| Search and tool/message-type filters after mandatory features | Helps navigate growing traffic without replacing the primary message view. |
| English dashboard interface; captured message content retains its original language; code and JSON render left-to-right | English aligns interface labels with protocol terminology and avoids the additional scope of a language switch. Preserving original message language keeps inspection faithful, while explicit left-to-right code/JSON maintains readability. |

## Implementation expectations for the lab

- Assign a stable capture ID before forwarding each request. Associate all response chunks, status updates, and errors with that ID rather than relying on timestamps or terminal output order.
- Capture structured data on the forwarding path without waiting for the entire reply before forwarding it to Codex. Parse streaming events incrementally across arbitrary network chunk boundaries; chunks can split UTF-8 characters or JSON events.
- Continue recognizing SSE through the correct Content-Type. When Content-Type is missing, use clearly identifiable SSE framing (event fields and JSON data lines separated into SSE records) as display-only evidence, retaining parsing state across arbitrary chunks, including split field names, lines, record delimiters, UTF-8 characters, and JSON data. Keep ordinary JSON and plain text available through their existing inspection paths without false SSE classification. Preserve original captured headers and response bytes exactly, and keep this inference independent of forwarding.
- Use session identity and ordered update IDs (or an equivalent consistent snapshot/resume mechanism) for initial history, refresh, and SSE reconnection. A browser subscribing during active traffic must neither miss captures nor duplicate them.
- Match tool calls/results using protocol identifiers within the appropriate conversation/session scope. Do not merge unrelated calls merely because their names or arguments match. Show unmatched results, pending calls, and ambiguous matches explicitly; reconcile them when sufficient evidence arrives. A received tool call is a model request for execution, not proof that the harness executed it.
- Separate captured occurrences from logical tool calls. Later history may supply a previously unseen result while repeating an old call. Update the logical pair while preserving each request's captured history.
- Preserve raw structure when normalization is uncertain. If traffic does not explicitly identify a boundary between historical and newly added input, label that limitation rather than guessing silently. The first capture may already contain history.
- Keep the dashboard local to the WSL machine. Captured prompts and tool results can be sensitive. Full message-body inspection is required; displaying authentication secrets is not. Do not expose credentials in the UI or introduce external analytics or persistence.
- Build on the already validated Codex round trip with ChatGPT login; during the lab, validate the complete browser capture and live-update flow against real traffic. Capture is limited to data actually sent through this proxy; hidden model internals and uncaptured local activity cannot be displayed.

## Acceptance criteria

1. With Codex routed through the proxy, submitting a prompt creates a request card before its reply completes. Reply text updates live and the complete reply remains inspectable. Two overlapping requests receive their own correctly associated replies.
2. A captured input containing system/developer messages, tool definitions, history, and new items exposes all captured content in clearly labeled sections. Developer instructions inside `input` are visible even when top-level `instructions` is absent. Definitions are not counted or styled as executed calls.
3. A model `custom_tool_call` and a later request's `custom_tool_call_output` sharing a valid scoped `call_id` appear beside one another. Multiple result blocks and nested JSON are inspectable in full. An unmatched result remains visible and clearly labeled.
4. Replaying that same call/result in subsequent request histories does not create a new logical execution. Each request still exposes its full original history. Distinct call IDs with identical tool names/arguments remain distinct.
5. Every message opens fully; long content collapses and expands; structured JSON is readable; unfamiliar fields and item types can be inspected without loss. Message categories are identifiable without relying on color.
6. While reading an older expanded message, arrival of new requests and stream updates does not displace the reader. The new-traffic control returns to the newest card.
7. Refresh during streaming restores earlier captures and continues the active reply. A temporary SSE interruption is visible and reconnecting recovers missed updates without duplicate cards. Restarting the server clearly starts a new empty session.
8. An upstream HTTP error, initial connection failure, and interrupted stream each produce an understandable state and retain available captured content. Invalid payload parsing does not make the whole request disappear or prevent raw inspection.
9. The harness continues receiving streamed responses as they arrive. Dashboard parsing or browser disconnection does not require buffering the entire upstream response or corrupt the forwarded payload.
10. No statistics panel, if added, displaces or substitutes for the mandatory request/message views.
11. Dashboard labels, controls, and explanatory states use English. Messages retain their original language, including non-English text; code and JSON render left-to-right, including within messages containing right-to-left text.
12. Pending new check: an SSE response without Content-Type, with framing matching the manual capture #5 finding (`event: response.created` followed by a JSON `data:` line), split across arbitrary network chunks (including within framing, UTF-8 characters, and JSON data), produces parsed events incrementally and readable model text/tool-call items as subsequent events arrive. Original captured headers and response bytes remain exact, and forwarded headers and bytes are unchanged by display inference.
13. Pending new check: ordinary JSON and plain text responses without Content-Type are not incorrectly treated as SSE and remain fully inspectable.
14. Pending new check: existing SSE responses with the correct Content-Type continue producing incremental parsed events and readable model text/tool-call items, preserving forwarding behavior.

## Optional enhancements

After mandatory acceptance criteria pass, prioritize search and filtering by tool or message type. Possible later additions include timing/token statistics when actually present in traffic, request counts, and richer navigation. Statistics must label unavailable or estimated values and distinguish logical calls from repeated historical appearances. Persistence, export, remote access, and authentication for remote access are outside the agreed lab scope.

## Decision status

No important product decisions remain unresolved for specification review. Framework and internal module layout may be chosen during the lab provided they satisfy this specification.

## Review status and assumptions

Ready for next-iteration review. The first home build and validation evidence are recorded above; the manual live-capture diagnostic identified the missing-Content-Type SSE parsing defect. The new acceptance checks remain pending and must not be reported as passing on the strength of the seven previously passing local tests. Other dashboard acceptance criteria still require their own validation. Protocol details beyond the observed Codex shapes must be verified against real captured traffic during implementation. A running server retains its session in available memory; production-scale retention and multi-user operation are outside scope.
