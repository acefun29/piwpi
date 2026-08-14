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
			width: 600,
			height: 600,
			show: false,
			webPreferences: {
				offscreen: true,
			},
		});

		const pageHtml = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
</head>
<body style="margin:0;padding:0;background:transparent;">
<canvas id="c"></canvas>
<script>
window.renderIcon = function(svgStr, size) {
	return new Promise((resolve, reject) => {
		const canvas = document.getElementById('c');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d');
		ctx.clearRect(0, 0, size, size);

		const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			// Center 900x500 logo inside square with subtle margins (e.g. 92% of box)
			const maxDim = size * 0.94;
			const scale = Math.min(maxDim / 900, maxDim / 500);
			const w = 900 * scale;
			const h = 500 * scale;
			const x = (size - w) / 2;
			const y = (size - h) / 2;
			ctx.drawImage(img, x, y, w, h);
			URL.revokeObjectURL(url);
			const dataUrl = canvas.toDataURL('image/png');
			resolve(dataUrl);
		};
		img.onerror = (e) => {
			URL.revokeObjectURL(url);
			reject(new Error('Failed to load SVG into image'));
		};
		img.src = url;
	});
};
</script>
</body>
</html>
`;

		await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`);
		await new Promise((r) => setTimeout(r, 200));

		const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
		const rendered = [];

		for (const size of sizes) {
			const dataUrl = await win.webContents.executeJavaScript(
				`window.renderIcon(${JSON.stringify(svgContent)}, ${size})`
			);
			const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
			const pngBuffer = Buffer.from(base64, "base64");
			rendered.push({ size, buffer: pngBuffer });
			console.log(`Rendered transparent ${size}x${size}: ${pngBuffer.length} bytes`);
		}

		// Save 512x512 transparent icon.png
		const png512 = rendered.find((r) => r.size === 512).buffer;
		const buildDir = path.join(repoRoot, "desktop", "build");
		const webAssetsDir = path.join(repoRoot, "desktop", "web", "assets");
		const webDir = path.join(repoRoot, "desktop", "web");

		fs.mkdirSync(buildDir, { recursive: true });
		fs.mkdirSync(webAssetsDir, { recursive: true });

		fs.writeFileSync(path.join(buildDir, "icon.png"), png512);
		fs.writeFileSync(path.join(webAssetsDir, "icon.png"), png512);
		fs.writeFileSync(path.join(webAssetsDir, "pwp-logo.png"), png512);

		// Also copy logo.svg
		fs.writeFileSync(path.join(webDir, "logo.svg"), svgContent);
		fs.writeFileSync(path.join(webAssetsDir, "logo.svg"), svgContent);

		// Build ICO with sizes 16, 24, 32, 48, 64, 128, 256
		const icoSizes = rendered.filter((r) => r.size <= 256);
		const icoBuffer = buildIco(icoSizes);
		fs.writeFileSync(path.join(buildDir, "icon.ico"), icoBuffer);
		console.log(`Generated transparent icon.ico: ${icoBuffer.length} bytes`);

		console.log("Transparent icon generation completed successfully!");
		win.close();
		app.quit();
	} catch (err) {
		console.error("Icon generation error:", err);
		process.exit(1);
	}
});
