# Knowledge, simplified: plan

_Status (12 Oct 2026): approved by Vahid on 11 Oct with all recommendations. Phase 0 (replay) done; phase 1 shipped as 4.2.40 and is on for IT at Draft only; phase 2 shipped as 4.2.42; phase 3 shipped as 4.2.43 (ask-at-close is off until switched on). Phases 4 and 5 in progress._
_Sources: code review of main, a read-only look at IT's production data for the last 30 days, and vendor/standards research (links at the end)._

## 1. The short version

Today a ticket only gets an answer if a playbook fits it. Most do not, so most tickets never reach an article.
The plan turns that round:

1. **Knowledge first.** Every ticket that passes the safety rules is checked against the articles. Publishing an
   article is enough to make it usable. Playbooks stay only for the few cases that need fixed steps or tools.
2. **One dial per category** decides what Auto-help may do with an answer: nothing, draft, suggest to the agent, or
   send when sure. Day and night can differ. The confidence of each answer moves it down the dial, never up.
3. **Agents add knowledge while they work**, by skill, and only when it is worth asking. An AI drafts and tidies; a
   person confirms.
4. **An AI steward reviews the library** every night: duplicates, contradictions, stale or unused articles, things
   agents keep answering that are not written down. It proposes; people decide.
5. **One inbox** holds everything that needs a person, sorted by impact and limited per person, so 100 categories
   and thousands of articles do not turn into a million items on a page.
6. **A new, simpler Knowledge section**: five tabs for admins, three for agents, and a Knowledge panel on the ticket.

Nothing sends by itself until a category has earned it on reviewed answers. That rule does not change.

## 2. What is wrong today (measured, IT, last 30 days)

| Finding | Number |
|---|---|
| Tickets that reached Auto-help | 587 |
| Stopped by the safety rules | 199 |
| Stopped at "no playbook fits" before any article was searched | 220 |
| In a playbook's category but "not this playbook" | 86 |
| Playbook chosen, no answer (31 stayed quiet on purpose) | 54 |
| Drafted (9 full, 18 partial) | 27 |
| Drafts reviewed by a person | 0 |
| Published articles | 7 (all Software / Procurement, all written by Vahid) |
| Top categories with no playbook and no article | 7 of 11 (about 1,600 tickets in 90 days) |
| Playbooks with no article in their category | 2 (Phones & mobile, Password/MFA): 0 drafts |
| Tickets with a verified solution | 2 |
| People who can write knowledge | 4 workspace admins |
| People with skills recorded | 15, all intermediate or above somewhere; 88 of 104 subcategories covered |

Design faults behind the numbers:

- A playbook has one top category in the form, but the AI already uses playbooks across categories (21 of 65
  choices). The screen and the behaviour disagree.
- No playbook means no answer, so a new article in an uncovered category does nothing.
- The Gaps tab drops every ticket outside a playbook's category, which hides the largest gaps.
- Playbook instructions repeat article facts, so the same knowledge is kept in two places.
- Nobody reviews drafts, so no playbook can ever leave Shadow.
- Seven tabs (Articles, Gaps, Playbooks, Waiting, Approvals, Activity, Settings) for what is, to an agent, one
  question: "is there something written about this, and is it right?"

## 3. Principles

1. **Reliability before reach.** Every answer cites what it read; a separate check decides whether that is enough
   to answer; silence is always allowed. A wrong answer costs more than no answer.
2. **Knowledge is the unit.** Rules about how to answer live on the category. Facts live in articles, once.
3. **Reuse is review** (KCS). An article is checked when it is used, by the person using it, not on a calendar.
4. **Flag it or fix it** (KCS). Anyone can flag; people with the skill can fix.
5. **Ask rarely, ask well.** The system asks an agent for knowledge only when it can show why this one matters.
6. **The AI proposes, a person decides.** The steward never changes published text by itself. The one automatic
   action is the safe direction: taking a doubtful article out of automatic answers.
7. **Team-safe.** No contributor rankings. Credit sits on the article.

## 4. How a ticket is answered (new order)

