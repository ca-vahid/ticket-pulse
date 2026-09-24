# Microsoft Sentinel → Ticket Pulse: integration guide

**For:** BGC IT (Mehdi Abbaspour), building the Sentinel playbooks (Logic Apps).
**Answers:** "TicketPulse and Microsoft Sentinel Integration: Requirements for the TicketPulse Dev Team", revision 2, 23 Sep 2026.
**Ticket Pulse version:** 3.9.79 (24 Sep 2026). **Status:** built, provisioned and tested end to end in the sandbox. Ready for your playbooks.

---

## 1. In one page

- **Scope: infrastructure alerts only.** This integration is for availability and infrastructure alerts: servers, FTP, certificate expiry, up/down and similar. It is **not a security path.** BGC's security alerts already go through **Simorgh**, our cybersecurity application, which investigates each alert before it files a ticket. Sentinel's security detections stay with Simorgh. You choose which specific alerts your Logic Apps send us; everything else keeps its current route.
- **Everything you listed as Must is available**, and most of the Should items too.
- **One call per alert, and Ticket Pulse makes the decision.** Your document has the Logic App look the ticket up and then decide whether to create, add a note or reopen. We built that decision into Ticket Pulse instead. You send each alert once, to `POST /api/v1/alert-occurrences`, with its fingerprint. Ticket Pulse then, in one step and safely under concurrency:
  - creates the ticket;
  - or counts a repeat on the open ticket, with a note, and raises the priority if the alert is more severe;
  - or reopens a ticket resolved within your reopen window;
  - or, after that window, starts a new ticket linked to the old one.

  Retries and simultaneous calls can never create a duplicate. Section 4 shows the simplified playbook.
- **Many Sentinel incidents per ticket.** Every ticket keeps a list of Sentinel references (incident ID, number, alert ID, URL, time). You can find every ticket that came from one incident with a single call.
- **Occurrences are visible.** The ticket page shows "Alert fired 29 times · last 2 hours ago" with a link to each Sentinel incident.
- **Authentication:** OAuth 2.0 client credentials (your alternative 1). Entra managed-identity login is planned as a later step; see section 10.
- **Test and production** credentials are both issued. Secrets go into your Key Vault, never into this document.

## 2. Connection details

| | Sandbox (test) | Production (IT) |
|---|---|---|
| Base URL | `https://ticket-pulse-app.azurewebsites.net/api/v1` | same |
| Token endpoint | `POST /api/v1/oauth/token` with `grant_type=client_credentials`, `client_id`, `client_secret` (form body or HTTP Basic) → `{ access_token, expires_in }` (Bearer JWT) | same |
| Workspace | **Sentinel Sandbox** (workspace 9): test data only, no FreshService copy, no schedulers | **IT** (workspace 1) |
| Client ID | `tpc_2ae9211a9c17b5495e6ddcd6` | `tpc_21781711a511c5f7ef67eab9` |
| Client name | Microsoft Sentinel (monitoring) | same |
| Scopes | `tickets:*`, `conversations:*`, `customfields:*`, `tags:*`, `search:read`, `agents:read`, `groups:read`, `categories:read`, `types:read`, `contacts:read`, `webhooks:read` | same |
| Group for the tickets | `internalGroupId: 8305` ("Servers (sandbox)") | `groupId: 1000208184` (the "Servers" group) |
| Tag | `monitoring-alert` (id 18) | `monitoring-alert` (id 19) |
| Requester | `sentinel@bgcengineering.ca` ("Microsoft Sentinel"). It is unattended, so Ticket Pulse never e-mails it | same |
| Arrival channel shown in the queue | **Monitoring Alert** (source 106), set automatically | same |
| IP allowlist | none | **none yet.** Please send the Logic Apps outbound IP ranges for West US and we will lock the production client to them |
| API reference | `GET /api/v1/openapi.json` (OpenAPI 3) and `GET /api/v1/docs` | same |

