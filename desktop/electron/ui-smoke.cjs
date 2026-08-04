/**
 * Electron UI 冒烟（CommonJS）：起窗口 → 真实对话（deepseek）→ 打开 Context 抽屉 → 截图留证。
 * 运行：node_modules/electron/dist/electron.exe electron/ui-smoke.cjs
 * 输出：desktop/screenshots/ui-smoke.png + DOM 状态 JSON
 */
const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, dirname } = require("node:path");

const SHOT_DIR = join(__dirname, "..", "screenshots");
const SHOT_PATH = join(SHOT_DIR, "ui-smoke.png");
mkdirSync(SHOT_DIR, { recursive: true });

const prompt = "读一下 pi/extension/src/hash.ts 的前 10 行，简单说下它做什么，不用修改任何文件。";
let bridge = null;
let win = null;

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, label) {
	const start = Date.now();
	for (;;) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {
			/* retry */
		}
		if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
		await sleep(500);
	}
}

app.whenReady().then(async () => {
	try {
		const { startBridge } = await import("../server/bridge.mjs");
		bridge = await startBridge({ port: 0 });
		win = new BrowserWindow({
			width: 1440,
			height: 900,
			show: true,
			webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
		});
		await win.loadURL(`http://127.0.0.1:${bridge.port}/`);

		// 1. 等待 pi 连接 + 模型名填充（get_state 完成）
		await waitFor(
			() =>
				win.webContents
					.executeJavaScript(`document.querySelector('#piStatus')?.textContent`)
					.then((t) => t === "pi 已连接"),
			30000,
			"pi connected",
		);
		await waitFor(
			() =>
				win.webContents
					.executeJavaScript(`document.querySelector('#modelName')?.textContent`)
					.then((t) => t && t !== "—"),
			90000,
			"model populated",
		);

		// 2. 发送真实消息
		await win.webContents.executeJavaScript(`
			(() => {
				const box = document.querySelector('#inputBox');
				box.value = ${JSON.stringify(prompt)};
				box.dispatchEvent(new Event('input'));
				document.querySelector('#btnSend').click();
			})()
		`);
		console.log("[ui-smoke] prompt sent");

		// 3. 等待对话完成（工具卡出现 + agent_settled：中断按钮隐藏）
		await waitFor(
			() =>
				win.webContents
					.executeJavaScript(
						`!!document.querySelector('.tool-card') && document.querySelector('#btnAbort').hidden === true`,
					),
			240000,
			"conversation settled with tool card",
		);

		// 4. 打开 Context 抽屉，等挂载文件出现
		await win.webContents.executeJavaScript(`document.querySelector('#btnContext').click()`);
		await waitFor(
			() =>
				win.webContents
					.executeJavaScript(`document.querySelector('#fileList .ctx-file')?.textContent ?? ''`)
					.then((t) => t.length > 0),
			20000,
			"context files mounted",
		);

		// 5. 展开思考块，收集 DOM 状态 + 事件日志
		await win.webContents.executeJavaScript(`document.querySelector('.think-block')?.classList.add('open')`);
		const state = await win.webContents.executeJavaScript(`(() => {
			const text = [...document.querySelectorAll('.msg')].map(n => n.textContent).join('\\n');
			return {
				model: document.querySelector('#modelName')?.textContent,
				thinkingLevel: document.querySelector('#thinkingSel')?.value,
				thinkingLevels: [...document.querySelector('#thinkingSel')?.options].map(o => o.value),
				piStatus: document.querySelector('#piStatus')?.textContent,
				toolCards: document.querySelectorAll('.tool-card').length,
				toolStatuses: [...document.querySelectorAll('.tool-status')].map(n => n.textContent),
				thinkBlocks: document.querySelectorAll('.think-block').length,
				ctxBadge: document.querySelector('#ctxBadge')?.textContent,
				ctxFiles: [...document.querySelectorAll('.ctx-file .f-path')].map(n => n.textContent),
				ctxRanges: [...document.querySelectorAll('.ctx-file .f-ranges')].map(n => n.textContent),
				ctxMsgs: document.querySelectorAll('.ctx-msg').length,
				textPreview: text.slice(0, 200),
			};
		})()`);

		// 6. 截图
		const image = await win.webContents.capturePage();
		writeFileSync(SHOT_PATH, image.toPNG());
		console.log("[ui-smoke] screenshot:", SHOT_PATH);
		console.log("[ui-smoke] state:", JSON.stringify(state, null, 2));

		const pass =
			state.toolCards >= 1 &&
			state.ctxFiles.length >= 1 &&
			state.thinkingLevels.length >= 1 &&
			state.toolStatuses.some((s) => s === "完成");
		console.log(pass ? "[ui-smoke] UI PASS" : "[ui-smoke] UI FAIL");
		process.exitCode = pass ? 0 : 1;
	} catch (err) {
		console.error("[ui-smoke] FAIL:", err.message);
		process.exitCode = 1;
	} finally {
		try {
			bridge?.killPi();
		} catch {
			/* ignore */
		}
		try {
			bridge?.server.close();
		} catch {
			/* ignore */
		}
		app.exit(process.exitCode ?? 0);
	}
});
