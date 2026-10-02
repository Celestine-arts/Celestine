"""
Fetches the current Billboard Hot 100 and writes it to data/hot100.json.
Run daily by .github/workflows/update-charts.yml.

PARSING APPROACH
Billboard's page renders each chart row with a predictable sequence of
visible text: [rank] [title] [artist credit] "LW" [number] "PEAK" [number]
"WEEKS"-ish [number] ... Rather than guess CSS class names, this script
anchors on the literal "LW" / "PEAK" text labels and reads title/artist
as the text nodes immediately before them.

CHANGE LOG (Billboard's markup has drifted several times):
  - Multi-artist credits are split across several text nodes. The backward
    walk from "LW" merges consecutive credit fragments (names + connector
    words like "Featuring"/"&"/"With") so the real title is found no
    matter how many fragments the credit uses.
  - The literal "WEEKS" label stopped appearing verbatim. Fixed with a
    two-tier lookup: known label variants first, then "next pure number
    after PEAK's number". If weeks=null shows up everywhere again, look
    at the live page.
  - LEADING-CONNECTOR FUSION: Billboard sometimes renders one node
    "& John Mayer" instead of "&" + "John Mayer". Nodes before "LW" that
    start with a connector are split in two before the walk.
    CORRECTION in this version: the split now ONLY covers "&", "+",
    "Featuring" and "feat." — NOT "with" / "and" / "duet with". Those are
    ambiguous with real titles ("With You", "And So It Goes") and were
    corrupting them. It also now only touches nodes BEFORE "LW", never
    the rest of the row.
  - TRAILING-CONNECTOR FUSION (new): a node that ends in " &" or " +"
    (e.g. "Belly Gang Kushington &") is a credit continuing into the next
    node — titles don't end that way — so the backward walk now treats it
    as part of the credit instead of mistaking it for the title. Any
    stray trailing connector is stripped from the final artist string.

COVER ART
Fetched per song from Apple's public iTunes Search API (no key needed).
If a song isn't found, coverArt is null and the front-end shows a
placeholder.

SPOTIFY LINKS
Each entry links to a Spotify *search* URL built from title + artist —
no credentials needed.
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

# Words/symbols that, as a node of their own, mean "this continues the
# same artist credit". Checked case-insensitively.
CONNECTOR_WORDS = {
    "featuring", "feat", "with", "duet with", "and", "x", "vs", "vs.",
}
CONNECTOR_SYMBOLS = {"&", "+", "x"}

WEEKS_LABEL_VARIANTS = [
    "WEEKS", "WKS", "WEEKS ON CHART", "WEEKS ON CHT", "TOTAL WEEKS", "WOC",
]

# Connectors that can be fused to the FRONT of the next name in one node
# ("& John Mayer", "Featuring Chase Matthew"). Deliberately excludes
# "with" / "and": a node like "With You" or "And So It Goes" is a real
# title, and splitting it breaks the parse.
_LEADING_CONNECTOR_RE = re.compile(
    r"^(?:featuring|feat\.?)\s+|^[&+]\s*",
    re.IGNORECASE,
)

# A node ending in " &" / " +" is a credit continuing into the next node.
_TRAILING_CONNECTOR_RE = re.compile(r"\s[&+]$")


def _split_leading_connector(s):
    """'& John Mayer' -> ['&', 'John Mayer']; otherwise [s]."""
    m = _LEADING_CONNECTOR_RE.match(s)
    if not m:
        return [s]
    connector = s[:m.end()].strip()
    rest = s[m.end():].strip()
    return [connector, rest] if rest else [connector]


def _ends_with_connector(s):
    return bool(_TRAILING_CONNECTOR_RE.search(s.strip()))


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
    """Free iTunes Search API lookup. Returns a URL or None; never raises."""
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
        return art.replace("100x100", "600x600")
    except Exception:
        return None


def _is_connector(s):
    """True if `s` is, by itself, a word/symbol continuing an artist credit."""
    cleaned = s.strip().lower().rstrip(".")
    if cleaned in CONNECTOR_WORDS:
        return True
    if s.strip() in CONNECTOR_SYMBOLS:
        return True
    return False


def _find_label_index(strings, start_idx, label_variants):
    variants_lower = {v.lower() for v in label_variants}
    for i in range(start_idx, len(strings)):
        if strings[i].strip().lower() in variants_lower:
            return i
    return None


def parse_row_strings(strings):
    """Find the 'LW' anchor, walk backward to recover the title and the
    full artist credit, then read PEAK and WEEKS numbers."""
    try:
        lw_idx = strings.index("LW")
    except ValueError:
        return None

    # Un-fuse leading connectors, but ONLY in the part of the row before
    # "LW" (where the title/credit live), so nothing else is touched.
    head = [frag for s in strings[:lw_idx] for frag in _split_leading_connector(s)]
    strings = head + strings[lw_idx:]
    lw_idx = len(head)

    if lw_idx < 2:
        return None

    # Walk backward from just before "LW", merging credit fragments:
    # a node joins the credit if it is a connector itself, if the node
    # after it was a connector, or if it ENDS with a connector symbol
    # (trailing fusion). The first node that is none of these is the title.
    j = lw_idx - 1
    artist_parts = [strings[j]]
    j -= 1
    while j >= 0 and (
        _is_connector(strings[j])
        or _is_connector(artist_parts[-1])
        or _ends_with_connector(strings[j])
    ):
        artist_parts.append(strings[j])
        j -= 1

    if j < 0:
        return None

    artist_parts.reverse()
    artist = " ".join(artist_parts)
    artist = re.sub(r"\s*[&+]$", "", artist).strip()  # stray trailing connector
    title = strings[j]

    def number_at(idx):
        if idx is None or idx + 1 >= len(strings):
            return None
        val = strings[idx + 1]
        return int(val) if val.isdigit() else None

    last_pos = number_at(lw_idx)

    peak_idx = _find_label_index(strings, lw_idx, ["PEAK"])
    peak = number_at(peak_idx)

    weeks_idx = _find_label_index(strings, lw_idx, WEEKS_LABEL_VARIANTS)
    weeks = number_at(weeks_idx)

    if weeks is None and peak_idx is not None:
        peak_num_idx = peak_idx + 1
        for k in range(peak_num_idx + 1, min(peak_num_idx + 4, len(strings))):
            if strings[k].strip().isdigit():
                weeks = int(strings[k])
                break

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
    suspect_rows = []
    for i, row in enumerate(rows, start=1):
        strings = [s for s in row.stripped_strings if s.strip().lower() not in STOP_WORDS]
        parsed = parse_row_strings(strings)
        if not parsed:
            continue
        title, artist, last_pos, peak, weeks = parsed

        # Diagnostic only: anything still showing a dangling connector.
        if (
            title.strip().endswith(("&", "+"))
            or artist.strip().startswith(("&", "+"))
            or artist.strip().lower().startswith(("featuring", "feat"))
        ):
            suspect_rows.append((i, title, artist))

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
            "coverArt": None,
        })

    if suspect_rows:
        print(
            "NOTE: these rows still show a dangling connector after parsing — "
            "check Billboard's live DOM for these ranks:",
            file=sys.stderr,
        )
        for rank, title, artist in suspect_rows:
            print(f"  rank {rank}: title={title!r} artist={artist!r}", file=sys.stderr)

    for entry in entries:
        entry["coverArt"] = fetch_cover_art(entry["title"], entry["artist"])
        time.sleep(0.1)

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

    missing_weeks = sum(1 for e in data["entries"] if e["weeks"] is None)
    if missing_weeks > len(data["entries"]) * 0.5:
        print(
            f"WARNING: {missing_weeks}/{len(data['entries'])} entries have no weeks value — "
            "Billboard's WEEKS label may have changed again; check parse_row_strings.",
            file=sys.stderr,
        )

    os.makedirs("data", exist_ok=True)
    with open("data/hot100.json", "w") as f:
        json.dump(data, f, indent=2)

    with_art = sum(1 for e in data["entries"] if e["coverArt"])
    print(f"Wrote {len(data['entries'])} entries ({with_art} with cover art) for chart dated {data['chartDate']}")
