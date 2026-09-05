#!/usr/bin/env python3
"""Regenerate staff tutorial artifacts: selfcontained HTML + served public page per role."""
import base64, pathlib, re, sys

TITLES = {
    'researcher': 'Research Portal - Researcher Guide',
    'therapist': 'Research Portal - Therapist Guide',
    'caseworker': 'Research Portal - Caseworker Guide',
}

def inline_images(html):
    def repl(m):
        p = pathlib.Path('tutorial-screenshots') / pathlib.Path(m.group(1)).name
        return 'src="data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode() + '"'
    return re.sub(r'src="shots/([^"]+)"', repl, html)

for role in sys.argv[1:]:
    guide = pathlib.Path(f'staff-tutorials/{role}-tutorial.html').read_text()
    inlined = inline_images(guide)
    pathlib.Path(f'staff-tutorials/{role}-selfcontained.html').write_text(inlined)

    # insert video block after the intro <p><em>...</em></p>
    idx = inlined.find('</em></p>') + len('</em></p>')
    video = (f'\n\n<div style="max-width:960px;margin:0 auto 24px">'
             f'<video controls preload="metadata" style="width:100%;border-radius:8px" '
             f'src="/tutorial/staff/{role}/{role}-tutorial-video.mp4">Your browser cannot play this video; '
             f'the written guide below covers everything.</video>'
             f'<p style="font-size:0.85em;color:#555"><em>Prefer to watch? The narrated tour covers the same '
             f'material as the written guide below.</em></p></div>')
    body = inlined[:idx] + video + inlined[idx:]
    page = ('<!doctype html><html><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>{TITLES[role]}</title>'
            '<style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:980px;margin:0 auto;'
            'padding:24px;line-height:1.55;color:#222}img{max-width:100%;height:auto;border:1px solid #ddd;'
            'border-radius:8px}h1,h2{color:#12233b}</style></head><body>' + body + '</body></html>\n')
    out = pathlib.Path(f'../../public/tutorial/staff/{role}/index.html')
    out.write_text(page)
    print(role, 'selfcontained+page ok', len(page))