**How the secrets reach you.** The two client secrets were generated once and are held by the Ticket Pulse team. Contact Vahid, and we'll add them to your Key Vault through the temporary write access you offered. Nothing goes by e-mail or Teams. Each secret can be rotated at any time from Ticket Pulse's Settings → API keys & webhooks, and the old one stops working immediately. There's no automatic expiry, so we suggest rotating yearly and after any staff change.

**The `sentinel` tag is not yours.** A tag with that name already exists, and Simorgh uses it for security tickets. Your tickets use `monitoring-alert` so the two stay apart.

## 3. The single call: `POST /api/v1/alert-occurrences`

```http
POST /api/v1/alert-occurrences
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: <Sentinel alert id>          (optional; the alert id in `reference` already makes retries safe)

{
  "fingerprint": "sentinel:9f2c7d0b5a1e4c3f8e6d2b9a7c5e3f1d0b8a6c4e2f0d9b7a5c3e1f0d8b6a4e41a",
  "fingerprintDisplay": "ftp-service-down|host:bgc-van-ftp01",
  "title": "[Sentinel] FTP service down: BGC-VAN-FTP01",
  "description": "<h3>Summary</h3><p>Severity: Medium | Source: Azure Monitor | First seen: 2026-09-24 10:14 PT</p> …",
  "severity": "Medium",
  "reopenWithinDays": 7,
  "requesterEmail": "sentinel@bgcengineering.ca",
  "category": "Cloud & Servers",
  "subcategory": "Network & Server Infrastructure",
  "groupId": 1000208184,
  "tags": ["monitoring-alert"],
  "customFields": { "detectionName": "FTP service down", "sourceProduct": "Azure Monitor", "primaryEntity": "BGC-VAN-FTP01" },
  "occurrenceNote": "<p>Service stopped at 10:12 PT; last successful transfer 10:05 PT.</p>",
  "reference": {
    "system": "sentinel",
    "incidentId": "5f3c1a2e-9b7d-4c1e-8a44-2d6f0b9e7c11",
    "incidentNumber": 48213,
    "alertId": "d1e2f3a4-5b6c-7d8e-9f0a-1b2c3d4e5f60",
    "url": "https://portal.azure.com/#asset/…",
    "time": "2026-09-24T17:14:00Z"
  }
}
```

**What Ticket Pulse does with the call:**

| Situation | `action` | HTTP | Effect |
|---|---|---|---|
| No ticket has this fingerprint | `created` | 201 | New ticket, occurrence count 1, reference stored |
| Open ticket with this fingerprint | `occurrence` | 200 | Count +1, last seen, private note "Repeat occurrence #N", reference added, priority **raised** if the alert is more severe (never lowered) |
| Ticket resolved or closed within `reopenWithinDays` | `reopened` | 200 | Status back to Open, count +1, note "Reopened — the alert fired again", reference added |
| Resolved or closed longer ago | `created` | 201 | A **new** ticket takes over the fingerprint, linked "related" to the old one (`previousTicket` in the response) |
| This alert id was already recorded | `duplicate` | 200 | Nothing written. This is what makes Logic App retries safe |

**The response:**

```json
{ "success": true,
  "action": "occurrence",
  "data": { "id": 46485, "ref": "TP-1650", "url": "https://ticketpulse.bgcsaas.com/tickets/46485",
            "status": "Open", "priority": 3, "occurrenceCount": 4, "lastOccurrenceAt": "…", "externalRef": "sentinel:9f2c…", … },
  "occurrence": { "count": 4, "lastSeenAt": "…" },
  "priorityRaised": true,
  "previousTicket": null }
```

