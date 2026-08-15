# Realtime Reliability Notes — SSE behind corporate proxies + Azure

**Researched: 2026-08-11.** Online research for Ticket Pulse's realtime layer (React SPA on Azure Static Web Apps + Node/Express on Azure App Service; native `EventSource` with `?token` auth, 30s server heartbeats, 90s client watchdog, exponential reconnect). Failing users sit behind corporate proxies with SSL inspection (Zscaler-class).

Claims are marked **[verified]** (vendor docs / spec / reproducible issue threads) or **[unverified]** (anecdotal, thin sourcing, or synthesized from practice). Accuracy over volume — where the evidence is thin, it says so.

---

## 1. Failure-mode table

| # | Failure mode | Mechanism | Our symptom match | Evidence |
|---|---|---|---|---|
| F1 | **SSL-inspecting proxy buffers the stream** (Zscaler, Netskope, Palo Alto, AV "web protection") | Proxy terminates TLS, scans response bodies before forwarding. A never-ending `text/event-stream` body is held in the scan buffer; headers may or may not be forwarded promptly. Client sees connection "open" (or stuck connecting) but frames arrive late, in one burst, or never. | **(a) eternal "connecting"** — if the proxy withholds even the response headers/first bytes, `EventSource` never fires `open` and `readyState` stays 0 forever (no error → no retry). | [verified] LibreChat #12037 (Nov 2025, Zscaler): stream never renders incrementally; works with Zscaler bypassed; no header/padding trick fixed it — only an SSL-inspection bypass rule on the proxy side. |
| F2 | **Threshold buffering** (some middleboxes/AV flush only after N KB or on connection close) | Older AV/proxy stacks buffer the first ~1–4 KB before streaming through. | Events delayed at connection start; short-lived streams appear empty. | [unverified] Widely reported in practice (the classic "2 KB padding preamble" trick); no current vendor doc found naming a threshold. Treat as legacy behavior that a preamble *may* unblock — it does **not** fix full-stream inspectors (F1). |
| F3 | **Intermediary compression buffering** | gzip/brotli applied by server middleware, CDN, or proxy buffers output until a compression block fills. Express `compression()` buffers SSE unless `res.flush()` is called per event. | Heartbeats "sent" server-side but never delivered → both symptoms. | [verified] Standard SSE guidance (multiple 2025–26 guides); Express compression docs. Fix: never compress `text/event-stream`. |
| F4 | **Idle-timeout drop without client-visible error** ("zombie") | A NAT/proxy/LB silently discards the TCP mapping. Neither end gets a FIN/RST; client socket looks open, server keeps writing into a dead pipe (or vice versa). | **(b) zombie "connected"** — heartbeats stop for hours until reload. | [verified] Documented for long-lived connections generally (websocket.org reconnection guide, OneUptime 2026 heartbeat guide): "long-lived connections can appear alive to both sides while being silently broken in the middle." |
| F5 | **Laptop sleep / network switch** | OS suspends TCP; on wake the socket is dead but no JS event fires reliably. Firefox/Safari may delay `visibilitychange` until user interaction. | Zombie after lunch/overnight; also stale auth token on reconnect. | [verified] Multiple 2025 writeups; grpc-web #1312; reconnecting-websocket #67. |
| F6 | **Legacy proxy short-timeout drop** | Some proxies drop idle HTTP connections after tens of seconds. | Frequent reconnect loops. | [verified] WHATWG HTML spec explicitly warns of this and recommends a comment line every ~15 s. |
| F7 | **Chunk-boundary re-chunking** | An intermediary unaware of SSE timing re-chunks the body (HTTP/1.1 `Transfer-Encoding: chunked`), delaying frame delivery. | Bursty/late events. | [verified] WHATWG spec: "HTTP chunking can have unexpected negative effects on the reliability of this protocol… authors can disable chunking" (not practical for infinite streams; padding + frequent writes mitigates). |
| F8 | **SWA linked-backend proxy buffers streaming** | Azure Static Web Apps' reverse proxy for linked backends delivers streamed responses **as a single payload**. | If any user's SSE path goes through the SWA domain instead of direct to App Service → eternal connecting for those users, on any network. | [verified] Azure/static-web-apps#1180, open since May 2023, still unresolved; workaround = call the App Service host directly. **Check our config**: SSE must target `ticket-pulse-app.azurewebsites.net` (it does per our deploy notes — but verify no user path falls back to `/api` on the SWA domain). |
| F9 | **Azure 230 s no-data timeout** | Azure's front end (load balancer) kills any request that goes ~230 s without response bytes. Not configurable. | Would cause 4-minute drops — our 30 s heartbeat defeats this **as long as heartbeats actually reach the wire** (see F3). | [verified] Microsoft Q&A + Learn troubleshooting docs (current through 2025-26). |
| F10 | **HTTP/2 vs 1.1 differences** | SSE itself works on both (h2 uses DATA frames, no chunked encoding). But SSL-inspecting proxies typically speak HTTP/1.1 on the client leg even when the origin leg is h2 — so chunked-encoding pathologies (F7) and h1's ~6-connections-per-origin `EventSource` limit reappear behind inspection. | Multi-tab users behind proxies can exhaust the per-origin connection budget → some tabs stuck connecting. | [verified] for the protocol mechanics; [unverified] for "inspectors downgrade to h1.1" as a universal rule (true of common deployments, not documented per-vendor). |
| F11 | **Token in query string** (`?token=`) | Not a delivery failure per se, but: URLs are logged by proxies, and some inspection layers treat long-lived parameterized GETs as suspicious; also leaks tokens into proxy logs. | Possible policy-based blocking for some tenants; security smell regardless. | [unverified] as a blocking cause; [verified] as a logging/security concern. Moving auth to a header (needs fetch-based client) removes it. |

