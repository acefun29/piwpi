const { cpSync } = require("node:fs");
const { join } = require("node:path");

exports.default = function afterPack(context) {
	cpSync(join(__dirname, "..", "build", "runtime"), join(context.appOutDir, "resources", "runtime"), {
		recursive: true,
	});
};
