import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import "./styles.css";

type Settings = {
  current_system: string;
  watched_paths: string[];
  watched_logs: WatchedLog[];
  jump_radius: number;
  sound_enabled: boolean;
  sound_volume: number;
  intel_expiry_minutes: number;
  compact_mode: boolean;
  always_on_top: boolean;
};

type WatchedLog = {
  folder: string;
  channel: string;
};

type GraphNode = {
  id: number;
  name: string;
  distance: number;
  x: number;
  y: number;
  active_intel_count: number;
  hostile_count: number;
  ship_summary: string[];
  severity: "clear" | "watch" | "danger";
  latest_report?: IntelReport;
};

type GraphEdge = {
  from: string;
  to: string;
};

type RegionNode = {
  id: number;
  name: string;
  x: number;
  y: number;
  security: number;
  external: boolean;
  external_region?: string | null;
  active_intel_count: number;
  hostile_count: number;
  ship_summary: string[];
  severity: "clear" | "watch" | "danger";
  latest_report?: IntelReport;
  is_current: boolean;
};

type MapView = {
  center: string;
  radius: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  active_reports: IntelReport[];
  all_reports: IntelReport[];
};

type RegionView = {
  region_id: number;
  region_name: string;
  width: number;
  height: number;
  current_system: string;
  nodes: RegionNode[];
  edges: GraphEdge[];
};

type IntelReport = {
  id: string;
  system: string;
  raw_line: string;
  source: string;
  timestamp_ms: number;
  severity: "clear" | "watch" | "danger";
  ship_hint?: string;
  character_hint?: string;
  distance: number | null;
};

type WatchStatus = {
  watched_channels: number;
  matched_files: string[];
  active_reports: number;
  latest_report?: IntelReport;
  read_errors: string[];
};

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<div class="boot-screen">Loading EVE Intel Companion...</div>`;

let settings: Settings = {
  current_system: "BKG-Q2",
  watched_paths: [],
  watched_logs: [],
  jump_radius: 5,
  sound_enabled: true,
  sound_volume: 0.5,
  intel_expiry_minutes: 20,
  compact_mode: false,
  always_on_top: false,
};
let mapView: MapView | null = null;
let regionView: RegionView | null = null;
let watchStatus: WatchStatus = { watched_channels: 0, matched_files: [], active_reports: 0, read_errors: [] };
let allSystems: string[] = [];
let availableChannels: string[] = [];
let systemQuery = "";
let watchPathInput = "";
let selectedChannel = "";
let lastAlertId = "";
let settingsOpen = false;
let intelScrollTop = 0;
let viewMode: "nearby" | "region" = "nearby";

function svgIcon(paths: string, size: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const icons = {
  radar: svgIcon('<path d="M19.07 4.93A10 10 0 0 0 4.93 19.07"/><path d="M4.93 4.93A10 10 0 0 1 19.07 19.07"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.22 4.22 2.83 2.83"/><path d="m16.95 16.95 2.83 2.83"/>', 20),
  folder: svgIcon('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M2 10h20"/>', 18),
  bell: svgIcon('<path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/>', 18),
  bellOff: svgIcon('<path d="m2 2 20 20"/><path d="M8.56 2.78A6 6 0 0 1 18 8c0 1.87.27 3.29.66 4.37"/><path d="M6.68 6.67C6.24 7.48 6 8.4 6 9c0 7-3 7-3 9h14"/><path d="M10.27 21a2 2 0 0 0 3.46 0"/>', 18),
  volume: svgIcon('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>', 18),
  refresh: svgIcon('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>', 18),
  search: svgIcon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', 16),
  compact: svgIcon('<path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M16 21h5v-5"/>', 16),
  expand: svgIcon('<path d="M3 8V3h5"/><path d="M21 8V3h-5"/><path d="M3 16v5h5"/><path d="M21 16v5h-5"/>', 16),
  pin: svgIcon('<path d="M12 17v5"/><path d="M5 17h14"/><path d="m7 10 5-7 5 7"/><path d="M8 10h8l-1 7H9z"/>', 16),
  tools: svgIcon('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.9 7.9l-6.6 6.6a2.1 2.1 0 0 1-3-3l6.6-6.6a6 6 0 0 1 7.9-7.9z"/>', 18),
};

function formatClock(timestampMs: number) {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function cleanIntelLine(rawLine: string) {
  return rawLine.replace(/^\s*\[\s*\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}:\d{2}\s*\]\s*/, "");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function externalLink(label: string, href: string, className = "intel-link") {
  return `<a class="${className}" href="${href}" data-external-url="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function zkillUrl(characterName: string) {
  return `https://zkillboard.com/search/${encodeURIComponent(characterName)}/`;
}

