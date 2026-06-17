import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exePath = join(root, "src-tauri", "target", "release", "eve-intel-companion.exe");
const portableRoot = join(root, "dist-portable");
const appDir = join(portableRoot, "EVE Intel Companion Portable");
const dataDir = join(appDir, "EVE Intel Companion Data");

if (!existsSync(exePath)) {
  throw new Error(`Release executable not found: ${exePath}`);
}

mkdirSync(appDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
copyFileSync(exePath, join(appDir, "EVE Intel Companion.exe"));
const readmePath = join(dataDir, "README.txt");
if (!existsSync(readmePath)) {
  writeFileSync(
    readmePath,
    [
      "EVE Intel Companion portable data folder",
      "",
      "The app stores settings.json here when launched from this portable folder.",
      "Keep this folder beside EVE Intel Companion.exe to keep the app portable.",
      "",
    ].join("\r\n"),
  );
}

console.log(`Portable build created at: ${appDir}`);
