# MEGA 09-22 — QA package "Features Request - 09-22"

**Source:** `qa/09-22 Package/Features Request - 09-22.docx` (Susan Xu, QA), 11 items · **Workspaces:** IT (ws1), Project Accounting (ws5) · **Tester:** Susan
**Also in this train:** the hourly-review fixes parked since Monday (staggered full syncs, API reads that re-asked FreshService).

Status: ☐ open · ☑ done · ✎ your call (Vahid) · ⓘ explain (not a bug)

## The short version

| # | QA said | Verdict | Root cause (production) |
|---|---------|---------|-------------------------|
| 1 | Reply spacing still too wide | fix | The composer's plain text comes from the browser's `innerText`, which counts a paragraph boundary as two line breaks: `<p>Hi</p><p><br></p><p>Ticket…</p>` becomes five newlines, and the e-mail renders every newline as a `<br>` (TP-1618 delivery #8256 has `<br/><br/><br/><br/><br/>`). |
| 2 | Forwarded subject loses what the agent added | fix | Forward intake takes the subject from the quoted "Subject:" header of the forwarded block, not the outer mail: TP-1626 stored "A Code Setup Request", the outer subject was "A Code Setup Request (THIS IS A TEST)". |
| 3 | Alvina's "Open Ticket Pulse" button has a colour artifact | fix + explain | The PA "Ticket arrived" template draws the button as an `<a>` with padding and border-radius. Classic desktop Outlook (Word engine — the "Click here to download pictures" bar is its tell) ignores both, so the blue background hugs the text. Others use new Outlook/OWA and see a real button. Fix at send time: every padded anchor becomes a table-cell button, for every workflow. |
| 4 | Tickets page default should show everything | fix | Default scope was Open+Pending in two places (page + rail). Now no status is pre-selected; "My open" keeps its explicit Open+Pending scope. |
| 5 | Requester page: category, filters, agent avatars, tickets-page theme | build | The page listed subject/assignee name/status only; the list API already returns category and assignee photo. |
| 6 | Verified solutions | build (v1) + plan | No such field existed. v1: mark/unmark on any ticket (closed and FS-born included), badge on the ticket and in the queue, "Verified solutions" view, "Verified solutions in this category" card on the ticket, checkbox in the resolve dialog. |
| 7 | Own profile photo + admin uploads | build | Photos came only from Entra (`photos.routes.js` sync); no upload path, no place to edit. |
| 8 | Signature under "Notifications" | fix | Renamed to "Mail & alerts" (e-mail, alerts & signature); the new profile page links to it. |
| 9 | Remove Summit for regular agents | ⓘ explain | Already gated: `showAdminSummitLink = canManageWorkspace && workspace is IT` (AppHeader.jsx:192). Susan sees it because she is an IT admin; agents and other workspaces never get the row. |
| 10 | Mail Workflows takes seconds to load | fix | The list call returned every workflow's full draft AND published definitions (IT: 22 workflows incl. 9 archived, ~115 KB) and the page waited for seven calls plus the selected workflow before painting anything. Now the list paints as soon as it arrives, the selected workflow and the catalogs load alongside it, and the default-variant seeding (seven upserts on every list and every open) runs at most once per ten minutes. |
| 11 | Sidebar enable toggle too easy to hit | fix | Toggle removed from the rows; a quiet On/Off state stays; enabling lives in the workflow's own header. |

## 1. Reply spacing
**Fix:** `RichTextEditor` derives text by walking blocks (P/DIV/LI/H*/BLOCKQUOTE/PRE = one paragraph, `<br>` = one newline, an empty paragraph = one blank line) and collapses 3+ newlines to 2; `TicketDetail.htmlToText` reuses it. Server defence: `textToReplyHtml()` in ticketService collapses 3+ newlines before `<br/>` rendering (mail + FS mirror). Tests: RichTextEditor.test (block walk), ticketService test (collapse).

## 2. Forwarded subject
**Fix:** `_createFromForward` prefers the outer subject with FW:/Fwd: prefixes stripped; the quoted header subject is the fallback. Test in mailboxIngest forward tests.

## 3. E-mail buttons in classic Outlook
**Fix:** `utils/emailHtmlHardening.js` → `bulletproofButtons(html)` rewrites `<a style="…background…padding…">` into `<table><tr><td bgcolor>` buttons (MSO-safe); applied in the engine where `htmlBody` is finalised. Test with the PA template markup.

## 4. Tickets default scope
**Fix:** `defaultStatuses` → `[]` in Tickets.jsx and TicketFilterRail.jsx; `openStatuses` (Open+Pending bases) kept for "My open" and the "Show it" toast. Tests updated (boardDrop, myOpen, queueScope).

## 5. Requester page
**Build:** filter row (status: All / Open / Resolved; category; agent with avatar), rows show category › subcategory (leaf first, like the queue), assignee avatar + first name, status pill, date. Server-side filters via `ticketsAPI.list` (`requesterId`, `status`, `internalCategoryId`, `assignedTechId`, pageSize 100). Options come from an unfiltered first load.

## 6. Verified solutions (v1)
**Data:** `tickets.solution_verified_at`, `solution_verified_by`, `solution_note` (additive migration + partial index on `(workspace_id, internal_category_id) WHERE solution_verified_at IS NOT NULL`, CONCURRENTLY).
**API:** `POST /tickets/:id/solution { verified, note }` (any origin, any status; audit `solution_verified` / `solution_cleared`); `GET /tickets/:id/solutions` (same subcategory first, then category, then the FS category string; excludes self; 5); list param `solution=verified`.
**UI:** action-row button "Mark as solution" (note prompt, prefilled from the resolution note); header mark; queue subject-line mark; canned view "Verified solutions"; card "Verified solutions in this category" above Related; "This is a verified solution" checkbox in ResolveReasonModal.
**Plan only (next):** suggestions on the New ticket page as the category is picked; a Knowledge base view grouped by category with search over solution notes; FS write-back of a "verified" tag (Vahid's call).

## 7. Profile photo
**Data:** `technicians.photo_source` ('entra' | 'custom'); Entra sync skips custom.
**API:** `PUT /photos/me { dataUrl }` (own technician in the workspace, by e-mail), `PUT /photos/:id` (admin), `DELETE …` reverts to Entra. Data URL ≤ 300 KB, jpeg/png/webp.
**UI:** `/profile` page (avatar, name, e-mail, role, upload/replace/revert; links to Mail & alerts); the account menu's name block opens it; Members panel gets a photo action for admins.

## 8–11. See the table. (#10: definitions stay in the list payload — the sidebar's after-hours detection reads them; the cost was the seeding and the serial waits, not the bytes.)

## Hourly-review items in this train
- Scheduled full syncs take their own minute per workspace (`fullSyncCronExpression`).
- API v1 reads answer from the Ticket Pulse copy (`{ reconcile: false }`).

## Execution order
Backend (#1 defence, #2, #3, #6, #7, #10 omit, hourly items) → frontend (#1 editor, #4, #5, #6, #7, #8, #10, #11) → Jest / Vitest / lint:dark / build → migration to prod → release 3.9.67-preview → PDF + e-mail → watch.

## Deliverables
`qa/Features Request - 09-22 - Response.pdf` (+ copy in the package), `qa/evidence-0922/`, e-mail to Susan cc Vahid.

## 12. Inbound replies to approval e-mails on FS-born tickets are dropped (from Vahid via the UI Design session, 23 Sep)
**Symptom:** IT #242611 (Ray Tishenko) — everything after Vahid's approved-with-condition on 22 Sep never reached Ticket Pulse or FreshService; zero held messages in ws1 for ten days.
**Root cause:** the five approval sends in `ticketApprovalService` call `sendTransactionalEmail` without `ticket`, so the mail leaves with no `+fs<n>` Reply-To, no threading headers and no stored Message-ID. Ray's reply lands on plain ticketpulse@; rungs 1/1b/1.5 miss; rung 3 sees `[#242611]` on an FS-born ticket and returns `skip: freshservice_ref` ("FS receives this mail itself") — but it@ was never a recipient, so FreshService never saw it either. Replies with ticketpulse@ in Cc die on the same rung.
**Fix (3.9.68-preview, same night):**
1. Rung 3 skips only when the workspace's FreshService helpdesk address was among To/Cc (learned from `raw_payload.support_email` on outgoing `freshservice_conversation` entries, overridable via `fs_helpdesk_email_ws<N>`); otherwise the mail is ingested onto the FS-born ticket through the existing FS-born lane (`ingestReply` → `_writeReplyToFreshService`). Every skip is logged with a reason and counted on the mailbox health card.
2. All five approval sends pass `ticket` (+ `threadEntryId` where a system note exists) so the return address and Message-ID are there; the `+ap` Reply-To on approval questions stays.
3. New last rung for FS-born tickets: sender is the requester or a Cc participant, normalised subject equals the ticket subject, updated within 30 days, open → thread via the FS-born lane; more than one plausible ticket → hold with `bestGuessTicketId`.
4. Repair: Settings → Mailboxes "Re-check inbox since <date>" (uses `getInboxMessagesForIngest`), run for ticketpulse@ from 22 Sep so Ray's and Vahid's mails ingest through the fixed ladder.
Tests: `mailboxIngestService.test.js` rung 3 rewritten (skipped only with the helpdesk as recipient), new rung + hold cases.
