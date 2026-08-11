const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const screenshotPath = join(__dirname, "..", "screenshots", "layout-smoke.png");
const startedAt = performance.now();
let targetWindow;

require("./main.cjs");

async function waitForWindow(timeoutMs) {
	const started = Date.now();
	for (;;) {
		const window = BrowserWindow.getAllWindows()[0];
		if (window && !window.webContents.isLoading()) return window;
		if (Date.now() - started > timeoutMs) throw new Error("desktop window did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function waitFor(check, timeoutMs, message) {
	const started = Date.now();
	for (;;) {
		if (await check()) return;
		if (Date.now() - started > timeoutMs) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

app.whenReady().then(async () => {
	try {
		const window = await waitForWindow(30_000);
		targetWindow = window;
		await waitFor(
			() => window.webContents.executeJavaScript(`document.querySelector('#piStatus')?.textContent === 'pi 已连接'`),
			30_000,
			"pi RPC did not become ready",
		);
		const piReadyMs = Math.round(performance.now() - startedAt);
		const inputPoint = await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#navProviders').click();
			document.querySelector('#navMap').click();
			document.querySelector('#navMap').click();
			document.querySelector('#modelPickerBtn').click();
			const rect = document.querySelector('#inputBox').getBoundingClientRect();
			return { x: Math.round(rect.left + 24), y: Math.round(rect.top + rect.height / 2) };
		})()`);
		window.webContents.sendInputEvent({ type: "mouseDown", ...inputPoint, button: "left", clickCount: 1 });
		await waitFor(
			() => window.webContents.executeJavaScript(`document.querySelectorAll('.provider-item').length > 0`),
			30_000,
			"provider catalog did not finish after model menu focus test",
		);
		window.webContents.sendInputEvent({ type: "mouseUp", ...inputPoint, button: "left", clickCount: 1 });
		window.webContents.sendInputEvent({ type: "char", keyCode: "q" });
		const inputFocus = await window.webContents.executeJavaScript(`(() => {
			const input = document.querySelector('#inputBox');
			const state = { activeElement: document.activeElement?.id, value: input.value };
			input.value = '';
			return state;
		})()`);
		await window.webContents.executeJavaScript(`document.querySelector('#btnContext').click()`);
		await waitFor(
			() => window.webContents.executeJavaScript(`!document.querySelector('#drawer').hidden`),
			5_000,
			"context drawer did not open",
		);
		await window.webContents.executeJavaScript(`document.querySelector('#navProviders').click()`);
		await waitFor(
			() => window.webContents.executeJavaScript(`document.querySelectorAll('.provider-item').length > 0`),
			30_000,
			"provider catalog did not render",
		);
		const layout = await window.webContents.executeJavaScript(`(() => {
			const titlebar = document.querySelector('.window-titlebar');
			const app = document.querySelector('#app');
			const providerList = document.querySelector('#providerList');
			const providerConfigured = [...providerList.querySelectorAll('.provider-item')]
				.map((item) => item.querySelector('.provider-status').classList.contains('on'));
			const firstUnconfigured = providerConfigured.indexOf(false);
			const lastConfigured = providerConfigured.lastIndexOf(true);
			providerList.scrollTop = 300;
			return {
				desktopShell: document.body.classList.contains('desktop-shell'),
				titlebarDisplay: getComputedStyle(titlebar).display,
				titlebarHeight: Math.round(titlebar.getBoundingClientRect().height),
				titlebarBrandCount: titlebar.childElementCount,
				appTop: Math.round(app.getBoundingClientRect().top),
				providerCount: document.querySelectorAll('.provider-item').length,
				configuredProviderCount: providerConfigured.filter(Boolean).length,
				configuredProvidersFirst: firstUnconfigured === -1 || lastConfigured < firstUnconfigured,
				firstProviderGroup: providerList.querySelector('.provider-list-title')?.textContent,
				providerListScrollable: providerList.scrollHeight > providerList.clientHeight,
				providerScrollTop: providerList.scrollTop,
				providersVisible: !document.querySelector('#providersPage').hidden,
				drawerHidden: document.querySelector('#drawer').hidden,
				contextButtonOpen: document.querySelector('#btnContext').classList.contains('open'),
			};
		})()`);
		layout.inputFocus = inputFocus;
		const passed =
			layout.desktopShell &&
			layout.titlebarDisplay === "flex" &&
			layout.titlebarHeight === 40 &&
			layout.titlebarBrandCount === 0 &&
			layout.appTop === 40 &&
			layout.providerCount > 0 &&
			layout.configuredProvidersFirst &&
			(layout.configuredProviderCount === 0 || layout.firstProviderGroup === "已配置") &&
			layout.providerListScrollable &&
			layout.providerScrollTop > 0 &&
			layout.providersVisible &&
			layout.drawerHidden &&
			!layout.contextButtonOpen &&
			layout.inputFocus.activeElement === "inputBox" &&
			layout.inputFocus.value === "q";
		mkdirSync(join(__dirname, "..", "screenshots"), { recursive: true });
		writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
		console.log(JSON.stringify({ passed, piReadyMs, layout, screenshotPath }));
		app.exit(passed ? 0 : 1);
	} catch (error) {
		if (targetWindow) {
			const state = await targetWindow.webContents.executeJavaScript(`({
				providerDetail: document.querySelector('#providerDetail')?.textContent,
				toasts: [...document.querySelectorAll('.toast')].map((node) => node.textContent),
				piStatus: document.querySelector('#piStatus')?.textContent,
			})`);
			console.error(JSON.stringify(state));
		}
		console.error(error);
		app.exit(1);
	}
});
