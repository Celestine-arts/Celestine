// scripts/update-news.mjs  (RSS + free Gemini AI summaries)
//
// Fetches items from news-sources.json (RSS feeds only), asks Gemini to
// write a short original summary of each new item, and regenerates the
// news card markup inside news.html between two marker comments.
//
// Requires (package.json): "rss-parser"
// Requires a GEMINI_API_KEY secret (free, from Google AI Studio).

import fs from "node:fs/promises";
import Parser from "rss-parser";

const SOURCES_PATH = "news-sources.json";
const NEWS_JSON_PATH = "news.json";
const NEWS_HTML_PATH = "news.html";
const MAX_ITEMS_KEPT = 12;
const MAX_NEW_ITEMS_PER_RUN = 6;

// Google AI Studio "-latest" alias — check https://ai.google.dev/gemini-api/docs/models
// occasionally in case Google retires this alias; swap in a current model name if so.
const GEMINI_MODEL = "gemini-flash-lite-latest";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function summarizeWithGemini(headline, rawText) {
  if (!GEMINI_API_KEY) return null;

  const prompt = `Summarize this arts/culture news item in exactly one punchy sentence (max 30 words), for a curated news feed. Do not add opinions or quotes, just state what happened. Headline: "${headline}". Source text: "${rawText.slice(0, 1500)}"`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!res.ok) {
      console.error("Gemini API error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? text.trim() : null;
  } catch (err) {
    console.error("Gemini call failed:", err.message);
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
    if (source.type !== "rss") continue; // RSS sources only
    try {
      const items = await fetchRssItems(source);
      for (const item of items) {
        if (!knownLinks.has(item.link)) candidates.push(item);
      }
    } catch (err) {
      console.error(`Failed to fetch ${source.name}:`, err.message);
    }
  }

  const picked = candidates.slice(0, MAX_NEW_ITEMS_PER_RUN);

  if (picked.length === 0) {
    console.log("No new items found this run.");
    return;
  }

  const newEntries = [];
  for (const item of picked) {
    const aiSummary = await summarizeWithGemini(item.headline, item.rawText);
    const fallback = item.rawText.slice(0, 160);
    newEntries.push({
      sourceName: item.sourceName,
      link: item.link,
      headline: item.headline,
      summary: aiSummary || (fallback ? `${fallback}…` : "Read the full story at the source."),
      category: item.category,
      publishedAt: item.publishedAt,
    });
    await sleep(3000); // be gentle with the free-tier rate limit
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
