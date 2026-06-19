import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inputDir = process.argv[2] ? join(root, process.argv[2]) : join(root, "sde");
const systemsPath = join(inputDir, "mapSolarSystems.csv");
const jumpsPath = join(inputDir, "mapSolarSystemJumps.csv");
const outputPath = join(root, "src-tauri", "resources", "regions.json");
const overridesPath = join(root, "scripts", "region-layout-overrides.json");

const regions = [{ id: 10000009, name: "Insmother" }];
const layoutOverrides = existsSync(overridesPath)
  ? JSON.parse(readFileSync(overridesPath, "utf8"))
  : {};

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
  const regionId = Number(system.regionID);
  if (!id || !regionId) continue;
  byId.set(id, {
    id,
    regionId,
    name: system.solarSystemName,
    x: Number(system.x),
    z: Number(system.z),
    security: Number(system.security),
  });
}

const output = regions.map((region) => {
  const regionSystems = [...byId.values()].filter((system) => system.regionId === region.id);
  const override = layoutOverrides[region.name];
  const overrideById = new Map((override?.systems ?? []).map((system) => [system.id, system]));
  const minX = Math.min(...regionSystems.map((system) => system.x));
  const maxX = Math.max(...regionSystems.map((system) => system.x));
  const minZ = Math.min(...regionSystems.map((system) => system.z));
  const maxZ = Math.max(...regionSystems.map((system) => system.z));
  const xRange = maxX - minX || 1;
  const zRange = maxZ - minZ || 1;
  const names = new Set(regionSystems.map((system) => system.name));
  const idToName = new Map(regionSystems.map((system) => [system.id, system.name]));
  const edgeKeys = new Set();

  for (const jump of jumps) {
    const from = idToName.get(Number(jump.fromSolarSystemID));
    const to = idToName.get(Number(jump.toSolarSystemID));
    if (!from || !to || !names.has(from) || !names.has(to)) continue;
    edgeKeys.add([from, to].sort().join("|"));
  }

  return {
    id: region.id,
    name: region.name,
    width: override?.width ?? 1000,
    height: override?.height ?? 720,
    systems: regionSystems
      .map((system) => ({
        id: system.id,
        name: system.name,
        x: overrideById.get(system.id)?.x ?? Math.round(60 + ((system.x - minX) / xRange) * 880),
        y: overrideById.get(system.id)?.y ?? Math.round(50 + ((maxZ - system.z) / zRange) * 620),
        security: Number(system.security.toFixed(3)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    edges: [...edgeKeys]
      .map((key) => {
        const [from, to] = key.split("|");
        return { from, to };
      })
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
  };
});

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${output.length} region layouts to ${outputPath}`);
