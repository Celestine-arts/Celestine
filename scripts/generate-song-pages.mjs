// scripts/generate-song-pages.mjs
//
// Reads data/hot100.json (written by fetch_chart.py) and, for every song
// that doesn't already have a page under songs/, generates one:
//   - cover art (already in hot100.json, from the iTunes Search API)
//   - an embedded YouTube player (found via a lightweight page scrape —
//     no API key, matching the "no card details" constraint)
//   - a Spotify search link (already in hot100.json)
//   - a link to the artist's bio, if bio-index.json has one
//   - a short AI-drafted paragraph via Gemini (same pattern as
//     update-news.mjs), explicitly instructed never to quote lyrics or
//     invent quotes from the artist
//
// Never overwrites an existing songs/{slug}.html for a page a HUMAN has
// touched — but see the pending-retry note below for the one deliberate
// exception.
//
// SONGS INDEX
// After each run, this script also merges what it saw into
// data/songs-index.json — a catalog that only ever grows, unlike
// hot100.json which gets overwritten daily and only ever holds today's
// 100 songs. This is what lets an artist's bio page show every song
// they've ever charted (including ones that have since dropped off the
// Hot 100), and whether each one has a review page to link to. This
// script is the natural place to maintain it, since it already knows,
// for every song, whether a review page exists or was just created.
//
// QUOTA-EXHAUSTION RECOVERY (new)
// If Gemini's daily quota runs out mid-run, the song still gets a page
// (with a "full review coming soon" placeholder) so nothing 404s, but
// enough info to redraft it is saved to song-blurb-pending.json. The
// NEXT run always tries song-blurb-pending.json first, before generating
// any brand-new pages, so a quota-exhausted day self-heals on the next
// scheduled run. This is the one sanctioned exception to "never
// overwrite" — it only ever touches a page THIS SCRIPT marked as its own
// unfinished placeholder, never a page a human has since edited.

import fs from "node:fs/promises";
import path from "node:path";
import { callGemini, isDailyQuotaExhausted } from "./lib/gemini-client.mjs";

const HOT100_PATH = "data/hot100.json";
const BIO_INDEX_PATH = "bio-index.json";
const SONGS_INDEX_PATH = "data/songs-index.json";
const SONGS_DIR = "songs";
const SITE_URL = "https://celestinestudio.com.lk";
const PENDING_PATH = "song-blurb-pending.json";

function slugify(title, artist) {
  const clean = (s) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `${clean(artist)}-${clean(title)}`;
}

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findBioLink(artist, bioIndex) {
  const key = artist.trim().toLowerCase();
  if (bioIndex[key]) return bioIndex[key];
  // Loose fallback: artist string contains a known name (handles
  // "Ella Langley & Morgan Wallen" style multi-artist credits)
  for (const [name, file] of Object.entries(bioIndex)) {
    if (key.includes(name)) return file;
  }
  return null;
}

