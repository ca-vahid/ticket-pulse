# Realtime Support Playbook

**Audience:** Ticket Pulse admins/support triaging "my dashboard isn't updating" / "stuck Connecting" / "it says Offline" reports.
**Since:** v3.4.01-preview (transport ladder) + v3.4.05-preview (hardening & observability). Background research: `docs/research/REALTIME_RELIABILITY_NOTES.md`; design: `plans/REALTIME_RELIABILITY_PLAN.md`.

---

## 1. How realtime works now (30-second version)

Every tab keeps ONE shared realtime connection and walks a transport ladder:

```
Live stream (SSE, fetch + Authorization header)
  └─ 3 failures in ~90s → Long-poll (25s holds)
       └─ 3 failures → Short-poll (every ~30s, jittered)
            └─ 3 failures → Offline (manual Reconnect / network-restore)
```

Degrades are **sticky** (remembered per tab session) with background re-probes at 1/5/15 min that promote back to the live stream when it works again. All transports share one event cursor, so hopping between them never loses or duplicates events.

## 2. Reading the status pill

Top-right of the header:

| Pill | Meaning | Is the user broken? |
|---|---|---|
| **Live** (green) | SSE stream healthy | No |
| **Syncing** (blue, spinner) | A backend sync is running right now | No |
| **Auto-refresh** (amber) | SSE is blocked on this network; data arrives via polling | No — data still updates (seconds of extra latency). This is the expected state behind SSL-inspecting proxies. |
| **Connecting** (amber pulse) | Ladder mid-attempt | Only if it persists >2 min |
| **Offline** (red) | All transports failed, or a terminal condition | Yes — clicking the pill IS the Reconnect button |

**Auto-refresh is not a bug.** It is the designed fallback for Zscaler-class networks. Only escalate to the proxy-bypass request (§5) if the user wants sub-second updates or Auto-refresh is also failing.

## 3. The diagnostics popover (one screenshot = triage)

Click the pill (when not Offline) to open the status popover. Ask the user for a screenshot of it — it contains everything the first reply needs:

| Row | What it tells you |
|---|---|
| **Realtime feed** | Live / Auto-refresh / Disconnected + Reconnect button |
| **Data refreshed** | When data ACTUALLY last changed on screen (honest stamp, all fetch paths) |
| **Transport** | `Live stream (SSE)` / `Long-poll fallback` / `Periodic refresh (30s)` |
| **Last event** | Age of the last server event. On Live, >90s means the watchdog is about to trip — healthy streams show <30s (heartbeats). |
| **Reconnects** | Connection-attempt churn this tab session. 1–3 is normal; dozens = flapping network/proxy (candidate for §5). |
| **Channel** | The workspace channel the stream is on. Must match the workspace the user is looking at — a mismatch is the old "zombie" class and self-heals with a forced reconnect. |
| *(red note)* "Too many Ticket Pulse tabs…" | The server enforces a per-user cap of 8 concurrent streams and closed this (oldest) tab's stream in favor of a newer one. Not an outage — close unused tabs, click Reconnect. |

### What each state means mechanically

- **Eternal "Connecting" is designed OUT**: the client requires a first server event within 5s and walks the ladder otherwise. If a user still reports it, get the popover screenshot + browser console and check they're on ≥ v3.4.01 (hard refresh / Ctrl-F5 first).
- **Live but frozen data**: check Channel row vs current workspace, and Last event age. Should self-heal ≤90s (watchdog). Persisting = collect §6 and escalate.
- **Offline (red)**: click the pill to reconnect. If it bounces straight back to Offline: check the popover reason note (tab cap?), then whether `/api/sync/health` and the API host are reachable at all (full outage vs realtime-only).

## 4. Server-side hardening (what the backend does on its own — v3.4.05)

- **Per-user cap (8 streams)**: opening a 9th closes the user's oldest with a `too_many_connections` event (that tab shows the explanation above; it does NOT auto-reconnect).
- **Idle reaping**: sockets with no successful write for ~2 minutes (≈4 heartbeats) are destroyed server-side — half-dead pipes can't accumulate.
- **Periodic re-auth (~15 min)**: streams whose session/token has since expired or been logged out get a `reauth` event and are closed; the client refreshes its token and reconnects automatically. Users should never notice.

## 5. Corporate proxy / SSL-inspection bypass request (Zscaler-class)

Full-stream SSL inspection buffers `text/event-stream` bodies indefinitely; **no client- or server-side trick defeats it** (verified in the research notes — LibreChat's identical issue only resolved via a proxy-side bypass). Auto-refresh keeps such users working; the bypass restores true realtime.

Template for the user's IT/network team:

> **Subject: SSL-inspection / streaming bypass request for Ticket Pulse**
>
> Our IT operations dashboard (Ticket Pulse) uses Server-Sent Events (long-lived `text/event-stream` HTTP responses). SSL inspection buffers these streams, breaking live updates for users on this network — the app currently works only in its degraded polling mode.
>
> Please add an SSL-inspection bypass / streaming exemption (Zscaler: SSL Inspection policy → "Do Not Inspect"; equivalent for Netskope/Palo Alto) for these hosts:
>
> - `ticketpulse.bgcsaas.com`
> - `api.ticketpulse.bgcsaas.com`
> - `ticket-pulse-app.azurewebsites.net`
>
> No other change is needed — standard HTTPS on 443. This is the vendor-documented resolution for SSE behind inspecting proxies.

(The API's primary host is `api.ticketpulse.bgcsaas.com` since Phase A2 — the
`azurewebsites.net` host remains valid indefinitely for webhooks and existing
API callers.)

## 6. What to collect in a support ticket

1. Screenshot of the **diagnostics popover** (§3) — pill state, transport, last event age, reconnects, channel.
2. **App version** (hard-refresh first) and browser.
3. Network context: office/VPN/home; corporate proxy or endpoint-security product if known (Zscaler, Netskope, "web protection" AV).
4. Browser console + Network tab: any red `/api/sse/events` or `/api/sse/poll` entries (status codes matter — 401/403 vs stalled/`(pending)`).
5. Does a hard refresh fix it? Does another network (phone hotspot) fix it? (Yes to hotspot ⇒ §5.)

## 7. Admin-side checks

- **`GET /api/sync/health`** (admin; or Settings → Notifications → **Sync freshness** card): per-workspace last completed sync vs its schedule — `ok` / `late` (>2× interval) / `stale` (>3× interval, 15-min floor). Stale ⇒ dashboards look alive on old data: check app logs, try "Sync now", consider a service restart. Admins also get a stale banner in-app plus ONE alert email per incident (re-armed when the workspace recovers; kill switch `SYNC_HEALTH_ALERTS=false`).
- **Settings → Notifications → Realtime health** card: today's sampled telemetry — downgrades to polling, offline transitions, dead-end offline (always reported), and the most-affected sessions (truncated emails). A recurring name = that person's network needs §5; a broad spike = suspect our side (deploy, App Service, proxy config).
- **`GET /api/sse/status`**: live connection count + server epoch (epoch changes on backend restart — clients resync automatically).
- Realtime telemetry is in-memory (today + yesterday) and resets on backend restart — it's a signal, not an audit log.

## 8. Rollback levers

- `VITE_REALTIME_TRANSPORT=eventsource` (frontend build env): restores the pre-ladder native-EventSource hook.
- `SYNC_HEALTH_ALERTS=false` (backend env): disables stale-sync alert emails (endpoint + banner keep working).
