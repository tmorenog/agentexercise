// Re-takes the handout's figures into img/: six slides from the deck and the
// four "what the agent does" diagrams from the site. Only needed when a slide
// or one of those diagrams changes; build.py uses whatever is in img/.
//
//   node screenshots.mjs --slides <folder of the deck's slide .html files> [--site <url>]
//
// --slides: the deck's slides/*.html (challenge, system, agent, mcp, data, lovable).
// --site:   the site to photograph (default: the live site). A local dev server works too.
// Needs Playwright with Chromium; set PLAYWRIGHT_MODULE / CHROMIUM_PATH if they aren't found.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const slidesDir = arg('slides');
const site = arg('site', 'https://recipes-delta-red.vercel.app').replace(/\/$/, '');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

const fontDir = path.join(HERE, 'assets', 'fonts');
const fontCss = fs.readFileSync(path.join(fontDir, 'local.css'), 'utf8');
const out = (name) => path.join(HERE, 'img', name);

// Slides: 1920×1080, cropped to the part the handout uses (x0, y0, x1, y1).
const SLIDES = {
  challenge: [64, 74, 1856, 808],
  system: [64, 76, 1856, 914],
  agent: [64, 75, 1856, 748],
  mcp: [100, 100, 1820, 580],
  data: [64, 76, 1856, 881],
  lovable: [64, 75, 1856, 909],
};
if (slidesDir) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const [name, [x0, y0, x1, y1]] of Object.entries(SLIDES)) {
    // Speaker notes (<aside>) go; the Lovable screenshot is an uploaded asset in the deck.
    const body = fs.readFileSync(path.join(slidesDir, `${name}.html`), 'utf8')
      .replace(/<aside>[\s\S]*?<\/aside>/, '')
      .replace(/\/_blob\/[0-9a-f]+/g, '../lovable-dashboard.webp');
    const html = `<!doctype html><meta charset="utf-8"><style>${fontCss}*{margin:0;box-sizing:border-box} section{width:1920px;height:1080px;position:relative;overflow:hidden} ol{padding-left:1.2em}</style>${body}`;
    const file = path.join(fontDir, `.slide-${name}.html`);
    fs.writeFileSync(file, html);
    await page.goto(`file://${file}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`crop-${name}.png`), clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
    fs.unlinkSync(file);
    console.log('slide', name);
  }
} else {
  console.log('no --slides folder: keeping the slide figures in img/');
}

// The site's flow diagrams, with the site's fonts served locally.
const page = await browser.newPage({ viewport: { width: 1180, height: 1000 }, deviceScaleFactor: 2 });
const routedCss = fontCss.replace(/url\(([^)]+)\)/g, (m, f) => `url(https://fonts.gstatic.com/local/${f})`);
await page.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: routedCss }));
await page.route('**/fonts.gstatic.com/local/**', (r) => r.fulfill({
  status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' },
  body: fs.readFileSync(path.join(fontDir, r.request().url().split('/').pop())),
}));
for (const agent of ['scout', 'pricer', 'planner', 'shopper']) {
  await page.goto(`${site}/${agent}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const box = await page.locator('figure.agent-flow').first().boundingBox();
  if (!box) { console.log('no diagram on', agent); continue; }
  await page.screenshot({
    path: out(`flow-${agent}.png`), fullPage: true,
    clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 20), width: box.width + 48, height: box.height + 40 },
  });
  console.log('site', agent);
}
await browser.close();
