"""Per-person ticket follow-up emails (the /ticket-followups skill).

Two sub-commands, both reading the JSON written by backend/scripts/followup-probe.mjs:

  python briefs/followups/followups.py candidates <data.json> [--exclude fs,fs]
      Applies Vahid's rules and prints who qualifies, why, and every ticket that would be
      raised WITH its latest human note — so the analyst can judge exclusions and write openers.

  python briefs/followups/followups.py render <data.json> --openers openers.json --out <dir>
                                        [--exclude fs,fs]
      Writes <dir>/<email>.html (one per person), <dir>/review.html (all of them, for Vahid)
      and <dir>/recipients.json. Refuses if any qualifying person lacks an opener.

Rules (Vahid, 23 Sep 2026). A person gets an email if ANY of:
  * 3 or more Open tickets past their due date
  * any Pending ticket with no human update for 30+ days
  * any Urgent/High Open ticket due within the next 7 days with no human update at all
Only those three kinds of ticket are raised. Tickets due later (e.g. RTBT items due Dec 31)
are never raised just for having no update. Machine notes ("[Ticket Pulse] …") are not updates.
Test tickets (subject starts "QA TEST" / "[SIMORGH TEST") are ignored. Inactive people and the
sender are never emailed. Links are Ticket Pulse only (never FreshService).

openers.json: {"<Full Name>": {"open": "text with {od} {st} {un} {res}", "asks": {"<fs>": "ask"}}}
  {od}=past-due count, {st}=quiet-pending count, {un}=urgent count, {res}=resolved last 7 days.
First names/nicknames come from nicknames.json next to this file (e.g. Muhammad Shahidullah → Mo).
"""
import argparse
import datetime
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TP = 'https://ticketpulse.bgcsaas.com/tickets'
PRI = {4: ('Urgent', '#dc2626'), 3: ('High', '#d97706'), 2: ('Medium', '#64748b'), 1: ('Low', '#94a3b8')}
OVERDUE_MIN, STALE_DAYS, URGENT_WINDOW_DAYS, SHOW_EACH = 3, 30, 7, 4
TEST = re.compile(r'^\s*(QA TEST|\[SIMORGH TEST)', re.I)
SUBJECT = 'Your tickets: a few to look at'

sys.stdout.reconfigure(encoding='utf-8')


def dt(v):
    return datetime.datetime.fromisoformat(v.replace('Z', '+00:00')) if v else None


def fmt(v):
    x = dt(v).date()
    now = datetime.date.today()
    return x.strftime('%b ') + str(x.day) + (x.strftime(', %Y') if x.year != now.year else '')


def since(days):
    if days < 60:
        return f'{days} days'
    m = round(days / 30.44)
    return f'{m} months' if m < 12 else ('over a year' if days < 548 else f'about {round(days / 365.25)} years')


def classify(data, exclude):
    now = datetime.datetime.now(datetime.timezone.utc)
    sender = data['sender']['email'].lower()
    techs = {t['name']: t for t in data['techs']}
    people = {}
    for r in data['tickets']:
        if TEST.search(r['subject'] or '') or str(r['fs']) in exclude:
            continue
        t = techs.get(r['agent'])
        if not t or (t['email'] or '').lower() == sender:
            continue
        due = dt(r['due'])
        r['overdue'] = r['status'] == 'Open' and due is not None and due < now
        r['stale'] = r['status'] == 'Pending' and r['quiet_days'] >= STALE_DAYS
        r['urgent'] = (r['status'] == 'Open' and (r['priority'] or 0) >= 3 and not r['last_human_at']
                       and due is not None and now <= due <= now + datetime.timedelta(days=URGENT_WINDOW_DAYS))
        people.setdefault(r['agent'], []).append(r)
    result = []
    for name, rs in sorted(people.items()):
        un = sorted([r for r in rs if r['urgent']], key=lambda r: r['due'])
        od = sorted([r for r in rs if r['overdue']], key=lambda r: r['due'])
        st = sorted([r for r in rs if r['stale']], key=lambda r: -r['quiet_days'])
        reasons = []
        if un:
            reasons.append(f'{len(un)} urgent/high due this week with no update')
        if len(od) >= OVERDUE_MIN:
            reasons.append(f'{len(od)} past due')
        if st:
            reasons.append(f'{len(st)} pending quiet {STALE_DAYS}+ days')
        if reasons:
            result.append(dict(name=name, tech=techs[name], un=un, od=od, st=st, reasons=reasons))
    return result


