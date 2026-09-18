# -*- coding: utf-8 -*-
# Response to "Features Request - 09-17". Rendered by build_html.py -> report.html -> PDF.
from build_html import img, callouts, steps, pill

COVER = {
    'title': 'QA package 09-17 &mdash; what we found',
    'subtitle': ('Seven items. Four built and live, three answered with production evidence &mdash; including two '
                 'where the answer is &ldquo;nothing to build, here is what actually happened&rdquo;.'),
    'meta': ('<b>From</b> the Ticket Pulse team &nbsp;&middot;&nbsp; <b>To</b> the QA team, BGC<br/>'
             '<b>In reply to</b> &ldquo;Features Request &ndash; 09-17&rdquo; (7 items, 4 screenshots)<br/>'
             '<b>Date</b> 17 September 2026, item 6 corrected 18 September &nbsp;&middot;&nbsp; <b>Release</b> 3.9.32-preview &mdash; live<br/>'
             '<b>Checked in</b> Project Accounting (items 1, 5), IT (item 4), Accounting (item 5), '
             'Field Equipment (items 6, 7)'),
}

S1 = {
    'toc': 'The short version',
    'title': 'The short version',
    'html': f'''
<div class="verdict">
<b>Alvina is right, and the cause is worse than it looked.</b> Project Accounting <i>does</i> have calendar-aware
SLAs switched on &mdash; but all four of its SLA rows carry a per-row <b>24/7</b> override that silently beats the
workspace switch, so every ticket really was a 24 wall-clock-hour countdown. And even with the override removed,
&ldquo;calendar-aware&rdquo; only ever meant <i>business hours</i>: a Friday 2pm ticket would have come due
<b>Wednesday morning</b>, not Monday 2pm. Both are fixed, and Project Accounting is already on the new clock.
</div>

<table>
<tr><th style="width:4%">#</th><th style="width:29%">What you reported</th><th style="width:18%">Verdict</th><th>Cause, in one line</th></tr>

<tr><td>1</td><td>Calendar-aware SLAs still count weekends</td>
    <td>{pill('Confirmed','warn')} {pill('Fixed','ok')}</td>
    <td>Two faults. The four Project Accounting rows override the workspace calendar with <b>24/7</b>; and the
    calendar itself counted business <i>hours</i>, never whole <i>days</i>. New <b>Business days</b> clock
    &mdash; Friday 2pm &rarr; Monday 2pm &mdash; and Project Accounting is switched to it.</td></tr>

<tr><td>2</td><td>Add a trigger for &ldquo;unassigned for N hours&rdquo;</td>
    <td>{pill('Built','ok')}</td>
    <td>The time-trigger worker ran aging and the two SLA triggers only. Nothing watched assignment.</td></tr>

<tr><td>3</td><td>Columns drag only by the six dots</td>
    <td>{pill('Built','ok')}</td>
    <td>The drag handler sat on the grip, not on the row.</td></tr>

<tr><td>4</td><td>Soheil&rsquo;s API error on internal notes, then it fixed itself</td>
    <td>{pill('Explained','info')} {pill('Already fixed','ok')}</td>
    <td>Not the deploys. A FreshService attribution switch was turned on for IT at 2:20pm; FreshService answered
    <b>403</b> to every note carrying an agent identity. Switching it off at 3:35pm is the &ldquo;fixed
    itself&rdquo;. A guard shipped in 3.9.29 the same afternoon.</td></tr>

<tr><td>5</td><td>Is the APTickets &rarr; FreshService forward needed?</td>
    <td>{pill('Explained','info')} {pill('Your turn','you')}</td>
    <td><b>No.</b> Ticket Pulse already copies every Project Accounting ticket into FreshService itself. The
    forward adds a second, unlinked copy &mdash; and has already turned three out-of-office auto-replies into
    tickets. Remove it.</td></tr>

<tr><td>6</td><td>Check the Field Equipment e-mail setup</td>
    <td>{pill('Verified','ok')} {pill('Your call','you')}</td>
    <td>Receiving, threading, reopening and agent-Cc filing all work &mdash; your 3:30pm test became TP-1552.
    The mailbox is <b>receive-only</b>, which is what keeps the replying agent&rsquo;s name on replies; the only
    thing it costs is a Sent Items copy. It is a choice, not a gap. The workspace has no sender identity.</td></tr>

<tr><td>7</td><td>&ldquo;There is no E-mail identity in settings&rdquo;</td>
    <td>{pill('Our mistake','warn')} {pill('Fixed','ok')}</td>
    <td>The checklist was wrong. The card is called <b>Sender identity</b> and was buried inside Notification
    Workflows. It now also sits in <b>Settings &rarr; Ticket Mailboxes</b>, where you looked.</td></tr>
</table>

<p class="note">Every number below was read from the production database on 17 September, not inferred from the
screenshots.</p>
''',
}

