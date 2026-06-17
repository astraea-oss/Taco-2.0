use anyhow::{Context, Result};
use chrono::{NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const UNIVERSE_JSON: &str = include_str!("../resources/universe.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolarSystem {
    id: u32,
    name: String,
    neighbors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    current_system: String,
    #[serde(default)]
    watched_paths: Vec<String>,
    #[serde(default)]
    watched_logs: Vec<WatchedLog>,
    jump_radius: u8,
    sound_enabled: bool,
    sound_volume: f32,
    intel_expiry_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchedLog {
    folder: String,
    channel: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            current_system: "BKG-Q2".to_string(),
            watched_paths: Vec::new(),
            watched_logs: Vec::new(),
            jump_radius: 5,
            sound_enabled: true,
            sound_volume: 0.5,
            intel_expiry_minutes: 20,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IntelSeverity {
    Clear,
    Watch,
    Danger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntelReport {
    id: String,
    system: String,
    raw_line: String,
    source: String,
    timestamp_ms: u128,
    severity: IntelSeverity,
    ship_hint: Option<String>,
    character_hint: Option<String>,
    distance: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    id: u32,
    name: String,
    distance: u8,
    x: f32,
    y: f32,
    active_intel_count: usize,
    severity: IntelSeverity,
    latest_report: Option<IntelReport>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    from: String,
    to: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MapView {
    center: String,
    radius: u8,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    active_reports: Vec<IntelReport>,
    all_reports: Vec<IntelReport>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WatchStatus {
    watched_channels: usize,
    matched_files: Vec<String>,
    active_reports: usize,
    latest_report: Option<IntelReport>,
    read_errors: Vec<String>,
}

pub struct AppState {
    universe: Universe,
    settings: Mutex<Settings>,
    reports: Mutex<Vec<IntelReport>>,
    file_states: Mutex<HashMap<String, FilePollState>>,
    last_errors: Mutex<Vec<String>>,
}

#[derive(Debug, Default)]
struct FilePollState {
    byte_offset: u64,
    pending_line: String,
    utf16_le: bool,
    initialized: bool,
    last_system_by_speaker: HashMap<String, String>,
}

#[derive(Debug)]
pub struct Universe {
    systems: HashMap<String, SolarSystem>,
    names: Vec<String>,
}

impl Universe {
    fn load() -> Result<Self> {
        let systems_vec: Vec<SolarSystem> = serde_json::from_str(UNIVERSE_JSON)?;
        let mut systems = HashMap::new();
        let mut names = Vec::new();
        for system in systems_vec {
            names.push(system.name.clone());
            systems.insert(system.name.to_lowercase(), system);
        }
        names.sort();
        Ok(Self { systems, names })
    }

    fn get(&self, name: &str) -> Option<&SolarSystem> {
        self.systems.get(&name.to_lowercase())
    }

    fn canonical_name(&self, text: &str) -> Option<String> {
        self.get(text).map(|system| system.name.clone())
    }

    fn find_systems_in_line(&self, line: &str) -> Vec<String> {
        let lower = line.to_lowercase();
        let mut matches = self
            .names
            .iter()
            .filter(|name| contains_system_token(&lower, &name.to_lowercase()))
            .cloned()
            .collect::<Vec<_>>();
        matches.sort();
        matches.dedup();
        matches
    }

    fn distance_tree_from(
        &self,
        start: &str,
        radius: u8,
    ) -> (HashMap<String, u8>, HashMap<String, String>) {
        let Some(start) = self.canonical_name(start) else {
            return (HashMap::new(), HashMap::new());
        };
        let mut distances = HashMap::from([(start.clone(), 0)]);
        let mut parents = HashMap::new();
        let mut queue = VecDeque::from([start]);
        while let Some(name) = queue.pop_front() {
            let distance = distances[&name];
            if distance >= radius {
                continue;
            }
            if let Some(system) = self.get(&name) {
                let mut neighbors = system.neighbors.clone();
                neighbors.sort();
                for neighbor in neighbors {
                    if !distances.contains_key(&neighbor) {
                        distances.insert(neighbor.clone(), distance + 1);
                        parents.insert(neighbor.clone(), name.clone());
                        queue.push_back(neighbor.clone());
                    }
                }
            }
        }
        (distances, parents)
    }
}

fn is_system_token_char(char: char) -> bool {
    char.is_ascii_alphanumeric() || char == '-'
}

fn contains_system_token(haystack: &str, needle: &str) -> bool {
    let mut search_start = 0;
    while let Some(offset) = haystack[search_start..].find(needle) {
        let start = search_start + offset;
        let end = start + needle.len();
        let before = haystack[..start].chars().next_back();
        let after = haystack[end..].chars().next();
        let bounded_before = before.map(|char| !is_system_token_char(char)).unwrap_or(true);
        let bounded_after = after.map(|char| !is_system_token_char(char)).unwrap_or(true);
        if bounded_before && bounded_after {
            return true;
        }
        search_start = end;
    }
    false
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn eve_log_timestamp_ms(line: &str) -> Option<u128> {
    let trimmed = line.trim_start_matches('\u{feff}').trim_start();
    let timestamp = trimmed.strip_prefix('[')?.split(']').next()?.trim();
    let parsed = NaiveDateTime::parse_from_str(timestamp, "%Y.%m.%d %H:%M:%S").ok()?;
    Some(Utc.from_utc_datetime(&parsed).timestamp_millis() as u128)
}

fn portable_data_dir() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    Some(exe_dir.join("EVE Intel Companion Data"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = match portable_data_dir() {
        Some(dir) => dir,
        None => app.path().app_config_dir()?,
    };
    fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

fn load_settings_from_disk(app: &AppHandle) -> Settings {
    let mut settings: Settings = settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    if settings.watched_logs.is_empty() && !settings.watched_paths.is_empty() {
        settings.watched_logs = settings
            .watched_paths
            .iter()
            .map(|path| WatchedLog {
                folder: path.clone(),
                channel: String::new(),
            })
            .collect();
    }
    settings
}

fn save_settings_to_disk(app: &AppHandle, settings: &Settings) -> Result<()> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings)?;
    fs::write(path, json)?;
    Ok(())
}

fn is_clear_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    [" clear", "clr", "blue only", "empty", "safe"]
        .iter()
        .any(|term| lower.contains(term))
}

fn is_status_query_line(line: &str) -> bool {
    line.to_lowercase().contains("status?")
}

fn is_intel_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    [
        " neut",
        " neuts",
        " neutral",
        " neutrals",
        " red",
        " reds",
        " hostile",
        " hostiles",
        " spike",
        " status?",
        " gate",
        " camp",
        " cyno",
        " tackled",
        " dictor",
        " sabre",
        " loki",
        " tengu",
        " legion",
        " proteus",
        " redeemer",
        " bomber",
        " fleet",
        " gang",
        " draugur",
        " vargur",
        " marauder",
    ]
    .iter()
    .any(|term| lower.contains(term))
        || lower.contains(" +")
}

fn message_body(line: &str) -> &str {
    line.split_once(" > ")
        .map(|(_, body)| body)
        .unwrap_or(line)
        .trim()
}

fn chat_speaker(line: &str) -> Option<String> {
    let (prefix, _) = line.split_once(" > ")?;
    let after_timestamp = prefix
        .rsplit_once(" ] ")
        .map(|(_, speaker)| speaker)
        .unwrap_or(prefix)
        .trim();
    if after_timestamp.is_empty() {
        None
    } else {
        Some(after_timestamp.to_string())
    }
}

fn looks_like_system_report(line: &str, systems: &[String]) -> bool {
    let body = message_body(line);
    if body.is_empty() {
        return false;
    }
    let body_lower = body.to_lowercase();
    systems.iter().any(|system| {
        let system_lower = system.to_lowercase();
        if !body_lower.contains(&system_lower) {
            return false;
        }
        let remaining = body_lower.replace(&system_lower, "");
        remaining.chars().any(|char| char.is_alphabetic())
            || remaining.contains('+')
            || remaining.split_whitespace().any(|part| part.parse::<u32>().is_ok())
    })
}

fn ship_hint(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    let ships = [
        "sabre", "loki", "tengu", "legion", "proteus", "redeemer", "bombers", "bomber", "vargur",
        "marauder", "dictor", "draugur", "kikimora", "caracal", "cerberus",
    ];
    ships
        .iter()
        .find(|ship| lower.contains(**ship))
        .map(|ship| ship.to_ascii_uppercase())
}

fn parse_intel_line(
    universe: &Universe,
    line: &str,
    source: &str,
    timestamp_ms: u128,
    fallback_system: Option<&str>,
) -> Vec<IntelReport> {
    let clear = is_clear_line(line);
    let body = message_body(line);
    let mut systems = universe.find_systems_in_line(body);
    if systems.is_empty() {
        if let Some(system) = fallback_system.and_then(|system| universe.canonical_name(system)) {
            systems.push(system);
        } else {
            return Vec::new();
        }
    }
    if !clear && !is_intel_line(line) && !looks_like_system_report(line, &systems) {
        return Vec::new();
    }
    systems
        .into_iter()
        .map(|system| IntelReport {
            id: Uuid::new_v4().to_string(),
            system,
            raw_line: line.trim().to_string(),
            source: source.to_string(),
            timestamp_ms,
            severity: if clear {
                IntelSeverity::Clear
            } else if is_status_query_line(line) {
                IntelSeverity::Watch
            } else {
                IntelSeverity::Danger
            },
            ship_hint: ship_hint(line),
            character_hint: None,
            distance: None,
        })
        .collect()
}

fn channel_from_log_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy();
    let parts = stem.rsplitn(4, '_').collect::<Vec<_>>();
    if parts.len() < 4 {
        return None;
    }
    let session = parts[0];
    let time = parts[1];
    let date = parts[2];
    let channel = parts[3];
    if date.len() == 8
        && time.len() == 6
        && !session.is_empty()
        && date.chars().all(|char| char.is_ascii_digit())
        && time.chars().all(|char| char.is_ascii_digit())
    {
        Some(channel.to_string())
    } else {
        None
    }
}

fn looks_utf16_le(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xff, 0xfe])
        || bytes
            .chunks_exact(2)
            .take(64)
            .filter(|chunk| chunk[1] == 0)
            .count()
            > 16
}

fn decode_utf16_le_bytes(bytes: &[u8]) -> String {
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
fn decode_chatlog_bytes(bytes: &[u8]) -> Result<String> {
    if looks_utf16_le(bytes) {
        let units = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        Ok(String::from_utf16_lossy(&units))
    } else {
        String::from_utf8(bytes.to_vec()).context("chat log is not valid UTF-8")
    }
}

fn decode_chatlog_chunk(bytes: &[u8], utf16_le: bool) -> Result<String> {
    if utf16_le {
        Ok(decode_utf16_le_bytes(bytes))
    } else {
        String::from_utf8(bytes.to_vec()).context("chat log chunk is not valid UTF-8")
    }
}

fn txt_files_in_folder(path: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let is_chatlog = entry_path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.eq_ignore_ascii_case("txt"))
                .unwrap_or(false);
            if is_chatlog {
                files.push(entry_path);
            }
        }
    }
    files
}

