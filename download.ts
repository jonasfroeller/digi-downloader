import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-extra";
import Stealth from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Page, Locator } from "playwright";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { once } from "node:events";
import { spawn } from "node:child_process";

chromium.use(Stealth());

/* ───────────────────────── user config ────────────────────────────── */
/**
 * `BOOK_TITLE` can be defined in your `.env` file in three different ways:
 * 1. Single title → BOOK_TITLE=My Book
 * 2. Multiple titles (semicolon-separated or JSON array) → BOOK_TITLE=Book A;Book B or BOOK_TITLE=["Book A","Book B"]
 * 3. `null` / empty / unset → download all books that are not yet present in ./books
 */

function parseBookEnv(raw: string | undefined): string[] | null {
  if (!raw || raw.trim() === "" || raw.trim().toLowerCase() === "null") return null;

  const txt = raw.trim();

  if (txt.startsWith("[")) {
    try {
      const arr = JSON.parse(txt);
      return Array.isArray(arr) ? arr.map(String) : [String(arr)];
    } catch {
      /* fall through to delimiter parsing */
    }
  }

  return txt.split(";").map((s) => s.trim()).filter(Boolean);
}

const BOOK_TITLES_CFG: string[] | null = parseBookEnv(process.env.BOOK_TITLE);
const CHROME_EXE =
  process.env.CHROME_PATH ??
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const USER_DATA_DIR =
  process.env.CHROME_PROFILE ??
  path.join(process.env.LOCALAPPDATA ?? ".", "digi4school-profile");
const PERSISTENT = true;

/* ─────────────────────── browser helpers ──────────────────────────── */
async function openContext(): Promise<BrowserContext> {
  const opts = {
    executablePath: CHROME_EXE,
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (PERSISTENT) return chromium.launchPersistentContext(USER_DATA_DIR, opts);
  const browser = await chromium.launch(opts);
  return browser.newContext();
}

function safe(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "").trim();
}

// Windows chokes on file paths longer than ~260 chars unless special handling
// is enabled.  To stay on the safe side we keep generated file names short and
// ASCII-only.  For now: strip diacritics, collapse whitespace, cut at 80 chars.
function safeFileName(raw: string, max = 80): string {
  // Quick latin-1 deburring (adequate for German titles)
  const deburr = raw.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const collapsed = deburr.replace(/\s+/g, " ").trim();
  const truncated = collapsed.slice(0, max);
  return safe(truncated);
}

async function cookieHeader(ctx: BrowserContext): Promise<string> {
  return (await ctx.cookies())
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/* ───────────────────── SVG download + inlining ───────────────────── */
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function guessMime(u: string): string {
  return MIME_BY_EXT[path.extname(u).toLowerCase()] ?? "application/octet-stream";
}

// convert every 0-length dash to 0.001 (PDFKit refuses zeros)
function fixDashArrays(svg: string): string {
  const fixList = (list: string): string =>
    list
      .split(/[, ]+/)
      .map((x) => (Number(x) === 0 ? "0.001" : x))
      .join(" ");

  svg = svg.replace(/stroke-dasharray="([^"]*)"/gi, (_, list) => {
    return `stroke-dasharray="${fixList(list)}"`;
  });

  svg = svg.replace(/stroke-dasharray\s*:\s*([^;"']+)/gi, (_, list) => {
    return `stroke-dasharray:${fixList(list)}`;
  });

  return svg;
}

// Attempt to pull a clean <svg>…</svg> snippet out of arbitrary text responses.
function extractSvgMarkup(text: string): string | null {
  const start = text.search(/<svg[\s\S]*?>/i);
  if (start === -1) return null;
  const end = text.indexOf("</svg>", start);
  if (end === -1) return null;
  return text.slice(start, end + 6);
}

// Remove HTML tags that sometimes leak into SVG responses and break the XML
// content such as <script>, <style>, … which is not required for rendering
// static pages.
function sanitizeSvg(svg: string): string {
  // Remove XML/HTML comments which occasionally appear in the markup.
  svg = svg.replace(/<!--[\s\S]*?-->/g, "");

  // Strip stray <!DOCTYPE …> declarations.
  svg = svg.replace(/<!DOCTYPE[^>]*?>/gi, "");

  // Elements that never belong inside static SVG files and confuse the XML parser.
  // Style tags are needed for some legacy books where the API wants to return HTML and does only return SVG, if prompted!
  const UNWANTED_TAGS = [
    "script",
    "link",
    "noscript",
    "meta",
    "base",
    "head",
    "html",
    "body",
    "foreignObject",
  ];

  const unwantedBlock = new RegExp(
    `<(?:${UNWANTED_TAGS.join("|")})[^>]*?>[\\s\\S]*?<\\/(?:${UNWANTED_TAGS.join("|")})>`,
    "gi",
  );
  const unwantedSingle = new RegExp(
    `<(?:${UNWANTED_TAGS.join("|")})[^>]*?\/?>`,
    "gi",
  );

  svg = svg.replace(unwantedBlock, "").replace(unwantedSingle, "");

  // Ensure the root <svg> carries the standard namespace so rendering works reliably.
  if (!/\sxmlns\s*=\s*"http:\/\/www\.w3\.org\/2000\/svg"/i.test(svg)) {
    svg = svg.replace(
      /<svg(\s|>)/i,
      (_m, tail) => `<svg xmlns="http://www.w3.org/2000/svg"${tail}`,
    );
  }

  return svg;
}

