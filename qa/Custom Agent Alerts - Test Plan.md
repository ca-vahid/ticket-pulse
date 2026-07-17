# Custom Agent Alerts — QA Test Plan (v3.0.67-preview)

**From:** Ticket Pulse dev · **Feature:** per-agent custom alerts (agent portal)
**Built from:** agent feedback — "agents want to follow certain categories/tags
and be alerted, with different triggers and delivery methods, and protection
against alert storms."

## What it does

Any agent can, in their own portal, create **alert subscriptions**. Each
subscription matches tickets by **category/subcategory**, **tag**, and/or a
**minimum priority**, and fires on the events they choose — delivered by the
channels they choose. Bursts are grouped into a single alert.

- **Where:** log in as an agent → **My Competencies** portal → **My Alerts** tab.
- **Match on:** a category (top or sub), a tag, a minimum priority (High+ or
  Urgent-only) — combine them (all conditions must hold).
- **Trigger on:** a matching ticket **arrives (new)**, is **escalated** (its
  priority is raised), or is **re-categorized** into your scope.
- **Deliver via:** Email, SMS, WhatsApp, or Phone call. (SMS/WhatsApp/Phone
  require a verified phone — set one up in the **Notifications** tab first.)
- **Scope:** alerts cover *any* matching ticket in your workspace, not just
  tickets assigned to you.
- **Quiet hours:** optionally mute alerts for a nightly window (they queue and
  deliver when it ends); Urgent can be allowed through.

## How to test

### 1. Create a subscription
1. Open **My Alerts** → **Add an alert**.
2. Pick a Category you can generate test tickets for (e.g. a Licensing or
   Software category). Leave Tag/Priority as "Any" for the first test.
3. Leave **arrives (new)** checked; leave **Email** checked.
4. (Optional) name it, e.g. "Licensing watch". **Create alert.**
5. ✅ It appears in the list showing the scope, the triggers, and channel icons.

### 2. New-ticket alert
1. Create a **QA TEST** ticket in that category (or reclassify one into it).
2. Within ~30–60 seconds you should receive **one email**: "Ticket Pulse alert:
   1 new ticket in <category>", listing the ticket with a link.
3. ✅ Email arrives; the link opens the ticket.

### 3. Alert-storm protection (the important one)
1. Quickly create **several** QA TEST tickets in the same category (or ask the
   team to, to simulate a burst).
2. ✅ You should get **one** grouped email — "N new tickets in <category>",
   listing them — **not** one email per ticket.

### 4. Priority-escalation alert
1. Edit the subscription (or make a new one) and check **is escalated (priority
   raised)**. Set the priority filter to **High and Urgent** if you like.
2. Raise a matching ticket's priority to High or Urgent.
3. ✅ You receive an "escalated" alert for it.

### 5. Re-categorized alert
1. On a subscription, check **is re-categorized into scope**.
2. Move a ticket's category into your watched category (via AI triage or a
   reclassification).
3. ✅ You receive a "re-categorized" alert.

### 6. Priority filter
1. On a subscription set **Priority = Urgent only**.
2. Create a **Medium** ticket in scope → ✅ **no** alert.
3. Create an **Urgent** ticket in scope → ✅ alert.

### 7. Other channels (optional — needs a verified phone)
1. In the **Notifications** tab, verify a phone number.
2. Back in **My Alerts**, edit a subscription and enable **SMS** (and/or
   WhatsApp / Phone call).
3. Trigger a matching ticket → ✅ you get the SMS/WhatsApp/call in addition to
   email. (If the phone isn't verified, those channels are greyed out with a
   hint.)

### 8. Quiet hours
1. Enable **Quiet hours** and set a window that covers "now" (e.g. start a few
   minutes ago, end a few minutes ahead). Leave "let Urgent through" as you
   like.
2. Trigger a **non-urgent** matching ticket → ✅ the alert does **not** arrive
   during the window; it should arrive shortly **after** the window ends.
3. (If "let Urgent through" is on) trigger an **Urgent** ticket during the
   window → ✅ it comes through immediately.

### 9. Pause / edit / delete
- **Pause** a subscription → matching tickets no longer alert until you Resume.
- **Edit** changes scope/triggers/channels.
- **Delete** removes it.

## Notes for QA
- There's a short grouping delay by design (up to ~60–90s) so bursts can be
  collapsed — a single ticket will alert within about a minute, not instantly.
- The same ticket never alerts you twice for the same trigger on the same
  subscription.
- Use the **QA TEST** prefix on tickets you create, and clean them up as usual.
- Please report: anything that sends duplicate alerts, an alert that fires for a
  ticket that shouldn't match, a channel that doesn't deliver, or quiet hours
  not being respected.
