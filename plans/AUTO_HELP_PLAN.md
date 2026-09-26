# Auto-help: AI first answers by playbook (QA 09-25 item 7)

_Status: plan + open questions, 25 Sep 2026. Build scope for this round: the framework (P0) in shadow mode only._

## The idea in one paragraph
When a ticket lands in a category we know how to answer (e.g. IT → Software & Apps → Installation), a small AI
pipeline runs a **playbook**: our instructions for that kind of request, a short list of tools it may use, and the
knowledge it may quote. It writes a short, grounded answer ("Install Bluebeam from Company Portal: …"), then —
depending on the playbook's mode — only records it (shadow), stages it for an agent to send (approve), or sends it
(auto). The requester can reply to reach a person; silence for N days resolves the ticket. Every run is recorded with
its sources and outcome, so we can see where it helps before we let it send anything.

## Decisions (Vahid, 25 Sep 2026)
- **Playbooks are per subcategory**, chosen in the UI; admins enable/disable/add. Seeded (IT, off): Software installs,
  Mobile / roaming, Password / MFA / access.
- **Both origins**: FS-born tickets answer through the existing TP → FreshService reply lane.
- **Knowledge = a main rail section "Knowledge"** (not Settings): Articles (full editor, search, categories) ·
  Playbooks · Waiting · Activity. Built so non-admin roles can get access later (role gate in one place).