function dotlanUrl(systemName: string) {
  return `https://evemaps.dotlan.net/system/${encodeURIComponent(systemName)}`;
}

const shipWords = new Set([
  "astero",
  "asteros",
  "buzzard",
  "buzzards",
  "caracal",
  "caracals",
  "cerberus",
  "cerbs",
  "draugur",
  "draugurs",
  "griffin",
  "griffins",
  "hecate",
  "hecates",
  "hulk",
  "hulks",
  "kikimora",
  "kikis",
  "legion",
  "legions",
  "loki",
  "lokis",
  "proteus",
  "redeemer",
  "sabre",
  "sabres",
  "saber",
  "sabers",
  "tengu",
  "tengus",
  "vargur",
  "vargurs",
  "vedmak",
  "vedmaks",
]);

const pilotBreakWords = new Set([
  "at",
  "clear",
  "clr",
  "cruiser",
  "destroyer",
  "dictor",
  "fleet",
  "frigate",
  "gang",
  "gate",
  "gates",
  "hostile",
  "hostiles",
  "in",
  "neut",
  "neuts",
  "neutral",
  "neutrals",
  "on",
  "red",
  "reds",
  "ship",
  "ships",
  "tackle",
  "tackled",
  "wh",
]);

function normalizeWord(word: string) {
  return word.toLowerCase().replace(/[^a-z0-9+]/g, "");
}

function isCountWord(word: string) {
  const normalized = normalizeWord(word);
  const count = normalized.startsWith("+") ? normalized.slice(1) : normalized.endsWith("+") ? normalized.slice(0, -1) : "";
  return Boolean(count) && /^\d+$/.test(count);
}

function isNameLikeWord(word: string) {
  return /^[A-Z][A-Za-z0-9'-]*$/.test(word.replace(/[>*]/g, ""));
}

function likelyPilotPhrase(text: string) {
  const cleaned = text.replace(/[>*]/g, " ").trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/).filter(Boolean);
  const picked: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const normalized = normalizeWord(word);
    const next = words[index + 1];
    const canBeNamePart =
      shipWords.has(normalized) && isNameLikeWord(word) && ((picked.length === 0 && next && isNameLikeWord(next)) || picked.length > 0);
    if (!normalized || isCountWord(word) || pilotBreakWords.has(normalized) || (shipWords.has(normalized) && !canBeNamePart)) break;
    picked.push(word);
    if (picked.length === 2) break;
  }
  return picked.join(" ");
}

function linkifyPilotPhrase(text: string, pilotName: string) {
  if (!pilotName) return escapeHtml(text);
  const pattern = new RegExp(`\\b${escapeRegex(pilotName)}\\b`);
  const match = text.match(pattern);
  if (!match || match.index === undefined) return escapeHtml(text);
  return [
    escapeHtml(text.slice(0, match.index)),
    externalLink(match[0], zkillUrl(match[0])),
    escapeHtml(text.slice(match.index + match[0].length)),
  ].join("");
}

function renderIntelLine(report: IntelReport) {
  const cleaned = cleanIntelLine(report.raw_line);
  const [speaker, ...bodyParts] = cleaned.split(" > ");
  if (!bodyParts.length) return escapeHtml(cleaned);

  const body = bodyParts.join(" > ");
  const systemPattern = new RegExp(`\\b${escapeRegex(report.system)}\\b`, "i");
  const match = body.match(systemPattern);
  const speakerLink = externalLink(speaker.trim(), zkillUrl(speaker.trim()));
  if (!match || match.index === undefined) {
    return `${speakerLink} &gt; ${escapeHtml(body)}`;
  }

  const beforeSystem = body.slice(0, match.index);
  const systemText = body.slice(match.index, match.index + match[0].length);
  const afterSystem = body.slice(match.index + match[0].length);
  const beforePilot = likelyPilotPhrase(beforeSystem);
  const afterPilot = likelyPilotPhrase(afterSystem);
  return [
    speakerLink,
    " &gt; ",
    linkifyPilotPhrase(beforeSystem, beforePilot),
    externalLink(systemText, dotlanUrl(report.system)),
    linkifyPilotPhrase(afterSystem, afterPilot),
  ].join("");
}