**Field notes:**
- **`fingerprint`** (required, 8–200 characters) is the stable key of the problem. Send `sentinel:` followed by the SHA-256 hex digest. Ticket Pulse stores it as the ticket's `externalRef`, unique per workspace, and that uniqueness is what guarantees one ticket even when two calls arrive in the same instant.
- **Build the fingerprint from the problem, never from the incident.** Use the detection plus the affected object, for example `cert-expiry|cn:portal.bgcengineering.ca` or `ftp-service-down|host:bgc-van-ftp01`. Your section 3.1 rule is right. For infrastructure alerts, the primary entity is usually the host, service or certificate common name, rather than a user.
- **`severity`** accepts Low, Medium, High or Critical and maps to priority 1, 2, 3 or 4. **Informational is refused with `422 informational_not_ticketed`**, as a guard in case your filter misses one. Send `priority` (1–4) instead to choose the priority yourself.
- **`reopenWithinDays`** defaults to 7, the same as your window. Send 0 to never reopen.
- **`title`, `description`, `category`, `group`, `tags` and `customFields`** apply when a ticket is **created**. On a repeat, only the note, the count, the reference and a priority raise happen. The description can be HTML (it is sanitised) up to 100 KB.
- **`occurrenceNote`** is optional HTML up to 20 KB, added to the repeat or reopen note. Ticket Pulse writes the heading, the count, the time in Pacific and the incident link itself, so you don't need to format your 7.3 and 7.4 notes.
- **`requesterEmail`** is required. Always send `sentinel@bgcengineering.ca`.
- **`fingerprintDisplay`** is stored in the custom field `alert_fingerprint`, so technicians can read it.

## 4. The simplified playbooks (please change your design to this)

**TicketPulse-Sync.** Triggered when an incident is created, or updated with new alerts, for the detections you choose.
```
for each NEW alert in the incident:
    compute fingerprint (detection + primary entity), SHA-256
    POST /alert-occurrences  { fingerprint, title, description, severity, …, reference: {incident + alert} }
    remember data.ref + data.url
tag the incident "TicketPulse-<ref>" for each distinct ticket + comment with the URLs
```
There's no look-up before the call, no branching on status, and no separate "add reference" call. One HTTP action per alert handles creates, repeats, reopens, successors and retries.

**TicketPulse-Update.** Triggered on a severity, owner or status change with no new alerts.
```
GET /tickets?reference=sentinel:<incidentId>                  → every ticket linked to this incident
for each: PATCH /tickets/{id} { "addNote": { "body": "<the change>", "agent": "Update" } }
          and, if the severity rose: PATCH /tickets/{id} { "priority": <new> }   (only if higher than data.priority)
```

**TicketPulse-Close.** Triggered when an incident is closed.
```
GET /tickets?reference=sentinel:<incidentId>
for each ticket:
    PATCH /tickets/{id} { "addNote": { "body": "Sentinel incident #N closed — <classification> — <comment>", "agent": "Close" } }
    GET /tickets/{id}/references                               → all incidents this ticket came from
    if every one of those incidents is closed in Sentinel:
        PATCH /tickets/{id} { "status": "Resolved" }
```

**TicketPulse-Callback (optional, R11).** Triggered by our webhook.
```
on ticket.status_changed with data.ticket.status Resolved/Closed (only monitoring-alert tickets reach you):
    GET /tickets/{id}/references
    close each linked incident whose alerts all belong to resolved tickets
    (GET /tickets?reference=sentinel:<incidentId> tells you the other tickets of that incident)
```

**Two cautions for the playbooks:**
- **Loops.** When your Close playbook resolves a ticket, our webhook reports that change back to your Callback. Ignore callbacks for incidents you have just closed yourself. The webhook's `data.actor` names your credential when the change came from you.
- **Retries.** Keep Logic Apps' default retry policy. Our API answers 429 with `Retry-After`, the limit is 120 calls a minute per credential, and a retried alert is recognised by its alert id.

## 5. Answers to your questions