S2 = {
    'toc': '1 &middot; Calendar-aware SLAs',
    'title': '1 &middot; Calendar-aware SLAs &mdash; Alvina is right, twice over',
    'html': f'''
<div class="asked">&ldquo;It&rsquo;s still counting the weekends. Alvina reported that on Sunday, she would find a
bunch of overdue tickets. Verify whether this is true. We want the counter to skip over the weekends. For example,
if a ticket arrives at 2pm on Friday, it should be due on Monday at 2pm.&rdquo;</div>

<h3>It is true, and here is the proof</h3>
<pre>ws5 "Project Accounting Team"   sla_calendar_aware = <b>TRUE</b>
business_hours ws5              Mon-Fri 08:00-17:00 America/Los_Angeles  (5 enabled rows)

sla_policies ws5   id 5  prio 1  resolve 1440  calendar_mode = <b>always_on</b>   set by sxu@  2026-08-21
                   id 6  prio 2  resolve 1440  calendar_mode = <b>always_on</b>
                   id 7  prio 3  resolve 1440  calendar_mode = <b>always_on</b>
                   id 8  prio 4  resolve 1440  calendar_mode = <b>always_on</b>

every Project Accounting ticket, last 14 days:   due_by - created_at = <b>24.0 hours exactly</b>
tickets due on a Saturday or Sunday, last 30 d:  <b>21</b>
created Friday, due Saturday:                    <b>10</b>
open and overdue at the moment we looked:        <b>12</b></pre>

<h3>Fault one: a row can silently beat the workspace switch</h3>
<p>The workspace switch was on. But each SLA row also carries its own clock setting, and a row set to <b>24/7</b>
overrides the workspace. All four Project Accounting rows were set that way on 21 August &mdash; those are the four
lit <b>24/7</b> badges in your screenshot. Nothing in the panel said that lighting them up turns the calendar off,
so the workspace switch looked on and did nothing for a month.</p>
{img('qa-reported-1.png', 'Your screenshot. The four lit 24/7 badges are the override &mdash; each one cancels the calendar for that row.', '78%')}

<h3>Fault two: &ldquo;calendar-aware&rdquo; counted hours, not days</h3>
<p>Even with the overrides removed, the old behaviour would not have given you Monday 2pm. It consumed only the
minutes inside 08:00&ndash;17:00, so a 1440-minute (24-hour) target taken at Friday 2pm burns 3 hours on Friday,
9 on Monday, 9 on Tuesday and comes due <b>Wednesday around 11am</b>. That is a reasonable clock for a target
written in <i>working hours</i> (&ldquo;four business hours to first response&rdquo;), and the wrong one for a
target written in <i>days</i> &mdash; which is what Project Accounting has.</p>

<h3>What we changed</h3>
<p>A calendar-aware workspace now chooses what the clock skips. <b>Business days</b> is new: the clock runs
24&nbsp;hours a day but skips non-working days whole, so Friday 2pm plus 24 hours is Monday 2pm. Holidays from
Settings &rarr; Business Hours &amp; Holidays are skipped the same way.</p>
{img('m1-sla-calendar.png', 'Settings &rarr; Ticket Ops &rarr; SLA policies, as it looks for Project Accounting now.', '92%')}
<p>The per-row 24/7 badge is now a named clock picker, and &ldquo;Workspace default&rdquo; says what it currently
resolves to &mdash; so a row that overrides the calendar can no longer do it quietly. And the card warns you when
the state Project Accounting was in happens again:</p>
{img('m1b-sla-warning.png', 'The warning you would have seen on 21 August.', '92%')}

<h3>Project Accounting is already on the new clock</h3>
<p>We did not leave this as a setting for you to find. The workspace is switched to <b>Business days</b> and all
four rows now follow it. Verified against production after the change, for all four priorities:</p>
<pre>Friday 18 Sep 14:00 PDT + 1440 minutes  &rarr;  <b>Monday 21 Sep 14:00 PDT</b></pre>

<div class="danger">
<b>One thing to know.</b> A due date is calculated once, when the ticket is created, and then stored. The
<b>12 tickets that are overdue today keep their old due dates</b> &mdash; the new clock applies to tickets created
from now on. If you want the open ones recalculated, say so and we will do it in one pass.
</div>

<h3>Try it</h3>
{steps([
  'Create a Project Accounting ticket late on a Friday afternoon (or any Friday after 2pm) and look at its due date &mdash; it should be the same time on Monday.',
  'Settings &rarr; Ticket Ops &rarr; SLA policies: the clock column on each row now reads <b>Workspace default (Business days)</b>.',
  'Set one row to <b>24/7</b> and watch the wording change &mdash; that row is now openly overriding the calendar.',
  'On the Sunday after this ships, check the overdue count for Project Accounting. Only tickets created before today should appear.',
])}
''',
}

