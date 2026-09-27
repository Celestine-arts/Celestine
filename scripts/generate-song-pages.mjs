import fs from "node:fs/promises";
import path from "node:path";
import { callGemini, isDailyQuotaExhausted } from "./lib/gemini-client.mjs";

const HOT100_PATH = "data/hot100.json";
const BIO_INDEX_PATH = "bio-index.json";
const SONGS_INDEX_PATH = "data/songs-index.json";
const SONGS_DIR = "songs";
const SITE_URL = "https://celestinestudio.com.lk";
const PENDING_PATH = "song-blurb-pending.json";

// ...(slugify, loadJson, fileExists, escapeHtml, sleep, findBioLink,
//     findYouTubeVideoId, draftBlurbWithGemini, renderPage — unchanged)...

async function main() {
  const chart = await loadJson(HOT100_PATH, null);
  if (!chart || !chart.entries) {
    console.error("No hot100.json found — run fetch_chart.py first.");
    process.exit(1);
  }
  const bioIndex = await loadJson(BIO_INDEX_PATH, {});
  const songsIndex = await loadJson(SONGS_INDEX_PATH, {});
  let pending = await loadJson(PENDING_PATH, {});

  await fs.mkdir(SONGS_DIR, { recursive: true });
  await fs.mkdir(path.dirname(SONGS_INDEX_PATH), { recursive: true });

  // --- Pass 1: retry pending blurbs from a quota-exhausted run ---
  let filled = 0;
  const stillPending = {};
  for (const [slug, info] of Object.entries(pending)) {
    if (isDailyQuotaExhausted()) {
      stillPending[slug] = info;
      continue;
    }
    const blurb = await draftBlurbWithGemini(info.entry);
    if (blurb) {
      const html = renderPage(info.entry, { videoId: info.videoId, bioLink: info.bioLink, blurb });
      await fs.writeFile(path.join(SONGS_DIR, `${slug}.html`), html);
      // This is the one sanctioned exception to "never overwrite" —
      // it only ever touches pages this script marked as its own
      // placeholders, never a page a human has since edited.
      filled++;
    } else {
      stillPending[slug] = info;
    }
  }
  pending = stillPending;
  if (filled) console.log(`Filled in ${filled} previously-pending song blurb(s).`);

  // --- Pass 2: existing logic ---
  let created = 0;
  const today = chart.chartDate;

  for (const entry of chart.entries) {
    const slug = entry.slug || slugify(entry.title, entry.artist);
    const outPath = path.join(SONGS_DIR, `${slug}.html`);
    const alreadyExists = await fileExists(outPath);

    if (!alreadyExists) {
      const videoId = await findYouTubeVideoId(entry.title, entry.artist);
      const bioLink = findBioLink(entry.artist, bioIndex);
      const blurb = await draftBlurbWithGemini(entry);

      if (!blurb && isDailyQuotaExhausted()) {
        pending[slug] = { entry, videoId, bioLink };
      }

      const html = renderPage(entry, { videoId, bioLink, blurb });
      await fs.writeFile(outPath, html);
      created++;

      await sleep(500);
    }

    const existing = songsIndex[slug];
    songsIndex[slug] = {
      slug,
      title: entry.title,
      artist: entry.artist,
      firstSeen: existing?.firstSeen || today,
      lastSeen: today,
      peak: Math.min(entry.peak ?? entry.rank, existing?.peak ?? Infinity),
      hasReview: alreadyExists || true,
    };
  }

  await fs.writeFile(SONGS_INDEX_PATH, JSON.stringify(songsIndex, null, 2));
  await fs.writeFile(PENDING_PATH, JSON.stringify(pending, null, 2));
  console.log(
    `Created ${created} new song page(s), filled ${filled} pending, ${Object.keys(pending).length} still pending. ` +
    `Songs index now has ${Object.keys(songsIndex).length} song(s).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