async function inlineAssets(
  ctx: BrowserContext,
  svgText: string,
  svgUrl: string,
): Promise<string> {
  const urlAttr = /(?:xlink:href|href)=["']([^"']+)["']/g;
  const cssUrl = /url\((?:'|"|)([^"')]+)(?:'|"|)\)/g;

  const refs = new Set<string>();
  for (const [, r] of svgText.matchAll(urlAttr)) refs.add(r);
  for (const [, r] of svgText.matchAll(cssUrl)) refs.add(r);

  const externals = [...refs].filter(
    (r) => !r.startsWith("data:") && !r.startsWith("#"),
  );

  await Promise.all(
    externals.map(async (ref) => {
      const abs = new URL(ref, svgUrl).href;
      const res = await fetch(abs, {
        headers: {
          cookie: await cookieHeader(ctx),
          accept: "image/svg+xml,image/*;q=0.8,*/*;q=0.5",
          referer: svgUrl,
        },
      });
      if (!res.ok) {
        console.error(`asset download failed (${res.status}) → ${abs}`);
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const mime =
        res.headers.get("content-type")?.split(";")[0] ?? guessMime(abs);
      const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
      svgText = svgText.split(ref).join(dataUri);
    }),
  );
  return svgText;
}

async function saveSvg(
  ctx: BrowserContext,
  url: string,
  file: string,
): Promise<void> {
  const abs = new URL(url).href;
  const res = await fetch(abs, {
    headers: {
      cookie: await cookieHeader(ctx),
      accept: "image/svg+xml,image/*;q=0.8,*/*;q=0.5",
      referer: url,
    },
  });
  if (!res.ok) throw new Error(`download ${res.status} → ${abs}`);

  const raw = await res.text();

  const ct = res.headers.get("content-type")?.split(";")[0] ?? "";

  // If the server labels the payload as SVG we can skip the expensive
  // heuristics and trust the response.
  let svg: string | null;

  if (ct === "image/svg+xml") {
    svg = raw;
  } else {
    // Prefer direct SVG, otherwise try to extract SVG markup from an HTML body.
    svg = raw.trim().startsWith("<svg") ? raw : extractSvgMarkup(raw);
  }

  if (!svg) {
    console.error(`⚠️  non-SVG content for ${abs} – using placeholder (ct=${ct})`);
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'; // valid minimal SVG
  }

  svg = await inlineAssets(ctx, svg, abs);
  svg = fixDashArrays(svg);
  svg = sanitizeSvg(svg);
  await fs.writeFile(file, svg);
}

/* ───────────────────────── SVG ➜ PDF ─────────────────────────────── */
async function svgFolderToPdf(dir: string): Promise<void> {
  console.log(`📄  converting SVGs to PDF for "${dir}"`);

  const svgFiles = (await fs.readdir(dir))
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!svgFiles.length) throw new Error(`no .svg files in "${dir}"`);

  const pdfBase = `${safeFileName(path.basename(dir))}.pdf`;
  const outFile = path.join(dir, pdfBase);
  const doc = new PDFDocument({ autoFirstPage: false });
  const fsMod = await import("node:fs");
  const out = fsMod.createWriteStream(outFile);
  doc.pipe(out);

  for (const file of svgFiles) {
    const svg = await fs.readFile(path.join(dir, file), "utf8");
    const { widthPt, heightPt } = getSvgSize(svg) ?? a4();
    doc.addPage({ size: [widthPt, heightPt] });
    SVGtoPDF(doc, svg, 0, 0, { width: widthPt, height: heightPt });
    console.log(`✓ added ${file}`);
  }

  doc.end();
  await once(out, "finish");
  console.log(`📄  saved PDF → ${outFile}`);
}

