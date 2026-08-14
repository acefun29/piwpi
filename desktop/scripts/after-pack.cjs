const { cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = function afterPack(context) {
	const build = join(__dirname, "..", "build");
	const resources = join(context.appOutDir, "resources");
	cpSync(join(build, "runtime.asar"), join(resources, "runtime.asar"));
	if (existsSync(join(build, "runtime.asar.unpacked"))) {
		cpSync(join(build, "runtime.asar.unpacked"), join(resources, "runtime.asar.unpacked"), { recursive: true });
	}
};
