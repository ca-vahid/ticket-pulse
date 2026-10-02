# MEGA 10-01 — QA package plan

Source: `qa/10-01 Package/Features Request - 10-01.docx` (Susan Xu, QA). Workspaces: IT (ws1) and Project Accounting (ws5) screenshots. Built on `cursor/qa-1001` from origin/main 4.1.30. Product decisions asked and answered by Vahid on 1 Oct 2026 (items 3 and 8).

Legend: ☑ done · ☐ to do · **fix** defect · **build** feature · **your call** product decision

| # | QA said | Verdict | Root cause / approach |
|---|---|---|---|
| 1 | Templates panel cut off on the right | fix | Third move of the Templates button (09-28 left, 10-01 right); a fixed anchor. Now opens toward the side with room. |
| 2 | Group headers look like a hovered/selected row; indent members | fix | Header was a full-width `bg-muted` band. Now a primary title + hairline on the page background; rows indented. |
| 3 | Autofill via the Teams bot (dump a picture) | build | Bot reads pasted images/text → same Autofill extraction → card with Create ticket / Open in Ticket Pulse / Discard. |
| 4 | Disconnect an agent from the Teams bot | build | New admin Disconnect (removes the app via Graph, marks the person); sends skip and are never re-installed until Connect again. Migration `20261001230000_teams_disconnect`. |
| 5 | Default "Ask a question" to approvers/agent only | fix | Default was `requester`; now `internal`, listed first. |
| 6 | Merge "Waiting until a date" and "In progress, with an ETA" | fix | One choice "Waiting until a date or an ETA"; `eta` kept for older parks/API. |
| 7 | Custom fields (to/cc/bcc_recipients…) as workflow recipients | build | `custom_field:<key>` recipient tokens on To/Cc/Bcc; comma/semicolon/space separated, non-addresses dropped, read at send time. |
| 8 | Onboarding / Offboarding section | build | `plans/HR_LIFECYCLE_PLAN.md` (+ research). Ships **off**; observe mode for rehearsal. |
| 9 | Priority Changed trigger | build | `ticket.priority_changed` rides on the field-change event (echo-safe); from/to/labels/raised; workflows' own writes don't fire it. |
| 10 | Webhook step: surface the variables list | fix | Variable picker under the body; new `{{ ticket.url }}` (it didn't exist — QA's webhook rendered an empty link). |
| 11 | How do we publish or delete a draft article? | fix | Publish + Delete on draft rows and in the article header (Delete = archive, recoverable). |

## Cross-cutting
- `ticketService.js` is also changed by tonight's 17:23 release — untouched here.
- Every file is re-diffed against origin/main before the release (other sessions ship in parallel).
- Two migrations, both additive: teams_disconnect, hr_lifecycle (+ teams autofill token if needed). Applied to prod before the merge.

## Execution order
1–2, 4–7, 9–11 (direct) ∥ 8 (agent) ∥ 3 (agent) → full suites → second look → release 4.1.3x → migrations → PDF + e-mail → watch.