def cmd_candidates(data, exclude):
    people = classify(data, exclude)
    print(f'{len(people)} qualify (rules: >={OVERDUE_MIN} past due | pending quiet >={STALE_DAYS}d | '
          f'urgent/high due <={URGENT_WINDOW_DAYS}d with no update)\n')
    for p in people:
        t = p['tech']
        print(f"== {p['name']} <{t['email']}> | resolved 7d: {t['resolved_7d']} | {', '.join(p['reasons'])}")
        for tag, rs in (('URGENT', p['un']), ('PASTDUE', p['od']), ('QUIET', p['st'])):
            for r in rs:
                when = f"due {r['due'][:10]}" if tag != 'QUIET' else f"quiet {r['quiet_days']}d"
                note = (r['note'] or '').strip()[:120]
                print(f"   {tag:7} #{r['fs']} P{r['priority']} {r['subject'][:70]} | {when} | last note: {note or '-'}")
        print()


def signature_html(data):
    h = data['sender'].get('signatureHtml') or ''
    if data['sender'].get('signatureSpacing', 'tight') == 'tight':  # = applySignatureSpacing('tight')
        h = re.sub(r'<p(?![^>]*margin)([^>]*)>', r'<p style="margin:0"\1>', h)
    return h


def default_ask(r):
    if r['urgent']:
        return 'Could you add a first update today?'
    return 'Update, or a new date?' if r['overdue'] else 'Still waiting on something, or can it close?'


def row(r, asks):
    lbl, col = PRI.get(r['priority'] or 2, PRI[2])
    what = f"Due {fmt(r['due'])}" if (r['overdue'] or r['urgent']) else f"No update in {since(r['quiet_days'])}"
    ask = asks.get(str(r['fs'])) or default_ask(r)
    return (f'<tr><td style="padding:6px 10px 6px 0;vertical-align:top;font-size:13px;color:{col};font-weight:700;white-space:nowrap;">{lbl}</td>'
            f'<td style="padding:6px 0;vertical-align:top;font-size:13.5px;color:#1f2937;line-height:1.45;">'
            f'<a href="{TP}/{r["tp_id"]}" style="color:#1d4ed8;text-decoration:none;">#{r["fs"]}</a> {r["subject"]}'
            f'<br><span style="color:#6b7280;font-size:12.5px;">{what}. {ask}</span></td></tr>')


def section(title, items, asks, more_href, noun):
    if not items:
        return ''
    shown = items[:SHOW_EACH]
    extra = len(items) - len(shown)
    more = (f'<p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Plus {extra} more {noun}: '
            f'<a href="{more_href}" style="color:#1d4ed8;text-decoration:none;">see the full list</a>.</p>') if extra else ''
    return (f'<p style="margin:14px 0 4px;"><b>{title}</b></p>'
            f'<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">{"".join(row(r, asks) for r in shown)}</table>{more}')


