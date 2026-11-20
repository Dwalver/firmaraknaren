"""Bygger den statiska sajten från src/ till site/.

Ändra värdena i CONFIG och kör: python3 build.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "src"
OUT = ROOT / "site"
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))

head = (SRC / "_head.txt").read_text(encoding="utf-8")
foot = (SRC / "_foot.txt").read_text(encoding="utf-8")
domain = CONFIG["DOMAIN"].rstrip("/")
import datetime
LASTMOD = datetime.date.today().isoformat()

pages = []
guides = []
files = sorted(SRC.glob("*.html"), key=lambda f: f.name == "guider.html")
for f in files:
    body = f.read_text(encoding="utf-8")
    title = re.search(r"<!--TITLE:(.*?)-->", body).group(1)
    desc = re.search(r"<!--DESC:(.*?)-->", body).group(1)
    ld = re.search(r"<!--LD:(.*?)-->", body, re.S)
    ld = f'<script type="application/ld+json">{ld.group(1).strip()}</script>\n' if ld else ""
    if "<!--GUIDE-->" in body:
        guides.append((f.name, re.search(r"<h1>(.*?)</h1>", body).group(1), desc))
    body = re.sub(r"<!--(TITLE|DESC|LD):.*?-->\n?", "", body, flags=re.S).replace("<!--GUIDE-->\n", "")
    body = body.replace("{{GUIDE_LIST}}", "\n".join(
        f'<div class="card"><h3><a href="{n}">{h}</a></h3><p>{d}</p></div>' for n, h, d in guides))
    url = f"{domain}/" if f.name == "index.html" else f"{domain}/{f.name}"
    html = f"""<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{url}">
<link rel="stylesheet" href="style.css">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:type" content="website">
<meta property="og:url" content="{url}">
<meta property="og:site_name" content="Firmaräknaren">
<meta property="og:locale" content="sv_SE">
{ld}
{CONFIG.get("ANALYTICS_SNIPPET", "")}
</head>
<body>
{head}
<main><div class="wrap">
{body}
</div></main>
{foot}
</body>
</html>
"""
    for key, val in CONFIG.items():
        html = html.replace("{{" + key + "}}", val)
    leftover = re.findall(r"\{\{[A-Z_]+\}\}", html)
    if leftover:
        print(f"Varning: {f.name} har ej ifyllda värden {set(leftover)}")
    (OUT / f.name).write_text(html, encoding="utf-8")
    pages.append(url)

pages.append(f"{domain}/k4/")
(OUT / "sitemap.xml").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + "".join(f"  <url><loc>{u}</loc><lastmod>{LASTMOD}</lastmod></url>\n" for u in pages)
    + "</urlset>\n",
    encoding="utf-8",
)
(OUT / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {domain}/sitemap.xml\n", encoding="utf-8")
print(f"Byggde {len(pages)} sidor till {OUT}")
