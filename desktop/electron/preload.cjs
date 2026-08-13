/**
 * piwpi 桌面端 - preload（sandbox: true 下的受限子集：contextBridge + ipcRenderer）
 * 仅暴露受限的外链与项目源文件打开能力，由主进程完成协议和目录边界校验。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopShell", true);

contextBridge.exposeInMainWorld("openExternal", (url) => {
	ipcRenderer.send("open-external", String(url));
});

contextBridge.exposeInMainWorld("openSourceFile", (filePath, workspace) => {
	return ipcRenderer.invoke("open-source-file", String(filePath), String(workspace));
});

// P0-3：bridge 鉴权 token（只暴露给本窗口渲染进程）
contextBridge.exposeInMainWorld("getBridgeToken", () => {
	return ipcRenderer.invoke("get-bridge-token");
});
