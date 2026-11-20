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

pages = []
for f in sorted(SRC.glob("*.html")):
    body = f.read_text(encoding="utf-8")
    title = re.search(r"<!--TITLE:(.*?)-->", body).group(1)
    desc = re.search(r"<!--DESC:(.*?)-->", body).group(1)
    body = re.sub(r"<!--(TITLE|DESC):.*?-->\n?", "", body)
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

(OUT / "sitemap.xml").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + "".join(f"  <url><loc>{u}</loc></url>\n" for u in pages)
    + "</urlset>\n",
    encoding="utf-8",
)
(OUT / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {domain}/sitemap.xml\n", encoding="utf-8")
print(f"Byggde {len(pages)} sidor till {OUT}")