| # | Answer |
|---|---|
| Q1 | Yes. REST, `/api/v1`, OpenAPI 3 at `GET /api/v1/openapi.json`, readable docs at `GET /api/v1/docs`. |
| Q2 | Both use `https://ticket-pulse-app.azurewebsites.net/api/v1`. Sandbox and production differ by **credential**: each client is bound to its workspace. |
| Q3 | Yes, it's on the public internet with TLS 1.2+ and a public CA certificate. Send us the Logic Apps outbound ranges and we'll add an IP allowlist to the production client. |
| Q4 | Not yet. For now, OAuth 2.0 client credentials (section 2). Entra managed identity is planned for later. |
| Q5 | `POST /api/v1/alert-occurrences` (section 3). For creating an ordinary ticket, `POST /api/v1/tickets` is also available. |
| Q6 | Yes. The fingerprint is the ticket's `externalRef`. Look it up with `GET /tickets?externalRef=<fingerprint>`, which returns `status`, `resolvedAt`, `closedAt`, `occurrenceCount` and `lastOccurrenceAt`. With the single call you rarely need to. |
| Q7 | Yes, including simultaneous calls. It's unique per workspace, with a per-fingerprint lock on our side. We tested two parallel first calls against production and got one ticket. |
| Q8 | Yes. `GET/POST /tickets/{id}/references`, and the single call adds them automatically. Find tickets by incident with `GET /tickets?reference=sentinel:<incidentId>`. |
| Q9 | Yes. `occurrenceCount` and `lastOccurrenceAt` are on every ticket, maintained by the single call and shown on the ticket page. |
| Q10 | `POST /tickets/{id}/notes { "body" \| "bodyHtml", "agent" }`: private, internal-only notes. `agent` sets the author line, e.g. "Microsoft Sentinel · Close". `PATCH /tickets/{id} { "addNote": {…} }` adds a note in the same call as a change. |
| Q11 | `PATCH /tickets/{id} { "priority": 1–4, "status": "…" }`. Priorities: 1 Low, 2 Medium, 3 High, 4 Urgent. IT statuses: **Open, Pending, Pending Response, Resolved, Closed** (`GET /meta` lists them with their base). "New" and "Reopened" are not statuses: new tickets are Open, and a reopen sets Open. |
| Q12 | Numbers look like `TP-1650`. The browser URL is `https://ticketpulse.bgcsaas.com/tickets/<id>`, returned as `data.url`. Every URL on the API accepts the id or `TP-1650`. |
| Q13 | Description and notes take **HTML**, sanitised, or plain text. Descriptions up to 100 KB, notes up to 200 KB, the request body up to 3 MB. Times are ISO 8601 UTC in and out. Our generated notes show Pacific time. |
| Q14 | Group: **Servers** (production `groupId: 1000208184`, sandbox `internalGroupId: 8305`). Type: **Incident**, the default. Requester: `sentinel@bgcengineering.ca`. Category by alert kind: see section 6. |
| Q15 | Links: yes. A post-window successor is linked automatically, and `POST /tickets/{id}/links { "related": "TP-…", "kind": "related_to" }` links any two. Custom fields: yes. Unknown keys are created automatically on first use, and yours are fine. |
| Q16 | 120 calls a minute per credential. Over the limit you get `429` with `Retry-After` and the `X-RateLimit-*` headers. |
| Q17 | Yes. Standard Webhooks signing (an HMAC-SHA256 `webhook-signature` over `id.timestamp.body` with a `whsec_` secret), with retries and backoff. We suggest the `ticket.status_changed` event, which covers resolved, closed and reopened, limited to `monitoring-alert` tickets. Send us the Logic App HTTPS URL and we create the subscription and hand over the signing secret the same way as the client secrets. The payload carries the ticket id, `externalRef` (your fingerprint), status, priority and `actor`. For the reference list, call `GET /tickets/{id}/references`. |
| Q18 | Tickets have an optional `resolutionReason`. Section 7 has the mapping to Sentinel's four classifications. |
| Q19 | Yes. Agents are keyed by their BGC e-mail (UPN). `GET /agents` lists them, and `PATCH /tickets/{id} { "assignedTechEmail": "…" }` assigns one. |
| Q20 | No automatic expiry. Rotate on demand in Settings. We suggest yearly and after any staff change. |
| Q21 | Built into the ticket model: fingerprint, occurrences and references. No separate table is needed on your side. |
| Q22 | Vahid Haeri (Ticket Pulse). |
| Q23 | Nothing on the Must list is missing. Everything is live in 3.9.79. |

## 6. Values to use

