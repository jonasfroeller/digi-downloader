import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

// rasterized output => very big file
export async function svgFolderToPdf(dir: string): Promise<void> {
  // -------------------------------------------------------------------------
  // collect *.svg files and make sure they are in the correct order
  // -------------------------------------------------------------------------
  const svgFiles = (await fs.readdir(dir))
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (svgFiles.length === 0) {
    throw new Error(`no .svg files found in “${dir}”`);
  }

  // -------------------------------------------------------------------------
  // create a PDF and add one page per SVG
  // -------------------------------------------------------------------------
  const pdf = await PDFDocument.create();

  for (const file of svgFiles) {
    const svg = await fs.readFile(path.join(dir, file));

    // Rasterise at 300 dpi (≈ 118 px / cm) for crisp A4 printing
    const png = await sharp(svg, { density: 300 }).png().toBuffer();
    const img = await pdf.embedPng(png);

    const { width, height } = img; // rendered pixel dimensions
    const page = pdf.addPage([width, height]);

    page.drawImage(img, { x: 0, y: 0, width, height });
    console.log(`✓ added ${file}`);
  }

  // -------------------------------------------------------------------------
  // write the finished document next to the SVGs
  // -------------------------------------------------------------------------
  const outFile = path.join(dir, `${path.basename(dir)}.pdf`);
  await fs.writeFile(outFile, await pdf.save());
  console.log(`🎉  saved → ${outFile}`);
}

/* -------------------------------------------------------------------------- */
/* CLI fallback: `bun run svg2pdf.ts <folder>`                                   */
/* -------------------------------------------------------------------------- */
if (require.main === module) {
  const folder = process.argv[2];
  if (!folder) {
    console.error("usage: node svg2pdf.js <folder-with-svgs>");
    process.exit(1);
  }
  svgFolderToPdf(path.resolve(folder)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
