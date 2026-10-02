// scripts/generate-song-pages.mjs
//
// Reads data/hot100.json (written by fetch_chart.py) and, for every song
// that doesn't already have a page under songs/, generates one:
//   - cover art (already in hot100.json, from the iTunes Search API)
//   - an embedded YouTube player (lightweight page scrape, no API key)
//   - a Spotify search link (already in hot100.json)
//   - a link to the artist's bio, if bio-index.json has one
//   - a short AI-drafted paragraph via Gemini, explicitly instructed never
//     to quote lyrics or invent quotes from the artist
//
// Never overwrites an existing songs/{slug}.html for a page a HUMAN has
// touched — except the pending-retry pass below.
//
// SONGS INDEX: after each run, merges what it saw into
// data/songs-index.json, a catalog that only ever grows.
//
// BIO-INDEX VALUE SHAPE — {href, thumbnail, name}
// findBioLink() always returns { href, thumbnail } or null. It now also
// accepts OLD bare-string entries (via toBioObject), so a bio-index.json
// that hasn't been upgraded yet can't produce "../undefined" links.
// Junk keys starting with & or + (from the fused-connector bug) are
// ignored so a song can't link to a mis-named bio.
//
// QUOTA-EXHAUSTION RECOVERY: if Gemini's quota runs out, the song still
// gets a placeholder page and is saved to song-blurb-pending.json; the
// next run redrafts it.

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

// Must match generate-artist-bios.mjs's normalizeKey() exactly.
function normalizeKey(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// A row parsed by the old fetch_chart.py connector bug: artist starts with
// a dangling connector ("& John Mayer", "Featuring X") or the title ends
// with one ("Belly Gang Kushington &"). Their titles/artists are wrong, so
// the page and catalog entry should go; the correctly-parsed version of
// the song gets created fresh under its proper slug.
function isJunkSong(song) {
  const artist = (song.artist || "").trim();
  const title = (song.title || "").trim();
  return (
    /^(?:[&+]|featuring\b|feat\.?(?=\s))/i.test(artist) ||
    /\s[&+]$/.test(title) ||
    /[&+]$/.test(artist)
  );
}

// Accepts an old bare-string entry or a new object entry.
function toBioObject(value) {
  if (!value) return null;
  if (typeof value === "string") return { href: value, thumbnail: null };
  if (!value.href) return null;
  return { href: value.href, thumbnail: value.thumbnail || null };
}

// Returns { href, thumbnail } for the best bio match, or null if none.
function findBioLink(artist, bioIndex) {
  const key = normalizeKey(artist);
  const exact = toBioObject(bioIndex[key]);
  if (exact) return exact;
  // Loose fallback: credit contains a known name (handles
  // "Ella Langley & Morgan Wallen" style multi-artist credits).
  // The length guard is a light mitigation against short-key false matches.
  for (const [name, info] of Object.entries(bioIndex)) {
    if (/^[&+]/.test(name)) continue; // junk keys from the connector bug
    if (name.length > 3 && key.includes(name)) {
      const obj = toBioObject(info);
      if (obj) return obj;
    }
  }
  return null;
}

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

  return callGemini(prompt);
}

