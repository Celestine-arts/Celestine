// scripts/update-news.mjs  (FREE VERSION — no AI API needed)
//
// Fetches items from news-sources.json (RSS feeds only), takes the title +
// a short excerpt directly from each feed, and regenerates the news card
// markup inside news.html between two marker comments.
//
// Requires (package.json): "rss-parser"
// No API key needed — completely free to run.

import fs from "node:fs/promises";
import Parser from "rss-parser";

const SOURCES_PATH = "news-sources.json";
const NEWS_JSON_PATH = "news.json";
const NEWS_HTML_PATH = "news.html";
const MAX_ITEMS_KEPT = 12;
const MAX_NEW_ITEMS_PER_RUN = 6;

const rssParser = new Parser();

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

function guessCategory(sourceName = "") {
  const n = sourceName.toLowerCase();
  if (n.includes("film")) return "Film";
  if (n.includes("music") || n.includes("label")) return "Music";
  return "Art";
}

async function fetchRssItems(source) {
  const feed = await rssParser.parseURL(source.url);
  return (feed.items || []).slice(0, 5).map((item) => {
    const excerpt = stripHtml(item.contentSnippet || item.content || "").slice(0, 160);
    return {
      sourceName: source.name,
      link: item.link,
      headline: item.title || source.name,
      summary: excerpt ? `${excerpt}${excerpt.length >= 160 ? "…" : ""}` : "Read the full story at the source.",
      category: guessCategory(source.name),
      publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
    };
  });
}

function renderCard(entry) {
  const date = new Date(entry.publishedAt).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `<a class="card c-span-2" href="${entry.link}" target="_blank" rel="noopener">
      <div class="thumb t-news"><span>${entry.category.toUpperCase()}</span></div>
      <div class="body"><h3>${entry.headline}</h3><p>${entry.summary}</p><div class="meta">${entry.sourceName} · ${date}</div></div>
    </a>`;
}

async function main() {
  const sources = await loadJson(SOURCES_PATH, []);
  const existing = await loadJson(NEWS_JSON_PATH, []);
  const knownLinks = new Set(existing.map((e) => e.link));

  const candidates = [];
  for (const source of sources) {
    if (source.type !== "rss") continue; // free version: RSS sources only
    try {
      const items = await fetchRssItems(source);
      for (const item of items) {
        if (!knownLinks.has(item.link)) candidates.push(item);
      }
    } catch (err) {
      console.error(`Failed to fetch ${source.name}:`, err.message);
    }
  }

  const newEntries = candidates.slice(0, MAX_NEW_ITEMS_PER_RUN);

  if (newEntries.length === 0) {
    console.log("No new items found this run.");
    return;
  }

  const merged = [...newEntries, ...existing].slice(0, MAX_ITEMS_KEPT);
  await fs.writeFile(NEWS_JSON_PATH, JSON.stringify(merged, null, 2));

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

  console.log(`Added ${newEntries.length} new item(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