**Reading our two symptoms against this table:** (a) *eternal connecting* = F1 (headers/first-bytes withheld by inspector) or F8 (SWA-path buffering) or F10 (h1 connection limit, multi-tab); (b) *zombie connected* = F4/F5 — and the fact it lasts **hours** means our 90 s client watchdog is not actually firing, which points at a watchdog timer that gets throttled/suspended in background tabs (browsers clamp background `setTimeout`/`setInterval` to ≥1 min, and suspend them entirely during sleep) — the watchdog must be re-armed from `visibilitychange`/wake detection, not just a free-running interval. **[verified** that browsers throttle background timers; the specific diagnosis of our watchdog is inference to test.**]**

---

## 2. Server-side SSE hygiene — what actually works, and its limits

Do all of these (cheap, verified), but understand none of them defeats a full-stream SSL inspector (F1):

- `Content-Type: text/event-stream; charset=utf-8` — UTF-8 is mandatory per spec; anything else aborts the connection. **[verified]**
- `Cache-Control: no-cache, no-transform` — `no-transform` tells (compliant) intermediaries not to buffer/transform. `X-Accel-Buffering: no` costs nothing and unbuffers nginx-family hops (harmless elsewhere). **[verified for nginx; advisory-only for corporate proxies]**
- **Never compress the stream.** Skip `compression()` for the SSE route (or `res.flush()` every write, but exclusion is safer). Some report sending explicit `Content-Encoding: identity`; note LibreChat saw a proxy mishandle even that header — keep the response header set minimal. **[verified]**
- **Comment-line heartbeat every 15–30 s** (`:hb\n\n`). The WHATWG spec itself recommends ~15 s for legacy proxies; 25–30 s is fine for Azure (F9 budget is 230 s) and stays under Front Door's 90 s client keep-alive if AFD is ever in the path. Heartbeats must be real bytes on the wire — verify with `curl -N` through the prod host. **[verified]**
- **2 KB padding preamble** (a `:` comment of ~2 KB whitespace sent immediately on connect): legacy trick for threshold-buffering middleboxes (F2). Cheap insurance, may unblock some AV stacks, **will not** fix Zscaler-class inspection. **[unverified — anecdotal lineage, no current vendor doc]**
- **Flush per event** and keep events small; line-buffered writes (`\n\n` terminated) per spec. **[verified]**
- **Retry hint**: send `retry: 5000` (ms) so native clients don't hammer at the 3 s default. **[verified — spec]**
- **The only real fix for F1 is on the customer's proxy**: an SSL-inspection bypass / streaming exemption for our domain. Zscaler & peers support bypass lists; LibreChat's issue resolved only that way. **Ship a diagnostics surface** (see §5) so support can tell a customer's IT "add `ticketpulse.bgcsaas.com` + `ticket-pulse-app.azurewebsites.net` to the SSL-inspection bypass," and fall back to polling meanwhile. **[verified]**

