"""
Fetches the current Billboard Hot 100 and writes it to data/hot100.json.
Run daily by .github/workflows/update-charts.yml.

PARSING APPROACH
Billboard's page renders each chart row with a predictable sequence of
visible text: [rank] [title] [artist] "LW" [number] "PEAK" [number]
"WEEKS" [number] ... (new/re-entry rows show "NEW"/"RE-ENTRY" badges
before the title instead of a rank-to-rank comparison, and "LW" reads
as "-" for them). Rather than guess CSS class names (which broke last
time — a class that used to hold a clean number started holding a whole
label+value blob instead), this script anchors on the literal "LW" /
"PEAK" / "WEEKS" text labels themselves and reads title/artist as the
two text nodes immediately before them. That's resilient to Billboard
reshuffling their CSS classes, since it depends on the visible words
rather than the styling around them.

COVER ART
Billboard's page doesn't expose usable per-song artwork through simple
scraping, so cover art is fetched separately per song from Apple's
public iTunes Search API (https://itunes.apple.com/search) — no API key
required, no rate-limit issues at this volume. If a given song can't be
found there, artwork is left as null and the front-end just shows a
plain placeholder instead of a broken image.

SPOTIFY LINKS
No official free Spotify API exists for this without registering an app
and handling OAuth, which is real ongoing complexity for a one-person
static site. Instead, each entry links to a Spotify *search* URL built
from the title + artist — no credentials needed, and it reliably lands
on the right song as the top result.
"""

import json
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

CHART_URL = "https://www.billboard.com/charts/hot-100/"
ITUNES_SEARCH_URL = "https://itunes.apple.com/search"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36"
}

STOP_WORDS = {
    "share", "chart history", "awards", "gains in performance",
    "credits", "songwriter(s)", "producer(s)", "imprint/label",
    "debut position", "debut chart date", "peak position", "peak chart date",
}


def spotify_search_url(title, artist):
    q = urllib.parse.quote(f"{title} {artist}")
    return f"https://open.spotify.com/search/{q}"


def slugify(title, artist):
    def clean(s):
        s = s.lower()
        s = re.sub(r"[^a-z0-9]+", "-", s)
        return s.strip("-")
    return f"{clean(artist)}-{clean(title)}"


def fetch_cover_art(title, artist):
    """Look up cover art via the free iTunes Search API. Returns a URL
    string or None — never raises, since a missing image shouldn't break
    the whole chart fetch."""
    try:
        resp = requests.get(
            ITUNES_SEARCH_URL,
            params={"term": f"{artist} {title}", "media": "music", "limit": 1},
            timeout=10,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
        if not results:
            return None
        art = results[0].get("artworkUrl100")
        if not art:
            return None
        # iTunes lets you swap the resolution right in the URL
        return art.replace("100x100", "600x600")
    except Exception:
        return None


def parse_row_strings(strings):
    """Given the row's visible text in order, find each 'LW <n> PEAK <n>
    WEEKS <n>' block and pull out title/artist (the two strings right
    before it) plus the three numbers. Handles the fact that this block
    appears twice per row (Billboard duplicates it, likely for a
    mobile/accessible layout) by just using the first occurrence."""
    try:
        lw_idx = strings.index("LW")
    except ValueError:
        return None

    if lw_idx < 2:
        return None

    artist = strings[lw_idx - 1]
    title = strings[lw_idx - 2]

    def number_after(label):
        try:
            idx = strings.index(label, lw_idx)
            val = strings[idx + 1]
            return int(val) if val.isdigit() else None
        except (ValueError, IndexError):
            return None

    last_pos = number_after("LW")
    peak = number_after("PEAK")
    weeks = number_after("WEEKS")

    return title, artist, last_pos, peak, weeks


def fetch_hot_100():
    resp = requests.get(CHART_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    rows = soup.select("div.o-chart-results-list-row-container")
    if not rows:
        raise RuntimeError(
            "No chart rows found — Billboard's page structure has likely "
            "changed. Check CHART_URL and the row selector in fetch_chart.py."
        )

    entries = []
    for i, row in enumerate(rows, start=1):
        strings = [s for s in row.stripped_strings if s.strip().lower() not in STOP_WORDS]
        parsed = parse_row_strings(strings)
        if not parsed:
            continue
        title, artist, last_pos, peak, weeks = parsed

        if last_pos is None:
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
            "spotifyUrl": spotify_search_url(title, artist),
            "slug": slugify(title, artist),
            "coverArt": None,  # filled in below
        })

    # Cover art lookups are a separate pass so a slow/failed image lookup
    # never affects whether the chart itself parsed successfully.
    for entry in entries:
        entry["coverArt"] = fetch_cover_art(entry["title"], entry["artist"])
        time.sleep(0.1)  # light rate-limit courtesy to iTunes' API

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
        print(f"FAILED: only parsed {len(data['entries'])} entries, expected ~100", file=sys.stderr)
        sys.exit(1)

    missing_artists = sum(1 for e in data["entries"] if not e["artist"])
    if missing_artists > 5:
        print(f"FAILED: {missing_artists} entries missing an artist name — parsing is likely broken", file=sys.stderr)
        sys.exit(1)

    os.makedirs("data", exist_ok=True)
    with open("data/hot100.json", "w") as f:
        json.dump(data, f, indent=2)

    with_art = sum(1 for e in data["entries"] if e["coverArt"])
    print(f"Wrote {len(data['entries'])} entries ({with_art} with cover art) for chart dated {data['chartDate']}")
