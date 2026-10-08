// Headless GPU smoke test / screenshots of the built site.
//   node tools/snap.mjs <outDir> [CamName ...]     ("overview" = default view)
// Serves dist/ on a free port, opens it in headless Chrome (GPU via ANGLE/Vulkan when available),
// waits for the model, prints console errors + renderer stats, writes <outDir>/<view>.png.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const [outDir = 'shots', ...views] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
                '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.hdr': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split(/[?#]/)[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const port = server.address().port;
const base = process.env.SNAP_URL || `http://127.0.0.1:${port}/`;     // SNAP_URL=https://… tests the live site

const soft = process.env.SNAP_SOFT === '1';                  // CI: no GPU, software GL (slow but fine for a load test)
const browser = await puppeteer.launch({
  headless: 'shell',
  protocolTimeout: 600000,
  args: soft ? ['--no-sandbox', '--enable-unsafe-swiftshader', '--window-size=1600,900']
             : ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--window-size=1600,900'],
  defaultViewport: soft ? { width: 800, height: 450 } : { width: 1600, height: 900 },
});
let failed = false;
try {
  for (const v of views.length ? views : ['overview']) {
    const page = await browser.newPage();
    page.on('console', (m) => { if (['error', 'warn'].includes(m.type())) console.log(`[${v}] console.${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => { failed = true; console.log(`[${v}] pageerror: ${e.message}`); });
    const t0 = Date.now();
    await page.goto(base + (v === 'overview' ? '' : v.startsWith('view=') ? '#' + v : '#cam=' + v));
    await page.waitForFunction('window.sagaReady === true', { timeout: soft ? 300000 : 120000 });
    await new Promise((r) => setTimeout(r, soft ? 15000 : 2500));   // textures + HDRI + shadow pass
    const gpu = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2');
      const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; });
    const stats = await page.$eval('#stats', (e) => e.textContent);
    await page.screenshot({ path: path.join(outDir, v.replace(/[^\w.-]+/g, '_').slice(0, 60) + '.png') });
    console.log(`${v}: ready in ${((Date.now() - t0) / 1000).toFixed(1)} s · ${stats} · ${gpu}`);
    await page.close();
  }
} catch (e) { failed = true; console.log('ERROR', e.message); }
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
