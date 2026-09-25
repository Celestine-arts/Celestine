"""
Fetches the current Billboard Hot 100 and writes it to data/hot100.json.
Run daily by .github/workflows/update-charts.yml — this file is not meant
to be run manually except for local testing.

Uses the unofficial `billboard.py` library, which reads Billboard's own
public chart pages. The chart itself only changes weekly (new charts drop
each Tuesday); running this daily just means the site never goes more
than a day out of date, not that the ranking itself moves daily.
"""

import json
import sys
from datetime import datetime, timezone

try:
    import billboard
except ImportError:
    print("Missing dependency: pip install billboard.py")
    sys.exit(1)


def fetch_hot_100():
    chart = billboard.ChartData('hot-100')

    entries = []
    for e in chart:
        if e.lastPos == 0:
            movement = "new"
        elif e.rank < e.lastPos:
            movement = "up"
        elif e.rank > e.lastPos:
            movement = "down"
        else:
            movement = "same"

        entries.append({
            "rank": e.rank,
            "title": e.title,
            "artist": e.artist,
            "weeks": e.weeks,
            "peak": e.peakPos,
            "lastPos": e.lastPos,
            "movement": movement,
        })

    return {
        "chartDate": chart.date,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "entries": entries,
    }


if __name__ == "__main__":
    data = fetch_hot_100()
    with open("data/hot100.json", "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {len(data['entries'])} entries for chart dated {data['chartDate']}")