| Alert kind | `category` | `subcategory` |
|---|---|---|
| Server down, service down, disk, CPU, VM availability | Cloud & Servers | Network & Server Infrastructure |
| FTP / file transfer service | Cloud & Servers | Network & Server Infrastructure |
| Backup / replication failures | Cloud & Servers | Backup / Restore |
| Azure resource health | Cloud & Servers | Azure Infrastructure |
| Certificate expiry (TLS) | Cloud & Servers | Network & Server Infrastructure |
| Internet link / ISP up/down | Network & Remote Access | ISP / Connectivity Monitoring |

- **Certificate expiry goes under Cloud & Servers, not Security.** Security-category tickets require a resolution reason to close, and certificate renewals belong to the server team anyway. If you'd rather use "Security / SSL / Certificate Management", your Close playbook must send `resolutionReason` when it resolves.
- **The sandbox has the same category names**, so the playbook only switches the base credential and the group between environments.

## 7. Resolution classification (Sentinel needs one to close an incident)

Ticket Pulse resolution reasons are optional on these tickets. When the Callback playbook closes an incident, map them like this:

| Ticket Pulse `resolutionReason` | Sentinel classification |
|---|---|
| none (the usual case: an outage was real and fixed) | **TruePositive** |
| `confirmed_threat_contained` | TruePositive |
| `benign_expected`, `no_action_required` | BenignPositive |
| `false_positive`, `needs_detection_tuning` | FalsePositive |
| `duplicate`, `other` | Undetermined |

For availability alerts we suggest **TruePositive** as the default: the alert was right, and the problem was dealt with. Your team can change that mapping inside the Logic App without us.

## 8. How Ticket Pulse treats these tickets

- **Trusted intake.** Our AI never re-categorises, re-types or re-prioritises your tickets, and never closes them as noise. It only picks an assignee in the group when you don't send one.
- **Tickets are native to Ticket Pulse** and are copied to FreshService as usual, so both systems show them.
- **Priority only ever goes up automatically.** A person can lower it.
- **Reopening follows your window** (`reopenWithinDays`). If the alert fires again within it, the ticket reopens even when a person resolved it, which is the point of the window. After the window, a new ticket starts and the resolved one stays resolved.

## 9. Before go-live, from your side

1. **E-mail overlap.** While e-mail notifications stay on as a fallback, check whether those e-mails reach the IT helpdesk mailbox. If they do, Ticket Pulse turns them into tickets too, and you'd get two tickets per alert. Either stop the e-mail for each detection as it moves to the API, or tell us the sender address and we'll make Ticket Pulse ignore it for those alerts.
2. **Allowlist.** Send the Logic Apps outbound IP ranges for West US, and we'll lock the production client.
3. **Callback URL.** Send it if you want R11. We create the webhook subscription and hand over its signing secret.
4. **Dry run first**, as you planned, then run your acceptance list against the **sandbox** credential.

## 10. Later, not now

- **Entra managed-identity login** (your preferred option). It needs an App Registration and token validation on our side. We'll schedule it once the integration is running on client credentials. Switching changes only how the token is obtained; the calls stay the same.
- **Attachments** (e.g. a screenshot of the alert graph): not on the API yet. Put links in the description.

## 11. What we verified against production (sandbox workspace, 24 Sep 2026)

15 of 15 end-to-end checks passed with the sandbox credential. Median response was 331 ms; the slowest was 1.07 s, a first create.

- **Creates and repeats.** A new alert creates a ticket with the right category, group, source and priority. A repeat on the open ticket counts it. A more severe repeat raises the priority, and a milder one leaves it alone.
- **Retries.** A retried alert id writes nothing.
- **Lookups.** The references list is complete, and tickets are found by Sentinel incident id and by fingerprint.
- **Reopen and successor.** A resolve followed by a recurrence reopens the same ticket. After the window, a new ticket is created and linked to the old one.
- **Concurrency.** Two simultaneous first calls produced one ticket.
- **Refusals.** Informational is refused with 422, and a call with no fingerprint gets a 400.
