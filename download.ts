import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-extra";
import Stealth from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Page, Locator } from "playwright";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { once } from "node:events";

chromium.use(Stealth());

// -------------------- user config --------------------
const BOOK_TITLE = "Recht IV HAK mit E-Book";
const CHROME_EXE =
  process.env.CHROME_PATH ??
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const USER_DATA_DIR =
  process.env.CHROME_PROFILE ??
  path.join(process.env.LOCALAPPDATA ?? ".", "digi4school-profile");
const PERSISTENT = true; // set false for a fresh profile each run

// -------------------- browser helpers --------------------
async function openContext(): Promise<BrowserContext> {
  const launchOpts = {
    executablePath: CHROME_EXE,
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
  };

  if (PERSISTENT) {
    return chromium.launchPersistentContext(USER_DATA_DIR, launchOpts);
  }
  const browser = await chromium.launch(launchOpts);
  return browser.newContext();
}

// -------------------- misc helpers --------------------
function safe(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "").trim();
}

// guess a mime type from the file extension
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function guessMime(u: string): string {
  const ext = path.extname(u).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

// replace every external reference with an inline data: URL
async function inlineAssets(
  ctx: BrowserContext,
  svgText: string,
  svgUrl: string,
): Promise<string> {
  const urlAttr = /(?:xlink:href|href)=["']([^"']+)["']/g;
  const cssUrl = /url\((?:'|"|)([^"')]+)(?:'|"|)\)/g;

  const refs = new Set<string>();
  for (const [, ref] of svgText.matchAll(urlAttr)) refs.add(ref);
  for (const [, ref] of svgText.matchAll(cssUrl)) refs.add(ref);

  const externals = [...refs].filter(
    (r) => !r.startsWith("data:") && !r.startsWith("#"),
  );

  await Promise.all(
    externals.map(async (ref) => {
      const assetUrl = new URL(ref, svgUrl).href;
      const r = await ctx.request.get(assetUrl);
      if (!r.ok()) {
        throw new Error(
          `asset download failed (${r.status()}) → ${assetUrl}`,
        );
      }

      const buf = Buffer.from(await r.body());
      const mime =
        r.headers()["content-type"]?.split(";")[0] || guessMime(assetUrl);
      const dataUri = `data:${mime};base64,${buf.toString("base64")}`;

      svgText = svgText.split(ref).join(dataUri);
    }),
  );

  return svgText;
}

// fully self-contained SVG downloader
async function saveSvg(
  ctx: BrowserContext,
  url: string,
  file: string,
): Promise<void> {
  const r = await ctx.request.get(url);
  if (!r.ok()) throw new Error(`download ${r.status()} → ${url}`);

  let svg = await r.text();
  svg = await inlineAssets(ctx, svg, url);

  await fs.writeFile(file, svg);
}

// -------------------- SVG → PDF --------------------
/* async function svgFolderToPdf(dir: string): Promise<void> {
  const svgFiles = (await fs.readdir(dir))
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (!svgFiles.length) {
    throw new Error(`no .svg files in “${dir}”`);
  }

  const pdf = await PDFDocument.create();

  for (const file of svgFiles) {
    const svg = await fs.readFile(path.join(dir, file));

    const png = await sharp(svg, { density: 72 }).png().toBuffer();
    const img = await pdf.embedPng(png);

    const { width, height } = img;
    const page = pdf.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });

    console.log(`✓ added ${file}`);
  }

  const outFile = path.join(dir, `${path.basename(dir)}.pdf`);
  await fs.writeFile(outFile, await pdf.save());
  console.log(`📄  saved PDF → ${outFile}`);
} */

export async function svgFolderToPdf(dir: string): Promise<void> {
  // collect *.svg files in natural order (0001.svg, 0002.svg, …)
  const svgFiles = (await fs.readdir(dir))
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (!svgFiles.length) {
    throw new Error(`no .svg files in “${dir}”`);
  }

  const outFile = path.join(dir, `${path.basename(dir)}.pdf`);
  const doc = new PDFDocument({ autoFirstPage: false });
  const out = (await import("node:fs")).createWriteStream(outFile);
  doc.pipe(out);

  for (const file of svgFiles) {
    const svg = await fs.readFile(path.join(dir, file), "utf8");

    // create a fresh page that is exactly as large as the SVG view-box
    // if width/height are missing we fall back to an A4 page.
    const { widthPt, heightPt } = getSvgSize(svg) ?? a4();
    doc.addPage({ size: [widthPt, heightPt] });

    // draw the SVG so that it fills the page
    SVGtoPDF(doc, svg, 0, 0, { width: widthPt, height: heightPt });
    console.log(`✓ added ${file}`);
  }

  doc.end();
  await once(out, "finish");
  console.log(`📄  saved PDF → ${outFile}`);
}

/* ───────────────── helpers ─────────────────────────────────────────── */

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
  // convert a few common SVG units to PostScript points (1 pt = 1/72 in)
  switch (unit) {
    case "": // px – assume 96 dpi
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

// -------------------- main flow --------------------
async function main(): Promise<void> {
  const { EMAIL, PASSWORD } = process.env;
  if (!EMAIL || !PASSWORD) {
    console.error("❌  set EMAIL and PASSWORD");
    return keepAlive();
  }

  const ctx = await openContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  // login
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

  // open the requested book
  await page.waitForSelector("app-book-list-entry");

  const entry = page
    .locator("app-book-list-entry", { hasText: BOOK_TITLE })
    .first();

  const [maybeNewTab] = await Promise.all([
    ctx.waitForEvent("page", { timeout: 7_000 }).catch(() => null),
    entry.click(),
  ]);

  const reader: Page = maybeNewTab ?? page;
  reader.setDefaultTimeout(60_000);

  await reader.waitForURL(/\/(reader|ebook)\//);
  await reader.waitForLoadState("domcontentloaded");

  // always start at page 1
  const u = new URL(reader.url());
  u.searchParams.set("page", "1");
  await reader.goto(u.toString(), { waitUntil: "domcontentloaded" });

  // download pages
  const folder = path.join("books", safe(BOOK_TITLE));
  await fs.mkdir(folder, { recursive: true });

  const next: Locator = reader.locator("#btnNext");
  let p = 1;
  const t0 = Date.now();

  while (true) {
    const obj = reader.locator(`object[data$='${p}.svg']`).first();
    await obj.waitFor();

    const rel = await obj.getAttribute("data");
    if (!rel) break;

    await saveSvg(
      ctx,
      new URL(rel, reader.url()).href,
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
      reader.waitForSelector(`object[data$='${p}.svg']`),
      next.click(),
    ]);
  }

  console.log(
    `🎉  finished → ${p} pages in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );

  // build the PDF
  await svgFolderToPdf(folder);

  console.log("Browser left open – press Ctrl+C to quit.");
  await keepAlive();
}

function keepAlive(): Promise<never> {
  return new Promise(() => { });
}

main().catch((err) => {
  console.error(err);
  return keepAlive();
});