function playAlert() {
  if (!settings.sound_enabled) return;
  const audioContext = new AudioContext();
  const gain = audioContext.createGain();
  gain.gain.value = settings.sound_volume;
  gain.connect(audioContext.destination);
  const osc = audioContext.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 720;
  osc.connect(gain);
  osc.start();
  osc.stop(audioContext.currentTime + 0.18);
}

function severityLabel(report?: IntelReport) {
  if (!report) return "Clear";
  return report.severity === "danger" ? "Reported" : report.severity === "watch" ? "Watch" : "Clear";
}

function isInRange(report: IntelReport) {
  return report.distance !== null && report.distance !== undefined;
}

function distanceLabel(report: IntelReport) {
  return isInRange(report) ? `${report.distance}j` : `>${settings.jump_radius}j`;
}

function render() {
  intelScrollTop = document.querySelector<HTMLDivElement>(".intel-list")?.scrollTop ?? intelScrollTop;
  const activeReports = mapView?.active_reports ?? [];
  const allReports = mapView?.all_reports ?? activeReports;
  const nearbyReports = activeReports.filter(isInRange);
  const regionSystems = new Set(regionView?.nodes.map((node) => node.name) ?? []);
  const regionReports = activeReports.filter((report) => regionSystems.has(report.system));
  const filteredSystems = allSystems
    .filter((name) => name.toLowerCase().includes(systemQuery.toLowerCase()))
    .slice(0, 10);
  const maxDistance = Math.max(1, settings.jump_radius);

  if (settings.compact_mode) {
    app.innerHTML = `
      <section class="compact-shell">
        <header class="compact-brand" title="Double-click to expand">
          <span class="brand-icon" data-tauri-drag-region>${icons.radar}</span>
          <h1>EVETel</h1>
          <button id="always-on-top" class="compact-pin ${settings.always_on_top ? "active" : ""}" title="${settings.always_on_top ? "Disable always on top" : "Always on top"}" aria-label="${settings.always_on_top ? "Disable always on top" : "Always on top"}" aria-pressed="${settings.always_on_top}">${icons.pin}</button>
          <button id="full-view" class="compact-exit" title="Full view" aria-label="Full view">${icons.expand}</button>
        </header>
        <div class="compact-map">
          ${viewMode === "region" ? renderRegionGraph() : renderGraph(maxDistance)}
        </div>
      </section>
    `;
    bindEvents();
    return;
  }

  app.innerHTML = `
    <section class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-icon" data-tauri-drag-region>${icons.radar}</span>
          <div>
            <h1>EVETel</h1>
          </div>
        </div>
        <div class="sidebar-summary">
          <div>
            <span>System</span>
            <strong>${settings.current_system}</strong>
          </div>
          <div>
            <span>Range</span>
            <strong>${settings.jump_radius} jumps</strong>
          </div>
          <div>
            <span>Logs</span>
            <strong>${watchStatus.matched_files.length}</strong>
          </div>
          <div>
            <span>Parsed</span>
            <strong>${watchStatus.active_reports}</strong>
          </div>
        </div>
        <button id="open-tools" class="settings-button tools-button ${viewMode === "region" ? "active" : ""}" type="button" title="Toggle region view">${icons.tools}<span>${viewMode === "region" ? "Nearby" : "Region"}</span></button>
        <button id="open-settings" class="settings-button">${icons.radar}<span>Settings</span></button>
      </aside>

      <section class="map-area">
        <div class="topbar">
          <div>
            <h2>${viewMode === "region" ? regionView?.region_name ?? "Region" : settings.current_system}</h2>
            <p>${
              viewMode === "region"
                ? `${regionReports.length} active reports in ${regionView?.region_name ?? "region"}`
                : `${nearbyReports.length} active reports inside ${settings.jump_radius} jumps`
            }</p>
          </div>
          <div class="topbar-actions">
            <div class="status-pill">${mapView ? "Live" : "Loading"}</div>
            <div class="window-controls">
              <button id="compact-view" class="window-control" title="Compact view" aria-label="Compact view">${icons.compact}</button>
            </div>
          </div>
        </div>
        <div class="map-wrap">
          ${viewMode === "region" ? renderRegionGraph() : renderGraph(maxDistance)}
        </div>
      </section>

      <aside class="intel-panel">
        <div class="panel-heading">Intel</div>
        <div class="intel-list">
          ${
            allReports.length
              ? allReports
                  .map(
                    (report) => `
                      <article class="intel-card ${report.severity} ${isInRange(report) ? "" : "out-of-range"}">
                        <div class="intel-row">
                          <strong>${report.system}</strong>
                          <span>${distanceLabel(report)} &middot; ${formatClock(report.timestamp_ms)}</span>
                        </div>
                        <p>${renderIntelLine(report)}</p>
                      </article>
                    `,
                  )
                  .join("")
              : `<div class="empty">No intel reports.${watchStatus.latest_report ? `<br><br>Latest parsed: ${watchStatus.latest_report.system} &middot; ${formatClock(watchStatus.latest_report.timestamp_ms)}` : ""}</div>`
          }
        </div>
      </aside>
      ${settingsOpen ? renderSettingsOverlay(filteredSystems) : ""}
    </section>
  `;

  bindEvents();
  const intelList = document.querySelector<HTMLDivElement>(".intel-list");
  if (intelList) {
    const maxScrollTop = Math.max(0, intelList.scrollHeight - intelList.clientHeight);
    intelList.scrollTop = Math.min(intelScrollTop, maxScrollTop);
    intelList.addEventListener("scroll", () => {
      intelScrollTop = intelList.scrollTop;
    });
  }
}

