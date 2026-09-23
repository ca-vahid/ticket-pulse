"""Render the IT memo's per-agent section: the "overdue inside the bar" workload
table on top, the ticket table (option C) underneath. Chosen by Vahid 23 Sep 2026.

Deterministic on purpose: the daily cron runs this instead of re-deriving the
layout from prose, so the look is identical every morning. Email-safe only
(tables + bgcolor, no flexbox, no gradients, no pills).

Usage:
  python briefs/agent_section.py <daily-data.json> [--standup] [--exclude 179369,235167]
                                 [--asks asks.json] [--me "Vahid Haeri"] > section.html

  --standup   Tue/Thu: up to 4 tickets per person (rest -> '+N more'). Otherwise
              the single most pressing ticket per person.
  --workload-only  just the bar table (the weekly memo's per-agent overview).
  --exclude   FS ticket numbers the analyst judged already explained by their
              own last note (they are listed in a footnote, not dropped silently).
  --asks      JSON {"<fs>": "ticket-specific ask"} overriding the lane default.
"""
import argparse
import datetime
import json
import sys
from urllib.parse import urlencode

BASE_TP = 'https://ticketpulse.bgcsaas.com/tickets'
BASE_FS = 'https://it.bgcengineering.ca/a/tickets/'
BLUE, GREY, RED, TRACK = '#3b82f6', '#cbd5e1', '#ef4444', '#f1f5f9'
INK, SUB, FAINT, LINE = '#0f172a', '#475569', '#94a3b8', '#e2e8f0'
PRI = {4: ('Urgent', '#dc2626'), 3: ('High', '#d97706'), 2: ('Medium', '#64748b'), 1: ('Low', '#94a3b8')}
LANE_ASK = {'urgent_no_action': 'First touch?', 'overdue': 'Update or new date?',
            'stale_pending': 'Still waiting, or close?'}
STANDUP_CAP = 4  # per person on Tue/Thu; the rest folds into '+N more'
LANE_RANK = {'urgent_no_action': 0, 'overdue': 1, 'stale_pending': 2}


def tp_link(**q):
    return f'{BASE_TP}?{urlencode(q)}'


def person_links(tid, since):
    return {'all': tp_link(assignee=tid, status='any'), 'open': tp_link(assignee=tid, status='Open'),
            'pending': tp_link(assignee=tid, status='Pending'), 'overdue': tp_link(assignee=tid, segment='overdue'),
            'oldest': tp_link(assignee=tid, segment='open', sort='createdAt', dir='asc'),
            'new': tp_link(assignee=tid, status='any', createdFrom=since),
            'resolved': tp_link(assignee=tid, segment='resolved')}


def ticket_url(i):
    if i.get('origin') == 'ticketpulse':
        return f"{BASE_TP}/{i['tp_id']}"
    return f"{BASE_FS}{i['fs']}"


def age(days):
    days = int(days or 0)
    if days < 60:
        return f'{days} days'
    months = round(days / 30.44)
    return f'{months} months' if months < 12 else f'{days / 365.25:.1f} years'


def fmt_date(v):
    if not v or v == 'None':
        return None
    d = datetime.date.fromisoformat(str(v)[:10])
    out = d.strftime('%b ') + str(d.day)
    return out + d.strftime(', %Y') if d.year != datetime.date.today().year else out


def why(i):
    if i['lane'] == 'urgent_no_action':
        return 'no action yet'
    if i['lane'] == 'overdue':
        due = fmt_date(i.get('due'))
        return f'overdue since {due}, no note' if due else 'overdue, no note'
    since = fmt_date(i.get('last_agent_at')) or fmt_date(i.get('created'))
    return f'pending since {since}, no update'


def a_(href, text, color=INK, weight='600', size=None):
    sz = f'font-size:{size};' if size else ''
    return f'<a href="{href}" style="color:{color};font-weight:{weight};text-decoration:none;{sz}">{text}</a>'


def bar(segs, maxv, width=230, height=12):
    cells, used = '', 0
    for val, col in segs:
        if val > 0:
            w = max(3, round(width * val / maxv))
            used += w
            cells += f'<td width="{w}" height="{height}" bgcolor="{col}" style="font-size:0;line-height:0;">&nbsp;</td>'
    if used < width:
        cells += f'<td width="{width - used}" height="{height}" bgcolor="{TRACK}" style="font-size:0;line-height:0;">&nbsp;</td>'
    return f'<table cellpadding="0" cellspacing="0" width="{width}" style="border-collapse:collapse;"><tr>{cells}</tr></table>'