fn watched_files(settings: &Settings) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !settings.watched_logs.is_empty() {
        for watched in &settings.watched_logs {
            let path = PathBuf::from(&watched.folder);
            if path.is_file() {
                files.push(path);
            } else if path.is_dir() {
                for file in txt_files_in_folder(&path) {
                    if watched.channel.is_empty()
                        || channel_from_log_filename(&file).as_deref()
                            == Some(watched.channel.as_str())
                    {
                        files.push(file);
                    }
                }
            }
        }
    } else {
        for path in &settings.watched_paths {
            let path = PathBuf::from(path);
            if path.is_file() {
                files.push(path);
            } else if path.is_dir() {
                files.extend(txt_files_in_folder(&path));
            }
        }
    }
    files
}

fn parse_poll_text(
    text: &str,
    source: &str,
    scan_timestamp: u128,
    app_state: &AppState,
    file_state: &mut FilePollState,
) -> Vec<IntelReport> {
    let mut combined = String::new();
    combined.push_str(&file_state.pending_line);
    combined.push_str(text);
    let has_partial_tail = !combined.ends_with('\n') && !combined.ends_with('\r');
    let mut lines = combined
        .lines()
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    if has_partial_tail {
        file_state.pending_line = lines.pop().unwrap_or_default();
    } else {
        file_state.pending_line.clear();
    }

    let mut parsed = Vec::new();
    for line in lines {
        let timestamp = eve_log_timestamp_ms(&line).unwrap_or(scan_timestamp);
        let speaker = chat_speaker(&line);
        let fallback_system = speaker
            .as_ref()
            .and_then(|speaker| file_state.last_system_by_speaker.get(speaker))
            .map(String::as_str);
        let reports = parse_intel_line(
            &app_state.universe,
            &line,
            source,
            timestamp,
            fallback_system,
        );
        if let (Some(speaker), Some(report)) = (speaker, reports.first()) {
            file_state
                .last_system_by_speaker
                .insert(speaker, report.system.clone());
        }
        parsed.extend(reports);
    }
    parsed
}

