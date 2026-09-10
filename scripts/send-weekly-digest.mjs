// scripts/send-weekly-digest.mjs
// Reads news.json, picks up everything published in the last 7 days,
// and sends it as one email through Buttondown's free API (no paid
// RSS-to-email add-on needed).

import fs from "node:fs/promises";

const NEWS_JSON_PATH = "news.json";
const DAYS_BACK = 7;
const BUTTONDOWN_API_KEY = process.env.BUTTONDOWN_API_KEY;

async function main() {
  if (!BUTTONDOWN_API_KEY) {
    console.error("Missing BUTTONDOWN_API_KEY secret.");
    process.exit(1);
  }

  const raw = await fs.readFile(NEWS_JSON_PATH, "utf8");
  const allItems = JSON.parse(raw);

  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;
  const recentItems = allItems.filter(
    (item) => new Date(item.publishedAt).getTime() >= cutoff
  );

  if (recentItems.length === 0) {
    console.log("No new items this week — skipping send.");
    return;
  }

  const dateLabel = new Date().toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const lines = [
    `This week on Celestine — your art, music, and film roundup for ${dateLabel}.`,
    "",
  ];

  for (const item of recentItems) {
    lines.push(`## ${item.headline}`);
    lines.push("");
    lines.push(item.summary);
    lines.push("");
    lines.push(`[Read the full story](${item.link})`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  const res = await fetch("https://api.buttondown.com/v1/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Token ${BUTTONDOWN_API_KEY}`,
      "X-API-Version": "2026-04-01",
      "X-Buttondown-Live-Dangerously": "true",
    },
    body: JSON.stringify({
      subject: `Celestine Weekly — ${dateLabel}`,
      body: lines.join("\n"),
      status: "about_to_send",
    }),
  });

  if (!res.ok) {
    console.error("Buttondown API error:", res.status, await res.text());
    process.exit(1);
  }

  const data = await res.json();
  console.log("Weekly digest queued:", data.absolute_url || data.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
