// scripts/update-news.mjs  (RSS + free Gemini AI summaries)
//
// Fetches items from news-sources.json (RSS feeds only), asks Gemini to
// write a short original summary of each new item, and regenerates the
// news card markup inside news.html between two marker comments.
// Also generates feed.xml (an RSS feed of the site's own news items).
//
// Requires (package.json): "rss-parser"
// Requires a GEMINI_API_KEY secret (free, from Google AI Studio).
//
// QUOTA-EXHAUSTION RECOVERY (new)
// Every entry now keeps its raw source text (rawText) alongside its
// summary. If Gemini's daily quota runs out before an item gets a real
// AI summary, that entry is saved with a truncated raw-text fallback AND
// an aiPending: true flag. The NEXT run always retries every aiPending
// entry first, before fetching any new RSS items — using the already-
// stored rawText, so no re-fetch of the source feed is needed — and only
// clears the flag once a real summary comes back. This means a quota-
// exhausted day self-heals on the next scheduled run instead of leaving
// that entry stuck on a raw excerpt forever. This also now goes through
// the same shared, rate-limited gemini-client.mjs used by the other two
// generator scripts, instead of a separate unthrottled fetch call.

import fs from "node:fs/promises";
import Parser from "rss-parser";
import { callGemini, isDailyQuotaExhausted } from "./lib/gemini-client.mjs";

const SOURCES_PATH = "news-sources.json";
const NEWS_JSON_PATH = "news.json";
const NEWS_HTML_PATH = "news.html";
const FEED_XML_PATH = "feed.xml";
const SITE_URL = "https://celestinestudio.com.lk";
const MAX_ITEMS_KEPT = 30;
const MAX_NEW_ITEMS_PER_RUN = 10;

// Keywords that mean "not an art/music/film story" — items matching these
// (in headline or body text) are skipped before they're ever added as a
// candidate. Not perfect (a legit "war photography exhibit" story could get
// caught), so check the Action logs for "Skipped (off-topic)" lines and
// adjust this list if you notice false positives.
const BLOCKED_KEYWORDS = [
  "trump", "biden", "election", "congress", "senate", "president",
  "democrat", "republican", "midterm", "war in", "invasion", "ceasefire",
  "politics", "political", "campaign", "shooting", "indictment",
];

function isOffTopic(headline = "", rawText = "") {
  const text = `${headline} ${rawText}`.toLowerCase();
  return BLOCKED_KEYWORDS.some((word) => text.includes(word));
}

