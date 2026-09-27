// scripts/lib/gemini-client.mjs
//
// A shared, self-throttling wrapper around the Gemini free-tier API,
// used by both generate-song-pages.mjs and generate-artist-bios.mjs.
//
// WHY THIS EXISTS
// The free tier caps out at 15 requests/minute per model. Both scripts
// used to just sleep a fixed 1.5-2s between calls, which is faster than
// that limit allows (30-40 calls/minute) — so a long run would reliably
// start hitting 429 RESOURCE_EXHAUSTED partway through and then fail the
// same way for every remaining item, since nothing paused to let the
// quota window reset.
//
// WHAT THIS DOES INSTEAD
// 1. Self-throttles BEFORE hitting the limit: tracks the timestamp of
//    every call in a rolling 60-second window and sleeps as needed to
//    stay under MAX_CALLS_PER_MINUTE, so a long run shouldn't hit 429 at
//    all under normal conditions.
// 2. If a 429 slips through anyway (e.g. another process/run sharing the
//    same API key), it reads Google's own "Please retry in X.Xs" hint
//    out of the error body and waits that long (plus a small buffer)
//    before retrying the same request — rather than failing that item.
// 3. Caps retries (MAX_RETRIES) so a single stuck item can't hang the
//    whole job forever. After that many attempts it gives up and returns
//    null, same as any other failure — callers already treat a null
//    response as "skip the AI text, fall back to a placeholder," so the
//    run still finishes and nothing crashes.

const GEMINI_MODEL = "gemini-flash-lite-latest";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_CALLS_PER_MINUTE = 12; // stay a margin under the real 15/min cap
const WINDOW_MS = 60_000;
const MAX_RETRIES = 6;
const DEFAULT_BACKOFF_MS = 15_000; // used if we can't parse a retry hint
const MAX_BACKOFF_MS = 70_000;

const callTimestamps = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Blocks until there's room in the rolling window for one more call.
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
    const waitMs = WINDOW_MS - (now - callTimestamps[0]) + 250; // small buffer
    console.log(`Gemini: pacing — waiting ${(waitMs / 1000).toFixed(1)}s to stay under the free-tier rate limit.`);
    await sleep(waitMs);
  }
}

// Pulls "Please retry in 6.86s" (or similar) out of a Gemini error body.
// Returns milliseconds, or null if no such hint is present.
function parseRetryDelayMs(errorBodyText) {
  const match = errorBodyText.match(/retry in ([\d.]+)s/i);
  if (!match) return null;
  const seconds = parseFloat(match[1]);
  if (Number.isNaN(seconds)) return null;
  return Math.ceil(seconds * 1000) + 500; // small buffer on top of Google's own hint
}

/**
 * Calls Gemini with a single text prompt. Returns the response text, or
 * null if the key is missing, all retries are exhausted, or a non-rate-
 * limit error occurs. Never throws — every caller already treats a null
 * result as "fall back to a placeholder," so a failed call degrades the
 * output instead of crashing the run.
 */
export async function callGemini(prompt) {
  if (!GEMINI_API_KEY) return null;

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
      const hinted = parseRetryDelayMs(bodyText);
      const waitMs = Math.min(hinted ?? DEFAULT_BACKOFF_MS * attempt, MAX_BACKOFF_MS);
      console.log(
        `Gemini: hit the rate limit (attempt ${attempt}/${MAX_RETRIES}). ` +
        `Waiting ${(waitMs / 1000).toFixed(1)}s before retrying this item.`
      );
      await sleep(waitMs);
      continue; // retry the same prompt
    }

    // Non-429 error: not something waiting will fix, so don't retry.
    console.error("Gemini API error:", res.status, bodyText);
    return null;
  }

  console.error(`Gemini: gave up after ${MAX_RETRIES} attempts (still rate-limited). Skipping AI text for this item.`);
  return null;
}
