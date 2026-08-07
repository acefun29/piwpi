/**
 * piwpi 桌面端 - preload（sandbox: true 下的受限子集：contextBridge + ipcRenderer）
 * 仅暴露 openExternal：把渲染进程的 http(s) 链接交给主进程校验后走系统浏览器
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openExternal", (url) => {
	ipcRenderer.send("open-external", String(url));
});
