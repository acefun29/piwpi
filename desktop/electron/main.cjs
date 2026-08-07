/**
 * piwpi 桌面端 - Electron 主进程（CommonJS）
 *
 * 为什么是 .cjs：Electron 37 在本机环境下 ESM 入口的 "electron" 内置模块注入失效
 * （import 与 require 都会解析到 node_modules/electron 包而非内置对象），
 * CJS 的 require("electron") 是唯一稳定路径。bridge 是 ESM，用动态 import 引入。
 *
 * 方案 A：内嵌现有 HTTP bridge（零前端改动，保留纯 Web 调试兜底）。
 * - startBridge({ port: 0 }) → 随机端口，回读实际端口 loadURL
 * - spawn pi 子进程由 bridge 负责（Electron 下自动注入 ELECTRON_RUN_AS_NODE=1）
 * - 关窗即杀 pi、关 bridge
 */
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("node:path");

let bridge = null;
let win = null;

// 单实例：防止两个窗口各自 spawn pi 抢占 debug 端口/会话锁
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});
}

async function createWindow() {
	const { startBridge } = await import("../server/bridge.mjs");
	bridge = await startBridge({ port: 0 });
	win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1024,
		minHeight: 700,
		autoHideMenuBar: true,
		title: "piwpi",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: path.join(__dirname, "preload.cjs"),
		},
	});
	// 渲染进程外链（markdown 渲染出的 http(s) 链接）→ 主进程校验协议后走系统浏览器
	ipcMain.on("open-external", (e, url) => {
		try {
			const u = new URL(String(url));
			if (u.protocol === "https:" || u.protocol === "http:") shell.openExternal(u.href);
		} catch { /* 非法 URL 忽略 */ }
	});
	// 安全基线：禁止新窗口、禁止导航到白名单之外的 URL
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("will-navigate", (e, url) => {
		if (!url.startsWith(`http://127.0.0.1:${bridge.port}`)) e.preventDefault();
	});
	win.on("closed", () => {
		win = null;
	});
	await win.loadURL(`http://127.0.0.1:${bridge.port}/`);
}

app.whenReady().then(async () => {
	try {
		await createWindow();
	} catch (err) {
		console.error("[electron] failed to start:", err);
		app.exit(1);
	}
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow().catch((e) => console.error(e));
	});
});

function shutdown() {
	if (bridge) {
		bridge.killPi();
		try {
			bridge.server.close();
		} catch {
			/* ignore */
		}
	}
}

app.on("before-quit", shutdown);
app.on("window-all-closed", () => {
	shutdown();
	app.quit();
});