function renderSettingsOverlay(filteredSystems: string[]) {
  return `
    <div class="settings-backdrop" data-close-settings="true">
      <section class="settings-menu" role="dialog" aria-modal="true" aria-label="Settings">
        <header class="settings-header">
          <div>
            <h3>Settings</h3>
            <p>Position, chat logs, and alerts</p>
          </div>
          <button id="close-settings" title="Close">x</button>
        </header>
        <section class="panel">
          <div class="panel-heading">Position</div>
          <label class="field">
            <span>Current system</span>
            <div class="search-field">
              ${icons.search}
              <input id="system-search" value="${systemQuery}" placeholder="${settings.current_system}" autocomplete="off" />
            </div>
          </label>
          <div class="system-list">
            ${filteredSystems
              .map(
                (system) => `
                  <button class="system-option ${system === settings.current_system ? "selected" : ""}" data-system="${system}">
                    ${system}
                  </button>
                `,
              )
              .join("")}
          </div>
          <label class="field compact">
            <span>Jump radius</span>
            <input id="radius" type="number" min="1" max="12" value="${settings.jump_radius}" />
          </label>
          <label class="field compact">
            <span>Intel expiry minutes</span>
            <input id="expiry" type="number" min="1" max="180" value="${settings.intel_expiry_minutes}" />
          </label>
        </section>

        <section class="panel">
          <div class="panel-heading">Chat Logs</div>
          <label class="field">
            <span>Chat log folder</span>
            <input id="watch-path" value="${watchPathInput}" placeholder="C:\\Users\\...\\EVE\\logs\\Chatlogs" />
          </label>
          <button id="browse-path" class="command">${icons.folder}<span>Browse chat log folder</span></button>
          <label class="field">
            <span>Intel channel</span>
            <select id="channel-select" ${availableChannels.length ? "" : "disabled"}>
              <option value="">${availableChannels.length ? "Select a channel" : "Choose a folder first"}</option>
              ${availableChannels
                .map(
                  (channel) => `
                    <option value="${channel}" ${channel === selectedChannel ? "selected" : ""}>${channel}</option>
                  `,
                )
                .join("")}
            </select>
          </label>
          <button id="add-channel" class="command primary-command">${icons.folder}<span>Watch selected channel</span></button>
          <div class="watch-list">
            ${
              watchStatus.read_errors.length
                ? `<div class="watch-note warning">${watchStatus.read_errors.map((error) => `<div>${error}</div>`).join("")}</div>`
                : ""
            }
            ${
              watchStatus.matched_files.length
                ? `<div class="watch-note">Matched ${watchStatus.matched_files.length} log file${watchStatus.matched_files.length === 1 ? "" : "s"} for selected channels.</div>`
                : `<div class="watch-note warning">No log files currently match the selected channel.</div>`
            }
            ${(settings.watched_logs.length
              ? settings.watched_logs
              : settings.watched_paths.map((path) => ({ folder: path, channel: "" }))
            )
              .map(
                (watch) => `
                  <div class="watch-item">
                    <span title="${watch.folder}">${watch.channel || "All channels"} · ${watch.folder}</span>
                    <button data-remove-watch-folder="${watch.folder}" data-remove-watch-channel="${watch.channel}" title="Remove">x</button>
                  </div>
                `,
              )
              .join("")}
          </div>
        </section>

        <section class="panel">
          <div class="panel-heading">Alerts</div>
          <button id="toggle-sound" class="command">
            ${settings.sound_enabled ? icons.bell : icons.bellOff}
            <span>${settings.sound_enabled ? "Sound enabled" : "Sound muted"}</span>
          </button>
          <label class="field compact">
            <span>${icons.volume} Volume</span>
            <input id="volume" type="range" min="0" max="1" step="0.05" value="${settings.sound_volume}" />
          </label>
          <button id="poll-now" class="command subtle">${icons.refresh}<span>Refresh logs</span></button>
        </section>
      </section>
    </div>
  `;
}

