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

// ...(BLOCKED_KEYWORDS, isOffTopic, rssParser, loadJson, stripHtml,
//     escapeHtml, escapeXml, guessCategory, sleep, extractImage,
//     fetchOgImage, fetchRssItems, renderCard, generateRssFeed — unchanged)...

async function summarizeWithGemini(headline, rawText) {
  const prompt = `Summarize this arts/culture news item in exactly one punchy sentence (max 30 words), for a curated news feed. Do not add opinions or quotes, just state what happened. Headline: "${headline}". Source text: "${(rawText || "").slice(0, 1500)}"`;
  return callGemini(prompt);
}

async function main() {
  const sources = await loadJson(SOURCES_PATH, []);
  let existing = await loadJson(NEWS_JSON_PATH, []);
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

  // --- Pass 2: existing fetch-new-items logic ---
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

  const newEntries = [];
  if (candidates.length === 0) {
    console.log("No new items found this run — re-rendering existing cards only.");
  } else {
    for (const item of candidates) {
      let image = item.image;
      if (!image) image = await fetchOgImage(item.link);

      const aiSummary = await summarizeWithGemini(item.headline, item.rawText);
      const fallback = item.rawText.slice(0, 160);
      const quotaCausedIt = !aiSummary && isDailyQuotaExhausted();

      newEntries.push({
        sourceName: item.sourceName,
        link: item.link,
        headline: item.headline,
        rawText: item.rawText, // kept so a pending retry doesn't need RSS again
        summary: aiSummary || (fallback ? `${fallback}…` : "Read the full story at the source."),
        category: item.category,
        image,
        publishedAt: item.publishedAt,
        ...(quotaCausedIt ? { aiPending: true } : {}),
      });
      await sleep(3000);
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
