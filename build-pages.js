const fs = require("fs");
const path = require("path");

const root = __dirname;
const dist = path.join(root, "dist");
const entries = ["index.html", "platform", "storage", "CLOUDFLARE_DEPLOYMENT.md"];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const entry of entries) {
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) continue;
  const target = path.join(dist, entry);
  fs.cpSync(source, target, { recursive: true });
}

fs.copyFileSync(path.join(root, "platform", "index.html"), path.join(dist, "index.html"));

console.log("Static site copied to dist.");