def legend():
    out = ''
    for label, col in (('overdue', RED), ('open, on time', BLUE), ('pending', GREY)):
        out += (f'<td style="padding-right:14px;white-space:nowrap;font-size:12px;color:{SUB};">'
                f'<span style="display:inline-block;width:9px;height:9px;background:{col};"></span>&nbsp;{label}</td>')
    return f'<table cellpadding="0" cellspacing="0"><tr>{out}</tr></table>'


def workload_table(stats, me, since):
    people = []
    for s in stats:
        if not s['open_now'] or not s.get('active', True):
            continue  # nothing on their plate, or no longer on the team (Vahid, 23 Sep): no row
        opn = s['open_now'] - s['pending_now']
        people.append(dict(s, open=opn, is_me=s['agent'] == me, L=person_links(s['tech_id'], since)))
    # alphabetical so order never reads as a ranking; Vahid's own queue last
    people.sort(key=lambda p: (p['is_me'], p['agent']))
    maxv = max((p['open'] + p['pending_now'] for p in people), default=1) or 1
    H = f'padding:0 10px 8px;font-size:11px;font-weight:700;letter-spacing:.06em;color:{FAINT};border-bottom:1px solid {LINE};'
    rows = [f'<tr><td style="{H}width:190px;">PERSON</td><td style="{H}">WHERE THEIR TICKETS SIT</td>'
            f'<td style="{H}text-align:right;">OLDEST</td><td style="{H}text-align:right;white-space:nowrap;">THIS WEEK</td></tr>']
    for p in people:
        name = 'Your queue' if p['is_me'] else p['agent']
        tag = ''
        on_time = max(0, p['open'] - p['overdue_now'])
        b = bar([(p['overdue_now'], RED), (on_time, BLUE), (p['pending_now'], GREY)], maxv)
        caption = ((a_(p['L']['overdue'], f"{p['overdue_now']} overdue", RED, '700', '12.5px') + '&nbsp;&middot;&nbsp;')
                   if p['overdue_now'] else '') + \
            a_(p['L']['open'], f"{p['open']} open", '#1d4ed8', '600', '12.5px') + '&nbsp;&middot;&nbsp;' + \
            a_(p['L']['pending'], f"{p['pending_now']} pending", SUB, '500', '12.5px')
        bg = ' bgcolor="#f8faff"' if p['is_me'] else ''
        c = f'padding:12px 10px;border-bottom:1px solid {LINE};vertical-align:middle;'
        rows.append(
            f'<tr{bg}><td style="{c}">{a_(p["L"]["all"], name, INK, "700", "14px")}{tag}</td>'
            f'<td style="{c}">{b}<div style="margin-top:6px;white-space:nowrap;">{caption}</div></td>'
            f'<td style="{c}text-align:right;white-space:nowrap;">{a_(p["L"]["oldest"], age(p["oldest_open_days"]), SUB, "500", "13px")}</td>'
            f'<td style="{c}text-align:right;white-space:nowrap;font-size:13px;">{a_(p["L"]["new"], p["assigned_new"], SUB, "500")} in'
            f'<span style="color:#cbd5e1;">&nbsp;/&nbsp;</span>{a_(p["L"]["resolved"], p["resolved"], "#047857", "600")} out</td></tr>')
    return (legend() + '<div style="height:10px;"></div>'
            f'<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">{"".join(rows)}</table>')


