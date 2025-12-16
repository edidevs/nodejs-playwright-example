// playwright-google-safe.js
// Run: node playwright-google-safe.js

const path = require("path");
const { chromium } = require("playwright");

const HOST = "host";
const PORT = "port";
const USERNAME = "username";
const PASSWORD = "password";

const IS_STICKY = true; // set true if you want to keep the same session/IP longer
const COUNTRY = "us"; // example: us, ru, ca, id
const STICKY_LIFETIME = 10; // in minutes, only used when IS_STICKY = true

const WORKERS = 1;

const KEYWORDS = ["best books", "best country"];

const MAX_RETRIES_PER_KEYWORD = 3;

// Utility
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildUsername(workerId) {
  const sessionId = `worker${workerId}_${Date.now()}`;

  if (IS_STICKY) {
    return (
      `${USERNAME}` +
      `-type-residential` +
      `-country-${COUNTRY}` +
      `-session-${sessionId}` +
      `-lifetime-${STICKY_LIFETIME}`
    );
  }
  return `${USERNAME}`;
}

async function safeGoto(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(rand(800, 1500));
}

async function fetchIpInfo(page) {
  await safeGoto(page, "http://ip-api.com/json");
  try {
    const raw = await page.textContent("body");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function safeGetTitle(page) {
  try {
    await page.waitForLoadState("domcontentloaded");
    return await page.title();
  } catch {
    return "N/A";
  }
}

async function handleGoogleConsent(page) {
  // Consent UI varies. This clicks common consent buttons if present.
  const selectors = [
    "button#L2AGLb",
    "button:has-text('Accept all')",
    "button:has-text('I agree')",
    "button:has-text('Accept')",
  ];

  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await page.waitForTimeout(rand(600, 1200));
        await btn.click({ delay: rand(20, 60) });
        await page.waitForTimeout(rand(1200, 1800));
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function isBlockedOrCaptcha(page) {
  const url = page.url().toLowerCase();
  if (url.includes("/sorry/")) return true;

  const text = (
    await page.evaluate(() => document.body?.innerText || "")
  ).toLowerCase();
  if (text.includes("unusual traffic")) return true;
  if (text.includes("our systems have detected unusual traffic")) return true;
  if (text.includes("to continue, please type the characters")) return true;

  const hasRecaptcha = await page.$('iframe[src*="recaptcha"]');
  if (hasRecaptcha) return true;

  return false;
}

async function extractTopResults(page, limit = 5) {
  // Flexible selectors; Google DOM changes often.
  return await page.evaluate((max) => {
    const out = [];
    const blocks = document.querySelectorAll("div.g, div.MjjYud, .tF2Cxc");

    for (const b of blocks) {
      const a = b.querySelector("a[href^='http']");
      const h3 = b.querySelector("h3");
      if (!a || !h3) continue;

      const snippet =
        b.querySelector(".VwiC3b") ||
        b.querySelector(".IsZvec") ||
        b.querySelector(".aCOpRe");

      out.push({
        title: h3.innerText.trim(),
        url: a.href,
        snippet: snippet ? snippet.innerText.trim() : null,
      });

      if (out.length >= max) break;
    }
    return out;
  }, limit);
}

async function backoff(attempt) {
  // Exponential backoff with jitter, capped at 2 minutes
  const base = 5000 * Math.pow(2, attempt);
  const jitter = rand(0, 3000);
  const waitMs = Math.min(120000, base + jitter);
  await sleep(waitMs);
}

async function runKeyword(page, keyword) {
  await safeGoto(page, "https://www.google.com/");
  await handleGoogleConsent(page);

  if (await isBlockedOrCaptcha(page)) {
    return { ok: false, reason: "blocked_on_landing", url: page.url() };
  }

  // Wait for search input
  const box = "textarea[name='q'], input[name='q']";
  await page.waitForSelector(box, { timeout: 20000 });

  // Human-like pacing
  await page.waitForTimeout(rand(1200, 2400));
  await page.click(box, { delay: rand(20, 60) });
  await page.waitForTimeout(rand(500, 1000));

  // Clear any existing content
  await page.keyboard.press("Control+A").catch(() => null);
  await page.keyboard.press("Backspace").catch(() => null);

  await page.keyboard.type(keyword, { delay: rand(70, 120) });
  await page.waitForTimeout(rand(800, 1400));

  await Promise.all([
    page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => null),
    page.keyboard.press("Enter"),
  ]);

  await page.waitForTimeout(rand(1200, 2200));

  const currentUrl = page.url();
  const title = await safeGetTitle(page);

  if (await isBlockedOrCaptcha(page)) {
    return {
      ok: false,
      reason: "blocked_after_search",
      url: currentUrl,
      title,
    };
  }

  // Not always /search depending on locale, but generally a good indicator.
  const reachedSearch =
    currentUrl.includes("/search") || currentUrl.includes("q=");
  if (!reachedSearch) {
    return { ok: false, reason: "not_search_page", url: currentUrl, title };
  }

  const results = await extractTopResults(page, 5);

  return { ok: true, url: currentUrl, title, results };
}

async function runWorker(workerId, keyword) {
  const username = buildUsername(workerId);

  const userDataDir = path.join(__dirname, `.pw_profile_worker_${workerId}`);

  // Persistent context reuses cookies and consent state, generally more stable than fresh sessions.
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    proxy: {
      server: `http://${HOST}:${PORT}`,
      username,
      password: PASSWORD,
    },
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  try {
    const ipInfo = await fetchIpInfo(page);
    console.log(`Worker ${workerId}`);
    if (ipInfo) {
      console.log(
        `IP: ${ipInfo.query} | Country: ${ipInfo.country} | Region: ${ipInfo.regionName} | City: ${ipInfo.city}`
      );
    } else {
      console.log("IP check failed");
    }

    for (let attempt = 0; attempt < MAX_RETRIES_PER_KEYWORD; attempt++) {
      console.log(`Keyword: ${keyword} | Attempt: ${attempt + 1}`);

      const res = await runKeyword(page, keyword);

      console.log("CURRENT URL:", res.url || page.url());

      if (res.ok) {
        console.log("Search page reached");
        console.log("Title:", res.title);
        console.log("Top results:", JSON.stringify(res.results, null, 2));
        return;
      }

      console.log(`Run ended: ${res.reason}`);

      // Save debug files to understand what happened
      try {
        await page.screenshot({
          path: `debug_worker${workerId}_attempt${attempt + 1}.png`,
          fullPage: true,
        });
      } catch (_) {}

      // Backoff before retrying
      await backoff(attempt);
    }

    console.log(
      `Worker ${workerId}: Max retries reached for keyword: ${keyword}`
    );
  } catch (e) {
    console.log(`Worker ${workerId} error: ${e?.message || e}`);
  } finally {
    await context.close();
  }
}

(async () => {
  const tasks = [];
  for (let i = 1; i <= WORKERS; i++) {
    const keyword = KEYWORDS[(i - 1) % KEYWORDS.length];
    tasks.push(runWorker(i, keyword));
  }
  await Promise.all(tasks);
})();
