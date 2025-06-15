import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-extra";
import Stealth from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Page, Locator } from "playwright";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { once } from "node:events";

chromium.use(Stealth());

/* ───────────────────────── user config ────────────────────────────── */
const BOOK_TITLE = "Recht IV HAK mit E-Book";
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
        headers: { cookie: await cookieHeader(ctx) },
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
  const res = await fetch(abs, { headers: { cookie: await cookieHeader(ctx) } });
  if (!res.ok) throw new Error(`download ${res.status} → ${abs}`);

  let svg = await res.text();
  svg = await inlineAssets(ctx, svg, abs);
  svg = fixDashArrays(svg);
  await fs.writeFile(file, svg);
}

/* ───────────────────────── SVG ➜ PDF ─────────────────────────────── */
async function svgFolderToPdf(dir: string): Promise<void> {
  const svgFiles = (await fs.readdir(dir))
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!svgFiles.length) throw new Error(`no .svg files in “${dir}”`);

  const outFile = path.join(dir, `${path.basename(dir)}.pdf`);
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

  const u = new URL(reader.url());
  u.searchParams.set("page", "1");
  await reader.goto(u.toString(), { waitUntil: "domcontentloaded" });

  const folder = path.join("books", safe(BOOK_TITLE));
  await fs.mkdir(folder, { recursive: true });

  const next: Locator = reader.locator("#btnNext");
  let p = 1;
  const t0 = Date.now();

  while (true) {
    const sel = `object[type='image/svg+xml'][data$='${p}.svg']`;
    await reader.waitForSelector(sel, { state: "attached" });
    const obj = reader.locator(sel).first();
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
      reader.waitForSelector(
        `object[type='image/svg+xml'][data$='${p}.svg']`,
        { state: "attached" },
      ),
      next.click(),
    ]);
  }

  console.log(
    `🎉  finished → ${p} pages in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );

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
