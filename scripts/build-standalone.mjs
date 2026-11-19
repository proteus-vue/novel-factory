/**
 * 构建自包含 PWA：把控制台 + 内嵌引擎打成一个零服务端依赖的静态目录 dist-platform/。
 * 产物可：静态托管 / 添加到主屏离线用 / Capacitor 打 APK。
 * 处理：把 /console/xxx 绝对路径改相对；补齐离线 SW 与 manifest；拷图标。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src", "console");
const WEB = path.join(ROOT, "src", "web");
const OUT = path.join(ROOT, "dist-platform");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. index.html：/console/ 绝对路径 → 相对；补 manifest 与 SW 注册
let html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
html = html.replace(/href="\/console\//g, 'href="./')
           .replace(/src="\/console\//g, 'src="./');
// 注入 manifest link（原 HTML 无）
html = html.replace(/(<meta name="theme-color"[^>]*>)/, '$1\n  <link rel="manifest" href="./manifest.webmanifest" />');
// 注入 SW 注册（在 module script 之后）
html = html.replace(/(<script type="module" src="\.\/app\.js"><\/script>)/,
  '$1\n  <script>if("serviceWorker" in navigator){addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));}</script>');
fs.writeFileSync(path.join(OUT, "index.html"), html, "utf8");

// 2. 前端 JS（module，内部用相对 import）
for (const f of ["app.js", "engine.js", "pipeline.js", "operations.js", "app.css"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}

// 3. manifest
const manifest = {
  name: "小说工厂 · 全自动创作平台",
  short_name: "小说工厂",
  description: "全自动写小说 + 自动编审 + 定稿发布，离线可用",
  start_url: "./index.html",
  scope: "./",
  display: "standalone",
  orientation: "any",
  background_color: "#f5f7f4",
  theme_color: "#0d3a3b",
  lang: "zh-CN",
  icons: [
    { src: "./icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "./icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};
fs.writeFileSync(path.join(OUT, "manifest.webmanifest"), JSON.stringify(manifest, null, 2), "utf8");

// 4. 图标
fs.copyFileSync(path.join(WEB, "icon-192.png"), path.join(OUT, "icon-192.png"));
fs.copyFileSync(path.join(WEB, "icon-512.png"), path.join(OUT, "icon-512.png"));

// 5. SW：缓存全部资源（含 module 依赖）
const sw = `/* 小说工厂自包含 App · 离线缓存 */
const CACHE = 'novel-factory-platform-v4';
const ASSETS = ['./','./index.html','./app.css','./app.js','./engine.js','./pipeline.js','./operations.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
    if (resp && resp.status === 200) { const copy = resp.clone(); caches.open(CACHE).then(c=>c.put(e.request, copy)); }
    return resp;
  }).catch(()=>caches.match('./index.html'))));
});
`;
fs.writeFileSync(path.join(OUT, "sw.js"), sw, "utf8");

console.log("自包含 PWA 已构建到:", OUT);
console.log("文件:", fs.readdirSync(OUT).sort().join(", "));

// 校验：无残留 /console/ 绝对路径
if (html.includes("/console/")) { console.error("警告: index.html 仍有 /console/ 绝对路径"); process.exit(1); }