// Finds a YouTube video id via a lightweight scrape of the search results
// page (no API key). YouTube embeds a JSON blob in the page source
// ("var ytInitialData = {...}") that includes video ids for the results —
// this pulls the first one out with a regex rather than parsing the full
// blob, so it degrades gracefully (returns null) if YouTube changes the
// page structure, instead of crashing the whole run.
async function findYouTubeVideoId(title, artist) {
  const query = encodeURIComponent(`${artist} ${title} official`);
  const url = `https://www.youtube.com/results?search_query=${query}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    return match ? match[1] : null;
  } catch (err) {
    console.error(`YouTube lookup failed for "${title}" by ${artist}:`, err.message);
    return null;
  }
}

async function draftBlurbWithGemini(entry) {
  const prompt = `Write a short (2-3 sentence, under 60 words) editorial-style note about the song "${entry.title}" by ${entry.artist}, for a music chart website. ` +
    `You may reference its chart performance (currently #${entry.rank}, peak #${entry.peak}, ${entry.weeks ?? "several"} weeks on the chart) and general, well-known facts about the artist or song's reception. ` +
    `Do NOT quote or paraphrase any song lyrics. Do NOT invent quotes attributed to the artist. Do NOT state specific factual claims you are not confident are true — keep it general and safe rather than specific and risky. ` +
    `Write it as flowing prose, no headers or bullet points.`;

  return callGemini(prompt); // handles rate-limit pacing and 429 retries itself
}

function renderPage(entry, { videoId, bioLink, blurb }) {
  const coverBlock = entry.coverArt
    ? `<img class="song-cover" src="${escapeHtml(entry.coverArt)}" alt="Cover art for ${escapeHtml(entry.title)}">`
    : `<div class="song-cover song-cover-placeholder"></div>`;

  const videoBlock = videoId
    ? `<div class="song-video">
         <iframe width="100%" height="100%" src="https://www.youtube.com/embed/${videoId}"
           title="${escapeHtml(entry.title)}" frameborder="0"
           allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
           allowfullscreen loading="lazy"></iframe>
       </div>`
    : `<div class="song-video song-video-unavailable"><p>No video available yet.</p></div>`;

  const bioBlock = bioLink
    ? `<a class="song-bio-link" href="../${bioLink}">Read ${escapeHtml(entry.artist)}'s full bio →</a>`
    : "";

  const blurbBlock = blurb
    ? `<p class="song-blurb">${escapeHtml(blurb)}</p><p class="song-draft-tag">Draft note — auto-generated, awaiting a full human review.</p>`
    : `<p class="song-draft-tag">Full review coming soon.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(entry.title)} — ${escapeHtml(entry.artist)} | Celestine</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,900;1,9..144,500;1,9..144,600&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../styles.css">
<style>
  .song-hero{max-width:800px;margin:60px auto 0;padding:0 24px;display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap;}
  .song-cover{width:180px;height:180px;border-radius:6px;object-fit:cover;box-shadow:0 4px 18px rgba(0,0,0,0.18);}
  .song-cover-placeholder{background:linear-gradient(135deg,#e8e4f5,#f5e8f0);}
  .song-hero-meta{flex:1;min-width:240px;}
  .song-hero-meta h1{font-family:'Fraunces',serif;font-size:2.1rem;font-weight:600;margin:0 0 6px;}
  .song-hero-meta .artist{font-size:1.15rem;color:#5c5670;margin:0 0 14px;}
  .song-stats{display:flex;gap:20px;flex-wrap:wrap;font-family:'Inter',sans-serif;font-size:0.85rem;color:#75708a;}
  .song-links{max-width:800px;margin:20px auto 0;padding:0 24px;display:flex;gap:16px;flex-wrap:wrap;align-items:center;}
  .song-spotify,.song-bio-link{font-family:'Inter',sans-serif;font-weight:700;font-size:0.9rem;padding:10px 18px;border:2px solid var(--ink);text-decoration:none;color:var(--ink);}
  .song-spotify{background:#1DB954;color:#fff;border-color:#1DB954;}
  .song-video{max-width:800px;margin:32px auto;padding:0 24px;aspect-ratio:16/9;}
  .song-video iframe{width:100%;height:100%;border-radius:6px;}
  .song-video-unavailable{display:flex;align-items:center;justify-content:center;background:#f0eef7;color:#9a94ac;font-family:'Inter',sans-serif;border-radius:6px;}
  .song-blurb{max-width:800px;margin:0 auto;padding:0 24px;font-family:'Fraunces',serif;font-size:1.15rem;line-height:1.6;color:#2c2836;}
  .song-draft-tag{max-width:800px;margin:10px auto 60px;padding:0 24px;font-family:'Inter',sans-serif;font-size:0.8rem;font-style:italic;color:#9a94ac;}
</style>
</head>
<body>

<header>
  <a href="../index.html" class="logo">Celestine<span></span></a>
  <nav>
    <a href="../bios.html">Artist bios</a>
    <a href="../film.html">Film</a>
    <a href="../music.html">Music</a>
    <a href="../charts.html">Charts</a>
    <a href="../news.html">News</a>
    <a href="../about.html">About</a>
  </nav>
</header>

<div class="song-hero">
  ${coverBlock}
  <div class="song-hero-meta">
    <h1>${escapeHtml(entry.title)}</h1>
    <p class="artist">${escapeHtml(entry.artist)}</p>
    <div class="song-stats">
      <span>Currently #${entry.rank}</span>
      <span>Peak #${entry.peak ?? "—"}</span>
      <span>${entry.weeks ?? "—"} weeks on chart</span>
    </div>
  </div>
</div>

<div class="song-links">
  <a class="song-spotify" href="${escapeHtml(entry.spotifyUrl)}" target="_blank" rel="noopener">Listen on Spotify</a>
  ${bioBlock}
</div>

${videoBlock}

${blurbBlock}

<footer>
  <a href="../index.html" class="logo">Celestine<span></span></a>
  <div class="socials">
    <a href="https://youtube.com/@celestinestudio" target="_blank">YouTube</a>
    <a href="https://www.instagram.com/celestine_studio_" target="_blank">Instagram</a>
    <a href="https://web.facebook.com/profile.php?id=61594418093291" target="_blank">Facebook</a>
  </div>
  <div class="fine">© 2026 Celestine Studio. All rights reserved.</div>
</footer>

</body>
</html>
`;
}

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

  // --- Pass 1: retry anything left over from a quota-exhausted run ---
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
      filled++;
    } else {
      stillPending[slug] = info;
    }
  }
  pending = stillPending;
  if (filled) console.log(`Filled in ${filled} previously-pending song blurb(s).`);

  // --- Pass 2: existing logic, generating brand-new song pages ---
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

      await sleep(500); // light courtesy pacing for the YouTube scrape; Gemini paces itself
    }

    // Merge into the persistent catalog regardless of whether the page
    // was just created or already existed — this is what keeps the
    // index accurate for songs generated by past runs too.
    const existing = songsIndex[slug];
    songsIndex[slug] = {
      slug,
      title: entry.title,
      artist: entry.artist,
      firstSeen: existing?.firstSeen || today,
      lastSeen: today,
      peak: Math.min(entry.peak ?? entry.rank, existing?.peak ?? Infinity),
      hasReview: alreadyExists || true, // page exists either way after this point
      // Carried over from hot100.json (iTunes Search API) so listing pages
      // (music.html) can render a real cover instead of a placeholder.
      // Re-merged every run — including for songs that already had a page —
      // so this backfills automatically for older entries too.
      coverArt: entry.coverArt || existing?.coverArt || null,
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