fn poll_one_file(path: &Path, state: &AppState, _current_system: &str) -> Result<Vec<IntelReport>> {
    let key = path.to_string_lossy().to_string();
    let metadata = fs::metadata(path).with_context(|| format!("Failed to stat {}", key))?;
    let file_len = metadata.len();
    let mut file_states = state.file_states.lock().unwrap();
    let file_state = file_states.entry(key.clone()).or_default();
    if file_len < file_state.byte_offset {
        *file_state = FilePollState::default();
    }
    if file_state.initialized && file_len == file_state.byte_offset {
        return Ok(Vec::new());
    }

    let read_from = if file_state.initialized {
        file_state.byte_offset
    } else {
        0
    };
    let mut file = File::open(path).with_context(|| format!("Failed to open {}", key))?;
    file.seek(SeekFrom::Start(read_from))
        .with_context(|| format!("Failed to seek {}", key))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .with_context(|| format!("Failed to read {}", key))?;
    if bytes.is_empty() {
        file_state.initialized = true;
        file_state.byte_offset = file_len;
        return Ok(Vec::new());
    }
    if !file_state.initialized {
        file_state.utf16_le = looks_utf16_le(&bytes);
    }
    let text = decode_chatlog_chunk(&bytes, file_state.utf16_le)
        .with_context(|| format!("Failed to decode {}", key))?;
    let scan_timestamp = now_ms();
    let parsed = parse_poll_text(&text, &key, scan_timestamp, state, file_state);
    file_state.initialized = true;
    file_state.byte_offset = file_len;
    Ok(parsed)
}

