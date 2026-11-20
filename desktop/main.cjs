/**
 * 小说工厂 · 桌面工作站（Electron 主进程）
 *
 * 职责：
 *  - 以 ELECTRON_RUN_AS_NODE 拉起内嵌的 C/S 编排服务（dist/index.js serve）
 *    大禹(node MCP) 随包捆绑，獬豸(python MCP) 优先系统 Python、失败自动降级。
 *  - 管理 BrowserWindow / 系统托盘 / 原生菜单 / 全局快捷键 / 创作通知 / IPC。
 *  - 数据落在 app.getPath('userData')/works，不污染安装目录。
 *
 * 注意：主进程为 CommonJS；编排服务作为独立 node 子进程，天然隔离、稳定。
 */
const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, shell, Notification, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");

const APP_NAME = "小说工厂";
const isMac = process.platform === "darwin";
const isDev = !!process.env.NOVEL_DESKTOP_DEV;

// ---------- 路径 ----------
// 打包后主进程运行在 app.asar/desktop，但 node 子进程（ELECTRON_RUN_AS_NODE）
// 不认 asar 协议，必须指向 app.asar.unpacked 下的真实文件。
const IS_PACKAGED = __dirname.includes("app.asar");
// __dirname 形如 .../resources/app.asar/desktop → 真实根为 .../resources/app.asar.unpacked
const ROOT = IS_PACKAGED
  ? path.resolve(__dirname, "..", "..", "app.asar.unpacked")
  : path.resolve(__dirname, "..");
const DATA_DIR = path.join(app.getPath("userData"), "works");
// 控制台走 HTTP 静态托管，asar 内可读（server 在主进程侧的 asar 环境运行）
// 但 server 作为独立 node 子进程，同样需要真实路径 → 用 unpacked
const CONSOLE_DIR = path.join(ROOT, "src", "console");
const DAYU_ENTRY = path.join(ROOT, "desktop", "mcp", "dayu", "index.js");
const DAYU_CONFIG_DIR = path.join(ROOT, "desktop", "mcp", "dayu");
const ENTRY = path.join(ROOT, "dist", "index.js");
const ICON = path.join(__dirname, "icons", isMac ? "icon.icns" : process.platform === "win32" ? "icon.ico" : "icon.png");

let mainWindow = null;
let tray = null;
let serverProc = null;
let serverPort = 0;
let serverReady = false;
let quitting = false;
let minimizeToTray = true;
let lastNotifiedChapter = 0;

// ---------- 单实例锁 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------- 工具 ----------
function log(...a) { console.log("[desktop]", ...a); }

function icon() {
  try {
    if (fs.existsSync(ICON)) {
      const img = nativeImage.createFromPath(ICON);
      if (!img.isEmpty()) return img;
    }
  } catch {}
  return undefined;
}