S3 = {
    'toc': '2 &middot; Unassigned-for-N-hours trigger',
    'title': '2 &middot; A trigger for &ldquo;nobody picked this up&rdquo;',
    'html': f'''
<div class="asked">&ldquo;In the email workflows, add a trigger for ticket unassigned for N hours&hellip; when a
ticket is unassigned for N hours an email can be sent to the same email thread as the Ticket Received email chain.
This will probably happen automatically if we keep the same subject but the trigger is missing.&rdquo;</div>

<h3>You were right about both halves</h3>
<p>The time-trigger worker ran exactly three things &mdash; unresolved-for-N-hours, SLA about to breach, SLA
breached. Nothing watched assignment. And yes, keeping the subject is what threads the mail: workflow e-mails
already carry the ticket&rsquo;s threading headers, so a reply with the same subject lands in the requester&rsquo;s
existing &ldquo;Ticket received&rdquo; chain.</p>

<h3>What we built</h3>
{img('m2-unassigned-trigger.png', 'Mail Workflows &rarr; the trigger node, with your 20-hour example.', '88%')}
<p>It scans open tickets with nobody assigned, every few minutes, and fires once per ticket. Two details worth
knowing:</p>
<ul>
<li><b>The clock restarts when a ticket is released.</b> If somebody takes a ticket and then puts it back in the
queue, the countdown starts again from the moment they let go &mdash; not from when the ticket arrived. So a
ticket that bounces back to the queue is chased again instead of being silently skipped.</li>
<li><b>Pending tickets are left alone.</b> A ticket waiting on the requester is not waiting for somebody to pick
it up, so it does not trigger.</li>
</ul>

<h3>A ready-made workflow ships with it</h3>
<p>Mail Workflows &rarr; Templates now offers <b>&ldquo;Nobody picked this up (unassigned for N hours)&rdquo;</b>.
It adds an internal note flagging the ticket for the team, and sends the requester a short note that keeps the
ticket subject &mdash; which is what puts it in the same chain. It installs disabled, like every template, so you
set the hours and read it before it does anything.</p>

<h3>Try it</h3>
{steps([
  'Settings &rarr; Mail Workflows &rarr; Templates &rarr; install <b>Nobody picked this up</b>.',
  'Open the trigger node, set <b>Fire when unassigned for (hours)</b> to 20 (or 1, for testing), publish, enable.',
  'Leave a test ticket unassigned past the threshold. Within five minutes the internal note appears and the e-mail goes out, in the requester&rsquo;s existing thread.',
  'Assign the ticket, then unassign it again &mdash; the trigger re-arms and fires a second time once the hours pass.',
])}
''',
}

