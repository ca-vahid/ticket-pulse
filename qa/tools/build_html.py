# Builds the branded QA follow-up HTML from SECTIONS below (screenshots embedded as base64).
# Canonical copy. Copy into qa/evidence-<MMDD>/ next to report_content.py and run it there -> report.html
import base64, io, os, html as H

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'report.html')

def img(rel, caption=None, width='100%'):
    path = os.path.join(HERE, rel)
    if not os.path.exists(path):
        return f'<div class="missing">[missing screenshot: {H.escape(rel)}]</div>'
    b64 = base64.b64encode(open(path, 'rb').read()).decode('ascii')
    cap = f'<figcaption>{caption}</figcaption>' if caption else ''
    return f'<figure><img src="data:image/png;base64,{b64}" style="width:{width}"/>{cap}</figure>'

def callouts(items):
    # items: list of (marker_number, text) rendered as a numbered legend under a screenshot
    lis = ''.join(f'<li><span class="mk">{n}</span>{t}</li>' for n, t in items)
    return f'<ol class="legend">{lis}</ol>'

def steps(items):
    lis = ''.join(f'<li>{t}</li>' for t in items)
    return f'<ol class="steps">{lis}</ol>'

def pill(text, tone='ok'):
    return f'<span class="pill {tone}">{text}</span>'