/** 找一个可用的回环端口 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function waitHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() > deadline) return reject(new Error("编排服务启动超时"));
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1000 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch { reject(new Error("健康检查返回异常")); }
        });
      });
      req.on("error", () => setTimeout(tick, 250));
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

// ---------- 编排服务子进程 ----------
async function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  serverPort = await getFreePort();

  // 探测系统 Python（獬豸优先用；无则 runner 自动降级只用大禹）
  const python = findPython();

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",              // 让 electron 二进制以纯 node 运行
    NOVEL_FACTORY_DATA: DATA_DIR,
    NOVEL_FACTORY_CONSOLE_DIR: CONSOLE_DIR,
    PORT: String(serverPort),
    HOST: "127.0.0.1",
    DAYU_CMD: process.execPath,
    DAYU_ENTRY,
    CDA_CONFIG_DIR: DAYU_CONFIG_DIR,
    CDA_MCP_DATA: path.join(DATA_DIR, "dayu-data"),
  };
  if (python) {
    env.XIEZHI_CMD = python;
    // 若随包带了獬豸源码则用之；否则设为空让连接失败自动降级
    const xz = path.join(ROOT, "desktop", "mcp", "xiezhi", "server.py");
    if (fs.existsSync(xz)) {
      env.XIEZHI_ENTRY = xz;
      env.XIEZHI_CWD = path.dirname(xz);
    }
  }

  log("启动编排服务，端口", serverPort, "| 数据目录", DATA_DIR, "| 大禹", DAYU_ENTRY, "| 獬豸", python || "降级");
  serverProc = spawn(process.execPath, [ENTRY, "serve"], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  serverProc.stdout.on("data", (d) => log("server:", String(d).trim()));
  serverProc.stderr.on("data", (d) => log("server.err:", String(d).trim()));
  serverProc.on("exit", (code) => {
    log("编排服务退出，code=", code);
    serverProc = null;
    if (!quitting) {
      // 服务意外退出：提示用户，不自动重启以免掩盖问题
      showNotification("编排服务已停止", "请从托盘菜单重新启动，或重启应用。");
    }
  });

  await waitHealth(serverPort);
  serverReady = true;
  log("编排服务就绪");
}

function findPython() {
  const candidates = ["python3", "python"];
  for (const c of candidates) {
    try {
      const r = require("node:child_process").spawnSync(c, ["--version"], { encoding: "utf8", timeout: 3000 });
      if (r.status === 0 && /Python 3\.(1[0-9]|[89])/.test(r.stdout + r.stderr)) return c;
    } catch {}
  }
  return null;
}

function restartServer() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
  serverReady = false;
  startServer().then(() => {
    if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
  }).catch((e) => dialog.showErrorBox("启动失败", e.message));
}

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: APP_NAME,
    icon: icon(),
    backgroundColor: "#f4f7f6",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false); // 用自绘顶栏；原生菜单通过托盘/快捷键访问
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
  mainWindow.on("close", (e) => {
    if (!quitting && minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
      if (isMac) app.dock?.hide();
      showNotification(APP_NAME, "已最小化到托盘，创作任务继续在后台运行。");
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ---------- 托盘 ----------
function createTray() {
  try { tray = new Tray(icon() || nativeImage.createEmpty()); } catch { return; }
  tray.setToolTip(`${APP_NAME} · 全自动创作工作站`);
  const menu = () => Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { type: "separator" },
    { label: "打开主窗口", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); if (isMac) app.dock?.show(); } } },
    { label: "新建作品", accelerator: "CmdOrCtrl+Shift+N", click: () => sendToRenderer("desktop:action", "new") },
    { label: "开始创作", accelerator: "CmdOrCtrl+Shift+R", click: () => sendToRenderer("desktop:action", "run") },
    { type: "separator" },
    { label: "打开数据目录", click: () => shell.openPath(DATA_DIR) },
    { label: "导入备份…", click: () => importBackup() },
    { label: minimizeToTray ? "关闭时最小化到托盘 ✓" : "关闭时直接退出", click: () => { minimizeToTray = !minimizeToTray; } },
    { label: "重启编排服务", click: restartServer },
    { type: "separator" },
    { label: "关于", click: () => dialog.showMessageBox({
      title: APP_NAME,
      message: `${APP_NAME} 桌面工作站 v${app.getVersion()}`,
      detail: `全自动小说创作流水线：写稿 → 大禹评审 → 獬豸终审 → 打回重写 → 定稿。\n\n数据目录：${DATA_DIR}\n编排服务：127.0.0.1:${serverPort}\n\n开源：github.com/proteus-vue/novel-factory`,
      buttons: ["好的"],
    }) },
    { label: "退出", accelerator: "CmdOrCtrl+Q", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on("click", () => { if (mainWindow) { mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); } });
  // 状态变化时刷新菜单（占位：每次打开时重建）
  tray.on("right-click", () => tray.setContextMenu(menu()));
}

function sendToRenderer(channel, payload) {
  if (mainWindow && mainWindow.webContents) mainWindow.webContents.send(channel, payload);
}

// ---------- 通知 ----------
function showNotification(title, body) {
  if (!Notification.isSupported()) return;
  try { new Notification({ title, body, icon: icon() }).show(); } catch {}
}

/** 轮询创作进度，章节通过/完本时发系统通知（后台挂机也能感知） */
let pollTimer = null;
function startProgressPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!serverReady || !mainWindow) return;
    // 只在工作站有可见窗口但未聚焦（或隐藏到托盘）时推送，避免前台重复打扰
    const focused = mainWindow.isFocused() && mainWindow.isVisible();
    if (focused) return;
    const req = http.get({ host: "127.0.0.1", port: serverPort, path: "/api/works", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          const works = (j.data || []).filter((w) => w.job && (w.job.status === "running" || w.job.status === "done"));
          for (const w of works) {
            const done = w.doneCount || 0;
            if (w.job.status === "running" && done > lastNotifiedChapter) {
              lastNotifiedChapter = done;
              showNotification("创作进行中", `《${w.书名}》已完成 ${done} 章`);
            }
            if (w.job.status === "done" && done > 0) {
              showNotification("创作完成", `《${w.书名}》全书 ${done} 章已定稿，点击窗口查看。`);
            }
          }
        } catch {}
      });
    });
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
  }, 8000);
}

