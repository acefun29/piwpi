const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function buildIco(pngBuffers) {
	// pngBuffers: array of { size, buffer }
	const headerSize = 6;
	const entrySize = 16;
	const count = pngBuffers.length;
	let offset = headerSize + entrySize * count;

	const header = Buffer.alloc(headerSize);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon (1)
	header.writeUInt16LE(count, 4); // number of images

	const entries = [];
	for (const { size, buffer } of pngBuffers) {
		const entry = Buffer.alloc(entrySize);
		entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
		entry.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 = 256)
		entry.writeUInt8(0, 2); // color count
		entry.writeUInt8(0, 3); // reserved
		entry.writeUInt16LE(1, 4); // color planes
		entry.writeUInt16LE(32, 6); // bits per pixel
		entry.writeUInt32LE(buffer.length, 8); // image size
		entry.writeUInt32LE(offset, 12); // image offset
		entries.push(entry);
		offset += buffer.length;
	}

	return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.buffer)]);
}

app.whenReady().then(async () => {
	try {
		const repoRoot = path.resolve(__dirname, "..");
		const svgContent = fs.readFileSync(path.join(repoRoot, "logo.svg"), "utf8");

		const win = new BrowserWindow({
			width: 1024,
			height: 1024,
			show: false,
			webPreferences: {
				offscreen: true,
			},
		});

		const html = `
<!DOCTYPE html>
<html>
<head>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: transparent; display: flex; align-items: center; justify-content: center; width: 100vw; height: 100vh; overflow: hidden; }
#container { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
svg { width: 88%; height: 88%; object-fit: contain; }
</style>
</head>
<body>
<div id="container">
${svgContent}
</div>
</body>
</html>
`;

		await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		await new Promise((r) => setTimeout(r, 500));

		const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
		const rendered = [];

		for (const size of sizes) {
			win.setContentSize(size, size);
			await new Promise((r) => setTimeout(r, 100));
			const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
			const pngBuffer = image.toPNG();
			rendered.push({ size, buffer: pngBuffer });
			console.log(`Rendered ${size}x${size}: ${pngBuffer.length} bytes`);
		}

		// Save 512x512 icon.png
		const png512 = rendered.find((r) => r.size === 512).buffer;
		const buildDir = path.join(repoRoot, "desktop", "build");
		const webAssetsDir = path.join(repoRoot, "desktop", "web", "assets");
		const webDir = path.join(repoRoot, "desktop", "web");

		fs.mkdirSync(buildDir, { recursive: true });
		fs.mkdirSync(webAssetsDir, { recursive: true });

		fs.writeFileSync(path.join(buildDir, "icon.png"), png512);
		fs.writeFileSync(path.join(webAssetsDir, "icon.png"), png512);
		fs.writeFileSync(path.join(webAssetsDir, "pwp-logo.png"), png512);

		// Also copy logo.svg to desktop/web/logo.svg and desktop/web/assets/logo.svg
		fs.writeFileSync(path.join(webDir, "logo.svg"), svgContent);
		fs.writeFileSync(path.join(webAssetsDir, "logo.svg"), svgContent);

		// Build ICO with sizes up to 256
		const icoSizes = rendered.filter((r) => r.size <= 256);
		const icoBuffer = buildIco(icoSizes);
		fs.writeFileSync(path.join(buildDir, "icon.ico"), icoBuffer);
		console.log(`Generated icon.ico: ${icoBuffer.length} bytes`);

		console.log("Icon generation completed successfully!");
		win.close();
		app.quit();
	} catch (err) {
		console.error("Icon generation error:", err);
		process.exit(1);
	}
});
