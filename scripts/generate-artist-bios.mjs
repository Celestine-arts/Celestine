// scripts/generate-artist-bios.mjs
//
// For every individual artist name found across today's chart
// (data/hot100.json) and the historical catalog (data/songs-index.json)
// that doesn't already have an entry in bio-index.json, this generates a
// bio page at the site root — root/{slug}.html, matching the existing
// convention already used by the hand-written bio pages listed in
// bio-index.json (e.g. "jisoo.html", "rose.html") — and adds a new entry
// so both song pages and future runs can link to it.
//
// Runs BEFORE generate-song-pages.mjs in the workflow, on purpose: that
// way a brand-new artist's bio already exists by the time their first
// song page is generated, so the song → bio link is there from day one
// instead of being permanently missing (song pages are never rewritten
// once created).
//
// GROUNDING
// To keep the AI from inventing biographical "facts," this script only
// drafts prose for an artist when it found a real summary via Wikipedia's
// free REST API (no key needed, no auth). If no Wikipedia page is found,
// the artist still gets a page — so the song → bio link never 404s —
// but with a plain "full bio coming soon" placeholder instead of guessed
// text.
//
// SONG LIST
// Rather than bake each artist's song list into the page at generation
// time (which would mean rewriting every existing bio page whenever that
// artist charts again), each bio page loads data/songs-index.json client-
// side and filters for songs whose artist credit contains this artist's
// name. That keeps every bio page automatically current with zero
// re-generation cost — the same approach charts.html already uses for
// its own live search box.
//
// ARTIST-NAME SPLITTING — known limitation
// A song's "artist" field can be a multi-artist credit ("X Featuring Y",
// "X & Y"), and this script splits those into individual names so each
// artist gets their own page. The naive version of this breaks on band
// names that legitimately contain a connector word — "Florence and the
// Machine" would otherwise get split into "Florence" and "the Machine".
// PROTECTED_ARTIST_NAMES below is a manual allow-list checked before
// splitting; it's deliberately small and meant to be extended by hand
// whenever you spot a wrong split on the live site. There's no fully
// automatic fix for this — it's a genuinely ambiguous text problem.
//
// QUOTA-EXHAUSTION RECOVERY (new)
// If Gemini's daily quota runs out mid-run, the artist still gets a page
// (with a "coming soon" placeholder) so the song → bio link never 404s,
// but that artist's name/wiki extract are also saved to bio-pending.json.
// The NEXT run always tries bio-pending.json first, before generating any
// brand-new pages, so a quota-exhausted day self-heals on the next
// scheduled run instead of leaving that placeholder in place forever.

import fs from "node:fs/promises";
import { callGemini, isDailyQuotaExhausted } from "./lib/gemini-client.mjs";

const HOT100_PATH = "data/hot100.json";
const SONGS_INDEX_PATH = "data/songs-index.json";
const BIO_INDEX_PATH = "bio-index.json";
const BIO_PENDING_PATH = "bio-pending.json";

const PROTECTED_ARTIST_NAMES = [
  "Florence and the Machine",
  "Hall and Oates",
  "Earth, Wind & Fire",
  "Simon and Garfunkel",
  "Ashford and Simpson",
  "Chip and Dale",
  "Emerson, Lake & Palmer",
  // Add more here whenever a real credit gets wrongly split on the site —
  // this list can't anticipate every band name that contains a connector.
];

// Same connector vocabulary as fetch_chart.py's artist-credit merging,
// used here in reverse to SPLIT a merged credit back into individual
// names. Requires whitespace on both sides so it only matches standalone
// connector words/symbols, not letters inside a longer word.
const CONNECTOR_PATTERN = /\s+(?:featuring|feat\.?|with|duet with|and|&|\+|x|vs\.?)\s+/gi;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitArtists(creditString) {
  let working = creditString;
  const placeholders = [];

  PROTECTED_ARTIST_NAMES.forEach((fullName, i) => {
    if (working.toLowerCase().includes(fullName.toLowerCase())) {
      const token = `__PROTECTED_${i}__`;
      working = working.replace(new RegExp(escapeRegex(fullName), "ig"), token);
      placeholders[i] = fullName;
    }
  });

  let names = working
    .split(",")
    .flatMap((part) => part.split(CONNECTOR_PATTERN))
    .map((name) => name.trim())
    .filter(Boolean);

  return names.map((name) => {
    const m = name.match(/^__PROTECTED_(\d+)__$/);
    return m ? placeholders[Number(m[1])] : name;
  });
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
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

// Wikipedia's free summary endpoint — no API key, no auth. Returns null
// if the artist has no page, the page is a disambiguation page, or the
// lookup fails, so a missing page never crashes the run.
async function fetchWikipediaSummary(name) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, "_"))}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "CelestineStudioBot/1.0 (celestinestudio.com.lk)" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.extract || data.type === "disambiguation") return null;
    return {
      extract: data.extract,
      thumbnail: data.thumbnail?.source || data.originalimage?.source || null,
      wikiUrl: data.content_urls?.desktop?.page || null,
    };
  } catch (err) {
    console.error(`Wikipedia lookup failed for "${name}":`, err.message);
    return null;
  }
}

async function draftBioWithGemini(name, wikiExtract) {
  const prompt =
    `Using ONLY the facts in the reference text below, write a short (3-4 sentence, under 100 words) artist bio for "${name}" for a music chart website. ` +
    `Do not add any fact, date, award, or claim that is not present in the reference text. Do not invent quotes. Write flowing prose, no headers or bullet points.\n\n` +
    `Reference text:\n"""${wikiExtract}"""`;

  return callGemini(prompt); // handles rate-limit pacing and 429 retries itself
}

