#!/usr/bin/env python3
"""Build the served tutorial pages under public/tutorial from the guide HTML
sources, styled to match the app's design system (Consolas mono type;
participant page uses the sage/green participant skin, staff pages use the
navy admin skin). Sections split on <h2> and render as cards with numbered
chips. Screenshots are inlined as base64 so each page is self-contained
except for its video.

Usage: build_tutorial_pages.py [participant|researcher|therapist|caseworker|hub ...]
(no args = all)
"""
import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
PUB = ROOT / '../../public/tutorial'

FONT = '"Consolas", "Andale Mono", monospace'

PARTICIPANT = {
    'accent': '#22452F', 'accentSoft': '#3F7052', 'chipBg': '#E7EEE8',
    'bg': '#F4F7F4', 'border': '#E3EAE4', 'headerGrad': 'linear-gradient(180deg,#1C3A27,#22452F)',
    'link': '#3F7052', 'radius': '18px',
}
STAFF = {
    'accent': '#002E5D', 'accentSoft': '#0047BA', 'chipBg': '#E8F0FA',
    'bg': '#F9FAFB', 'border': '#E5E7EB', 'headerGrad': 'linear-gradient(180deg,#002647,#002E5D)',
    'link': '#0047BA', 'radius': '12px',
}


def css(t):
    return f'''
*{{box-sizing:border-box}}
body{{margin:0;background:{t['bg']};color:#1F2937;font-family:{FONT};font-size:0.92rem;line-height:1.6}}
.page-header{{background:{t['headerGrad']};color:#fff;padding:34px 20px 30px;text-align:center}}
.page-header h1{{margin:0 0 6px;font-size:1.7rem;letter-spacing:-0.5px}}
.page-header .sub{{color:rgba(255,255,255,.82);font-size:.95rem;margin:0}}
.page-header .pill{{display:inline-block;margin-top:12px;padding:3px 14px;border-radius:999px;background:rgba(255,255,255,.16);color:#fff;font-size:.8rem}}
main{{max-width:960px;margin:0 auto;padding:26px 18px 60px}}
.card{{background:#fff;border:1px solid {t['border']};border-radius:{t['radius']};box-shadow:0 1px 3px rgba(0,0,0,.06);padding:22px 26px;margin:0 0 18px}}
.card.video-card{{padding:14px}}
video{{width:100%;border-radius:10px;display:block}}
.video-note{{font-size:.82rem;color:#6B7280;margin:10px 6px 2px}}
h2{{display:flex;align-items:center;gap:10px;color:{t['accent']};font-size:1.08rem;margin:0 0 12px}}
.chip{{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:999px;background:{t['chipBg']};color:{t['accent']};font-size:.85rem;font-weight:700}}
p{{margin:.6em 0}}
ul{{margin:.6em 0;padding-left:1.3em}}
li{{margin:.35em 0}}
img{{max-width:100%;height:auto;border:1px solid {t['border']};border-radius:10px;margin:.4em 0}}
a{{color:{t['link']}}}
code{{background:{t['chipBg']};padding:1px 6px;border-radius:6px;font-size:.88em}}
.intro{{color:#4B5563}}
.safety{{background:#FDECEC;border:1px solid #F6CFCF;border-radius:12px;color:#B91C1C;padding:14px 18px;font-size:.88rem;margin:0 0 18px}}
.footer-note{{color:#6B7280;font-size:.82rem;text-align:center;margin-top:26px}}
.role-cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}}
.role-card{{background:#fff;border:1px solid {t['border']};border-radius:{t['radius']};box-shadow:0 1px 3px rgba(0,0,0,.06);padding:22px}}
.role-card h2{{margin-bottom:8px}}
.role-card p{{color:#4B5563;font-size:.88rem}}
.role-card .go{{display:inline-block;margin-top:10px;font-weight:700}}
@media (max-width:640px){{.card{{padding:16px}}main{{padding:18px 10px 40px}}}}
'''


def inline_images(html, base):
    def repl(m):
        p = (base / m.group(1)).resolve()
        return 'src="data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode() + '"'
    html = re.sub(r'src="(tutorial-screenshots/[^"]+)"', lambda m: repl_path(m.group(1)), html)
    html = re.sub(r'src="shots/([^"]+)"', lambda m: repl_path('tutorial-screenshots/' + m.group(1)), html)
    return html


def repl_path(rel):
    p = ROOT / pathlib.Path(rel)
    if not p.exists():
        p = ROOT / 'tutorial-screenshots' / pathlib.Path(rel).name
    return 'src="data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode() + '"'