---

## 3. Fetch-based SSE clients (vs native EventSource)

**Real advantages** — all client-side control, none of them changes how a middlebox treats the bytes:

1. `Authorization` header instead of `?token=` (kills F11; plays nicer with token refresh).
2. **`onopen` validation + first-byte/first-event timeout**: you can `AbortController.abort()` a connect attempt that got headers but no bytes — this is the primitive that converts "eternal connecting" into a detectable failure you can fall back from. Native `EventSource` gives you no timeout control and retries opaquely.
3. Full **retry control** (your own backoff, jitter, failure budget) and **error visibility** (status codes — native EventSource can't even tell you it got a 401).
4. POST bodies (not needed for us), custom headers, and works in environments without EventSource.
5. Page Visibility integration (auto-close when hidden, resume with `Last-Event-ID` when visible) — though see the bug below.

**Behavior through inspecting proxies: identical.** It's the same HTTP GET streaming response; a proxy that buffers `text/event-stream` buffers it for fetch too. The win is *detection and control*, not delivery. **[verified reasoning; no source claims fetch streams pass inspectors better]**

**Maturity status (as of 2026-08):**
- `@microsoft/fetch-event-source` — npm latest 2.0.1, published ~5 years ago; **effectively unmaintained**. Repo now lives under the Azure org (`Azure/fetch-event-source`, ~2.9k stars, 51 open issues). Known bug: visibility-based retry keeps hitting the server in error scenarios while hidden (Azure/fetch-event-source#17). **[verified]**
- Maintained forks exist: `@sentool/fetch-event-source` (refactor, browser+Node, active ~Oct 2024), `fetch-event-source-sse` (straight copy). **[verified they exist; depth of maintenance unverified]**
- **Recommendation:** the library is ~500 lines; given our needs (custom state machine, watchdog, fallback ladder) a **hand-rolled fetch + ReadableStream + TextDecoder parser** (or vendored fork) is the 2026-typical choice — every major LLM-chat frontend does exactly this. Avoid taking an unmaintained dep for logic we'll override anyway.

---

## 4. Recommended architecture

### 4.1 Transport ladder

```
L0  SSE (fetch-based, Authorization header, HTTP/2 where available)
L1  Long-poll  (GET /api/events/poll?cursor=...  — server holds ≤25 s, returns on event or timeout)
L2  Short-poll (GET /api/events/delta?cursor=... every 30–60 s, jittered)
L3  Offline    (navigator.onLine false or all transports failing; banner + manual retry)
```

Industry pattern **[verified]**: socket.io is websocket-first with polling fallback (and has known cases where handshake failure does *not* auto-fall-back — socketio#2751 — i.e., optimistic-first needs explicit failure budgets). **Ably deliberately inverts it: connect on Comet/long-poll first because "there are environments in which websockets are subtly broken (such as some corporate proxies)", then upgrade to the fancy transport at leisure.** That upgrade-from-working-baseline philosophy is the right one for our population; the SSE analog is: it's fine to try SSE first, but the fallback must be automatic, fast, and sticky.

**Detection heuristics (synthesized from the above patterns — tune in prod):**
- **Time-to-first-frame budget:** after fetch resolves headers, require the server's immediate `event: hello` (send one on every connect, carrying a session/state epoch) within **5 s**, else abort → counts as a failure. This is the direct catch for symptom (a).
- **Connect budget:** headers themselves within ~10 s.
- **Failure budget:** 3 consecutive SSE failures (connect, first-frame, or watchdog-triggered) within a rolling ~90 s → drop to L1/L2 ("degraded").
- **Sticky degrade + background re-probe:** while degraded, keep polling as the source of truth and re-try one SSE probe at 1 min, then 5 min, then every 15 min (jittered). Only promote back after a probe stays healthy (hello + 2 heartbeats). Remember last-known-good transport in `sessionStorage` so a Zscaler user's next page load starts on polling instantly instead of re-suffering the 3-failure dance.
- **Zombie trip (below) counts as a failure** toward the budget, so a network where SSE opens but starves also lands on polling.

### 4.2 Client state machine

```
            connect ok + hello
CONNECTING ────────────────────► CONNECTED (live)
   │  ▲                              │
   │  │ backoff retry                │ watchdog trip / error
   │  └───────────── RECONNECTING ◄──┘
   │ failure budget hit                │ failure budget hit
   ▼                                   ▼
DEGRADED-POLLING ◄─────────────────────┘
   │        ▲ SSE re-probe succeeds → CONNECTING
   │ polls also failing / offline event
   ▼
OFFLINE ── navigator.onLine / manual retry ──► CONNECTING
```

- **User-visible status:** one small indicator with three states — `Live` (SSE), `Auto-refresh` (polling; tooltip: "Live stream unavailable on this network — updating every 30 s"), `Offline`. Never show a spinner-forever "connecting" state to users: after the failure budget, you're either degraded or offline, both of which are honest and actionable. Expose transport + last-event-age in a diagnostics popover for support.
- All timers (backoff, watchdog, poll interval) must **re-evaluate on `visibilitychange` and wake detection**, not rely on background intervals firing on time (browsers throttle hidden-tab timers to ≥1 min and suspend during sleep). **[verified throttling behavior]**

### 4.3 Zombie detection & heartbeat design

- **Server:** heartbeat comment every **25–30 s** (also satisfies Azure F9 and legacy-proxy F6). Additionally send a real `event: hb` with an `id:` every ~30 s so the client's `Last-Event-ID` stays fresh even in quiet periods.
- **Client watchdog:** trip at **2.5–3× the heartbeat interval** (75–90 s of silence) — standard ratio in heartbeat guides **[verified pattern]**. On trip: hard-abort the fetch, transition to RECONNECTING, count a failure. Crucial fix for our hours-long zombies: implement the watchdog as a **deadline check** (`lastFrameAt` timestamp compared on every frame, on a foreground interval, *and* on `visibilitychange`/`focus`/`online`), not a naive `setTimeout` that a background tab never runs.
- **Sleep/resume detection** (no single API exists **[verified]**): combine
  1. `visibilitychange → visible` and `window focus`: check `Date.now() - lastFrameAt`; if > watchdog, reconnect immediately;
  2. a 10 s interval that compares expected vs actual elapsed wall time (fires-late-by->30 s ⇒ machine slept) — run it in a **Web Worker** if precision matters (workers are throttled less) **[verified technique]**;
  3. `online`/`offline` events — treat `online` as "probe now", never trust `navigator.onLine === true` as proof of connectivity.
  4. On any wake signal: **refresh the auth token before reconnecting** — reconnecting with an expired token burns retries and delays recovery **[verified guidance]**.

### 4.4 Resume semantics & full resync

- Native `Last-Event-ID` **[verified spec behavior]**: browser resends the last `id:` as a request header on auto-reconnect; fetch-based clients must send it manually. Server should hold a **replay ring buffer** (per workspace/channel, e.g. last 500 events or 5 minutes) keyed by monotonically increasing ids.
- **Resume decision on (re)connect:** if client's `Last-Event-ID` is inside the buffer → replay the gap, then continue. If it's older than the buffer, unknown, or the server restarted (embed a **server epoch** in ids or in the `hello` event) → server sends `event: resync` and the client performs a **full-state refetch** of the affected stores (dashboard counts, ticket lists) before applying new deltas.
- **Force full resync whenever silence exceeded the buffer window** — after sleep/zombie recovery, never assume continuity. For our dashboard (state-shaped, not feed-shaped), the simple rule from SSE practice applies **[verified pattern]**: *when in doubt, send/fetch current state; replay buffers are an optimization, not the correctness mechanism.*
- Polling and SSE should share **one cursor scheme** (see §6) so demotion/promotion between transports never loses or duplicates events.

---

## 5. Azure specifics (numbers current as of research date)

| Layer | Fact | Status |
|---|---|---|
| **App Service front end (ARR/LB)** | ~**230 s** max with *no response bytes*; **not configurable**. Any write (incl. `:hb`) resets it → 30 s heartbeats make streams effectively unlimited. | [verified — MS Learn/Q&A] |
| **App Service** | No hard duration cap on streaming responses beyond the no-data rule. `Always On` recommended for long-lived connections. Node on Linux: `WEBSITES_CONTAINER_IDLE_TIMEOUT` (default ~20 min) only matters with Always On off. | [verified for Always On advice; idle-timeout detail partially verified] |
| **WebSockets on App Service** | Supported (enable "Web sockets" toggle). Basic tier: 350 concurrent per instance; Standard+ Windows: no fixed WS cap (bounded by concurrent-request limits); Linux non-Free: ~50k/instance. **But**: WS is *not* more proxy-proof — corporate SSL-inspectors break WS upgrades at least as often as they buffer SSE (Ably's stated reason for long-poll-first). Moving to WS does not solve our failing-user problem; a polling fallback does. | [verified limits; verified Ably rationale] |
| **Azure Static Web Apps linked backend** | **Streams do not stream** — proxied responses arrive as one payload (Azure/static-web-apps#1180, open since May 2023, no fix). SSE via the SWA domain (`/api` on the custom domain) is therefore broken by design today. **Action: guarantee the SPA opens SSE directly against the App Service host** (`ticket-pulse-app.azurewebsites.net` or a dedicated api subdomain) with CORS, and audit for any code path that builds the SSE URL from `window.location.origin`. This alone could explain "eternal connecting" for users whose build/env made the SSE URL same-origin. | [verified] |
| **Front Door (if ever added)** | Origin response timeout configurable **16–240 s** (Std/Premium) — an idle SSE stream dies at that limit, so heartbeat < timeout; separate non-configurable **90 s** client keep-alive nuance reported. AFD is generally hostile to infinite streams; prefer keeping SSE off any AFD route. | [verified range; 90 s detail single-sourced] |
| **Application Gateway** | MS explicitly documents SSE support: set backend request timeout > max event gap. (Not in our stack; noted for completeness.) | [verified] |
| **SignalR Service** | Microsoft's managed answer (WS/SSE/long-poll negotiation done for you). Viable long-term option but adds a service dependency + cost; our transport ladder replicates the part we need. | [verified existence; no cost analysis done] |

---

## 6. Polling fallback design (L1/L2)

- **One delta endpoint** shared by both poll modes: `GET /api/events/delta?cursor=<lastEventId>` returns `{events: [...], cursor, resync?: true}`. Cursor = the same monotonic event id used for SSE `id:`/`Last-Event-ID`, backed by the same ring buffer; `resync: true` when the cursor fell out of the buffer → client does full refetch. This keeps transports interchangeable mid-session.
- **Long-poll variant (L1):** server holds the request up to ~25 s waiting for an event (well under the 230 s Azure rule and typical 30–60 s proxy request timeouts), then returns empty. Gives near-realtime latency at ~2 req/min/client. Note: the same full-stream inspectors *usually* pass long-poll fine because each response completes and gets scanned as a unit — that's exactly why Ably's Comet-first works behind them. **[verified rationale]**
- **Short-poll variant (L2):** fixed interval **30 s foreground / 120 s+ hidden tab**, with **±20% jitter** (avoid synchronized stampedes after deploys/outages) and **burst-then-backoff**: after user activity or a delivered delta, poll at 10 s for ~1 min, then decay to baseline. Honor `Retry-After` on 429/503.
- **ETag/304:** support `If-None-Match` on the delta endpoint (ETag = latest cursor) so empty polls are 304s with zero body — cheap on both ends. **[standard HTTP; verified mechanism]**
- **Cost math (rough):** SSE ≈ 1 concurrent socket + 2 heartbeat writes/min/client. Short-poll @30 s ≈ 2 req/min/client — with 304s these are trivial (<1 KB); 200 users degraded ≈ ~7 req/s worst case, negligible for Express+PG. Long-poll ≈ same request rate but holds sockets like SSE. Conclusion: polling fallback at our scale is effectively free; there is no cost reason to leave failing users broken on SSE.
- Pause all polling when `document.hidden` for > few minutes except a slow keep-fresh tick; resume with an immediate poll on `visibilitychange → visible`.

---

## 7. Priority actions for our observed bugs

1. **Audit the SSE URL origin** (F8): must hit App Service directly, never the SWA proxy. Cheapest possible fix if any user path is same-origin.
2. **Replace native EventSource with a fetch-based client** (vendored/hand-rolled): Authorization header, `hello`-within-5 s first-frame timeout, real error visibility. Converts symptom (a) into a detected failure.
3. **Add the transport ladder + degraded-polling state** with sticky memory and a visible `Live / Auto-refresh / Offline` indicator. This is the only guaranteed fix for Zscaler-class networks short of customer IT adding a bypass.
4. **Fix the watchdog to be event-driven** (deadline checks on visibility/focus/online/wake + worker timer), refresh token before reconnect, and force full resync after any gap > buffer window. Fixes symptom (b).
5. **Server hygiene pass**: `no-transform`, `X-Accel-Buffering: no`, no compression on the SSE route, `retry:` hint, id-bearing heartbeats, replay ring buffer + `resync` event, server epoch in `hello`.
6. **Support playbook**: diagnostics popover (transport, last-event age, failure counts) + a doc snippet asking customer IT for an SSL-inspection bypass of our two hosts.

---

## Sources

- WHATWG HTML — Server-sent events spec (proxy keepalive ~15 s note, chunking warning, UTF-8, `Last-Event-ID`, `retry`): https://html.spec.whatwg.org/multipage/server-sent-events.html
- LibreChat × Zscaler SSE breakage (Nov 2025): https://github.com/danny-avila/LibreChat/issues/12037 and discussion #12038
- Azure SWA linked-backend streaming buffering (open May 2023): https://github.com/Azure/static-web-apps/issues/1180
- Azure App Service 230 s: https://learn.microsoft.com/en-us/answers/questions/1167766/azure-app-service-timing-out-in-230-seconds ; https://learn.microsoft.com/en-us/troubleshoot/azure/app-service/web-request-times-out-app-service
- Azure Front Door origin timeout 16–240 s: https://learn.microsoft.com/en-us/azure/frontdoor/how-to-configure-origin
- App Gateway SSE guidance: https://learn.microsoft.com/en-us/azure/application-gateway/use-server-sent-events
- App Service WS limits: https://github.com/MicrosoftDocs/azure-docs/blob/main/includes/azure-websites-limits.md ; https://techcommunity.microsoft.com/t5/apps-on-azure-blog/azure-app-service-limit-3-connection-limit-tcp-connection-snat/ba-p/3898841
- Ably long-poll-first rationale: https://faqs.ably.com/why-the-realtime-sdk-is-always-establishing-comet-connections-for-long-polling-rather-than-using-it-as-a-fallback-for-websockets
- socket.io transports/fallback: https://socket.io/docs/v3/how-it-works/ ; https://github.com/socketio/socket.io/issues/2751
- fetch-event-source repo + visibility-retry bug: https://github.com/Azure/fetch-event-source ; https://github.com/Azure/fetch-event-source/issues/17 ; npm @microsoft/fetch-event-source (2.0.1, ~5 y old)
- Sleep/wake detection techniques: https://medium.com/@erlan.zharkeev/how-to-detect-when-a-computer-wakes-up-from-sleep-my-experience-solving-the-problem-with-6639f79e5275 ; https://websocket.org/guides/reconnection/
- Heartbeat design: https://oneuptime.com/blog/post/2026-01-27-websocket-heartbeat/view ; nginx SSE buffering guides (oneuptime 2025-12-16)