- **Follow-up, editable per playbook**: answer → after 2 business days of silence a nudge ("hope that sorted it; we'll
  close this in 2 days unless you reply") → 2 business days later resolve as Auto-help. Implemented as a dedicated
  park kind **`auto_help`**, with its own waiting queue (Knowledge → Waiting, and a "Auto-help waiting" queue view).
- **AI disclosure line**: a per-workspace setting with editable wording, on by default.

## Research findings (deep research, 25 Sep 2026) and what they require of us
Verified (multi-source, adversarially checked) findings, mapped to requirements. R-numbers are audit checks.
- **R1 Knowledge hygiene is the #1 cause of wrong AI answers** (Atlassian; ServiceNow Now Assist guidance): one topic
  per article, self-contained (the model can't follow links), headings + numbered steps, no duplicate procedures, scheduled
  accuracy review. -> Articles carry an owner, last-verified date and review interval; overdue articles are ranked down
  and flagged; the editor warns on a likely duplicate title and shows the writing rules.
- **R2 Structure-aware chunks with metadata** (Atlan; OWASP RAG): split on headings so a numbered procedure stays whole.
  -> Articles are embedded per section; retrieval returns the matching section, not the whole article.
- **R3 Hybrid keyword + embedding retrieval** (Anthropic contextual retrieval: ~halves top-20 misses). -> Done: both,
  normalized to one scale, workspace + published scoped.
- **R4 An explicit answerability gate** (Google Research, ICLR 2025: with insufficient context wrong answers went from
  10% to 66%). -> A separate cheap "is the retrieved context enough to answer fully?" check runs on every draft and is
  logged; "insufficient" = not answerable, whatever the drafting model says. Every step in the answer must name the
  source it came from, and the runner verifies each step's sources were actually retrieved.
- **R5 Ticket text is untrusted input** (OWASP LLM01): mark and fence it in the prompt, least-privilege read-only tools,
  strict output validation, human approval for the send. -> Fenced + labelled in the prompt; adversarial "injected
  ticket" tests; approve mode before auto.
- **R6 Shadow mode compares with what people actually did** (Microsoft Case Management Agent shadow mode): no side
  effects; store the AI's answer next to the human outcome; score answer quality separately from follow-up/closure.
  -> Each run shows the agent's first public reply and the resolution next to the draft; reviewers mark a draft
  Good / Partly right / Wrong / Shouldn't answer; Activity shows these counts with N per playbook.
- **R7 Deterministic playbooks first, generation as fallback** (JSM Rovo). -> Already the design.
- **R8 Freshdesk closes only on an explicit "yes, close it"; silence leaves it with people.** Our decision is nudge then
  close on silence (Zendesk counts 72 h silence as a resolution). Keep the decision; record silence-closes as their own
  outcome so we can see if they reopen.
- **R9 No vendor publishes a numeric bar for turning on auto-send.** We set our own: per playbook, at least 30 reviewed
  shadow drafts, >= 85 % Good, 0 "Wrong" on security-adjacent playbooks, then approve mode for 2 weeks before auto.
- Refuted in verification (don't rely on): "reranking cuts misses 67 %", "Zendesk hands sensitive queries off by default".
- Not covered by evidence (our call): password/MFA/security handling -> approve-only, never auto (proposed).

## What already exists (reuse, don't rebuild)
| Need | Existing piece |
|---|---|
| LLM loop with tools, budgets, failover | `notificationWorkflowLlmPipelineService` (turn/tool/time budgets), `providerGateway.runToolTurn` |
| Grounding / leak guard | `guardNotificationEmailPayload` (unsupported claims, internal-note leaks) |
| Draft an agent can send | `TicketProposedReply` + `ProposedReplyCard` (one open proposal per ticket) |
| Confidence gate, never-auto people | `evaluateAutoSendGate` (`minLlmConfidence`, `alwaysHumanRecipients`) |
| Trigger after the category is known | `ticket.categorized` event (fires ~49 s after create, `first=true` once) |
| A curated knowledge base we own | Verified solutions (`solutionVerifiedAt/solutionNote`) + `solutionSuggestions` |
| Similar resolved tickets | `ticketSimilaritySearchService` (calibrated scores) |
| Waiting for the requester | Parked tickets (wake date) + `ticket.reply_received` |
| Test a prompt on a real ticket | `/llm-tools/test-run` pattern |

Missing: a knowledge-article store, a playbook model + runner, outcome tracking, FS solution-article import, Intune app
catalog tool.

## What others do (Sep 2026)
Freshservice Freddy AI Agent / Email Bot (solution articles, up to 3 links in the reply, deflection metric); Freshdesk
Email AI Agent ("Yes, close my ticket" widget); Zendesk AI agents (an "automated resolution" = 72 h silence + relevance
check, billed per resolution); ServiceNow Now Assist (e-mail answers are mostly agent-approved drafts); Jira SM Rovo
(KB-grounded); Copilot Studio IT Helpdesk template (KB answer → ticket fallback). Common pattern: answers grounded in
articles with citations, confidence-gated, a clear "reply to reach a person" path, a waiting window before counting a
resolution, and shadow/draft modes before auto-send. Sources in the research notes of the 09-25 response.

## Model (new tables, additive)
- **`auto_help_playbooks`** — workspaceId, name, enabled, `mode` (`shadow` | `approve` | `auto`), categoryId,
  subcategoryId (nullable = whole category), `match` (conditions JSON: keywords, exclusions, requester domain, ticket
  type), `instructions` (the playbook prompt), `allowedTools[]`, `kbScope` (which sources/collections), `minConfidence`,
  `waitDays`, `onSilence` (`resolve` | `leave_open`), `onHelp` (`assign_normally` | `group:<id>`), `priority`, version,
  createdBy/updatedBy.
- **`auto_help_articles`** — workspaceId, source (`tp` | `fs_solution` | `verified_ticket`), externalId, title,
  bodyHtml, bodyText, categoryId?, tags[], status (`draft` | `published`), embedding (Float[], same 256-d model as
  tickets), contentHash, updatedAt.
- **`auto_help_runs`** — ticketId, playbookId + version, mode, status (`no_match` | `not_answerable` | `drafted` |
  `staged` | `sent` | `failed`), transcript, sources used (article ids / ticket ids / tool calls), draft
  (subject/html/text), confidence, gate decision, proposedReplyId / sentEntryId, `outcome` (`resolved_silence` |
  `resolved_confirmed` | `help_requested` | `reopened` | `agent_dismissed` | `agent_edited_sent`), outcomeAt, cost.
- Resolution reason `auto_help` (added to the reason list; excluded from agent closing stats).

## Run lifecycle
1. **Trigger** `ticket.categorized` (first=true). Pick the highest-priority enabled playbook whose category and
   `match` fit. Skip: noise / never-noise-held, security/approval tickets, agent requesters, Straight-Talk-only rules
   (item 5 applies to the tone), an existing run, an open proposal. FS-born: your call (Q2).
2. **Retrieve** from the playbook's KB scope: embeddings + keyword over articles and verified solutions; top 5 above
   the calibrated floor. Nothing relevant → `not_answerable`, stop.
3. **Draft** with the playbook instructions and allowed tools only; the model must call `submit_auto_help_reply`
   `{answerable, subject, html, text, confidence, citedSourceIds}`. `answerable=false` → stop silently.
4. **Guard** (existing output guard + "every step traces to a cited source").
5. **Gate** by mode: shadow → record only (shown on the ticket's AI tab and in the run list); approve → staged proposed
   reply ("Auto-help suggests…"); auto → send if confidence ≥ bar and requester isn't always-human, else stage.
6. **After sending**: footer "Did this sort it out? Just reply if you still need a hand — a person will pick it up.
   If we don't hear back in N days we'll close this ticket." Park until then (ticket stays assigned, or goes to an
   Auto-help queue: Q7).
7. **Reply**: "thanks, works" → `resolved_confirmed`; anything else → unpark, route normally, `help_requested`.
   Silence → resolve with `auto_help` (`resolved_silence`). Reopen within 7 d → `reopened`.

## Tools (v1, read-only)
`search_knowledge`, `get_article`, `find_similar_resolved_tickets`, `get_ticket_details`, `get_requester_profile`
(Entra office/department/country — useful for roaming), `lookup_company_portal_app` (Intune catalog cache; needs Graph
`DeviceManagementApps.Read.All`), `submit_auto_help_reply`. Later: MCP connectors per workspace.

## Knowledge sources, by effort
1. Verified solutions (exist; add an embed job). 2. TP articles written in a small editor under Settings → Auto-help.
3. FreshService solution articles (API `GET /api/v2/solutions/articles?folder_id=`, published only; nightly import).
4. Intune app catalog (Graph permission from IT). 5. SharePoint pages (Graph). 6. MCP servers.

## Guardrails
Shadow by default; kill switch per workspace and per playbook; grounded answers with citations or silence; one
Auto-help mail per ticket; per-requester daily cap; never on noise, security, approvals, VIP/always-human; tool output
treated as untrusted; the requester always has the "reply to reach a person" path; the mail says it's an automated
answer (wording Q8); every run audited on the ticket.

## Metrics (team-safe, always with N)
Coverage (matching tickets that got an answer), approve-mode acceptance and edit rate, automated resolution rate
(after the waiting window), help-requested rate, 7-day reopen rate, CSAT with N, shadow agreement with how a person
actually solved it.

## Phases
- **P0 — this build (framework, shadow only):** tables; Settings → **Auto-help** (playbook list + editor: category,
  match, instructions, tools, KB scope, mode locked to shadow); article editor; verified-solution embed job; runner on
  `ticket.categorized`; **"Test on ticket #…"** button showing the draft, sources and confidence; runs list with
  outcome columns; ticket AI tab shows the shadow answer. Jest: matcher, gate, runner with a mock provider, reply
  classifier. One seeded example playbook per workspace, disabled.
- **P1:** approve mode via ProposedReplyCard; FS solution-article import; reply handling + park + outcomes.
- **P2:** auto mode for one playbook after ~2 weeks of shadow data meeting the bar; Intune tool.
- **P3:** SharePoint/MCP sources, more playbooks (mobile roaming), analytics panel.

## Open questions (for Vahid)
1. First workspace(s) and playbooks: IT Software & Apps installs + mobile roaming? Others?
2. FS-born tickets too (reply goes through the FS lane; FS status moves)?
3. Who writes playbooks and articles — admins only, or category owners?
4. Knowledge: are FS solution articles current enough to import? SharePoint wanted? A Company Portal app list?
5. Will IT grant Graph `DeviceManagementApps.Read.All` (+ group membership read) for the app catalog?
6. Wait before auto-resolving on silence (3 days?); must the requester confirm, or does silence count?
7. While waiting: ticket stays assigned to a person, or sits unassigned in an "Auto-help waiting" view?
8. Sender and wording: from the team mailbox; say it's automated? The reply-for-a-person line?
9. Stats: Auto-help resolutions excluded from agent numbers, shown as their own line?
10. Bar to move shadow → approve → auto (e.g. ≥ 80 % agreement, ≤ 5 % reopen, N ≥ 30)?
11. Monthly cost ceiling per workspace?
12. Languages (English only for v1?).