S4 = {
    'toc': '3 &middot; Dragging columns',
    'title': '3 &middot; Columns drag by the whole row',
    'html': f'''
<div class="asked">&ldquo;Right now, columns can only be dragged by the 6 dots in the front. This is unintuitive.
Make it so that the entire row can be dragged to adjust the order of the columns.&rdquo;</div>

<p>Fair. The drag handler was attached to the grip icon; the row only listened for drops. It is on the row now
&mdash; grab a column anywhere, including its name.</p>
{img('m3-columns-drag.png', 'Anywhere on the row starts the drag. The blue line is where it will land.', '58%')}
<ul>
<li>The <b>checkbox still toggles</b> instead of starting a drag.</li>
<li>The grip keeps its grab cursor, so it still reads as the handle, and keeps <b>Alt&nbsp;+&nbsp;&uarr;/&darr;</b>
for keyboard users.</li>
<li>Text no longer smears blue when you drag across a label.</li>
</ul>
''',
}

S5 = {
    'toc': '4 &middot; Soheil&rsquo;s API error',
    'title': '4 &middot; Soheil&rsquo;s 403 &mdash; what really happened',
    'html': f'''
<div class="asked">&ldquo;Soheil couldn&rsquo;t add an internal note to any ticket today. He received an API error.
Nobody else had this issue. It was just Soheil. An hour or so later, this issue was fixed by itself. Figure out why
this happened and prevent it from happening again. (Vahid&rsquo;s note: this could be related to us developing
during the day and restarting backend.)&rdquo;</div>

{img('qa-reported-3.png', 'The error Soheil saw.', '62%')}

<div class="verdict">
<b>It was not the restarts.</b> It was a setting we turned on that morning, and turning it back off is the
&ldquo;fixed itself&rdquo;. The restarts at 2:24, 3:34 and 4:10 pm carried no errors at all.
</div>

<h3>The timeline, from the production log and the settings history</h3>
<pre>2:20 pm   setting <b>fs_reply_as_agent_ws1</b> turned ON
          ("FreshService attributes our replies and notes to the acting agent")
2:50-2:56 POST /tickets/242909/notes  &rarr;  <b>403</b>  x14
          body: "[Ticket Pulse note] Soheil Nasiri ..."
3:24 pm   the same 403 on a reply on #242882 (the e-mail itself still went out)
3:35 pm   setting <b>fs_reply_as_agent_ws1</b> turned OFF      &larr; "fixed itself"
4:05 pm   Soheil's note on 242909 posts normally (fs-conversation:1043085631)</pre>

<p>With that setting on, Ticket Pulse tells FreshService <i>who</i> is writing, so the note appears under the
agent&rsquo;s own name instead of the API account. FreshService refuses that on this tenant &mdash; our API key is
not allowed to write as another person &mdash; and rejects the whole note rather than just the attribution.</p>
<p>Why only Soheil: he was the one adding internal notes in that 75-minute window.</p>

<h3>Why it cannot happen again</h3>
<p>Shipped the same afternoon in <b>3.9.29</b>: when FreshService refuses the attribution, Ticket Pulse retries the
note immediately as the API account and records the refusal in the log. The note always lands; only the name on it
can fall back. The setting itself is off for IT and stays off until FreshService allows it.</p>
<p class="note">Worth keeping: &ldquo;only one person, then it healed on its own&rdquo; is almost always a setting
that was changed and changed back, not a deploy. Deploys break everybody at once, and they do not heal.</p>
''',
}

