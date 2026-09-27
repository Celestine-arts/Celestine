// scripts/lib/gemini-client.mjs
// (same file as before, with these additions)

const GEMINI_MODEL = "gemini-flash-lite-latest";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_CALLS_PER_MINUTE = 12;
const WINDOW_MS = 60_000;
const MAX_RETRIES = 6;
const DEFAULT_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 70_000;

const callTimestamps = [];
let dailyQuotaExhausted = false; // sticky for the life of this process/run

export function isDailyQuotaExhausted() {
  return dailyQuotaExhausted;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimitWindow() {
  while (true) {
    const now = Date.now();
    while (callTimestamps.length && now - callTimestamps[0] > WINDOW_MS) {
      callTimestamps.shift();
    }
    if (callTimestamps.length < MAX_CALLS_PER_MINUTE) {
      callTimestamps.push(now);
      return;
    }
    const waitMs = WINDOW_MS - (now - callTimestamps[0]) + 250;
    console.log(`Gemini: pacing — waiting ${(waitMs / 1000).toFixed(1)}s to stay under the free-tier rate limit.`);
    await sleep(waitMs);
  }
}

function parseRetryDelayMs(errorBodyText) {
  const match = errorBodyText.match(/retry in ([\d.]+)s/i);
  if (!match) return null;
  const seconds = parseFloat(match[1]);
  if (Number.isNaN(seconds)) return null;
  return Math.ceil(seconds * 1000) + 500;
}

// Distinguishes "you're over the per-minute rate" (retry shortly) from
// "you're over the per-day cap" (nothing will fix this until tomorrow).
// Google puts this in details[].violations[].quotaId, e.g.
// "GenerateRequestsPerDayPerProjectPerModel-FreeTier" vs "...PerMinute...".
// NOTE: the retryDelay hint can look short (e.g. "51s") even for a daily
// cap, so that field can't be used to tell them apart — only quotaId can.
function isDailyQuotaError(errorBodyText) {
  try {
    const parsed = JSON.parse(errorBodyText);
    const details = parsed?.error?.details ?? [];
    const quotaFailure = details.find(
      (d) => d["@type"] === "type.googleapis.com/google.rpc.QuotaFailure"
    );
    const violations = quotaFailure?.violations ?? [];
    return violations.some((v) => /PerDay/i.test(v.quotaId || ""));
  } catch {
    return false;
  }
}

export async function callGemini(prompt) {
  if (!GEMINI_API_KEY) return null;
  if (dailyQuotaExhausted) return null; // short-circuit — no wait, no retry

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await waitForRateLimitWindow();

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
    } catch (err) {
      console.error(`Gemini call failed (network error, attempt ${attempt}/${MAX_RETRIES}):`, err.message);
      await sleep(DEFAULT_BACKOFF_MS);
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return text ? text.trim() : null;
    }

    const bodyText = await res.text();

    if (res.status === 429) {
      if (isDailyQuotaError(bodyText)) {
        dailyQuotaExhausted = true;
        console.error(
          "Gemini: daily quota exhausted — skipping AI text for everything else this run. " +
          "Unfinished items are tracked and will be retried on the next scheduled run."
        );
        return null;
      }

      const hinted = parseRetryDelayMs(bodyText);
      const waitMs = Math.min(hinted ?? DEFAULT_BACKOFF_MS * attempt, MAX_BACKOFF_MS);
      console.log(
        `Gemini: hit the per-minute rate limit (attempt ${attempt}/${MAX_RETRIES}). ` +
        `Waiting ${(waitMs / 1000).toFixed(1)}s before retrying this item.`
      );
      await sleep(waitMs);
      continue;
    }

    console.error("Gemini API error:", res.status, bodyText);
    return null;
  }

  console.error(`Gemini: gave up after ${MAX_RETRIES} attempts (still rate-limited). Skipping AI text for this item.`);
  return null;
}