function renderPage(entry, { videoId, bioLink, blurb }) {
  const isDraft = !!blurb;

  const coverFigure = entry.coverArt
    ? `<figure class="figure-full">
         <div class="frame" style="background-image:url('${escapeHtml(entry.coverArt)}');background-size:cover;background-position:center;"></div>
       </figure>`
    : "";

  const videoBlock = videoId
    ? `<div class="inline-figure" style="max-width:760px;margin:34px auto;">
         <div class="frame" style="height:auto;aspect-ratio:16/9;background:#151220;">
           <iframe width="100%" height="100%" style="display:block;border:0;"
             src="https://www.youtube.com/embed/${videoId}"
             title="${escapeHtml(entry.title)}"
             allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
             allowfullscreen loading="lazy"></iframe>
         </div>
       </div>`
    : `<div class="inline-figure" style="max-width:760px;margin:34px auto;">
         <div class="frame" style="height:160px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#e8e4f5,#f5e8f0);">
           <p style="margin:0;font-family:'Inter',sans-serif;color:#9a94ac;">No video available yet.</p>
         </div>
       </div>`;

  const bioLinkBlock = bioLink
    ? `<a class="hero-cta" style="padding:12px 22px;box-shadow:5px 5px 0 var(--ink);" href="../${escapeHtml(bioLink.href)}">Read ${escapeHtml(entry.artist)}'s bio →</a>`
    : "";

  const blurbText = blurb || "Full review coming soon — check back as our editorial team finishes this one.";
  const draftTag = isDraft
    ? `<p class="artist-draft-tag" style="max-width:760px;margin:14px auto 0;padding:0 5vw;font-family:'Inter',sans-serif;font-size:0.8rem;font-style:italic;color:#9a94ac;">Draft note — auto-generated, awaiting a full human review.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(entry.title)} — ${escapeHtml(entry.artist)} | Celestine</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,900;1,9..144,500;1,9..144,600&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../styles.css">
<link rel="icon" type="image/x-icon" href="../favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-96x96.png">
<link rel="apple-touch-icon" href="../apple-touch-icon.png">
</head>
<body>

<div class="cosmos" aria-hidden="true"><i></i><i></i><i></i><i></i></div>

<header>
  <a href="../index.html" class="logo">Celestine<span></span></a>
  <button class="hamburger" id="hamburger-btn" aria-label="Toggle Menu">
    <span></span>
    <span></span>
    <span></span>
  </button>
  <nav id="nav-menu">
    <a href="../bios.html">Artist bios</a>
    <a href="../film.html">Film</a>
    <a href="../music.html">Music</a>
    <a href="../charts.html">Charts</a>
    <a href="../news.html">News</a>
    <a href="../about.html">About</a>
  </nav>
</header>

<div class="masthead" style="border-bottom:3px solid var(--ink);">
  <span class="tag">Song Review${isDraft ? " · Draft" : ""}</span>
  <h1>${escapeHtml(entry.title)}</h1>
  <p class="dek">${escapeHtml(entry.artist)}</p>
  <p class="range">Currently #${entry.rank} · Peak #${entry.peak ?? "—"} · ${entry.weeks ?? "—"} weeks on chart</p>
</div>

${coverFigure}

<article style="padding-top:40px;">
  <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
    <a class="hero-cta" style="padding:12px 22px;box-shadow:5px 5px 0 var(--ink);" href="${escapeHtml(entry.spotifyUrl)}" target="_blank" rel="noopener">Listen on Spotify</a>
    ${bioLinkBlock}
  </div>

  ${videoBlock}

  <section class="chapter" style="padding:20px 0 0;border-bottom:none;">
    <p>${escapeHtml(blurbText)}</p>
  </section>
</article>

${draftTag}

<footer>
  <a href="../index.html" class="logo">Celestine<span></span></a>
  <div class="socials">
    <a href="https://youtube.com/@celestinestudio" target="_blank">YouTube</a>
    <a href="https://www.instagram.com/celestine_studio_" target="_blank">Instagram</a>
    <a href="https://web.facebook.com/profile.php?id=61594418093291" target="_blank">Facebook</a>
  </div>
  <div class="fine">© 2026 Celestine Studio. All rights reserved.</div>
</footer>

<script>
  (function() {
    var hamburgerBtn = document.getElementById('hamburger-btn');
    var navMenu = document.getElementById('nav-menu');
    var navLinks = document.querySelectorAll('#nav-menu a');
    hamburgerBtn.addEventListener('click', function() {
      hamburgerBtn.classList.toggle('open');
      navMenu.classList.toggle('open');
    });
    navLinks.forEach(function(link) {
      link.addEventListener('click', function() {
        hamburgerBtn.classList.remove('open');
        navMenu.classList.remove('open');
      });
    });
  })();
</script>

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

  // --- Pass 0: prune junk rows left behind by the old connector bug ---
  // songs/ only ever holds pages this script generated (hand-written
  // reviews live in music/), so deleting those files is safe.
  let pruned = 0;
  for (const [slug, song] of Object.entries(songsIndex)) {
    if (!isJunkSong(song)) continue;
    delete songsIndex[slug];
    delete pending[slug];
    await fs.rm(path.join(SONGS_DIR, `${slug}.html`), { force: true });
    pruned++;
  }
  if (pruned) console.log(`Pruned ${pruned} junk song(s) from the catalog and songs/.`);

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
      // Re-resolve the bio link: a bio may have been created (or the
      // stored one may be in the old shape) since this was queued.
      const bioLink = findBioLink(info.entry.artist, bioIndex) || toBioObject(info.bioLink);
      const html = renderPage(info.entry, { videoId: info.videoId, bioLink, blurb });
      await fs.writeFile(path.join(SONGS_DIR, `${slug}.html`), html);
      filled++;
    } else {
      stillPending[slug] = info;
    }
  }
  pending = stillPending;
  if (filled) console.log(`Filled in ${filled} previously-pending song blurb(s).`);

  // --- Pass 2: generate brand-new song pages ---
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
      hasReview: true,
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