S6 = {
    'toc': '5 &middot; The APTickets forward',
    'title': '5 &middot; The APTickets forward &mdash; not needed, and not harmless',
    'html': f'''
<div class="asked">&ldquo;The Accounting workspace has APTickets forwarded to
bgcengineeringcaAPTickets@efusion.freshservice.com. Is this necessary? Wouldn&rsquo;t this cause duplicate tickets
because Ticket Pulse syncs with FreshService? &hellip; we were puzzled that why we did it for APTickets, maybe it
was necessary at some point and now it&rsquo;s not needed, but then why aren&rsquo;t duplicates? Ideally we want
to remove the forward if it&rsquo;s not necessary.&rdquo;</div>

<div class="verdict"><b>Remove it.</b> Ticket Pulse already puts every Project Accounting ticket into FreshService
itself. The forward adds a second, unlinked copy of every inbound e-mail &mdash; and it has already turned three
out-of-office auto-replies into tickets.</div>

<h3>What production says</h3>
<pre>workspaces           ws5 "Project Accounting Team"  &rarr;  FreshService workspace 8
mailbox_connections  patickets@bgcengineering.ca   mode = ingest   connected to Ticket Pulse

Project Accounting tickets, last 30 days
  136  from the Power App     (the team's real intake)
   11  from e-mail
    5  born in FreshService   &larr; <b>this is the forward's footprint</b>

those 5:  #240320 / #240321 / #240322  "<b>Automatic reply: Ticket received: #TP-1211</b>"  2 Sep
          #240116 / #240118            QA reply tests                                      1 Sep

the last 8 Ticket Pulse tickets in this workspace:  <b>8 of 8 carry a FreshService id, state = mirrored</b></pre>

<h3>Why there are no duplicates to complain about</h3>
<p>Three reasons stacked up, which is why this went unnoticed for so long:</p>
<ul>
<li><b>Project Accounting barely uses e-mail.</b> 11 of 148 tickets in a month arrived by mail. The rest come from
the Power App, which the forward never sees.</li>
<li><b>The team works in Ticket Pulse.</b> The forwarded copies land in the FreshService queue, where nobody on
that team looks.</li>
<li><b>The one visible symptom looked like junk, not like duplication.</b> When Ticket Pulse sent a
&ldquo;Ticket received&rdquo; confirmation, the requester&rsquo;s out-of-office reply went to patickets@, was
forwarded to FreshService, and became its own ticket &mdash; three of those on 2 September.</li>
</ul>

<h3>Where it came from</h3>
<p>Before Ticket Pulse ingested patickets@ directly, the forward was the <i>only</i> route from that mailbox into a
ticketing system. Once the mailbox was connected here and the mirror started copying tickets into FreshService
workspace 8, the forward became a second, redundant path. Field Equipment was set up without one, which is why it
behaves correctly &mdash; your instinct there was right.</p>

<div class="danger"><b>Your turn:</b> delete the Exchange forwarding rule on
<code>patickets@bgcengineering.ca</code>. Nothing in Ticket Pulse changes, and the FreshService copies keep arriving
through the mirror as they do today. Worth a quick check first that no FreshService report or automation reads the
forwarded tickets specifically.</div>
''',
}