function getSvgSize(svg: string): { widthPt: number; heightPt: number } | null {
  const w = svg.match(/\bwidth="([\d.]+)(\w*)"/i);
  const h = svg.match(/\bheight="([\d.]+)(\w*)"/i);
  if (!w || !h) return null;
  return {
    widthPt: toPt(parseFloat(w[1]), w[2]),
    heightPt: toPt(parseFloat(h[1]), h[2]),
  };
}

function toPt(val: number, unit: string): number {
  switch (unit) {
    case "":
    case "px":
      return (val / 96) * 72;
    case "pt":
      return val;
    case "mm":
      return (val / 25.4) * 72;
    case "cm":
      return (val / 2.54) * 72;
    case "in":
      return val * 72;
    default:
      return val;
  }
}

function a4() {
  return { widthPt: 595.28, heightPt: 841.89 };
}

/* ─────────────────────────── main ────────────────────────────────── */
async function main(): Promise<void> {
  const { EMAIL, PASSWORD } = process.env;
  if (!EMAIL || !PASSWORD) {
    console.error("❌  set EMAIL and PASSWORD");
    return keepAlive();
  }

  const ctx = await openContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  await page.goto("https://digi4school.at/login");
  await page.fill("input[autocomplete='email']", EMAIL);
  await page.fill("input[autocomplete='current-password']", PASSWORD);

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/br/xhr/v2/login")),
    page.locator("ion-button:has-text('Anmelden')").click(),
  ]);
  if (resp.status() !== 200 || (await resp.text()).trim() !== "OK") {
    console.error(`❌  login failed (${resp.status()})`);
    return keepAlive();
  }
  console.log("✅  login successful");

  let targets: string[];

  if (BOOK_TITLES_CFG === null) {
    // Gather all book titles but skip already downloaded ones
    await page.waitForSelector("app-book-list-entry");
    const entries = page.locator("app-book-list-entry");
    const count = await entries.count();

    const existing = new Set<string>();
    try {
      (await fs.readdir("books")).forEach((d) => existing.add(d));
    } catch {
      /* books folder may not exist yet */
    }

    targets = [];
    for (let i = 0; i < count; i++) {
      // Use only the visible heading text (without publisher/date) as book title
      const heading = (await entries
        .nth(i)
        .locator("h2.entry-heading")
        .innerText())
        .trim();

      if (!existing.has(safe(heading))) targets.push(heading);
    }
  } else {
    targets = BOOK_TITLES_CFG;
  }

  if (!targets.length) {
    console.log("🎉  nothing to download – all requested books are present");
    return keepAlive();
  }

  const conversions: Promise<void>[] = [];

  for (const title of targets) {
    await downloadBook(ctx, page, title, conversions);

    // To avoid potential rate-limiting by the server we pause briefly before
    // starting the next book download. A 15-second delay has proven to be a
    // reasonable compromise between throughput and courtesy.
    if (title !== targets[targets.length - 1]) {
      console.log("⏳  waiting 15 s before next book …");
      await sleep(15_000);
    }
  }

  console.log("⏳  waiting for PDF conversions to finish …");
  await Promise.allSettled(conversions);

  console.log("Browser left open – press Ctrl+C to quit.");
  await keepAlive();
}

function keepAlive(): Promise<never> {
  return new Promise(() => { });
}

/* ──────────────────────── book logic ────────────────────────────── */