// ---------- 导入备份 ----------
async function importBackup() {
  if (!mainWindow) return;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "选择备份 JSON",
    filters: [{ name: "JSON 备份", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return;
  try {
    const text = fs.readFileSync(filePaths[0], "utf8");
    const parsed = JSON.parse(text);
    sendToRenderer("desktop:import-backup", parsed);
  } catch (e) {
    dialog.showErrorBox("导入失败", "文件不是有效的 JSON 备份：" + e.message);
  }
}

// ---------- IPC ----------
function setupIPC() {
  ipcMain.handle("desktop:info", () => ({
    version: app.getVersion(),
    dataDir: DATA_DIR,
    port: serverPort,
    platform: process.platform,
    dayuBundled: fs.existsSync(path.join(DAYU_CONFIG_DIR, "rules.yaml")),
  }));
  ipcMain.handle("desktop:open-data-dir", () => shell.openPath(DATA_DIR));
  ipcMain.handle("desktop:choose-import", async () => {
    if (!mainWindow) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: "JSON 备份", extensions: ["json"] }], properties: ["openFile"],
    });
    if (canceled || !filePaths.length) return null;
    try { return JSON.parse(fs.readFileSync(filePaths[0], "utf8")); } catch { return null; }
  });
  ipcMain.handle("desktop:save-export", async (_e, suggestedName, content) => {
    if (!mainWindow) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "保存备份", defaultPath: suggestedName || "novel-factory-backup.json",
      filters: [{ name: "JSON 备份", extensions: ["json"] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  });
  ipcMain.handle("desktop:notify", (_e, title, body) => showNotification(title, body));
  ipcMain.handle("desktop:restart-server", () => { restartServer(); return true; });
  ipcMain.handle("desktop:open-external", (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

// ---------- 原生菜单（macOS 保留应用菜单）----------
function setupMenu() {
  if (isMac) {
    const template = [
      { label: APP_NAME, submenu: [
        { label: `关于 ${APP_NAME}`, click: () => dialog.showMessageBox({ title: APP_NAME, message: `v${app.getVersion()}`, detail: "github.com/proteus-vue/novel-factory" }) },
        { type: "separator" },
        { label: "隐藏", accelerator: "Cmd+H", role: "hide" },
        { label: "退出", accelerator: "Cmd+Q", click: () => { quitting = true; app.quit(); } },
      ]},
      { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      { label: "视图", submenu: [{ role: "reload" }, { role: "forceReload" }, { type: "separator" }, { role: "togglefullscreen" }] },
      { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    Menu.setApplicationMenu(null);
  }
}

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  setupIPC();
  setupMenu();
  try {
    await startServer();
    createWindow();
    createTray();
    startProgressPolling();
  } catch (e) {
    log("启动失败:", e);
    dialog.showErrorBox("启动失败", `编排服务无法启动：${e.message}\n\n数据目录：${DATA_DIR}`);
    app.quit();
    return;
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on("window-all-closed", () => {
  // 桌面工作站默认驻留托盘；托盘菜单可真正退出
  if (!isMac && quitting) app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  clearInterval(pollTimer);
  if (serverProc) { try { serverProc.kill(); } catch {} serverProc = null; }
});