function systemSuggestionsHtml() {
  return allSystems
    .filter((name) => name.toLowerCase().includes(systemQuery.toLowerCase()))
    .slice(0, 10)
    .map(
      (system) => `
        <button class="system-option ${system === settings.current_system ? "selected" : ""}" data-system="${system}">
          ${system}
        </button>
      `,
    )
    .join("");
}

function bindSystemOptions() {
  document.querySelectorAll<HTMLButtonElement>("[data-system]").forEach((button) => {
    button.addEventListener("click", async () => {
      settings.current_system = button.dataset.system!;
      systemQuery = "";
      settingsOpen = false;
      await saveSettings();
      await refresh();
    });
  });
}

function renderGraph(maxDistance: number) {
  if (!mapView) return `<div class="empty map-empty">Loading map data...</div>`;
  const width = 360;
  const height = 320;
  const nodes = mapView.nodes;
  const edges = mapView.edges;
  return `
    <svg class="node-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="Nearby system node map">
      <g class="range-rows">
        ${Array.from({ length: maxDistance + 1 }, (_, distance) => {
          const y = 286 - distance * Math.min((286 - 34) / maxDistance, 50);
          return `
            <line x1="8" y1="${y}" x2="${width - 8}" y2="${y}" />
            <text x="10" y="${y - 7}">${distance}j</text>
          `;
        }).join("")}
      </g>
      <g class="edges">
        ${edges
          .map((edge) => {
            const from = nodes.find((node) => node.name === edge.from);
            const to = nodes.find((node) => node.name === edge.to);
            if (!from || !to) return "";
            return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" />`;
          })
          .join("")}
      </g>
      <g class="nodes">
        ${nodes
          .map((node) => {
            const dangerClass = node.severity === "danger" ? "danger" : node.severity === "watch" ? "watch" : "";
            const centerClass = node.name === settings.current_system ? "center" : "";
            const ships = node.ship_summary.length ? node.ship_summary.join(", ") : "Unknown";
            const tooltip = `${node.name} · ${node.distance}j · ${severityLabel(node.latest_report)}\nNumbers: ${node.hostile_count || 0}\nShips: ${ships}`;
            return `
              <g class="map-node ${dangerClass} ${centerClass}" transform="translate(${node.x}, ${node.y})">
                <title>${escapeHtml(tooltip)}</title>
                <circle r="${node.name === settings.current_system ? 13 : 8}" />
                ${node.hostile_count ? `<text class="count" y="-17">${node.hostile_count}</text>` : ""}
              </g>
            `;
          })
          .join("")}
      </g>
    </svg>
  `;
}

function renderRegionGraph() {
  if (!regionView) return `<div class="empty map-empty">Loading region data...</div>`;
  const nodes = regionView.nodes;
  return `
    <svg class="region-map" viewBox="0 0 ${regionView.width} ${regionView.height}" role="img" aria-label="${escapeHtml(regionView.region_name)} region map">
      <g class="region-edges">
        ${regionView.edges
          .map((edge) => {
            const from = nodes.find((node) => node.name === edge.from);
            const to = nodes.find((node) => node.name === edge.to);
            if (!from || !to) return "";
            const activeClass = from.hostile_count || to.hostile_count ? " active" : "";
            return `<line class="${activeClass}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" />`;
          })
          .join("")}
      </g>
      <g class="region-nodes">
        ${nodes
          .map((node) => {
            const dangerClass = node.severity === "danger" ? "danger" : node.severity === "watch" ? "watch" : "";
            const currentClass = node.is_current ? "current" : "";
            const externalClass = node.external ? "external" : "";
            const ships = node.ship_summary.length ? node.ship_summary.join(", ") : "Unknown";
            const regionLabel = node.external_region ?? "External";
            const tooltip = node.external
              ? `${node.name} · ${regionLabel} · ${severityLabel(node.latest_report)}\nNumbers: ${node.hostile_count || 0}\nShips: ${ships}`
              : `${node.name} · ${node.security.toFixed(1)} · ${severityLabel(node.latest_report)}\nNumbers: ${node.hostile_count || 0}\nShips: ${ships}`;
            return `
              <g class="region-node ${dangerClass} ${currentClass} ${externalClass}" transform="translate(${node.x}, ${node.y})">
                <title>${escapeHtml(tooltip)}</title>
                <rect x="${node.external ? -25 : -30}" y="-15" width="${node.external ? 50 : 60}" height="30" rx="${node.external ? 1 : 12}" />
                <text class="system" y="-2">${node.name}</text>
                <text class="security" y="10">${node.external ? escapeHtml(regionLabel) : node.security.toFixed(1)}</text>
                ${node.hostile_count ? `<text class="count" x="33" y="-16">${node.hostile_count}</text>` : ""}
              </g>
            `;
          })
          .join("")}
      </g>
    </svg>
  `;
}

function bindEvents() {
  const currentWindow = getCurrentWindow();
  document.querySelector<HTMLElement>(".brand-icon")?.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    currentWindow.startDragging().catch((error) => {
      console.error("Failed to start window drag", error);
    });
  });
  document.querySelector<HTMLElement>(".compact-brand")?.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    currentWindow.startDragging().catch((error) => {
      console.error("Failed to start compact window drag", error);
    });
  });
  document.querySelector<HTMLButtonElement>("#compact-view")?.addEventListener("click", async () => {
    settings.compact_mode = true;
    settingsOpen = false;
    await saveSettings();
    render();
  });
  document.querySelector<HTMLElement>(".compact-brand")?.addEventListener("dblclick", async () => {
    settings.compact_mode = false;
    await saveSettings();
    render();
  });
  document.querySelector<HTMLButtonElement>("#full-view")?.addEventListener("click", async () => {
    settings.compact_mode = false;
    await saveSettings();
    render();
  });
  document.querySelector<HTMLButtonElement>("#always-on-top")?.addEventListener("click", async () => {
    settings.always_on_top = !settings.always_on_top;
    await currentWindow.setAlwaysOnTop(settings.always_on_top);
    await saveSettings();
    render();
  });
  document.querySelectorAll<HTMLAnchorElement>(".intel-link[data-external-url]").forEach((link) => {
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const url = link.dataset.externalUrl || link.href;
      try {
        await invoke("open_external_url", { url });
      } catch (error) {
        console.error("Failed to open external link", error);
      }
    });
  });
  document.querySelector<HTMLButtonElement>("#open-tools")?.addEventListener("click", () => {
    viewMode = viewMode === "nearby" ? "region" : "nearby";
    render();
  });
  document.querySelector<HTMLButtonElement>("#open-settings")?.addEventListener("click", () => {
    settingsOpen = true;
    render();
  });
  document.querySelector<HTMLButtonElement>("#close-settings")?.addEventListener("click", () => {
    settingsOpen = false;
    render();
  });
  document.querySelector<HTMLDivElement>(".settings-backdrop")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).dataset.closeSettings) {
      settingsOpen = false;
      render();
    }
  });
  document.querySelector<HTMLElement>(".settings-menu")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.querySelector<HTMLInputElement>("#system-search")?.addEventListener("input", (event) => {
    systemQuery = (event.target as HTMLInputElement).value;
    const list = document.querySelector<HTMLDivElement>(".system-list");
    if (list) {
      list.innerHTML = systemSuggestionsHtml();
      bindSystemOptions();
    }
  });
  bindSystemOptions();
  document.querySelector<HTMLInputElement>("#radius")?.addEventListener("change", async (event) => {
    settings.jump_radius = Number((event.target as HTMLInputElement).value);
    await saveSettings();
    await refresh();
  });
  document.querySelector<HTMLInputElement>("#expiry")?.addEventListener("change", async (event) => {
    settings.intel_expiry_minutes = Number((event.target as HTMLInputElement).value);
    await saveSettings();
    await refresh();
  });
  document.querySelector<HTMLInputElement>("#watch-path")?.addEventListener("input", (event) => {
    watchPathInput = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLButtonElement>("#browse-path")?.addEventListener("click", async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select EVE chat log folder",
    });
    const folder = typeof selected === "string" ? selected : watchPathInput.trim();
    if (!folder) return;
    watchPathInput = folder;
    availableChannels = await invokeWithTimeout<string[]>("scan_log_channels", { folder });
    selectedChannel = availableChannels[0] ?? "";
    render();
  });
  document.querySelector<HTMLSelectElement>("#channel-select")?.addEventListener("change", (event) => {
    selectedChannel = (event.target as HTMLSelectElement).value;
  });
  document.querySelector<HTMLButtonElement>("#add-channel")?.addEventListener("click", async () => {
    const folder = watchPathInput.trim();
    const channel = document.querySelector<HTMLSelectElement>("#channel-select")?.value || selectedChannel;
    if (!folder || !channel) return;
    const exists = settings.watched_logs.some(
      (watch) => watch.folder === folder && watch.channel === channel,
    );
    if (exists) return;
    selectedChannel = channel;
    settings.watched_logs = [...settings.watched_logs, { folder, channel }];
    settings.watched_paths = settings.watched_logs.map((watch) => watch.folder);
    await saveSettings();
    await invoke("rescan_watch_paths");
    await refresh();
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-remove-watch-folder]").forEach((button) => {
    button.addEventListener("click", async () => {
      const folder = button.dataset.removeWatchFolder!;
      const channel = button.dataset.removeWatchChannel ?? "";
      settings.watched_logs = settings.watched_logs.filter(
        (watch) => watch.folder !== folder || watch.channel !== channel,
      );
      settings.watched_paths = settings.watched_logs.map((watch) => watch.folder);
      await saveSettings();
      await refresh();
      render();
    });
  });
  document.querySelector<HTMLButtonElement>("#toggle-sound")?.addEventListener("click", async () => {
    settings.sound_enabled = !settings.sound_enabled;
    await saveSettings();
    render();
  });
  document.querySelector<HTMLInputElement>("#volume")?.addEventListener("change", async (event) => {
    settings.sound_volume = Number((event.target as HTMLInputElement).value);
    await saveSettings();
  });
  document.querySelector<HTMLButtonElement>("#poll-now")?.addEventListener("click", refresh);
}

async function saveSettings() {
  await invoke("save_settings", { settings });
}

function normalizeSettings(loaded: Settings): Settings {
  return {
    ...loaded,
    watched_paths: loaded.watched_paths ?? [],
    watched_logs:
      loaded.watched_logs ??
      (loaded.watched_paths ?? []).map((path) => ({
        folder: path,
        channel: "",
      })),
    compact_mode: loaded.compact_mode ?? false,
    always_on_top: loaded.always_on_top ?? false,
  };
}

async function invokeWithTimeout<T>(command: string, args?: Record<string, unknown>, timeoutMs = 3000): Promise<T> {
  return await Promise.race([
    invoke<T>(command, args),
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${command}`)), timeoutMs);
    }),
  ]);
}

async function refresh() {
  await invokeWithTimeout("poll_logs");
  watchStatus = await invokeWithTimeout<WatchStatus>("get_watch_status");
  mapView = await invokeWithTimeout<MapView>("get_map_view", {
    currentSystem: settings.current_system,
    radius: settings.jump_radius,
  });
  regionView = await invokeWithTimeout<RegionView>("get_region_view", {
    currentSystem: settings.current_system,
  });
  const latest = mapView.active_reports.find((report) => isInRange(report));
  if (latest && latest.id !== lastAlertId && latest.severity === "danger") {
    lastAlertId = latest.id;
    playAlert();
  }
  if (!settingsOpen) {
    render();
  }
}

async function boot() {
  try {
    settings = normalizeSettings(await invokeWithTimeout<Settings>("load_settings"));
    await getCurrentWindow().setAlwaysOnTop(settings.always_on_top);
    allSystems = await invokeWithTimeout<string[]>("list_systems");
    await refresh();
    setInterval(refresh, 1000);
  } catch (error) {
    app.innerHTML = `<pre class="fatal">Startup failed:\n${String(error)}</pre>`;
  }
}

boot();
