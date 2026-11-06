// Renders the home-screen icons (public/icons/*.png) with the preinstalled Chromium.
//   node scripts/make-icons.cjs
const { chromium } = require("playwright");
const path = require("node:path");

const out = path.join(__dirname, "..", "public", "icons");
// glyphScale: share of the square taken by the "ā"; maskable icons keep it inside the safe zone.
const ICONS = [
  { file: "apple-touch-icon.png", size: 180, glyphScale: 0.72 },
  { file: "icon-192.png", size: 192, glyphScale: 0.72 },
  { file: "icon-512.png", size: 512, glyphScale: 0.72 },
  { file: "icon-maskable-512.png", size: 512, glyphScale: 0.56 },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size, glyphScale } of ICONS) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><body style="margin:0">
      <div style="width:${size}px;height:${size}px;background:#8a3b12;display:flex;align-items:center;justify-content:center;">
        <span style="font-family:'DejaVu Serif','Liberation Serif',serif;font-size:${Math.round(size * glyphScale)}px;line-height:1;color:#f6f3ec">ā</span>
      </div></body></html>`);
    await page.screenshot({ path: path.join(out, file), omitBackground: false });
  }
  await browser.close();
})();
