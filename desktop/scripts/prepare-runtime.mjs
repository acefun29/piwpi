import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "..");
const runtime = join(desktop, "build", "runtime");
const runtimeModules = join(runtime, "node_modules");
const packageRoot = join(runtimeModules, "@earendil-works");
const packages = new Map([
	["pi-ai", "ai"],
	["pi-agent-core", "agent"],
	["pi-tui", "tui"],
	["pi-protocol", "protocol"],
	["pi-client", "client"],
	["pi-coding-agent", "coding-agent"],
]);

await rm(runtime, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

const rootModules = join(repo, "node_modules");
await cp(rootModules, runtimeModules, {
	recursive: true,
	filter(source) {
		const relative = source.slice(rootModules.length + 1).replaceAll("\\", "/");
		if (!relative) return true;
		if (relative.startsWith("@earendil-works/")) return false;
		if (/^pi-extension-[^/]+(?:\/|$)/.test(relative)) return false;
		return true;
	},
});

for (const [name, directory] of packages) {
	const source = join(repo, "packages", directory);
	const target = join(packageRoot, name);
	await mkdir(target, { recursive: true });
	await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
	const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
	await writeFile(join(target, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
}

console.log(`Prepared piwpi runtime at ${runtime}`);