S7 = {
    'toc': '6 &middot; Field Equipment e-mail',
    'title': '6 &middot; Field Equipment &mdash; working, with one choice and one gap',
    'html': f'''
<div class="asked">&ldquo;Check the email setup for the field equipment team. Verify whether it&rsquo;s setup
correctly to send and receive emails to requesters and whether the forward function is setup.&rdquo;</div>

<h3>What production says</h3>
<pre>mailbox_connections  ws4  <b>fetickets@bgcengineering.ca</b>   enabled   mode = <b>ingest</b>
                     new-ticket policy = hold unknown senders
                     agent Cc intake   = <b>on</b>
                     routes to group 1000209769
                     last message 3:34 pm   errors: <b>none, ever</b>

tickets ws4          <b>TP-1552</b> created from mail at 3:30 pm today
workflows ws4        "Reopen on requester reply"  <b>enabled</b>
workspace_email_identities   no row for ws4</pre>

<table class="kv">
<tr><td>Receiving mail</td><td>{pill('Works','ok')} Your 3:30pm test became TP-1552.</td></tr>
<tr><td>Replying to requesters</td><td>{pill('Works','ok')} Replies go out from <code>fetickets@</code> and come back to the ticket.</td></tr>
<tr><td>Requester reply reopens the ticket</td><td>{pill('Works','ok')} The workflow is enabled (it ships disabled &mdash; somebody turned it on correctly).</td></tr>
<tr><td>Forwarding an e-mail in to file it</td><td>{pill('Works','ok')} Agent Cc intake is on: forward or Cc the mailbox and the ticket is filed under the original sender.</td></tr>
<tr><td>Forward to FreshService</td><td>{pill('Correct as is','ok')} Deliberately absent &mdash; see item 5. Do not add one.</td></tr>
<tr><td>Individual agent names on replies</td><td>{pill('Works','ok')} A reply reads as the agent who wrote it, over the team address.</td></tr>
<tr><td>Copy of replies in the mailbox&rsquo;s Sent Items</td><td>{pill('Your call','you')} Not today &mdash; and getting it costs the line above.</td></tr>
<tr><td>Sender identity</td><td>{pill('Gap','warn')} No row for this workspace, so its mail signs &ldquo;Ticket Pulse&rdquo;.</td></tr>
</table>

<div class="danger">
<b>Correction, 18 September.</b> The first version of this document told you to switch <code>fetickets@</code>
from <b>Ingest only</b> to <b>Ingest + send</b>. That advice was wrong on its own and has been withdrawn &mdash; a
separate e-mail went out the same day. The mode is a trade-off, not a fix, and it is explained below.
</div>

<h3>The mailbox mode decides whether replies can carry an agent&rsquo;s name</h3>
<p>The mode does more than allow sending. It picks <i>which service sends the mail</i>, and that decides whether a
reply can show the person who wrote it.</p>
<table>
<tr><th style="width:44%"></th><th style="width:28%">Ingest only (today)</th><th>Ingest + send</th></tr>
<tr><td>Sends from <code>fetickets@</code></td><td>Yes</td><td>Yes</td></tr>
<tr><td>Reply comes back to the ticket</td><td>Yes</td><td>Yes</td></tr>
<tr><td>Reply shows the individual agent&rsquo;s name</td><td><b>Yes</b></td><td>No &mdash; always the team name</td></tr>
<tr><td>Copy of the reply in the mailbox&rsquo;s Sent Items</td><td>No</td><td><b>Yes</b></td></tr>
</table>
<p>On <b>Ingest only</b>, SendGrid sends and any From name we set survives, so the reply reads as the agent over
the team address. On <b>Ingest + send</b>, Microsoft Graph sends as the mailbox and Exchange rewrites the From
name to that mailbox&rsquo;s own directory name &mdash; every reply reads as the team. No setting gives you both:
Exchange owns the display name on a shared-mailbox send.</p>
<p>All three mailboxes &mdash; IT, Project Accounting and Field Equipment &mdash; are on Ingest only, so all three
show individual names today. <b>IT is staying that way.</b> Field Equipment and Project Accounting are a choice
for those teams.</p>
<p>The panel now states the trade on both modes, and the mode list names which way each one goes:</p>
<pre>Ingest only   &rarr; "Receive only. Replies still leave from this address, but through SendGrid, so they
                can carry the replying agent's name - and nothing is copied to this mailbox's Sent Items."
Ingest + send &rarr; "Sends through the mailbox, so replies are copied to its Sent Items - but Microsoft 365
                replaces the From name with this mailbox's own name, so requesters never see the
                individual agent."</pre>

<h3>The one real gap &mdash; no sender identity</h3>
<p>Only Project Accounting has one, so Field Equipment&rsquo;s mail signs &ldquo;Ticket Pulse&rdquo; rather than
&ldquo;Field Equipment&rdquo;. That is item 7, and the card is now where you would look for it.</p>

<h3>Your turn</h3>
{steps([
  'Switch to the <b>Field Equipment Team</b> workspace &rarr; Settings &rarr; <b>Ticket Mailboxes</b>.',
  'Set the <b>Sender identity</b> From-name at the top of that page to &ldquo;Field Equipment&rdquo;.',
  'Ask the team the plain question: when a requester gets a reply, should it come from a <i>person</i> or from the <i>team</i>? Leave the mode alone for a person, switch it to Ingest + send for the team.',
  'Send one more test from outside and reply to it, to confirm the loop end to end.',
])}
''',
}