function renderPage(name, { bio, thumbnail, wikiUrl, isDraft }) {
  const photoBlock = thumbnail
    ? `<img class="artist-photo" src="${escapeHtml(thumbnail)}" alt="${escapeHtml(name)}">`
    : `<div class="artist-photo artist-photo-placeholder"></div>`;

  const bioBlock = bio
    ? `<p class="artist-bio-text">${escapeHtml(bio)}</p>` +
      (isDraft
        ? `<p class="artist-draft-tag">Draft bio — auto-generated from public sources, awaiting a full human writeup.</p>`
        : "")
    : `<p class="artist-draft-tag">Full bio coming soon.</p>`;

  const sourceBlock = wikiUrl
    ? `<a class="artist-source-link" href="${escapeHtml(wikiUrl)}" target="_blank" rel="noopener">Source: Wikipedia →</a>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(name)} | Celestine</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,900;1,9..144,500;1,9..144,600&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="styles.css">
<style>
  .artist-hero{max-width:800px;margin:60px auto 0;padding:0 24px;display:flex;gap:28px;align-items:center;flex-wrap:wrap;}
  .artist-photo{width:160px;height:160px;border-radius:50%;object-fit:cover;box-shadow:0 4px 18px rgba(0,0,0,0.18);}
  .artist-photo-placeholder{background:linear-gradient(135deg,#e8e4f5,#f5e8f0);}
  .artist-hero h1{font-family:'Fraunces',serif;font-size:2.1rem;font-weight:600;margin:0;}
  .artist-bio-text{max-width:800px;margin:28px auto 0;padding:0 24px;font-family:'Fraunces',serif;font-size:1.15rem;line-height:1.6;color:#2c2836;}
  .artist-draft-tag{max-width:800px;margin:10px auto 0;padding:0 24px;font-family:'Inter',sans-serif;font-size:0.8rem;font-style:italic;color:#9a94ac;}
  .artist-source-link{display:block;max-width:800px;margin:14px auto 0;padding:0 24px;font-family:'Inter',sans-serif;font-size:0.85rem;color:#5c5670;text-decoration:none;}
  .artist-source-link:hover{color:var(--violet);}
  .artist-songs{max-width:800px;margin:50px auto 80px;padding:0 24px;}
  .artist-songs h2{font-family:'Fraunces',serif;font-size:1.4rem;font-weight:600;margin:0 0 16px;}
  .artist-song-row{display:flex;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid rgba(0,0,0,0.08);}
  .artist-song-row .no-cover{width:44px;height:44px;border-radius:4px;background:linear-gradient(135deg,#e8e4f5,#f5e8f0);flex-shrink:0;}
  .artist-song-row a{font-family:'Inter',sans-serif;font-weight:600;color:var(--ink);text-decoration:none;}
  .artist-song-row a:hover{color:var(--violet);}
  .artist-song-row span{font-family:'Inter',sans-serif;font-size:0.85rem;color:#9a94ac;}
  #artistSongsStatus{font-family:'Inter',sans-serif;font-size:0.9rem;color:#9a94ac;font-style:italic;}
</style>
</head>
<body>

<header>
  <a href="index.html" class="logo">Celestine<span></span></a>
  <nav>
    <a href="bios.html">Artist bios</a>
    <a href="film.html">Film</a>
    <a href="music.html">Music</a>
    <a href="charts.html">Charts</a>
    <a href="news.html">News</a>
    <a href="about.html">About</a>
  </nav>
</header>

<div class="artist-hero">
  ${photoBlock}
  <h1>${escapeHtml(name)}</h1>
</div>

${bioBlock}
${sourceBlock}

<section class="artist-songs">
  <h2>Songs on our charts</h2>
  <div id="artistSongsList"></div>
  <p id="artistSongsStatus">Loading…</p>
</section>

<footer>
  <a href="index.html" class="logo">Celestine<span></span></a>
  <div class="socials">
    <a href="https://youtube.com/@celestinestudio" target="_blank">YouTube</a>
    <a href="https://www.instagram.com/celestine_studio_" target="_blank">Instagram</a>
    <a href="https://web.facebook.com/profile.php?id=61594418093291" target="_blank">Facebook</a>
  </div>
  <div class="fine">© 2026 Celestine Studio. All rights reserved.</div>
</footer>

<script>
  (function() {
    var ARTIST_NAME = ${JSON.stringify(name)};
    var listEl = document.getElementById('artistSongsList');
    var statusEl = document.getElementById('artistSongsStatus');

    fetch('data/songs-index.json')
      .then(function(res) {
        if (!res.ok) throw new Error('not found');
        return res.json();
      })
      .then(function(songs) {
        var needle = ARTIST_NAME.toLowerCase();
        var matches = Object.values(songs).filter(function(s) {
          return s.artist.toLowerCase().indexOf(needle) !== -1;
        });
        matches.sort(function(a, b) { return (a.peak || 999) - (b.peak || 999); });

        if (matches.length === 0) {
          statusEl.textContent = "No charting songs found yet for this artist.";
          return;
        }
        statusEl.style.display = 'none';
        matches.forEach(function(s) {
          var row = document.createElement('div');
          row.className = 'artist-song-row';
          var link = s.hasReview
            ? '<a href="songs/' + s.slug + '.html">' + s.title + '</a>'
            : '<span>' + s.title + '</span>';
          row.innerHTML = '<div class="no-cover"></div><div>' + link + '<br><span>Peak #' + (s.peak || '—') + '</span></div>';
          listEl.appendChild(row);
        });
      })
      .catch(function() {
        statusEl.textContent = "Couldn't load this artist's songs right now.";
      });
  })();
</script>

</body>
</html>
`;
}

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
    if (bioIndex[key]) continue; // already has a bio page

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

    await sleep(300); // light courtesy pacing for Wikipedia's API; Gemini paces itself
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