CSS = r'''
@page { size: Letter; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI", -apple-system, Arial, sans-serif; color: #0f172a; margin: 0; font-size: 11.5px; line-height: 1.5; }
.cover { background: linear-gradient(135deg, #1d4ed8 0%, #6d28d9 60%, #0f172a 100%); color: #fff; padding: 56px 44px; border-radius: 14px; page-break-after: always; min-height: 9.2in; display: flex; flex-direction: column; justify-content: space-between; }
.cover h1 { font-size: 34px; margin: 0 0 8px; letter-spacing: -0.5px; }
.cover .sub { font-size: 15px; opacity: .92; }
.cover .meta { font-size: 12px; opacity: .85; margin-top: 30px; }
.cover .toc { background: rgba(255,255,255,.12); border-radius: 12px; padding: 16px 20px; margin-top: 26px; }
.cover .toc h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; opacity: .9; }
.cover .toc li { margin: 4px 0; font-size: 13px; }
h2 { font-size: 20px; margin: 0 0 6px; color: #1e293b; page-break-after: avoid; }
h3 { font-size: 13.5px; margin: 18px 0 6px; color: #1d4ed8; page-break-after: avoid; }
section { page-break-before: always; }
section.cont { page-break-before: auto; }
.asked { background: #f1f5f9; border-left: 4px solid #94a3b8; padding: 10px 14px; border-radius: 8px; margin: 8px 0 14px; font-style: italic; color: #334155; }
.verdict { background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 10px; padding: 12px 14px; margin: 10px 0 14px; }
.verdict b { color: #3730a3; }
.pill { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; margin-right: 6px; vertical-align: middle; }
.pill.ok { background: #dcfce7; color: #166534; } .pill.info { background: #dbeafe; color: #1e40af; } .pill.warn { background: #fef3c7; color: #92400e; } .pill.you { background: #fce7f3; color: #9d174d; }
figure { margin: 10px 0 14px; page-break-inside: avoid; }
figure img { border: 1px solid #e2e8f0; border-radius: 8px; box-shadow: 0 2px 8px rgba(15,23,42,.08); max-width: 100%; }
figcaption { font-size: 10.5px; color: #64748b; margin-top: 5px; }
ol.legend { margin: 4px 0 12px; padding-left: 0; list-style: none; columns: 2; column-gap: 24px; }
ol.legend li { margin: 3px 0; break-inside: avoid; }
.mk { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: #ef4444; color: #fff; font-weight: 700; font-size: 10px; margin-right: 6px; }
ol.steps li { margin: 4px 0; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; font-size: 11px; }
th, td { border: 1px solid #e2e8f0; padding: 5px 8px; text-align: left; vertical-align: top; }
th { background: #f8fafc; }
code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 10.5px; }
.missing { background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 6px; margin: 8px 0; }
/* ---- charts (dataviz skill: validated categorical slots, direct labels on every
   bar so identity is never colour-alone; print is light-mode only by design) ---- */
.viz { --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --good: #0ca30c; --crit: #d03b3b;
  --ink: #0f172a; --ink2: #52514e; --grid: #e7e5e4;
  background: #fcfcfb; border: 1px solid var(--grid); border-radius: 10px; padding: 12px 14px; margin: 10px 0 12px; page-break-inside: avoid; }
.viz h4 { margin: 0 0 2px; font-size: 12.5px; color: var(--ink); }
.viz .sub { font-size: 10.5px; color: var(--ink2); margin: 0 0 9px; }
.viz .row { display: grid; grid-template-columns: 165px 1fr auto; align-items: center; gap: 9px; margin: 5px 0; }
.viz .row .lbl { font-size: 10.5px; color: var(--ink2); text-align: right; line-height: 1.25; }
.viz .track { display: block; background: #f1f0ee; border-radius: 4px; height: 15px; position: relative; overflow: hidden; }
.viz .fill { display: block; height: 15px; border-radius: 4px; background: var(--s1); }
.viz .val { font-size: 11px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; min-width: 46px; }
.viz .note { font-size: 10px; color: var(--ink2); margin-top: 8px; border-top: 1px solid var(--grid); padding-top: 6px; }
.viz.split .bar { display: flex; height: 22px; border-radius: 5px; overflow: hidden; gap: 2px; background: transparent; }
.viz.split .seg { height: 22px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff; }
.viz .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 7px; font-size: 10.5px; color: var(--ink2); }
.viz .legend i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; margin-right: 5px; }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0 12px; }
.tile { background: #fcfcfb; border: 1px solid #e7e5e4; border-radius: 10px; padding: 9px 11px; page-break-inside: avoid; }
.tile b { display: block; font-size: 19px; line-height: 1.15; color: #0f172a; font-variant-numeric: tabular-nums; }
.tile span { font-size: 10px; color: #52514e; }
.ask { background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 10px 13px; margin: 10px 0; }
.ask h4 { margin: 0 0 6px; font-size: 12px; color: #3730a3; }
.ask ol { margin: 0; padding-left: 18px; font-size: 11.5px; }
.ask li { margin: 4px 0; }
.note { font-size: 10.5px; color: #475569; }
.check { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 10px 14px; margin: 10px 0; }
pre { background: #0f172a; color: #e2e8f0; padding: 10px 12px; border-radius: 8px; font-size: 9.6px; line-height: 1.45; page-break-inside: avoid; white-space: pre-wrap; word-break: break-word; font-family: Consolas, monospace; margin: 8px 0 12px; }
pre em { color: #86efac; font-style: normal; }
pre b { color: #93c5fd; font-weight: 600; }
.danger { background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; padding: 11px 14px; margin: 10px 0; }
.danger b { color: #991b1b; }
.kv td:first-child { width: 32%; background: #f8fafc; font-weight: 600; }

'''

def build(sections, cover):
    parts = [f'<!doctype html><html><head><meta charset="utf-8"><title>{H.escape(cover["title"])}</title><style>{CSS}</style></head><body>']
    toc = ''.join(f'<li>{s["toc"]}</li>' for s in sections)
    parts.append(f'''<div class="cover"><div><div class="sub">Ticket Pulse · QA response</div><h1>{cover["title"]}</h1><div class="sub">{cover["subtitle"]}</div>
      <div class="toc"><h3>What is in this document</h3><ol style="margin:0;padding-left:18px">{toc}</ol></div></div>
      <div class="meta">{cover["meta"]}</div></div>''')
    for i, s in enumerate(sections):
        parts.append(f'<section><h2>{i+1}. {s["title"]}</h2>{s["html"]}</section>')
    parts.append('</body></html>')
    io.open(OUT, 'w', encoding='utf-8').write(''.join(parts))
    print('html written', OUT)

if __name__ == '__main__':
    from report_content import SECTIONS, COVER  # authored separately
    build(SECTIONS, COVER)
