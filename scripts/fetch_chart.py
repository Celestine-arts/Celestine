"""
Fetches the current Billboard Hot 100 and writes it to data/hot100.json.
Run daily by .github/workflows/update-charts.yml.

PARSING APPROACH
Billboard's page renders each chart row with a predictable sequence of
visible text: [rank] [title] [artist credit] "LW" [number] "PEAK" [number]
"WEEKS"-ish [number] ... (new/re-entry rows show "NEW"/"RE-ENTRY" badges
before the title instead of a rank-to-rank comparison, and "LW" reads
as "-" for them). Rather than guess CSS class names (which broke last
time — a class that used to hold a clean number started holding a whole
label+value blob instead), this script anchors on the literal "LW" /
"PEAK" text labels and reads title/artist as the text nodes immediately
before them.

CHANGE LOG (read this before assuming the anchors below are still right —
Billboard's markup has drifted twice now):
  - Originally assumed exactly two text nodes sit before "LW": [title,
    artist]. That broke for any multi-artist credit ("X Featuring Y",
    "X & Y", "X With Y"), which Billboard renders as several separate
    text nodes instead of one string. Fixed below by walking backward
    from "LW" and merging consecutive artist-credit fragments (names +
    connector words like "Featuring"/"&"/"With") into one artist string,
    so the real title node is found regardless of how many fragments
    the credit is split into.
  - The literal "WEEKS" label stopped appearing verbatim at some point
    (every row was silently coming back with weeks=None while LW/PEAK
    still worked fine, which is the tell — only that one label moved).
    Fixed below with a two-tier lookup: try a handful of known label
    variants case-insensitively first, then fall back to "the next pure
    number after PEAK's number" if none of those match. If a future run
    still shows weeks=null everywhere, that fallback found nothing
    number-shaped either, and the anchor text search needs a fresh look
    at the live page.
  - CONNECTOR-FUSION FIX (this change): the merge-backward logic above
    only recognized a text node that WAS a connector by itself ("&",
    "Featuring"). It turns out Billboard sometimes fuses the connector
    to the FRONT of the next name in a single node instead — one node
    "& John Mayer" instead of two nodes "&" and "John Mayer" — and
    _is_connector() returned False for that fused node, so the backward
    walk stopped one node early and swallowed the real title into the
    artist credit (rank 48 on 2026-09-27: title became "Lainey Wilson",
    artist became "& John Mayer" — the real title, "Lainey Wilson", is
    actually correct by coincidence there, but the same bug produced
    fully wrong titles like "Jhene Aiko" for rank 59 and "Elevation
    Worship" for rank 90, which should have been the ARTIST field, not
    the title). Fixed below by splitting any node that STARTS WITH a
    connector into [connector, rest] before the backward walk runs, so
    fused and un-fused connectors are handled identically. A trailing-
    fusion case (rank 53: "Belly Gang Kushington &") is NOT handled by
    this fix — peeling a trailing "&" off a node can't reliably tell
    "title bleeding into next field" apart from "legitimate continuing
    credit" from static text alone. Watch for it in the post-run
    diagnostic below and check the live page's DOM directly if it
    recurs.

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

# Words/symbols that signal "this text node is a continuation of the same
# artist credit", not a separate title or a new field. Checked case-
# insensitively (and stripped of a trailing period, for "feat.").
CONNECTOR_WORDS = {
    "featuring", "feat", "with", "duet with", "and", "x", "vs", "vs.",
}
CONNECTOR_SYMBOLS = {"&", "+", "x"}

# Label variants to try, in order, before falling back to positional
# guessing. All matched case-insensitively against the stripped string.
WEEKS_LABEL_VARIANTS = [
    "WEEKS", "WKS", "WEEKS ON CHART", "WEEKS ON CHT", "TOTAL WEEKS", "WOC",
]

# Connector words/symbols that sometimes render fused to the FRONT of the
# next name instead of as their own text node (e.g. Billboard giving one
# node "& John Mayer" instead of two nodes "&" and "John Mayer", or
# "Featuring Chase Matthew" instead of "Featuring" + "Chase Matthew").
# This is what actually caused the title/artist boundary to be
# mis-located: _is_connector() only recognized a node that WAS a
# connector, not one that merely STARTED with one, so the backward walk
# stopped one node too early and swallowed the real title into the
# artist credit. See CHANGE LOG above.
_LEADING_CONNECTOR_RE = re.compile(
    r"^(?:featuring|feat\.?|duet\s+with|with|and)\s+|^(?:&|\+)\s*",
    re.IGNORECASE,
)


def _split_leading_connector(s):
    """If `s` starts with a connector fused to a name ('& John Mayer',
    'Featuring Chase Matthew'), split it into ['&', 'John Mayer'] /
    ['Featuring', 'Chase Matthew'] so the backward walk sees the
    connector as its own node — same as the un-fused case it already
    handles correctly. Returns [s] unchanged otherwise."""
    m = _LEADING_CONNECTOR_RE.match(s)
    if not m:
        return [s]
    connector = s[:m.end()].strip()
    rest = s[m.end():].strip()
    return [connector, rest] if rest else [connector]


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


def _is_connector(s):
    """True if `s` is a word/symbol that continues an artist credit
    rather than starting a new field (e.g. 'Featuring', '&', 'With')."""
    cleaned = s.strip().lower().rstrip(".")
    if cleaned in CONNECTOR_WORDS:
        return True
    if s.strip() in CONNECTOR_SYMBOLS:
        return True
    return False


def _find_label_index(strings, start_idx, label_variants):
    """Case-insensitive search for any of `label_variants` in strings,
    starting at start_idx. Returns the index, or None if none match."""
    variants_lower = {v.lower() for v in label_variants}
    for i in range(start_idx, len(strings)):
        if strings[i].strip().lower() in variants_lower:
            return i
    return None


def parse_row_strings(strings):
    """Given the row's visible text in order, find the 'LW' anchor and
    walk backward to recover the title and full artist credit — merging
    however many text nodes the artist credit happens to be split across
    (Billboard doesn't always keep a multi-artist credit as one node, and
    doesn't always keep a connector as its own node either — see
    _split_leading_connector above). Then reads PEAK and WEEKS-ish
    numbers, with a positional fallback for the latter in case its label
    text has changed again."""
    # Un-fuse any node that starts with a connector glued to a name,
    # BEFORE the backward walk runs, so the walk's connector check
    # ("_is_connector") sees them as separate nodes like it expects.
    strings = [frag for s in strings for frag in _split_leading_connector(s)]

    try:
        lw_idx = strings.index("LW")
    except ValueError:
        return None

    if lw_idx < 2:
        return None

    # Walk backward from just before "LW", merging consecutive artist-
    # credit fragments (names and connector words) into one credit string.
    # Stops as soon as we hit a node that is neither a connector itself
    # nor immediately follows one — that node is the real title.
    j = lw_idx - 1
    artist_parts = [strings[j]]
    j -= 1
    while j >= 0 and (_is_connector(strings[j]) or _is_connector(artist_parts[-1])):
        artist_parts.append(strings[j])
        j -= 1

    if j < 0:
        return None

    artist_parts.reverse()
    artist = " ".join(artist_parts)
    title = strings[j]

    def number_at(idx):
        if idx is None or idx + 1 >= len(strings):
            return None
        val = strings[idx + 1]
        return int(val) if val.isdigit() else None

    lw_label_idx = lw_idx  # we already matched "LW" exactly
    last_pos = number_at(lw_label_idx)

    peak_idx = _find_label_index(strings, lw_idx, ["PEAK"])
    peak = number_at(peak_idx)

    weeks_idx = _find_label_index(strings, lw_idx, WEEKS_LABEL_VARIANTS)
    weeks = number_at(weeks_idx)

    if weeks is None and peak_idx is not None:
        # Fallback: the next purely-numeric node after PEAK's number,
        # as long as it's close by (so we don't wander into the next
        # row's rank number if the label truly vanished).
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
    suspect_rows = []  # rows whose parsed title/artist still look off after the fix
    for i, row in enumerate(rows, start=1):
        strings = [s for s in row.stripped_strings if s.strip().lower() not in STOP_WORDS]
        parsed = parse_row_strings(strings)
        if not parsed:
            continue
        title, artist, last_pos, peak, weeks = parsed

        # Diagnostic only — doesn't block the row, just flags it for the
        # trailing-connector case (e.g. rank 53's "Belly Gang Kushington &")
        # that this fix doesn't attempt to auto-correct. Printed at the end
        # of the run so you can check the live page's DOM for that rank.
        if title.strip().endswith(("&", "+")) or artist.strip().startswith(("&", "+")):
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
            "coverArt": None,  # filled in below
        })

    if suspect_rows:
        print(
            "NOTE: the following rows still show a leading/trailing "
            "connector after the fused-connector fix — check Billboard's "
            "live DOM for these ranks (likely a trailing-fusion case like "
            "rank 53's historical 'Belly Gang Kushington &'):",
            file=sys.stderr,
        )
        for rank, title, artist in suspect_rows:
            print(f"  rank {rank}: title={title!r} artist={artist!r}", file=sys.stderr)

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