def ticket_table(review, me, standup, exclude, asks, inactive=frozenset()):
    by = {}
    more = {}
    excluded = []
    for r in review:
        if r['agent'] in inactive:
            continue  # inactive people are left out entirely (Vahid, 23 Sep)
        if r['lane'] == 'truncated':
            more[r['agent']] = r.get('more', 0)
            continue
        if str(r['fs']) in exclude:
            excluded.append(r)
            continue
        by.setdefault(r['agent'], []).append(r)
    for items in by.values():
        items.sort(key=lambda i: (LANE_RANK[i['lane']], -(i.get('priority') or 0)))
    order = sorted(by, key=lambda a: (a == me, a))
    H = f'padding:6px 8px;font-size:11px;font-weight:700;color:#64748b;letter-spacing:.05em;border-bottom:2px solid #cbd5e1;'
    rows = [f'<tr><td style="{H}">WHO</td><td style="{H}">PRIORITY</td><td style="{H}">TICKET</td>'
            f'<td style="{H}">WHY IT&rsquo;S LISTED</td><td style="{H}">ASK</td></tr>']
    for a in order:
        items = by[a][:STANDUP_CAP] if standup else by[a][:1]
        hidden = (len(by[a]) - len(items)) + more.get(a, 0)
        for k, i in enumerate(items):
            lbl, col = PRI.get(i.get('priority') or 2, PRI[2])
            top = 'border-top:1px solid #cbd5e1;' if k == 0 else 'border-top:1px solid #f1f5f9;'
            cell = 'padding:7px 8px;vertical-align:top;' + top
            who = f'<b style="color:{INK};">{"Your queue" if a == me else a}</b>' if k == 0 else ''
            ask = asks.get(str(i['fs'])) or LANE_ASK[i['lane']]
            rows.append(
                f'<tr><td style="{cell}font-size:13px;white-space:nowrap;">{who}</td>'
                f'<td style="{cell}font-size:13px;color:{col};font-weight:700;">{lbl}</td>'
                f'<td style="{cell}font-size:13px;color:#334155;"><a href="{ticket_url(i)}" style="color:#1d4ed8;text-decoration:none;">#{i["fs"]}</a> {i["subject"]}</td>'
                f'<td style="{cell}font-size:12.5px;color:#64748b;">{why(i)}</td>'
                f'<td style="{cell}font-size:12.5px;color:#334155;font-weight:600;">{ask}</td></tr>')
        if hidden:
            rows.append(f'<tr><td></td><td colspan="4" style="padding:2px 8px 8px;font-size:12px;color:{FAINT};">'
                        f'+{hidden} more for {"you" if a == me else a.split()[0]}</td></tr>')
    foot = ''
    if excluded:
        names = ', '.join(f'#{r["fs"]} ({r["agent"].split()[0]})' for r in excluded)
        foot = f'<div style="font-size:12px;color:{FAINT};margin-top:8px;">Left out because their own last note already explains them: {names}.</div>'
    return f'<table width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table>{foot}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('data')
    ap.add_argument('--standup', action='store_true')
    ap.add_argument('--exclude', default='')
    ap.add_argument('--asks')
    ap.add_argument('--me', default='Vahid Haeri')
    ap.add_argument('--workload-only', action='store_true', help='weekly memo: just the bar table')
    args = ap.parse_args()
    data = json.load(open(args.data, encoding='utf-8'))
    ws1 = next(w for w in data['workspaces'] if w['id'] == 1)
    since = (datetime.date.today() - datetime.timedelta(days=7)).isoformat()
    exclude = {x.strip().lstrip('#') for x in args.exclude.split(',') if x.strip()}
    asks = json.load(open(args.asks, encoding='utf-8')) if args.asks else {}
    if args.workload_only:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stdout.write(workload_table(ws1.get('agentStats') or [], args.me, since))
        return
    inactive = frozenset(x['agent'] for x in (ws1.get('agentStats') or []) if not x.get('active', True))
    label = 'STANDUP EDITION &middot; up to 4 tickets per person' if args.standup else 'the most pressing ticket per person'
    html = (f'<div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#475569;margin-bottom:8px;">WORKLOAD NOW</div>'
            f'{workload_table(ws1.get("agentStats") or [], args.me, since)}'
            f'<div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#475569;margin:24px 0 6px;">TICKETS TO RAISE '
            f'<span style="font-weight:400;letter-spacing:0;color:{FAINT};">&nbsp;{label}</span></div>'
            f'{ticket_table(ws1.get("agentReview") or [], args.me, args.standup, exclude, asks, inactive)}'
            f'<div style="font-size:12px;color:{FAINT};margin-top:10px;">Every name and number opens that exact list in Ticket Pulse (keep IT selected). '
            f'&ldquo;This week&rdquo; is the last 7 days; its &ldquo;out&rdquo; link opens all resolved tickets for that person.</div>')
    # Windows consoles default to cp1252, which mangles em dashes in subjects.
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdout.write(html)


if __name__ == '__main__':
    main()
