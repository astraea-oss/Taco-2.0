import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const svgPath = process.argv[2] ? join(root, process.argv[2]) : join(root, "dotlan-insmother.svg");
const outputPath = process.argv[3]
  ? join(root, process.argv[3])
  : join(root, "scripts", "region-layout-overrides.json");

const svg = readFileSync(svgPath, "utf8");
const namesById = new Map();

for (const match of svg.matchAll(
  /<symbol id="def(\d+)">[\s\S]*?<text x="28" y="14" class="ss" text-anchor="middle">([^<]+)<\/text>/g,
)) {
  namesById.set(Number(match[1]), match[2]);
}

const systems = [];
for (const match of svg.matchAll(/<use id="sys(\d+)" x="([\d.]+)" y="([\d.]+)"[^>]*>/g)) {
  const id = Number(match[1]);
  const name = namesById.get(id);
  if (!name) continue;
  systems.push({
    id,
    name,
    x: Math.round(Number(match[2]) + 28),
    y: Math.round(Number(match[3]) + 14.5),
  });
}

systems.sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      Insmother: {
        source: "https://evemaps.dotlan.net/map/Insmother",
        width: 1024,
        height: 768,
        systems,
      },
    },
    null,
    2,
  )}\n`,
);

console.log(`Wrote ${systems.length} Dotlan system positions to ${outputPath}`);