S8 = {
    'toc': '7 &middot; Where E-mail identity lives',
    'title': '7 &middot; &ldquo;There is no E-mail identity in settings&rdquo; &mdash; our mistake',
    'html': f'''
<div class="asked">&ldquo;We checked the QA test plan for 09-16. There is no E-mail identity in settings. What are
you referring to?&rdquo;</div>

{img('qa-reported-4.png', 'Step 4 of our own checklist, which sent you looking for something that does not exist under that name.', '70%')}

<p>You were right and the checklist was wrong. There is no &ldquo;E-mail identity&rdquo; page. The card is called
<b>Sender identity</b>, and it was three levels down:</p>
<pre>Settings &rarr; Notification Workflows &rarr; Email Branding &rarr; Sender identity</pre>
<p>Nothing linked to it from Ticket Mailboxes, which is exactly where somebody setting up a mailbox looks &mdash;
so the instruction was not just misnamed, it was unfindable.</p>

<h3>What we changed</h3>
<p>The same card is now mounted at the top of <b>Settings &rarr; Ticket Mailboxes</b> as well. It is one card in
two places, not a copy: set the From-name in either and it is the same setting. The Email Branding tab keeps it too,
so nobody&rsquo;s bookmark breaks.</p>
<p>The corrected step, for your 09-16 plan:</p>
<pre><b>4.</b> Settings &rarr; Ticket Mailboxes &rarr; <b>Sender identity</b>: set the From-name
   (for example "Field Equipment"), and tick "replies use the agent's name" if the team wants that.</pre>
''',
}

S9 = {
    'toc': 'What changed, and your list',
    'title': 'What changed, and your list',
    'html': f'''
<h3>Release 3.9.32-preview &mdash; live</h3>
<table>
<tr><th style="width:4%">#</th><th style="width:34%">Change</th><th>Where to see it</th></tr>
<tr><td>1</td><td>Business-days SLA clock</td><td>Settings &rarr; Ticket Ops &rarr; SLA policies. Project Accounting is already switched to it.</td></tr>
<tr><td>1</td><td>Per-row clock picker + override warning</td><td>Same card. A row can no longer cancel the calendar quietly.</td></tr>
<tr><td>2</td><td><b>Ticket unassigned for N hours</b> trigger</td><td>Mail Workflows &rarr; trigger list, under Time-based. Template: &ldquo;Nobody picked this up&rdquo;.</td></tr>
<tr><td>3</td><td>Whole-row column drag</td><td>Tickets &rarr; Columns.</td></tr>
<tr><td>6</td><td>Ingest-only mailboxes explain themselves</td><td>Settings &rarr; Ticket Mailboxes.</td></tr>
<tr><td>7</td><td>Sender identity moved into reach</td><td>Settings &rarr; Ticket Mailboxes, top of the page.</td></tr>
</table>

<h3>For you to do or decide</h3>
<table>
<tr><th style="width:4%">#</th><th style="width:30%">Item</th><th>Action</th></tr>
<tr><td>1</td><td>The 12 already-overdue Project Accounting tickets</td>
    <td><b>Decide:</b> leave their stored due dates as they are, or tell us to recalculate the open ones on the new clock. New tickets are already correct.</td></tr>
<tr><td>5</td><td>The APTickets forward</td>
    <td><b>Remove</b> the Exchange rule on <code>patickets@</code>. Check first that no FreshService report reads those forwarded tickets.</td></tr>
<tr><td>6</td><td>Field Equipment mailbox mode</td>
    <td><b>Decide, do not switch by default.</b> Ingest only (today) keeps the replying agent&rsquo;s name on replies;
    Ingest + send adds a Sent Items copy but makes every reply read as the team. IT is staying on individual names.</td></tr>
<tr><td>6</td><td>Field Equipment sender identity</td>
    <td><b>Set</b> the From-name to &ldquo;Field Equipment&rdquo; in Settings &rarr; Ticket Mailboxes.</td></tr>
<tr><td>4</td><td>FreshService agent attribution</td>
    <td><b>Nothing now.</b> The setting stays off for IT. If you want notes to carry the agent&rsquo;s own name in
    FreshService, that needs FreshService to allow our API key to write as another user.</td></tr>
</table>

<h3>Watch</h3>
<p>The hourly production review continues through Friday 18 September, 5&nbsp;pm Pacific, and now includes the new
SLA clock and the unassigned trigger. Anything that misbehaves overnight gets fixed before you see it.</p>
''',
}

SECTIONS = [S1, S2, S3, S4, S5, S6, S7, S8, S9]