```
ticket categorised
  1. Safety rules            noise, security, agent requester, parked, already answered ...   (unchanged)
  2. One triage check        "Can the requester do this themselves with instructions,
                              or must a person do something?"            needs a person -> stop, not a gap
  3. Search                  article sections + verified solutions, whole workspace,
                              the ticket's own category preferred                    nothing -> gap in that category
  4. Draft                   workspace style + category notes (+ a playbook, only if one matches)
  5. Checks                  enough to answer? every step cited? stay-quiet rules? leak guard?   (unchanged)
  6. Confidence              High / Medium / Low from evidence (section 6)
  7. Act                     what the category's dial allows for that confidence, day or night
```

Step 2 keeps the one useful job the playbook choice does today (it stops server alerts, admin tasks and access
requests). It becomes one workspace-level check with an editable prompt, and it also says whether a playbook applies.

**Playbooks become "Special handling"** and are optional. A playbook can cover several categories. Keep one only
where the answer needs fixed steps, tools or questions:

| Today | After |
|---|---|
| Software, apps & licences | Removed as a gate. Its facts move into the articles; its tone notes become the Software category notes. |
| Phones & mobile | Kept as special handling (uses the requester's country and office). Needs articles first. |
| Password, MFA & access | Becomes the Account & Access category setting "always checked by a person". |
| OpenGround, AI tools (off) | Retired; already merged. |

## 5. One dial per category

Replaces Shadow / Approve / Auto per playbook, the workspace approve switch and the after-hours switch.
The table below is an illustration of the screen; the settings and counts in it are made up.

```
Answering                                        Business hours        After hours        Evidence
---------------------------------------------------------------------------------------------------------
Everything else (default)                        Draft only            Draft only
Software & Apps                                  Suggest to agent      Send when sure     41 reviewed, 90 % good
  OpenGround                                     Suggest to agent      Suggest to agent   (own setting)
Procurement & Licensing                          Suggest to agent      Suggest to agent   12 reviewed, needs 30
Account & Access          always checked         Suggest to agent      Suggest to agent   locked: sensitive
Security                                         Off                   Off
Phones & Mobile                                  Draft only            Draft only         0 articles
```

- **Four levels:** Off, Draft only (recorded, shown on the ticket), Suggest to agent (a ready reply the agent
  sends or edits), Send when sure.
- **Inheritance:** workspace default, then top category, then subcategory. Most rows are never touched.
- **Earned, not chosen:** "Send when sure" is locked until that category meets the bar on its own reviewed answers
  (today's bar: 30 reviewed, 85 % good, no recent "wrong"). The row shows the progress. Sensitive categories stop
  at Suggest.
- **Confidence moves an answer down, never up:** High gets the level the row allows; Medium gets one level lower;
  Low is recorded only.

## 6. Confidence an agent can trust

The model's own score is a weak signal (research: self-reported confidence is poorly calibrated). The band is built
from things we can observe:

| Signal | High needs |
|---|---|
| The "enough to answer" check | "yes", no step dropped |
| Match strength of the best section | above the calibrated floor by a margin |
| The article | checked by a person, not past review, not flagged |
| The article's record | used before with no "wrong" |
| The category's record | meets the bar |
| The model's own score | at or above the category's bar |

Any miss makes it Medium; two or a failed check make it Low. Activity gets a small calibration table per category:
"when we said High, agents agreed 46 of 50 times". If High stops meaning high, the category drops a level by itself
and the admins are told.

## 7. Who can add and change knowledge

Mapped from the skills people already have (the KCS licence idea: Candidate, Contributor, Publisher).

| Skill in the category | Can |
|---|---|
| Any workspace member | Read, search, flag an article, say "this helped / this is wrong" |
| Basic | Propose (goes to someone with the skill) |
| Intermediate | Write and publish as **Not checked yet**; fix articles in their categories |
| Advanced, Expert | All of that, plus confirm an article as **Checked** |
| Workspace admin | Everything, everywhere |

- A skill in a top category covers its subcategories. The 16 IT subcategories with nobody at intermediate fall to
  the admins.
- **Not checked yet** articles are visible to agents and may be used in drafts and suggestions, marked as such.
  They are never used in an answer that sends by itself.
- An article becomes **Checked** when an advanced/expert person confirms it, or by reuse: two different agents sent
  a suggested answer built on it without changing the steps.
- Every change keeps the previous version. One click restores it.

## 8. How agents contribute without being nagged

| Moment | What the agent sees | Extra work |
|---|---|---|
| Closing a ticket | Only when the system can show it is worth it: "This came up 6 times this month and is not written down. Save your answer?" One click. The AI drafts from the thread in the background (personal data removed) and offers to add it to the closest article instead of making a new one. | 1 click, then a 2-minute check later |
| Using an Auto-help draft | Good / Partly / Wrong on the ticket. If the agent edits before sending, the AI compares the two and proposes the edit to the article. | 1 click or none |
| Reading an article | "Flag" with one sentence, or "Fix" if they have the skill. | seconds |
| Any time | "Add to knowledge" on the ticket's More menu and the command palette. Paste rough notes; **Tidy** rewrites them to the house style; side-by-side preview; save. | as much as they want |
| A gap in their area | "Asked 6 times, nothing written" sent to at most two people with the skill who are at work. | optional |

When to ask at close (starting values, all settings):

- no article matched this ticket, or Auto-help could not answer it; and
- at least 3 similar tickets in 90 days; and
- the thread has a public agent reply with real steps; and
- the agent has the skill for the category; and
- not noise, not security, not a person-specific request.
- Never more than once a day per agent, never twice for the same topic, "Not now" is remembered.

If nobody is asked, the steward still drafts from groups of solved tickets and sends the draft to the inbox.

## 9. The AI steward (review, merge, fix, ask)

A nightly job in quiet hours, inside the workspace's monthly cost cap. It writes **suggestions**; it never edits a
published article.

| Check | Finds | Suggests |
|---|---|---|
| Overlap | Sections in different articles that say the same thing | A merge, with the merged text drafted |
| Contradiction | Two articles that disagree on a fact | A question to the person with the skill |
| Drift | Agents' recent replies differ from the article ("Company Portal" became something else) | An edit, with the tickets that show it |
| Wrong in use | An article behind answers marked wrong, edited heavily or reopened | A fix. After two such signals the article is taken out of automatic answers at once |
| Unused | Never found or quoted in 180 days | Retire or merge |
| House rules | Several topics in one article, missing steps, prices, server addresses, no "when this does not apply" | A tidy-up |
| Not written down | Groups of solved tickets with a consistent answer and no article | A new article, or a section for an existing one |
| Cannot decide | Anything it is unsure of | One concrete question ("Is Bluebeam still limited to the CAD team?"). The answer is applied as an edit for the person to confirm |
| Imports | FreshService solution articles (existing import) | Arrive as suggestions, not as published articles |

Safeguards: every proposed text must be supported by the tickets or articles it cites (the same citation check the
answers use); personal data is removed before and after; suggestions expire after four weeks; one suggestion per
topic (duplicates are merged).

## 10. One inbox, and how it stays small

Everything that needs a person is a **suggestion** with the same shape: what, why, the evidence, the proposed
change, and three actions (Accept, Edit, Dismiss). The items below are made-up examples.

```
Inbox  -  For you (4)   My categories (11)   Everything (38)

  Merge   "Installing software" and "Paid software" both explain Adobe Acrobat          Software & Apps
          Why: two sections, 84 % the same. Used 9 times last month.           [See both] [Merge] [Dismiss]

  New     DT Logger from Company Portal                                         Field Instrumentation
          Why: 5 tickets in 30 days, answered the same way by 2 people.        [Read draft] [Publish] [Dismiss]

  Ask     Is Bluebeam still limited to the CAD team?                            Procurement & Licensing
          Why: the article says yes; 3 recent replies granted it to others.    [Yes] [No, it changed ...]
```

How it scales to 100 categories and thousands of articles:

- **Sorted by impact**: how many tickets a month the change would touch.
- **Routed by skill**, to at most two people, never to someone on leave. A weekly cap per person.
- **Grouped by article**: five findings on one article are one item.
- **Review by use, not by calendar**: an article that keeps being used without complaint renews itself. A calendar
  review is kept only for articles that send by themselves and articles nobody has used for 180 days.
- **Expiry**: an untouched suggestion closes after four weeks and comes back only if the evidence grows.
- **Library by category, never one flat list**: a category tree with counts and a health word, search first,
  lists drawn only as far as you scroll.

## 11. Gaps, enriched

Gaps move from "per playbook" to "per category" and become part of the inbox and the Library.

- **What counts as a gap:** tickets no article matched; answers that were not enough; drafts marked partly or wrong;
  answers agents rewrote; things agents answered from their own head; searches that found nothing (Library and the
  ticket panel); flags.
- **Each gap shows:** how often and the trend, example tickets, who could write it (people with the skill), what it
  would cover ("about 14 tickets a month"), and its state.
- **States, automatic:** open, with someone, drafted, published, proven (Auto-help started answering that group),
  closed.
- **Coverage map:** one row per category with demand, articles, share answered, share agreed. This replaces the
  current Articles overview. It is about topics, never about people.
- **One click:** "Draft from these tickets" (the existing drafter).

## 12. The new Knowledge section

| Tab | Who | What |
|---|---|---|
| **Home** | everyone | For you: your inbox items, your categories' health, what Auto-help did in your areas this week |
| **Library** | everyone | Category tree, search, article reader, "Mine", "Needs a look", "Never used" |
| **Inbox** | people with a skill, admins | Suggestions, gaps, flags, questions, reviews (section 10) |
| **Answering** | admins | The category dial, special handling, stay-quiet rules, style, signature, prompts |
| **Activity** | admins, reviewers | Runs, waiting on the requester, calibration, cost |

Seven tabs become five; an agent sees three. Old links (`/knowledge/playbooks`, `/knowledge/gaps` ...) redirect.

On the **ticket page**, where agents actually work, a Knowledge panel:

- the articles that fit this ticket, with "insert into reply";
- the Auto-help draft with Good / Partly / Wrong;
- "Add to knowledge" and "Flag".

**Article page:** a reading layout (not a form), section links, "used 14 times, last confirmed by <photo> <name>
3 days ago", a health word (Checked, Not checked yet, Needs a look, Out of date), history with restore, and
suggestions shown as changes marked in the text (accept or reject each).

**Editor:** the existing Tiptap editor plus a slash menu, **Tidy** (AI rewrite to house style with a before/after
view), a live "already covered in ..." warning by meaning, and the writing rules as checks, not a wall of text.

Look and feel: Vahid's rules stay (dot and word, small headers, photo and name, little boxing). The Knowledge
artist mock-up stays the visual base. Keyboard triage in the inbox (next, accept, dismiss).

## 13. Technology updates worth making

| Change | Why | When |
|---|---|---|
| Sections as their own table (`knowledge_sections`) instead of JSON inside the article | Per-section use, feedback, duplicates and search in SQL | Phase 1 |
| Article versions table | Safe edits and restore | Phase 2 |
| TanStack Query for Knowledge screens | Caching, instant accept/dismiss, background refresh; less hand-written loading code | Phase 2 |
| TanStack Virtual for long lists | Thousands of rows without slowing the page | Phase 2 |
| Postgres full-text index for the keyword half of search (today: `ILIKE`) | Faster and better ranking as articles grow | Phase 2 |
| Structured (schema-checked) outputs for the triage check and the steward | Fewer malformed results to retry or discard | Phase 1 and 4 |
| Batch pricing and prompt caching for the nightly steward | About half the cost for work that is not urgent | Phase 4 |
| `pgvector` with an index for embeddings (today: vectors scanned in the app, capped at 5,000) | Needed past a few thousand articles. Needs the extension allowed on the Azure database (owner action) | Phase 5, only if volume calls for it |
| Lazy-loaded Knowledge bundle, view transitions that respect the motion setting | Faster first load, calmer navigation | Phase 2 |

Not in this plan: moving the app to React 19 or a new router. Nothing here needs it.

## 14. Data model (all additive)

| Table / column | Purpose |
|---|---|
| `knowledge_category_policies` | The dial: workspace, category (top or sub, null = default), day level, night level, bar, always-checked, notes, stay-quiet list |
| `knowledge_sections` | One row per article section: heading, text, embedding, use counts |
| `knowledge_article_versions` | Every saved version, who, why, from which suggestion |
| `knowledge_suggestions` | The inbox: kind, state, article, category, why, proposed change, evidence, impact, sent to, decided by, expiry, dedupe key |
| `knowledge_signals` | Used / good / edited / wrong / flagged / search-with-no-result, per article section and ticket |
| `knowledge_articles` + `confidence` (`not_checked` / `checked` / `needs_look`), `checked_by`, `checked_at` | Article state |
| `auto_help_playbooks` + `category_ids int[]` | Several categories per playbook |
| `auto_help_runs` + `category_id`, `subcategory_id`, `confidence_band`, `evidence` | Evidence and calibration per category |
| `knowledge_settings` + steward on/off, ask-at-close limits, licence mapping | Workspace settings |

No drops or renames. `auto_help_playbooks.mode` and the workspace approve switch stay readable until Phase 5 and are
then ignored. Migrations are applied by hand before each merge, as always. New indexes on live tables are created
`CONCURRENTLY`.

## 15. Phases

Each phase ships on its own and leaves production safe. Nothing sends by itself before Phase 5.

**Phase 0 - Prove it (no behaviour change).**
Replay IT's last 30 days through the new order with the existing backtest tool. Record category and confidence on
runs. Put the extra drafts in front of Vahid and the skilled agents.
Exit: the replayed drafts are reviewed; wrong answers are counted; the triage prompt is tuned until server alerts and
admin tasks are stopped at least as well as today.

**Phase 1 - Knowledge-first engine and the dial.**
Policies table and resolution, triage check, confidence bands, evidence per category, playbooks on several
categories, gaps by category, sections table. Migrate the three playbooks (section 4). Every category starts at
Draft only. The Answering tab replaces Playbooks.
Exit: "no playbook fits" is gone from Activity; drafts appear in categories that have articles; no change for
requesters.

**Phase 2 - Library, reader and the ticket panel.**
New tabs, category tree, search, article page, health words, versions, the Knowledge panel on the ticket with
Good / Partly / Wrong and Flag. TanStack Query and Virtual, full-text index.
Exit: agents review drafts on the ticket; the first categories start collecting evidence.

**Phase 3 - Contribution.**
Rights by skill, Not checked yet / Checked, save-at-close (selective), Add to knowledge with Tidy, the inbox with
suggestions, checked-by-reuse.
Exit: articles written by someone other than an admin; the ask-at-close rate stays under the cap.

**Phase 4 - Steward and enriched gaps.**
Nightly checks (section 9), gap states and the coverage map, the weekly personal digest (replaces the review
digest), FreshService imports as suggestions.
Exit: merge, drift and "not written down" suggestions arrive with evidence; dismiss rate is tracked and the checks
are tuned on it.

**Phase 5 - Earned sending and other workspaces.**
Suggest to agent, then Send when sure, per category and by day or night, once a category meets the bar. Calibration
table and automatic step-down. A starter set for Accounting, Health & Safety and Project Accounting. `pgvector` if
volume needs it.
Exit: the first category sends after hours on its own evidence.

## 16. What we will measure (always with the count)

- Share of eligible tickets that got a draft, a suggestion, an automatic answer.
- Agreement: Good / Partly / Wrong by category.
- Calibration: how often High was right.
- Gaps: open, time to close, tickets a month covered.
- Library health: checked, not checked, needs a look, unused.
- Suggestions: accepted, edited, dismissed, expired (to tune the steward).
- Asks at close: asked, accepted, "not now".
- Cost per month against the cap.

A person sees their own contributions. Nobody sees a ranking of people.

## 17. Risks and how the plan handles them

| Risk | Safeguard |
|---|---|
| Knowledge-first drafts for tickets a person must handle | The triage check (step 2), proven on replay in Phase 0 before anything changes |
| A wrong article reaches a requester | Only Checked articles in automatic answers; two bad signals pull an article out at once; versions and restore |
| Confidence that looks precise but is not | Bands from observable evidence; calibration shown; automatic step-down |
| Agents get tired of being asked | Ask only with a reason; daily cap; "not now" remembered; most capture needs no ask |
| The steward floods the inbox | Impact sort, per-person cap, grouping, expiry, dismiss rate watched |
| AI-written text with invented steps | Proposed text must be supported by cited tickets or articles; a person accepts every change |
| Personal data in articles | The existing scrubber before and after the model; internal notes never read |
| Cost | Monthly cap per workspace; nightly work in batch; last 30 days of Auto-help cost US$4.59 |
| Other workspaces have flat categories (Accounting: 21, no subcategories) | The dial works on any tree; default row covers the rest |

## 18. Decisions for Vahid

1. **Rights by skill** as in section 7 (intermediate publishes as Not checked yet; advanced and expert confirm).
2. **Not checked yet articles** may be used in drafts and suggestions to agents, never in automatic answers.
3. **Ask at close**: at most once a day per agent, only with a reason (section 8).
4. **The steward never edits published text**; its only automatic action is pulling a doubtful article out of
   automatic answers.
5. **The sending bar** stays 30 reviewed, 85 % good, per category; Security and Account & Access stop at Suggest.
6. **Names**: "Special handling" for what is left of playbooks, "Answering" for the dial. "Auto-help" stays.
7. **Start**: Phase 0 on IT now; other workspaces only in Phase 5.

## 19. What already exists and is reused

Article store with sections and hybrid search; the answer runner with its checks, stay-quiet rules and leak guard;
the "enough to answer" check; the drafter from solved tickets and the personal-data scrubber; gap clustering; the
backtest tool; the readiness bar; the after-hours test; the monthly cost cap; the resolve dialog's solution note;
the FreshService article import; the review digest; the Tiptap editor; skills and levels per category.

## 20. Sources

- KCS v6 Practices Guide (reuse is review, flag it or fix it, licence levels):
  https://library.serviceinnovation.org/KCS/KCS_v6/KCS_v6_Practices_Guide/030/030/040/030 and
  https://library.serviceinnovation.org/KCS/KCS_v6/KCS_v6_Practices_Guide/030/040/030/020
- Zendesk, Getting started with AI agents (knowledge-only by default):
  https://support.zendesk.com/hc/en-us/articles/8724978128282-Getting-started-with-AI-agents
- Intercom, When to use Fin Guidance vs Procedures ("content first"):
  https://www.intercom.com/help/en/articles/14623785-when-to-use-fin-guidance-vs-procedures
- Intercom, AI-powered recommendations (gaps, duplicates, contradictions from conversations; review before use;
  four-week expiry): https://www.intercom.com/help/en/articles/11394959-use-ai-powered-suggestions-to-improve-fin
- ServiceNow, generate a knowledge article from a resolved incident (draft, then a person reviews):
  https://www.servicenow.com/docs/r/BgFKZnPHldZ62gGtzQ71Mw/MdVt1~gCXCQpCYHb5ITedA
- Zendesk, removal of Content Cues (a gap tool nobody used: a warning about passive gap lists):
  https://support.zendesk.com/hc/en-us/articles/8558652714778
- Google Research, the role of sufficient context (ICLR 2025):
  https://research.google/blog/deeper-insights-into-retrieval-augmented-generation-the-role-of-sufficient-context/
- Decagon, graduated autonomy (trust earned step by step): https://decagon.ai/glossary/what-is-graduated-autonomy
- Per-action confidence bands instead of one global threshold: https://www.tdcommons.org/dpubs_series/10581
- Air Canada chatbot ruling (the company owns the answer): https://www.law360.ca/ca/articles/1804075

Evidence notes: the Zendesk and Intercom "content first" pages were read directly; the KCS, ServiceNow, Decagon
and Content Cues points come from search summaries of those pages. No controlled study compares a playbook gate
with knowledge-first answering; the case rests on vendor practice, the abstention research and our own numbers.
