import fs from "node:fs/promises";
import { callGemini, isDailyQuotaExhausted } from "./lib/gemini-client.mjs";

const HOT100_PATH = "data/hot100.json";
const SONGS_INDEX_PATH = "data/songs-index.json";
const BIO_INDEX_PATH = "bio-index.json";
const BIO_PENDING_PATH = "bio-pending.json";

// ...(PROTECTED_ARTIST_NAMES, CONNECTOR_PATTERN, escapeRegex, splitArtists,
//     slugify, loadJson, escapeHtml, sleep, fetchWikipediaSummary,
//     draftBioWithGemini, renderPage — all unchanged from before)...

async function main() {
  const chart = await loadJson(HOT100_PATH, { entries: [] });
  const songsIndex = await loadJson(SONGS_INDEX_PATH, {});
  const bioIndex = await loadJson(BIO_INDEX_PATH, {});
  let pending = await loadJson(BIO_PENDING_PATH, {});

  // --- Pass 1: retry anything left over from a quota-exhausted run ---
  let filled = 0;
  const stillPending = {};
  for (const [key, info] of Object.entries(pending)) {
    if (isDailyQuotaExhausted()) {
      stillPending[key] = info; // don't bother trying, save the wasted call
      continue;
    }
    const bio = await draftBioWithGemini(info.name, info.wikiExtract);
    if (bio) {
      const html = renderPage(info.name, {
        bio,
        thumbnail: info.thumbnail,
        wikiUrl: info.wikiUrl,
        isDraft: true,
      });
      await fs.writeFile(info.outPath, html);
      filled++;
    } else {
      stillPending[key] = info;
    }
  }
  pending = stillPending;
  if (filled) console.log(`Filled in ${filled} previously-pending bio(s).`);

  // --- Pass 2: existing logic, generating brand-new artist pages ---
  const allArtistNames = new Set();
  for (const song of Object.values(songsIndex)) {
    splitArtists(song.artist).forEach((n) => allArtistNames.add(n));
  }
  for (const entry of chart.entries || []) {
    splitArtists(entry.artist).forEach((n) => allArtistNames.add(n));
  }

  let created = 0;
  for (const name of allArtistNames) {
    const key = name.toLowerCase();
    if (bioIndex[key]) continue;

    const slug = slugify(name);
    const outPath = `${slug}.html`;

    const wiki = await fetchWikipediaSummary(name);
    let bio = null;
    if (wiki) {
      bio = await draftBioWithGemini(name, wiki.extract);
      if (!bio && isDailyQuotaExhausted()) {
        // Page still gets written below so the link never 404s — but we
        // remember to come back and redraft it once quota resets.
        pending[key] = {
          name,
          wikiExtract: wiki.extract,
          thumbnail: wiki.thumbnail,
          wikiUrl: wiki.wikiUrl,
          outPath,
        };
      }
    }

    const html = renderPage(name, {
      bio,
      thumbnail: wiki?.thumbnail || null,
      wikiUrl: wiki?.wikiUrl || null,
      isDraft: !!bio,
    });
    await fs.writeFile(outPath, html);
    bioIndex[key] = outPath;
    created++;

    await sleep(300);
  }

  await fs.writeFile(BIO_INDEX_PATH, JSON.stringify(bioIndex, null, 2));
  await fs.writeFile(BIO_PENDING_PATH, JSON.stringify(pending, null, 2));
  console.log(
    `Created ${created} new artist bio page(s), filled ${filled} pending, ` +
    `${Object.keys(pending).length} still pending. bio-index.json now has ${Object.keys(bioIndex).length} artist(s).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
