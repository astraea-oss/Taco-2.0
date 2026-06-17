import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inputDir = process.argv[2] ? join(root, process.argv[2]) : join(root, "sde");
const systemsPath = join(inputDir, "mapSolarSystems.csv");
const jumpsPath = join(inputDir, "mapSolarSystemJumps.csv");
const outputPath = join(root, "src-tauri", "resources", "universe.json");

function readCsv(path) {
  return parse(readFileSync(path, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
  });
}

const systems = readCsv(systemsPath);
const jumps = readCsv(jumpsPath);
const byId = new Map();

for (const system of systems) {
  const id = Number(system.solarSystemID);
  const name = system.solarSystemName;
  if (!id || !name) continue;
  byId.set(id, { id, name, neighbors: new Set() });
}

for (const jump of jumps) {
  const from = Number(jump.fromSolarSystemID);
  const to = Number(jump.toSolarSystemID);
  const fromSystem = byId.get(from);
  const toSystem = byId.get(to);
  if (!fromSystem || !toSystem) continue;
  fromSystem.neighbors.add(toSystem.name);
  toSystem.neighbors.add(fromSystem.name);
}

const universe = [...byId.values()]
  .map((system) => ({
    id: system.id,
    name: system.name,
    neighbors: [...system.neighbors].sort(),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(outputPath, `${JSON.stringify(universe, null, 2)}\n`);
console.log(`Wrote ${universe.length} systems to ${outputPath}`);
