import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const svgPath = process.argv[2] ? join(root, process.argv[2]) : join(root, "dotlan-insmother.svg");
const outputPath = process.argv[3]
  ? join(root, process.argv[3])
  : join(root, "scripts", "region-layout-overrides.json");

const svg = readFileSync(svgPath, "utf8");
const symbolsById = new Map();

for (const match of svg.matchAll(/<symbol id="def(\d+)">([\s\S]*?)<\/symbol>/g)) {
  const id = Number(match[1]);
  const body = match[2];
  const internalName = body.match(/<text x="28" y="14" class="ss" text-anchor="middle">([^<]+)<\/text>/)?.[1];
  const externalName = body.match(/<text x="28" y="14" class="es" text-anchor="middle">([^<]+)<\/text>/)?.[1];
  const externalRegion = body.match(/<text x="28" y="21\.7" class="er" text-anchor="middle">([^<]+)<\/text>/)?.[1];
  if (internalName) {
    symbolsById.set(id, { id, name: internalName, external: false });
  } else if (externalName) {
    symbolsById.set(id, {
      id,
      name: externalName,
      external: true,
      external_region: externalRegion ?? "External",
    });
  }
}

const systems = [];
const externalSystems = [];
for (const match of svg.matchAll(/<use id="sys(\d+)" x="([\d.]+)" y="([\d.]+)"[^>]*>/g)) {
  const id = Number(match[1]);
  const symbol = symbolsById.get(id);
  if (!symbol) continue;
  const system = {
    id,
    name: symbol.name,
    x: Math.round(Number(match[2]) + 28),
    y: Math.round(Number(match[3]) + 14.5),
  };
  if (symbol.external) {
    externalSystems.push({
      ...system,
      external_region: symbol.external_region,
    });
  } else {
    systems.push(system);
  }
}

systems.sort((a, b) => a.name.localeCompare(b.name));
externalSystems.sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      Insmother: {
        source: "https://evemaps.dotlan.net/map/Insmother",
        width: 1024,
        height: 768,
        systems,
        external_systems: externalSystems,
      },
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Wrote ${systems.length} Dotlan system positions and ${externalSystems.length} external positions to ${outputPath}`,
);
