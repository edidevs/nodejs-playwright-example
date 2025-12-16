const { chromium } = require("playwright");

const HOST = "host";
const PORT = "port";
const USERNAME = "username";
const PASSWORD = "password";
const IS_STICKY = true; // set this to false if you are using rotating ports 9000 - 9010

const COUNTRY = "us"; // add country code here eg: US, RU, CA ETC
const STICKY_LIFETIME = 10; // set lifetime for sticky in minutes
const WORKERS = 1; // set the number of worker

const KEYWORDS = ["best books", "best country"];

function buildUsername(workerId) {
  const sessionId = `worker${workerId}${Date.now()}`;

  if (IS_STICKY) {
    return (
      `${USERNAME}` +
      `-type-residential` +
      `-country-${COUNTRY}` +
      `-session-${sessionId}` +
      `-lifetime-${STICKY_LIFETIME}`
    );
  } else {
    return (
      `${USERNAME}` +
      `-type-residential` +
      `-country-${COUNTRY}` +
      `-lifetime-${STICKY_LIFETIME}`
    );
  }
}

async function safeGoto(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(800);
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

async function safeGetTitle(page, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.waitForLoadState("domcontentloaded");
      return await page.title();
    } catch {
      await page.waitForTimeout(800);
    }
  }
  return "N/A";
}

async function runWorker(workerId, keyword) {
  const username = buildUsername(workerId);

  const browser = await chromium.launch({
    headless: false,
    proxy: {
      server: `http://${HOST}:${PORT}`,
      username,
      password: PASSWORD,
    },
  });

  const context = await browser.newContext({
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

    // await safeGoto(page, "https://www.google.com/");

    // await page.fill("textarea[name='q']", keyword);

    // await Promise.all([
    //   page
    //     .waitForNavigation({ waitUntil: "domcontentloaded" })
    //     .catch(() => null),
    //   page.keyboard.press("Enter"),
    // ]);

    // await page.waitForTimeout(1500);

    await safeGoto(page, "https://www.google.com/");

    // wait a bit after page load
    // await page.waitForTimeout(2000 + Math.floor(Math.random() * 2000));

    // // click the search box first
    // await page.click("textarea[name='q']");

    // // type slowly instead of fill
    // await page.keyboard.type(keyword, {
    //   delay: 80 + Math.floor(Math.random() * 70),
    // });

    // // short pause
    // await page.waitForTimeout(800 + Math.floor(Math.random() * 1200));

    // await Promise.all([
    //   page
    //     .waitForNavigation({ waitUntil: "domcontentloaded" })
    //     .catch(() => null),
    //   page.keyboard.press("Enter"),
    // ]);

    // const currentUrl = page.url();
    await page.click("textarea[name='q']");

    // Type the keyword slowly
    await page.keyboard.type(keyword, { delay: 80 });

    // Small pause after typing is completed
    await page.waitForTimeout(800);

    // Trigger search and wait for the page to load
    await Promise.all([
      page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(() => null),
      page.keyboard.press("Enter"),
    ]);

    // Optional additional wait to let the page settle
    await page.waitForTimeout(1500);

    const currentUrl = page.url();
    console.log("CURRENT URL:", currentUrl);
    const pageTitle = await safeGetTitle(page);

    console.log(`Keyword: ${keyword}`);
    console.log(`URL: ${currentUrl}`);
    console.log(`Title: ${pageTitle}`);

    if (currentUrl.includes("/sorry/")) {
      console.log("Blocked by Google after search");
      //   return;
    }

    if (!currentUrl.includes("/search")) {
      console.log("Did not reach normal search results page");
      return;
    }

    console.log("Search page reached");
  } catch (e) {
    console.log(`Worker ${workerId} error: ${e?.message || e}`);
  } finally {
    await browser.close();
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
