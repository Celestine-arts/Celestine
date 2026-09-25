"""
Fetches the current Billboard Hot 100 and writes it to data/hot100.json.
Run daily by .github/workflows/update-charts.yml.

This does its own lightweight scraping of billboard.com rather than using
the third-party `billboard.py` library, because that library's parser
broke against Billboard's current page markup (it was grabbing a whole
blob of label+value text instead of a single clean number, then crashing
on int()). The fix here is defensive: every numeric field is pulled out
with a regex that finds *a number inside the text*, rather than assuming
the whole string is already just a number. If a field genuinely can't be
found, it's set to None and the entry is still kept — one messy field
should never take down the whole chart.

Billboard's page structure can still change again in the future; if this
script starts failing, the fix is almost always: re-check the class names
below against the live page and update the selectors.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

URL = "https://www.billboard.com/charts/hot-100/"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36"
}


def first_number(text):
    """Pull the first integer out of a string; None if there isn't one.
    This is the core defensive fix: never assume scraped text is already
    a clean number."""
    if not text:
        return None
    match = re.search(r"\d+", text)
    return int(match.group()) if match else None


def clean_text(el):
    return el.get_text(strip=True) if el else ""


def fetch_hot_100():
    resp = requests.get(URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    rows = soup.select("div.o-chart-results-list-row-container")
    if not rows:
        # Billboard's markup changed shape entirely — fail loudly rather
        # than silently writing an empty/garbage chart.
        raise RuntimeError(
            "No chart rows found — Billboard's page structure has likely "
            "changed. Selectors in fetch_chart.py need updating."
        )

    entries = []
    for i, row in enumerate(rows, start=1):
        title_el = row.select_one("h3.c-title")
        artist_el = row.select_one("span.c-label") or row.select_one("p.c-label")

        title = clean_text(title_el)
        artist = clean_text(artist_el)
        if not title:
            continue  # skip anything that isn't really a chart entry

        # Stat blocks (LAST, PEAK, WEEKS) are typically stacked as
        # label + value pairs further down each row. Rather than trust
        # position, grab every number-bearing small text node in order.
        stat_texts = [
            clean_text(el) for el in row.select("span.c-label")
        ]
        numbers = [n for n in (first_number(t) for t in stat_texts) if n is not None]

        # Best-effort mapping: on Billboard's row layout these generally
        # appear in the order [this-week dup, last-week, peak, weeks-on-chart]
        # after the rank/title/artist labels — but we defensively fall back
        # to None for anything we can't confidently identify.
        last_pos = numbers[-3] if len(numbers) >= 3 else None
        peak = numbers[-2] if len(numbers) >= 2 else None
        weeks = numbers[-1] if len(numbers) >= 1 else None

        if last_pos is None or last_pos == 0:
            movement = "new"
        elif i < last_pos:
            movement = "up"
        elif i > last_pos:
            movement = "down"
        else:
            movement = "same"

        entries.append({
            "rank": i,
            "title": title,
            "artist": artist,
            "weeks": weeks,
            "peak": peak,
            "lastPos": last_pos,
            "movement": movement,
        })

    return {
        "chartDate": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "entries": entries,
    }


if __name__ == "__main__":
    try:
        data = fetch_hot_100()
    except Exception as e:
        print(f"FAILED to fetch chart: {e}", file=sys.stderr)
        sys.exit(1)

    if len(data["entries"]) < 50:
        # Sanity check — a real Hot 100 fetch should have ~100 entries.
        # Better to fail the workflow than publish a suspiciously short chart.
        print(f"FAILED: only parsed {len(data['entries'])} entries, expected ~100", file=sys.stderr)
        sys.exit(1)

    os.makedirs("data", exist_ok=True)
    with open("data/hot100.json", "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {len(data['entries'])} entries for chart dated {data['chartDate']}")
