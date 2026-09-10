// scripts/update-news.mjs
//
// Fetches items from news-sources.json (RSS or plain HTML pages), asks Claude
// to write a short original summary + headline for any item not already in
// news.json, then regenerates the news card markup inside news.html between
// two marker comments.
//
// Requires (package.json): "rss-parser", "cheerio", "@anthropic-ai/sdk"
// Requires env var: ANTHROPIC_API_KEY

import fs from "node:fs/promises";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import Anthropic from "@anthropic-ai/sdk";

const SOURCES_PATH = "news-sources.json";
const NEWS_JSON_PATH = "news.json";
const NEWS_HTML_PATH = "news.html";
const MAX_ITEMS_KEPT = 12;
const MAX_NEW_ITEMS_PER_RUN = 6; // cost/safety cap per run

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const rssParser = new Parser();

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchRssItems(source) {
  const feed = await rssParser.parseURL(source.url);
  return (feed.items || []).slice(0, 5).map((item) => ({
    sourceName: source.name,
    link: item.link,
    title: item.title,
    rawText: (item.contentSnippet || item.content || "").slice(0, 3000),
    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
  }));
}

async function fetchHtmlItems(source) {
  const res = await fetch(source.url, {
    headers: { "User-Agent": "CelestineNewsBot/1.0" },
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  $("script,style,nav,footer,header").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);
  return [
    {
      sourceName: source.name,
      link: source.url,
      title: $("title").text().trim() || source.name,
      rawText: text,
      publishedAt: new Date().toISOString(),
    },
  ];
}

async function summarizeItem(item) {
  const prompt = `You are writing a short news card for Celestine Studio's website (art, music, and film).
Summarize the following source material into ONE short original news blurb — do not copy sentences verbatim.

Source name: ${item.sourceName}
Source title: ${item.title}
Source text: ${item.rawText}

Respond ONLY with JSON, no markdown fences, in this exact shape:
{"headline": "short headline, under 8 words", "summary": "1-2 sentence original summary, under 40 words, factual, no hype adjectives", "category": "Art" | "Music" | "Film"}`;

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  const clean = text.replace(/^```json|```$/g, "").trim();
  return JSON.parse(clean);
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
    try {
      const items = source.type === "rss"
        ? await fetchRssItems(source)
        : await fetchHtmlItems(source);
      for (const item of items) {
        if (!knownLinks.has(item.link)) candidates.push(item);
      }
    } catch (err) {
      console.error(`Failed to fetch ${source.name}:`, err.message);
    }
  }

  const toSummarize = candidates.slice(0, MAX_NEW_ITEMS_PER_RUN);
  const newEntries = [];
  for (const item of toSummarize) {
    try {
      const summary = await summarizeItem(item);
      newEntries.push({
        ...summary,
        link: item.link,
        sourceName: item.sourceName,
        publishedAt: item.publishedAt,
      });
    } catch (err) {
      console.error(`Failed to summarize ${item.link}:`, err.message);
    }
  }

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
    console.warn("Markers not found in news.html — cards were not injected. See setup notes.");
  } else {
    await fs.writeFile(NEWS_HTML_PATH, updated);
  }

  console.log(`Added ${newEntries.length} new item(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