def cmd_render(data, exclude, openers, outdir):
    nick = json.load(open(os.path.join(HERE, 'nicknames.json'), encoding='utf-8'))
    people = classify(data, exclude)
    missing = [p['name'] for p in people if p['name'] not in openers]
    if missing:
        raise SystemExit(f'no opener written for: {", ".join(missing)}')
    os.makedirs(outdir, exist_ok=True)
    sig = signature_html(data)
    cards, recipients = [], []
    for p in people:
        o, t = openers[p['name']], p['tech']
        first = nick.get(p['name']) or p['name'].split()[0]
        asks = {str(k): v for k, v in (o.get('asks') or {}).items()}
        opener = o['open'].format(od=len(p['od']), st=len(p['st']), un=len(p['un']), res=t['resolved_7d'])
        opener = opener[0].upper() + opener[1:]
        tid = t['id']
        body = (f'<p style="margin:0 0 12px;">Hi {first},</p>'
                f'<p style="margin:0 0 12px;">Following up on my email to the team, here&rsquo;s your own breakdown, so it&rsquo;s easier to see where to start.</p>'
                f'<p style="margin:0 0 4px;">{opener}</p>'
                + section('Urgent or high priority, due this week, no update yet', p['un'], asks, f'{TP}?assignee={tid}&amp;segment=open', 'urgent')
                + section('Past their due date', p['od'], asks, f'{TP}?assignee={tid}&amp;segment=overdue', 'past due')
                + section(f'Pending with no update for over a month', p['st'], asks,
                          f'{TP}?assignee={tid}&amp;status=Pending&amp;sort=createdAt&amp;dir=asc', 'pending')
                + '<p style="margin:16px 0 12px;">Could you go through these before the next standup? A short note on each one '
                  '(what you&rsquo;re waiting on, or a new date) is enough, and please close anything that&rsquo;s already done. '
                  'If something is stuck or needs me, just tell me and I&rsquo;ll help.</p>'
                  f'<p style="margin:0 0 10px;">Thanks,</p>{sig}')
        with open(os.path.join(outdir, f"{t['email']}.html"), 'w', encoding='utf-8') as f:
            f.write('<html><head><meta charset="utf-8"></head><body style="font-family:Segoe UI,Arial,sans-serif;'
                    f'font-size:14px;color:#1f2937;line-height:1.6;">{body}</body></html>')
        recipients.append(dict(name=p['name'], email=t['email'], reasons=p['reasons']))
        weight = len(p['un']) * 100 + len(p['od']) * 10 + len(p['st'])
        cards.append((weight, f'''<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 26px;"><tr><td bgcolor="#ffffff" style="border:1px solid #e5e7eb;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td bgcolor="#f8fafc" style="padding:10px 18px;border-bottom:1px solid #e5e7eb;font-size:12.5px;color:#4b5563;line-height:1.7;">
<b style="color:#111827;">To:</b> {p["name"]} &lt;{t["email"]}&gt;<br><b style="color:#111827;">Subject:</b> {SUBJECT}<br>
<span style="color:#9ca3af;">Why: {", ".join(p["reasons"])}</span></td></tr>
<tr><td style="padding:18px 20px;font-size:14px;color:#1f2937;line-height:1.6;">{body}</td></tr></table></td></tr></table>'''))
    cards.sort(key=lambda c: -c[0])
    listing = ''.join(f'<li>{r["name"]}: {", ".join(r["reasons"])}</li>' for r in recipients)
    review = f'''<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ticket follow-ups for review</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;"><div style="max-width:760px;margin:0 auto;padding:26px 16px;">
<div style="font-size:20px;font-weight:700;color:#111827;">Ticket follow-ups: {len(recipients)} emails ready</div>
<div style="font-size:13.5px;color:#4b5563;margin:6px 0 16px;line-height:1.55;">Nothing has been sent to the team yet. Built from live data at {data["generatedAt"][:16].replace("T", " ")} UTC.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;"><tr><td bgcolor="#ffffff" style="padding:16px 20px;border:1px solid #e5e7eb;font-size:13.5px;color:#1f2937;line-height:1.6;">
<b>Who gets one</b><ul style="margin:6px 0 0;padding-left:20px;">{listing}</ul></td></tr></table>
{"".join(c for _, c in cards)}</div></body></html>'''
    with open(os.path.join(outdir, 'review.html'), 'w', encoding='utf-8') as f:
        f.write(review)
    json.dump(dict(subject=SUBJECT, sender=data['sender']['email'], recipients=recipients),
              open(os.path.join(outdir, 'recipients.json'), 'w', encoding='utf-8'), indent=1)
    print(f'rendered {len(recipients)} emails -> {outdir}')
    for r in recipients:
        print(f"  {r['name']} <{r['email']}>: {', '.join(r['reasons'])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['candidates', 'render'])
    ap.add_argument('data')
    ap.add_argument('--exclude', default='')
    ap.add_argument('--openers')
    ap.add_argument('--out')
    a = ap.parse_args()
    data = json.load(open(a.data, encoding='utf-8'))
    exclude = {x.strip().lstrip('#') for x in a.exclude.split(',') if x.strip()}
    if a.cmd == 'candidates':
        cmd_candidates(data, exclude)
    else:
        if not a.openers or not a.out:
            raise SystemExit('render needs --openers and --out')
        cmd_render(data, exclude, json.load(open(a.openers, encoding='utf-8')), a.out)


if __name__ == '__main__':
    main()