def cardify(body):
    """Split guide body on <h2> into cards; number chips from 'N. Title'."""
    parts = re.split(r'(?=<h2>)', body)
    intro = parts[0]
    out = []
    for sec in parts[1:]:
        m = re.match(r'<h2>(\d+)\.\s*(.*?)</h2>', sec, re.S)
        if m:
            num, title = m.group(1), m.group(2)
            rest = sec[m.end():]
            heading = f'<h2><span class="chip">{num}</span><span>{title}</span></h2>'
        else:
            m2 = re.match(r'<h2>(.*?)</h2>', sec, re.S)
            heading = f'<h2>{m2.group(1)}</h2>' if m2 else ''
            rest = sec[m2.end():] if m2 else sec
        out.append(f'<section class="card">{heading}{rest}</section>')
    return intro, '\n'.join(out)


def build_page(guide_path, theme, title, header_title, header_sub, pill, video_src, out_path):
    raw = pathlib.Path(guide_path).read_text()
    raw = inline_images(raw, ROOT)
    # h1 + intro em paragraph
    raw = re.sub(r'<h1>.*?</h1>\s*', '', raw, count=1, flags=re.S)
    intro_m = re.match(r'\s*<p><em>(.*?)</em></p>', raw, re.S)
    intro_text = intro_m.group(1) if intro_m else ''
    body = raw[intro_m.end():] if intro_m else raw
    _, cards = cardify(body)

    video_block = (f'<div class="card video-card"><video controls preload="metadata" src="{video_src}">'
                   'Your browser cannot play this video; the written guide below covers everything.</video>'
                   '<p class="video-note">Prefer to watch? The narrated tour covers the same material as the '
                   'written guide below.</p></div>')

    page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><style>{css(theme)}</style></head><body>
<header class="page-header"><h1>{header_title}</h1><p class="sub">{header_sub}</p>{pill}</header>
<main>
{video_block}
<div class="card"><p class="intro">{intro_text}</p></div>
{cards}
<p class="footer-note">Questions or something looks wrong? Use the Report-a-problem button in the app — reports go straight to the team.</p>
</main></body></html>
'''
    pathlib.Path(out_path).write_text(page)
    print(out_path, len(page))


def build_hub():
    roles = [
        ('researcher', 'Researcher', 'Study operations: sessions, safety queues, Qualtrics, evals, exports, and the system surfaces (prompts, knowledge base, redaction, consent, retention).'),
        ('therapist', 'Therapist', 'Clinical oversight with the full clinical data tier: caseload, triage, profiles, work queue, escalations, and secure messaging.'),
        ('caseworker', 'Caseworker', 'Day-to-day participant support from the summary data tier: triage, work queue, care notes, and escalating to clinical staff.'),
    ]
    cards = '\n'.join(
        f'<div class="role-card"><h2>{label}</h2><p>{desc}</p>'
        f'<a class="go" href="/tutorial/staff/{slug}/">Watch the tour &amp; read the guide &rarr;</a></div>'
        for slug, label, desc in roles)
    page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Research Portal - Staff Tutorials</title><style>{css(STAFF)}</style></head><body>
<header class="page-header"><h1>AI Therapist Research &amp; Therapist Audit Portal</h1>
<p class="sub">Staff tutorials — pick your role</p></header>
<main><div class="role-cards">{cards}</div>
<p class="footer-note">New staff practice in a sandbox with synthetic clients before touching real participants — ask a researcher for a sandbox invite.</p>
</main></body></html>
'''
    (PUB / 'staff/index.html').write_text(page)
    print('hub ok')


def main(targets):
    if 'participant' in targets:
        build_page(ROOT / 'app-tutorial.html', PARTICIPANT,
                   'AI Support Agent - How to Use the App',
                   'AI Therapist Assistant',
                   'How to use the app — a guided tour for study participants',
                   '', '/tutorial/tutorial-video.mp4', PUB / 'index.html')
    for role, label in [('researcher', 'Researcher'), ('therapist', 'Therapist'), ('caseworker', 'Caseworker')]:
        if role in targets:
            build_page(ROOT / f'staff-tutorials/{role}-tutorial.html', STAFF,
                       f'Research Portal - {label} Guide',
                       'AI Therapist Research &amp; Therapist Audit Portal',
                       f'{label} tutorial — how to use the portal in your role',
                       f'<span class="pill">{label.lower()}</span>',
                       f'/tutorial/staff/{role}/{role}-tutorial-video.mp4',
                       PUB / f'staff/{role}/index.html')
    if 'hub' in targets:
        build_hub()


if __name__ == '__main__':
    args = sys.argv[1:] or ['participant', 'researcher', 'therapist', 'caseworker', 'hub']
    main(args)
