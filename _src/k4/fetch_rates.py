"""Hämtar Riksbankens dagliga valutakurser (SEK per enhet) och skriver k4/rates.json.

Körs av GitHub Actions varje vecka. Riksbankens API (SWEA) är öppet men har
en gräns på antal anrop per minut, därför pausar skriptet mellan anropen.
"""
import datetime as dt
import json
import sys
import time
import urllib.request
from pathlib import Path

CURRENCIES = ["USD", "EUR", "GBP", "NOK", "DKK", "CHF", "CAD", "JPY", "AUD",
              "HKD", "PLN", "CZK", "SGD", "NZD", "CNY"]
# Valutor som Riksbanken kan ange per 100 enheter. Avgörs per kurs nedan.
PER100_CANDIDATES = {"JPY", "ISK", "HUF", "KRW", "IDR"}
START = "2015-01-01"
OUT = Path(__file__).resolve().parents[2] / "k4" / "rates.json"
API = "https://api.riksbank.se/swea/v1/Observations/SEK{c}PMI/{a}/{b}"


def get(url):
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json",
                                                       "User-Agent": "k4-rates-fetcher"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            wait = 20 * (attempt + 1)
            print(f"fel {e} för {url}, försöker igen om {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"kunde inte hämta {url}")


def main():
    today = dt.date.today().isoformat()
    out = {"source": "Sveriges riksbank, SWEA (SEK per valutaenhet, mittkurs)",
           "updated": today, "currencies": {}}
    for i, c in enumerate(CURRENCIES):
        if i:
            time.sleep(13)
        obs = get(API.format(c=c, a=START, b=today))
        obs = [o for o in obs if o.get("value") is not None]
        if not obs:
            print(f"inga kurser för {c}", file=sys.stderr)
            continue
        unit = 1
        if c in PER100_CANDIDATES and float(obs[-1]["value"]) > 1:
            unit = 100
        by_year = {}
        for o in obs:
            d = o["date"][:10]
            by_year.setdefault(d[:4], []).append(f"{d[5:7]}{d[8:10]}:{float(o['value']):g}")
        out["currencies"][c] = {"unit": unit, "first": obs[0]["date"][:10],
                                "last": obs[-1]["date"][:10],
                                "years": {y: ",".join(v) for y, v in by_year.items()}}
        print(f"{c}: {len(obs)} kurser, senast {obs[-1]['date'][:10]} = {obs[-1]['value']} (enhet {unit})")
    if len(out["currencies"]) < 5:
        raise SystemExit("för få valutor hämtades, skriver inte filen")
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
