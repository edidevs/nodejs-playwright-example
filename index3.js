// search with bing.com

const path = require("path");
const { chromium } = require("playwright");

const HOST = "host";
const PORT = "port"; // use sticky port such as port 10010 etc from port 10000 to 10900
const USERNAME = "username";
const PASSWORD = "password";

const IS_STICKY = true;
const COUNTRY = "us";
const STICKY_LIFETIME = 10; // minutes in your current naming convention

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

async function handleBingConsent(page) {
  const selectors = [
    "button#bnp_btn_accept",
    "button#bnp_btn_agree",
    "button:has-text('Accept')",
    "button:has-text('I agree')",
    "button:has-text('Agree')",
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

async function isBingBlockedOrCaptcha(page) {
  const url = page.url().toLowerCase();

  if (url.includes("captcha")) return true;
  if (url.includes("blocked")) return true;

  const text = (
    await page.evaluate(() => document.body?.innerText || "")
  ).toLowerCase();

  if (text.includes("unusual traffic")) return true;
  if (text.includes("verify you are human")) return true;
  if (text.includes("complete the security check")) return true;

  const hasRecaptcha = await page.$('iframe[src*="recaptcha"]');
  if (hasRecaptcha) return true;

  return false;
}

async function extractTopResultsBing(page, limit = 5) {
  return await page.evaluate((max) => {
    const out = [];
    const items = document.querySelectorAll("li.b_algo");

    for (const it of items) {
      const a = it.querySelector("h2 a[href]");
      if (!a) continue;

      const snippet =
        it.querySelector(".b_caption p") ||
        it.querySelector(".b_paractl") ||
        it.querySelector("p");

      out.push({
        title: (a.innerText || "").trim(),
        url: a.href,
        snippet: snippet ? (snippet.innerText || "").trim() : null,
      });

      if (out.length >= max) break;
    }

    return out;
  }, limit);
}

// Wait for element presence (not visibility) using retries
async function waitForElementHandle(page, selector, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = await page.$(selector);
    if (el) return el;
    await page.waitForTimeout(300);
  }
  return null;
}

async function backoff(attempt) {
  const base = 5000 * Math.pow(2, attempt);
  const jitter = rand(0, 3000);
  const waitMs = Math.min(120000, base + jitter);
  await sleep(waitMs);
}

async function runKeywordBing(page, keyword) {
  await safeGoto(page, "https://www.bing.com/");
  await handleBingConsent(page);

  if (await isBingBlockedOrCaptcha(page)) {
    return { ok: false, reason: "blocked_on_landing", url: page.url() };
  }

  // Bing stable selector
  const boxSelector = "#sb_form_q";
  const box = await waitForElementHandle(page, boxSelector, 25000);

  if (!box) {
    return { ok: false, reason: "search_box_not_found", url: page.url() };
  }

  await page.waitForTimeout(rand(1200, 2400));
  await box.click({ delay: rand(20, 60) });
  await page.waitForTimeout(rand(500, 1000));

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

  if (await isBingBlockedOrCaptcha(page)) {
    return {
      ok: false,
      reason: "blocked_after_search",
      url: currentUrl,
      title,
    };
  }

  const reachedSearch =
    currentUrl.includes("/search") || currentUrl.includes("q=");
  if (!reachedSearch) {
    return { ok: false, reason: "not_search_page", url: currentUrl, title };
  }

  await page.waitForTimeout(rand(1200, 2200));

  const results = await extractTopResultsBing(page, 5);

  return { ok: true, url: currentUrl, title, results };
}

async function runWorker(workerId, keyword) {
  const username = buildUsername(workerId);
  const userDataDir = path.join(__dirname, `.pw_profile_worker_${workerId}`);

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

      const res = await runKeywordBing(page, keyword);

      console.log("CURRENT URL:", res.url || page.url());

      if (res.ok) {
        console.log("Search page reached");
        console.log("Title:", res.title);
        console.log("Top results:", JSON.stringify(res.results, null, 2));
        return;
      }

      console.log(`Run ended: ${res.reason}`);

      try {
        await page.screenshot({
          path: `debug_worker${workerId}_attempt${attempt + 1}.png`,
          fullPage: true,
        });
      } catch (_) {}

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