fn prune_reports(reports: &mut Vec<IntelReport>, expiry_minutes: u32) {
    let cutoff = now_ms().saturating_sub(expiry_minutes as u128 * 60_000);
    reports.retain(|report| report.timestamp_ms >= cutoff);
}

#[tauri::command]
fn load_settings(app: AppHandle, state: State<'_, AppState>) -> Result<Settings, String> {
    let settings = load_settings_from_disk(&app);
    *state.settings.lock().unwrap() = settings.clone();
    Ok(settings)
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    settings: Settings,
    state: State<'_, AppState>,
) -> Result<(), String> {
    save_settings_to_disk(&app, &settings).map_err(|error| error.to_string())?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
fn list_systems(state: State<'_, AppState>) -> Vec<String> {
    state.universe.names.clone()
}

#[tauri::command]
fn get_watch_status(state: State<'_, AppState>) -> WatchStatus {
    let settings = state.settings.lock().unwrap().clone();
    let mut matched_files = watched_files(&settings)
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    matched_files.sort();
    let reports = state.reports.lock().unwrap();
    WatchStatus {
        watched_channels: settings.watched_logs.len(),
        matched_files,
        active_reports: reports.len(),
        latest_report: reports
            .iter()
            .max_by_key(|report| report.timestamp_ms)
            .cloned(),
        read_errors: state.last_errors.lock().unwrap().clone(),
    }
}

#[tauri::command]
fn scan_log_channels(folder: String) -> Vec<String> {
    let mut channels = txt_files_in_folder(&PathBuf::from(folder))
        .into_iter()
        .filter_map(|path| channel_from_log_filename(&path))
        .collect::<Vec<_>>();
    channels.sort();
    channels.dedup();
    channels
}

#[tauri::command]
fn rescan_watch_paths(state: State<'_, AppState>) {
    state.reports.lock().unwrap().clear();
    state.file_states.lock().unwrap().clear();
}

#[tauri::command]
fn poll_logs(state: State<'_, AppState>) -> Result<Vec<IntelReport>, String> {
    let settings = state.settings.lock().unwrap().clone();
    let mut new_reports = Vec::new();
    let mut errors = Vec::new();
    for file in watched_files(&settings) {
        match poll_one_file(&file, &state, &settings.current_system) {
            Ok(mut reports) => new_reports.append(&mut reports),
            Err(error) => errors.push(format!("{}: {error}", file.display())),
        }
    }
    *state.last_errors.lock().unwrap() = errors;
    let mut reports = state.reports.lock().unwrap();
    reports.extend(new_reports.clone());
    prune_reports(&mut reports, settings.intel_expiry_minutes);
    Ok(new_reports)
}

fn build_map_view(
    universe: &Universe,
    current_system: String,
    radius: u8,
    reports: Vec<IntelReport>,
) -> MapView {
    let radius = radius.clamp(1, 12);
    let (distances, parents) = universe.distance_tree_from(&current_system, radius);
    let mut all_reports = reports
        .into_iter()
        .map(|mut report| {
            let distance = distances.get(&report.system).copied();
            report.distance = distance;
            report
        })
        .collect::<Vec<_>>();
    all_reports.sort_by_key(|report| std::cmp::Reverse(report.timestamp_ms));

    let mut latest_clear_by_system: HashMap<String, u128> = HashMap::new();
    for report in &all_reports {
        if report.severity == IntelSeverity::Clear {
            latest_clear_by_system
                .entry(report.system.clone())
                .and_modify(|timestamp| *timestamp = (*timestamp).max(report.timestamp_ms))
                .or_insert(report.timestamp_ms);
        }
    }

    let mut active_reports = all_reports
        .iter()
        .filter(|report| {
            if report.severity == IntelSeverity::Clear {
                return false;
            }
            let latest_clear = latest_clear_by_system
                .get(&report.system)
                .copied()
                .unwrap_or_default();
            report.timestamp_ms > latest_clear
        })
        .cloned()
        .collect::<Vec<_>>();
    active_reports.sort_by_key(|report| {
        (
            report.distance.is_none(),
            report.distance.unwrap_or(u8::MAX),
            std::cmp::Reverse(report.timestamp_ms),
        )
    });

    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for (child, parent) in &parents {
        children
            .entry(parent.clone())
            .or_default()
            .push(child.clone());
    }
    for child_list in children.values_mut() {
        child_list.sort();
    }

    let mut rows: HashMap<u8, Vec<String>> = HashMap::new();
    fn collect_branch_rows(
        name: &str,
        distances: &HashMap<String, u8>,
        children: &HashMap<String, Vec<String>>,
        rows: &mut HashMap<u8, Vec<String>>,
    ) {
        if let Some(distance) = distances.get(name) {
            rows.entry(*distance).or_default().push(name.to_string());
        }
        if let Some(child_list) = children.get(name) {
            for child in child_list {
                collect_branch_rows(child, distances, children, rows);
            }
        }
    }
    if let Some(center) = universe.canonical_name(&current_system) {
        collect_branch_rows(&center, &distances, &children, &mut rows);
    }

    let mut nodes = Vec::new();
    let viewport_width = 360.0;
    let top_padding = 34.0;
    let bottom_y = 286.0;
    let row_gap = if radius == 0 {
        0.0
    } else {
        ((bottom_y - top_padding) / radius as f32).min(50.0)
    };
    for distance in 0..=radius {
        let Some(row) = rows.get(&distance) else {
            continue;
        };
        let y = bottom_y - (distance as f32 * row_gap);
        let count = row.len().max(1);
        let horizontal_gap = (viewport_width - 42.0) / (count + 1) as f32;
        for (index, name) in row.iter().enumerate() {
            let x = 21.0 + horizontal_gap * (index + 1) as f32;
            let system_reports = active_reports
                .iter()
                .filter(|report| report.system == *name)
                .cloned()
                .collect::<Vec<_>>();
            let severity = if system_reports
                .iter()
                .any(|report| report.severity == IntelSeverity::Danger)
            {
                IntelSeverity::Danger
            } else if !system_reports.is_empty() {
                IntelSeverity::Watch
            } else {
                IntelSeverity::Clear
            };
            nodes.push(GraphNode {
                id: universe
                    .get(name)
                    .map(|system| system.id)
                    .unwrap_or_default(),
                name: name.clone(),
                distance,
                x,
                y,
                active_intel_count: system_reports.len(),
                severity,
                latest_report: system_reports
                    .into_iter()
                    .max_by_key(|report| report.timestamp_ms),
            });
        }
    }
    nodes.sort_by_key(|node| (node.distance, node.name.clone()));

    let mut edges = Vec::new();
    for (child, parent) in parents {
        if distances.contains_key(&child) && distances.contains_key(&parent) {
            edges.push(GraphEdge {
                from: parent,
                to: child,
            });
        }
    }
    edges.sort_by_key(|edge| (edge.from.clone(), edge.to.clone()));

    MapView {
        center: current_system,
        radius,
        nodes,
        edges,
        active_reports,
        all_reports,
    }
}

#[tauri::command]
fn get_map_view(current_system: String, radius: u8, state: State<'_, AppState>) -> MapView {
    let reports = state.reports.lock().unwrap().clone();
    build_map_view(&state.universe, current_system, radius, reports)
}

pub fn run() {
    let universe = Universe::load().expect("bundled universe data should be valid");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            universe,
            settings: Mutex::new(Settings::default()),
            reports: Mutex::new(Vec::new()),
            file_states: Mutex::new(HashMap::new()),
            last_errors: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            list_systems,
            get_watch_status,
            scan_log_channels,
            rescan_watch_paths,
            poll_logs,
            get_map_view
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn graph_radius_returns_expected_distances() {
        let universe = Universe::load().unwrap();
        let one_jump = universe.distance_tree_from("BKG-Q2", 1).0;
        assert_eq!(one_jump.get("BKG-Q2"), Some(&0));
        assert_eq!(one_jump.get("8-4GQM"), Some(&1));
        assert!(!one_jump.contains_key("LRWD-B"));

        let five_jump = universe.distance_tree_from("BKG-Q2", 5).0;
        assert_eq!(five_jump.get("LRWD-B"), Some(&2));
        assert_eq!(five_jump.get("C-LP3N"), Some(&2));
    }

    #[test]
    fn graph_does_not_duplicate_nodes() {
        let universe = Universe::load().unwrap();
        let distances = universe.distance_tree_from("BKG-Q2", 5).0;
        let unique = distances.keys().collect::<HashSet<_>>();
        assert_eq!(unique.len(), distances.len());
    }

    #[test]
    fn parser_detects_common_intel() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(
            &universe,
            "[12:20] pilot > red sabre in 2D-0SO on gate",
            "test",
            1,
            None,
        );
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].system, "2D-0SO");
        assert_eq!(reports[0].severity, IntelSeverity::Danger);
        assert_eq!(reports[0].ship_hint.as_deref(), Some("SABRE"));
    }

    #[test]
    fn parser_ignores_unknown_systems() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(&universe, "red sabre in nowhere", "test", 1, None);
        assert!(reports.is_empty());
    }

    #[test]
    fn parser_handles_multiple_systems() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(
            &universe,
            "neut gang moving 2D-0SO to L-TOFR",
            "test",
            1,
            None,
        );
        let systems = reports
            .into_iter()
            .map(|report| report.system)
            .collect::<HashSet<_>>();
        assert!(systems.contains("2D-0SO"));
        assert!(systems.contains("L-TOFR"));
    }

    #[test]
    fn parser_recognizes_clear_lines() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(&universe, "2D-0SO clear", "test", 1, None);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].severity, IntelSeverity::Clear);
    }

    #[test]
    fn parser_detects_actual_eve_chatlog_intel_line() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(
            &universe,
            "[ 2026.06.17 10:27:41 ] Hulk Harley > 04-EHC +4 neutrals NV",
            "test",
            1,
            None,
        );
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].system, "04-EHC");
        assert_eq!(reports[0].severity, IntelSeverity::Danger);
    }

    #[test]
    fn parser_detects_actual_astero_count_line() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(
            &universe,
            "[ 2026.06.17 11:14:52 ] Hulk Harley > 04-EHC  Hulk Harley +4 Asteros",
            "test",
            1,
            None,
        );
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].system, "04-EHC");
        assert_eq!(reports[0].severity, IntelSeverity::Danger);
    }

    #[test]
    fn eve_log_timestamp_is_parsed_as_utc() {
        let timestamp = eve_log_timestamp_ms(
            "\u{feff}[ 2026.06.17 11:28:46 ] Hulk Harley > 04-EHC Hulk Harley +4 Asteros",
        );
        assert_eq!(timestamp, Some(1_781_695_726_000));
    }

    #[test]
    fn parser_detects_system_pilot_count_ship_format() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(&universe, "04-EHC Some Pilot +3 Lokis", "test", 1, None);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].system, "04-EHC");
        assert_eq!(reports[0].severity, IntelSeverity::Danger);
    }

    #[test]
    fn parser_detects_pilot_system_count_ship_format() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(&universe, "Some Pilot 04-EHC +2 Sabres", "test", 1, None);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].system, "04-EHC");
        assert_eq!(reports[0].severity, IntelSeverity::Danger);
    }

    #[test]
    fn parser_detects_player_or_ship_name_then_system_format() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(
            &universe,
            "[12:04:17] Bishop2142 > Utrabug 8-WYQZ",
            "test",
            1,
            None,
        );
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].system, "8-WYQZ");
        assert_eq!(reports[0].severity, IntelSeverity::Danger);
    }

    #[test]
    fn parser_detects_system_with_count_suffix_format() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(
            &universe,
            "[12:02:37] Pentagruel > 8-WYQZ 5+",
            "test",
            1,
            None,
        );
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].system, "8-WYQZ");
        assert_eq!(reports[0].severity, IntelSeverity::Danger);
    }

    #[test]
    fn chat_speaker_is_extracted_from_eve_log_line() {
        assert_eq!(
            chat_speaker("[ 2026.06.17 12:11:51 ] Ranadaine Oramara > Vert01 KDG-TA")
                .as_deref(),
            Some("Ranadaine Oramara")
        );
    }

    #[test]
    fn parser_uses_previous_speaker_system_for_followup_intel() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(
            &universe,
            "[ 2026.06.17 12:12:02 ] Ranadaine Oramara > Legacy Destroyer sabre",
            "test",
            2,
            Some("KDG-TA"),
        );
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].system, "KDG-TA");
        assert_eq!(reports[0].severity, IntelSeverity::Danger);
        assert_eq!(reports[0].ship_hint.as_deref(), Some("SABRE"));
    }

    #[test]
    fn parser_does_not_match_systems_from_speaker_name() {
        let universe = Universe::load().unwrap();
        let reports = parse_intel_line(
            &universe,
            "[ 2026.06.17 12:11:38 ] Miranda Ghostwalker > Syrianah Stormborne 5M2-KP buzzard",
            "test",
            2,
            None,
        );
        let systems = reports
            .iter()
            .map(|report| report.system.as_str())
            .collect::<Vec<_>>();
        assert_eq!(systems, vec!["5M2-KP"]);
    }

    #[test]
    fn poll_one_file_reads_only_appended_chatlog_lines() {
        fn utf16_bytes(text: &str) -> Vec<u8> {
            let mut bytes = Vec::new();
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            bytes
        }

        let path = std::env::temp_dir().join(format!("evetel-test-{}.txt", Uuid::new_v4()));
        let first_line =
            "\u{feff}[ 2026.06.17 12:11:51 ] Ranadaine Oramara > Vert01 KDG-TA\r\n";
        fs::write(&path, utf16_bytes(first_line)).unwrap();
        let state = AppState {
            universe: Universe::load().unwrap(),
            settings: Mutex::new(Settings::default()),
            reports: Mutex::new(Vec::new()),
            file_states: Mutex::new(HashMap::new()),
            last_errors: Mutex::new(Vec::new()),
        };

        let first_poll = poll_one_file(&path, &state, "04-EHC").unwrap();
        assert_eq!(first_poll.len(), 1);
        assert_eq!(first_poll[0].system, "KDG-TA");

        let second_poll = poll_one_file(&path, &state, "04-EHC").unwrap();
        assert!(second_poll.is_empty());

        let followup_line =
            "[ 2026.06.17 12:12:02 ] Ranadaine Oramara > Legacy Destroyer sabre\r\n";
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        use std::io::Write;
        file.write_all(&utf16_bytes(followup_line)).unwrap();

        let third_poll = poll_one_file(&path, &state, "04-EHC").unwrap();
        assert_eq!(third_poll.len(), 1);
        assert_eq!(third_poll[0].system, "KDG-TA");
        assert_eq!(third_poll[0].ship_hint.as_deref(), Some("SABRE"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parser_detects_system_status_formats() {
        let universe = Universe::load().unwrap();
        let clear = parse_intel_line(&universe, "04-EHC Clear", "test", 1, None);
        let query = parse_intel_line(&universe, "04-EHC Status?", "test", 1, None);
        let red = parse_intel_line(&universe, "04-EHC red", "test", 1, None);
        let spike = parse_intel_line(&universe, "04-EHC Spike", "test", 1, None);

        assert_eq!(clear[0].severity, IntelSeverity::Clear);
        assert_eq!(query[0].severity, IntelSeverity::Watch);
        assert_eq!(red[0].severity, IntelSeverity::Danger);
        assert_eq!(spike[0].severity, IntelSeverity::Danger);
    }

    #[test]
    fn map_view_keeps_out_of_radius_active_reports() {
        let universe = Universe::load().unwrap();
        let reports = vec![
            IntelReport {
                id: "nearby".to_string(),
                system: "BKG-Q2".to_string(),
                raw_line: "BKG-Q2 Some Pilot +1 Astero".to_string(),
                source: "test".to_string(),
                timestamp_ms: 2,
                severity: IntelSeverity::Danger,
                ship_hint: Some("ASTERO".to_string()),
                character_hint: None,
                distance: None,
            },
            IntelReport {
                id: "far".to_string(),
                system: "Jita".to_string(),
                raw_line: "Jita Some Pilot +1 Astero".to_string(),
                source: "test".to_string(),
                timestamp_ms: 1,
                severity: IntelSeverity::Danger,
                ship_hint: Some("ASTERO".to_string()),
                character_hint: None,
                distance: None,
            },
        ];

        let view = build_map_view(&universe, "BKG-Q2".to_string(), 1, reports);
        assert_eq!(view.active_reports.len(), 2);
        assert_eq!(view.active_reports[0].id, "nearby");
        assert_eq!(view.active_reports[0].distance, Some(0));
        assert_eq!(view.active_reports[1].id, "far");
        assert_eq!(view.active_reports[1].distance, None);
    }

    #[test]
    fn map_view_keeps_clear_reports_in_all_intel_but_not_active_intel() {
        let universe = Universe::load().unwrap();
        let reports = vec![
            IntelReport {
                id: "danger".to_string(),
                system: "BKG-Q2".to_string(),
                raw_line: "BKG-Q2 Some Pilot +1 Astero".to_string(),
                source: "test".to_string(),
                timestamp_ms: 1,
                severity: IntelSeverity::Danger,
                ship_hint: Some("ASTERO".to_string()),
                character_hint: None,
                distance: None,
            },
            IntelReport {
                id: "clear".to_string(),
                system: "BKG-Q2".to_string(),
                raw_line: "BKG-Q2 clear".to_string(),
                source: "test".to_string(),
                timestamp_ms: 2,
                severity: IntelSeverity::Clear,
                ship_hint: None,
                character_hint: None,
                distance: None,
            },
        ];

        let view = build_map_view(&universe, "BKG-Q2".to_string(), 1, reports);
        assert_eq!(view.all_reports.len(), 2);
        assert_eq!(view.all_reports[0].id, "clear");
        assert!(view.active_reports.is_empty());
    }

    #[test]
    fn channel_name_is_extracted_from_eve_log_filename() {
        let path = PathBuf::from("Taco test_20260617_111424_95101976.txt");
        assert_eq!(
            channel_from_log_filename(&path).as_deref(),
            Some("Taco test")
        );
    }

    #[test]
    fn watched_files_match_selected_channel_logs() {
        let settings = Settings {
            current_system: "04-EHC".to_string(),
            watched_paths: Vec::new(),
            watched_logs: vec![WatchedLog {
                folder: "C:\\Users\\Astraea\\Documents\\EVE\\logs\\Chatlogs".to_string(),
                channel: "Taco test".to_string(),
            }],
            jump_radius: 5,
            sound_enabled: true,
            sound_volume: 0.5,
            intel_expiry_minutes: 20,
        };
        let folder_exists = PathBuf::from(&settings.watched_logs[0].folder).exists();
        let files = watched_files(&settings);
        if folder_exists {
            assert!(files.len() >= 2);
            assert!(files
                .iter()
                .all(|path| channel_from_log_filename(path).as_deref() == Some("Taco test")));
        }
    }

    #[test]
    fn utf16_eve_chatlog_bytes_are_decoded() {
        let text =
            "\u{feff}[ 2026.06.17 11:37:04 ] Hulk Harley > 04-EHC Hulk Harley +4 Asteros\r\n";
        let mut bytes = Vec::new();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let decoded = decode_chatlog_bytes(&bytes).unwrap();
        assert!(decoded.contains("04-EHC Hulk Harley +4 Asteros"));
    }

    #[test]
    fn parser_detects_decoded_utf16_eve_chatlog_line() {
        let universe = Universe::load().unwrap();
        let text =
            "\u{feff}[ 2026.06.17 11:37:04 ] Hulk Harley > 04-EHC Hulk Harley +4 Asteros\r\n";
        let mut bytes = Vec::new();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let decoded = decode_chatlog_bytes(&bytes).unwrap();
        let reports = decoded
            .lines()
            .flat_map(|line| parse_intel_line(&universe, line, "test", 1, None))
            .collect::<Vec<_>>();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].system, "04-EHC");
    }

    #[test]
    fn layered_layout_puts_current_system_on_bottom_row() {
        let universe = Universe::load().unwrap();
        let view = build_map_view(&universe, "BKG-Q2".to_string(), 5, Vec::new());
        let current = view
            .nodes
            .iter()
            .find(|node| node.name == "BKG-Q2")
            .expect("current system should be present");
        let highest_y = view.nodes.iter().map(|node| node.y).fold(0.0, f32::max);
        assert_eq!(current.y, highest_y);
    }

    #[test]
    fn layered_layout_places_connected_systems_above_current_system() {
        let universe = Universe::load().unwrap();
        let view = build_map_view(&universe, "BKG-Q2".to_string(), 5, Vec::new());
        let current_y = view
            .nodes
            .iter()
            .find(|node| node.name == "BKG-Q2")
            .unwrap()
            .y;
        for node in view.nodes.iter().filter(|node| node.distance == 1) {
            assert!(node.y < current_y);
        }
    }

    #[test]
    fn layered_layout_draws_only_parent_child_branch_edges() {
        let universe = Universe::load().unwrap();
        let view = build_map_view(&universe, "BKG-Q2".to_string(), 5, Vec::new());
        let distances = view
            .nodes
            .iter()
            .map(|node| (node.name.clone(), node.distance))
            .collect::<HashMap<_, _>>();

        for edge in &view.edges {
            let from = distances[&edge.from];
            let to = distances[&edge.to];
            assert_eq!(to, from + 1);
        }

        let non_root_nodes = view.nodes.iter().filter(|node| node.distance > 0).count();
        assert_eq!(view.edges.len(), non_root_nodes);
    }
}