async function downloadBook(
  ctx: BrowserContext,
  listPage: Page,
  title: string,
  conversions: Promise<void>[],
): Promise<void> {
  console.log(`📚  starting download for "${title}"`);

  await listPage.waitForSelector("app-book-list-entry");
  const entry = listPage
    .locator("app-book-list-entry")
    .filter({
      has: listPage.locator("h2.entry-heading", { hasText: title }),
    })
    .first();

  const [maybeNewTab] = await Promise.all([
    ctx.waitForEvent("page", { timeout: 7_000 }).catch(() => null),
    entry.click(),
  ]);

  const reader: Page = maybeNewTab ?? listPage;
  reader.setDefaultTimeout(60_000);
  await reader.waitForURL(/\/(reader|ebook)\//);
  await reader.waitForLoadState("domcontentloaded");

  // Jump to page=1 so the first SVG appears immediately. Some books, however,
  // keep the real pages under a "/1/index.html" sub-path. We try the standard
  // URL first and fall back to that variant if no SVG shows up quickly.

  const baseUrl = new URL(reader.url());
  baseUrl.searchParams.set("page", "1");

  await reader.goto(baseUrl.toString(), { waitUntil: "domcontentloaded" });

  try {
    // If the typical SVG object does not appear within 5 s, assume we are on
    // the overview page and load the alternate page path.
    await reader.waitForSelector("object[type='image/svg+xml']", {
      timeout: 5_000,
    });
  } catch {
    const pathNoSlash = baseUrl.pathname.endsWith("/")
      ? baseUrl.pathname.slice(0, -1)
      : baseUrl.pathname;
    const alt = `${baseUrl.origin}${pathNoSlash}/1/index.html?page=1`;
    await reader.goto(alt, { waitUntil: "domcontentloaded" });
  }

  const folder = path.join("books", safe(title));
  await fs.mkdir(folder, { recursive: true });

  const next: Locator = reader.locator("#btnNext");
  let p = 1;
  const t0 = Date.now();

  await maybeDismissTour(reader);

  while (true) {
    await maybeDismissTour(reader);

    const sel = `object[type='image/svg+xml'][data*='${p}.svg']`;
    await reader.waitForSelector(sel, { state: "attached" });

    const obj = reader.locator(sel).first();
    const rel = await obj.getAttribute("data");
    if (!rel) break;

    // The `data` attribute is often a bare filename like "1.svg". When the
    // current page URL ends with a number (e.g. "/861/1"), treating that as a
    // *file* causes `new URL(rel, reader.url())` to drop the last segment and
    // yield "/861/1.svg" – but the correct asset lives in "/861/1/1.svg".
    // Using the *directory* URL (`new URL('.', …)`) ensures the last segment
    // is preserved, giving the correct location regardless of whether the
    // base ends with "index.html", "/reader", or just the page number.

    const pageDir = new URL('.', reader.url()).href; // guarantees trailing '/'
    const absSvg = new URL(rel, pageDir).href;

    await saveSvg(
      ctx,
      absSvg,
      path.join(folder, `${p.toString().padStart(4, "0")}.svg`),
    );
    console.log(`✓ page ${p}`);

    const last = await next.evaluate(
      (e) =>
        e.hasAttribute("disabled") ||
        e.classList.contains("disabled") ||
        getComputedStyle(e).pointerEvents === "none",
    );
    if (last) break;

    p += 1;
    await Promise.all([
      reader.waitForSelector(
        `object[type='image/svg+xml'][data*='${p}.svg']`,
        { state: "attached" },
      ),
      next.click(),
    ]);
  }

  console.log(
    `🎉  finished "${title}" → ${p} pages in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );

  const conv = convertPdfInChild(folder).catch((err) => {
    console.error(`❌  PDF conversion failed for "${title}":`, err);
  });
  conversions.push(conv);

  if (reader !== listPage) {
    await reader.close();
  } else {
    await reader.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
}

/* ───────────────────── PDF helper (child process) ───────── */

function convertPdfInChild(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, "--pdf", dir], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PDF worker exited with code ${code}`));
    });
  });
}

/* ───────────────────── Helper to skip overlays ─────────── */

async function maybeDismissTour(page: Page): Promise<void> {
  try {
    /*
     * The e-book viewer occasionally shows a guided-tour overlay that blocks
     * interaction. Over time, several slightly different variants have
     * appeared. We first attempt a cheap DOM cleanup (remove the complete
     * overlay nodes) and then, as a fallback, click any of the action buttons
     * that are known to close the dialog.
     */

    // 1) Brutal-force removal – this is fast and works even when the overlay
    //    is off-screen or covers the navigation buttons.
    await page.evaluate(() => {
      const roots = [
        ".tlyPageGuideWelcome",
        ".tlyPageGuideOverlay",
        "#tlyPageGuide",
        "#tlyPageGuideWrapper",
        "#tlyPageGuideOverlay",
        "[id^='tlyPageGuide']",
        "[data-product-tour]", // future-proof catch-all
      ];
      for (const sel of roots) {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      }
    }).catch(() => undefined);

    // 2) Friendly dismissal via the buttons (covers cases where the overlay
    //    logic re-injects itself after being removed).
    const buttons = [
      ".tlypageguide_dismiss",
      ".tlypageguide_ignore",
      ".tlypageguide_start",
      // older uppercase/lowercase mixes observed in the wild + explicit close
      ".tlyPageGuide_dismiss",
      ".tlyPageGuide_ignore",
      ".tlyPageGuide_start",
      ".tlypageguide_close",
    ];

    for (const sel of buttons) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        const visible = await btn.isVisible().catch(() => false);
        if (visible) {
          await btn.click({ force: true, timeout: 2000 }).catch(() => undefined);
          await page.waitForTimeout(300);
          break;
        }
      }
    }
  } catch {
    /* overlay not present or already gone */
  }
}

/* ────────────────────── entrypoint logic ────────────────── */

if (process.argv[2] === "--pdf" && process.argv[3]) {
  svgFolderToPdf(process.argv[3])
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  main().catch((err) => {
    console.error(err);
    return keepAlive();
  });
}

/* ─────────────────── utility helpers ──────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