// IMPORTANT: without this customFields config, rss-parser silently drops
// <media:content> and <media:thumbnail> tags, which is why images never showed up.
const rssParser = new Parser({
  customFields: {
    item: [
      ["media:content", "media:content", { keepArray: true }],
      ["media:thumbnail", "media:thumbnail"],
    ],
  },
});

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function stripHtml(str = "") {
  return str.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function guessCategory(sourceName = "") {
  const n = sourceName.toLowerCase();
  const filmSources = ["variety", "indiewire", "film"];
  const musicSources = ["pitchfork", "nme", "soompi", "music", "label"];
  if (filmSources.some((s) => n.includes(s))) return "Film";
  if (musicSources.some((s) => n.includes(s))) return "Music";
  return "Art"; // Hyperallergic, Colossal, Vanity Fair, Vogue, NYT Arts default here
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pulls an image out of the RSS item itself (enclosure, media:content, media:thumbnail,
// or an <img> tag hiding in the full content). Returns null if the feed has nothing.
function extractImage(item) {
  if (item.enclosure?.url) return item.enclosure.url;

  const mediaContent = item["media:content"];
  if (mediaContent) {
    const arr = Array.isArray(mediaContent) ? mediaContent : [mediaContent];
    const found = arr.find((m) => m?.$?.url);
    if (found) return found.$.url;
  }

  const mediaThumbnail = item["media:thumbnail"];
  if (mediaThumbnail?.$?.url) return mediaThumbnail.$.url;

  const html = item.content || item["content:encoded"] || "";
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

// Fallback for feeds (like Soompi's) that carry no image info at all: fetch the
// actual article page and pull its og:image meta tag. Only called for items that
// still have no image after extractImage(), and only for items we're actually keeping.
async function fetchOgImage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CelestineBot/1.0)" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    const match =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return match ? match[1] : null;
  } catch (err) {
    console.error(`Could not fetch og:image for ${url}:`, err.message);
    return null;
  }
}

async function fetchRssItems(source) {
  const feed = await rssParser.parseURL(source.url);
  return (feed.items || []).slice(0, 5).map((item) => ({
    sourceName: source.name,
    link: item.link,
    headline: item.title || source.name,
    rawText: stripHtml(item.contentSnippet || item.content || item.title || ""),
    image: extractImage(item),
    category: guessCategory(source.name),
    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
  }));
}

function renderCard(entry) {
  const date = new Date(entry.publishedAt).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const thumb = entry.image
    ? `<div class="thumb t-news" style="background-image:url('${escapeHtml(entry.image)}');background-size:cover;background-position:center;">
         <span>${entry.category.toUpperCase()}</span>
       </div>`
    : `<div class="thumb t-news"><span>${entry.category.toUpperCase()}</span></div>`;

  return `<a class="card c-span-2" href="${entry.link}" target="_blank" rel="noopener">
      ${thumb}
      <div class="body"><h3>${escapeHtml(entry.headline)}</h3><p>${escapeHtml(entry.summary)}</p><div class="meta">${escapeHtml(entry.sourceName)} · ${date}</div></div>
    </a>`;
}

function generateRssFeed(entries) {
  const items = entries
    .map(
      (e) => `
    <item>
      <title>${escapeXml(e.headline)}</title>
      <link>${escapeXml(e.link)}</link>
      <guid>${escapeXml(e.link)}</guid>
      <pubDate>${new Date(e.publishedAt).toUTCString()}</pubDate>
      <description>${escapeXml(e.summary)}</description>
    </item>`
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Celestine — Art, Music &amp; Film News</title>
    <link>${SITE_URL}/news.html</link>
    <description>What's happening right now across art, music, and film.</description>
    ${items}
  </channel>
</rss>`;
}

async function summarizeWithGemini(headline, rawText) {
  const prompt = `Summarize this arts/culture news item in exactly one punchy sentence (max 30 words), for a curated news feed. Do not add opinions or quotes, just state what happened. Headline: "${headline}". Source text: "${(rawText || "").slice(0, 1500)}"`;
  return callGemini(prompt); // handles rate-limit pacing and 429 retries itself
}

async function main() {
  const sources = await loadJson(SOURCES_PATH, []);
  const existing = await loadJson(NEWS_JSON_PATH, []);
  const knownLinks = new Set(existing.map((e) => e.link));

  // --- Pass 1: retry anything left pending from a quota-exhausted run ---
  let filled = 0;
  for (const entry of existing) {
    if (!entry.aiPending) continue;
    if (isDailyQuotaExhausted()) break; // stop trying, save the calls
    const aiSummary = await summarizeWithGemini(entry.headline, entry.rawText);
    if (aiSummary) {
      entry.summary = aiSummary;
      delete entry.aiPending;
      filled++;
    }
  }
  if (filled) console.log(`Filled in ${filled} previously-pending summary(s).`);

  // --- Pass 2: existing logic, fetching new RSS items ---
  const perSourceCandidates = [];
  for (const source of sources) {
    if (source.type !== "rss") continue;
    try {
      const items = await fetchRssItems(source);
      const newItems = items.filter((item) => {
        if (knownLinks.has(item.link)) return false;
        if (isOffTopic(item.headline, item.rawText)) {
          console.log(`Skipped (off-topic): ${item.headline}`);
          return false;
        }
        return true;
      });
      if (newItems.length) perSourceCandidates.push(newItems);
    } catch (err) {
      console.error(`Failed to fetch ${source.name}:`, err.message);
    }
  }

  // Round-robin interleave: one item from each source per round, so early
  // sources in the list (Soompi, Variety) can't crowd out the rest.
  const candidates = [];
  let round = 0;
  while (
    candidates.length < MAX_NEW_ITEMS_PER_RUN &&
    perSourceCandidates.some((arr) => arr.length > round)
  ) {
    for (const arr of perSourceCandidates) {
      if (arr[round] && candidates.length < MAX_NEW_ITEMS_PER_RUN) {
        candidates.push(arr[round]);
      }
    }
    round++;
  }

  const picked = candidates;
  const newEntries = [];

  if (picked.length === 0) {
    console.log("No new items found this run — re-rendering existing cards only.");
  } else {
    for (const item of picked) {
      // If the feed itself had no image, try grabbing it from the article page.
      let image = item.image;
      if (!image) {
        image = await fetchOgImage(item.link);
      }

      const aiSummary = await summarizeWithGemini(item.headline, item.rawText);
      const fallback = item.rawText.slice(0, 160);
      const quotaCausedIt = !aiSummary && isDailyQuotaExhausted();

      newEntries.push({
        sourceName: item.sourceName,
        link: item.link,
        headline: item.headline,
        rawText: item.rawText, // kept so a pending retry doesn't need to re-fetch RSS
        summary: aiSummary || (fallback ? `${fallback}…` : "Read the full story at the source."),
        category: item.category,
        image,
        publishedAt: item.publishedAt,
        ...(quotaCausedIt ? { aiPending: true } : {}),
      });
      await sleep(3000); // be gentle with the free-tier rate limit
    }
  }

  const merged = [...newEntries, ...existing].slice(0, MAX_ITEMS_KEPT);
  await fs.writeFile(NEWS_JSON_PATH, JSON.stringify(merged, null, 2));
  await fs.writeFile(FEED_XML_PATH, generateRssFeed(merged));

  const cardsHtml = merged.map(renderCard).join("\n");
  const html = await fs.readFile(NEWS_HTML_PATH, "utf8");
  const updated = html.replace(
    /<!-- NEWS_CARDS_START -->[\s\S]*<!-- NEWS_CARDS_END -->/,
    `<!-- NEWS_CARDS_START -->\n${cardsHtml}\n<!-- NEWS_CARDS_END -->`
  );

  if (updated === html) {
    console.warn("Markers not found in news.html — cards were not injected.");
  } else {
    await fs.writeFile(NEWS_HTML_PATH, updated);
  }

  const stillPending = merged.filter((e) => e.aiPending).length;
  console.log(`Added ${newEntries.length} new item(s), filled ${filled} pending, ${stillPending} still pending.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
