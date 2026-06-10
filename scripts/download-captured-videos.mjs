#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const root = args.root || "C:\\Users\\NewAdmin\\Documents\\Academy of Art University\\2026\\Gam623";
const logPath = args.log || path.join(root, "video_capture_log.json");
const catalogPath = args.catalog || path.join(root, "video_catalog.json");
const modules = new Set((args.modules || "").split(",").map(value => value.trim()).filter(Boolean));
const entryIds = new Set((args.entryIds || args.entryId || "").split(",").map(value => value.trim()).filter(Boolean));
const limit = Number(args.limit || 0);

const catalog = JSON.parse((await fs.readFile(catalogPath, "utf8")).replace(/^\uFEFF/, ""));
const captures = JSON.parse(await fs.readFile(logPath, "utf8"));
const catalogByEntry = new Map(catalog.filter(item => item.entryId).map(item => [item.entryId, item]));
const manifests = latestManifests(captures);
const selected = manifests
  .map(item => ({ ...item, catalog: catalogByEntry.get(item.entryId) }))
  .filter(item => item.catalog)
  .filter(item => modules.size === 0 || modules.has(item.catalog.module))
  .filter(item => entryIds.size === 0 || entryIds.has(item.entryId))
  .slice(0, limit || undefined);

if (selected.length === 0) {
  throw new Error("No captured HLS manifests matched the requested filters.");
}

for (const item of selected) {
  const moduleName = item.catalog.module || item.module || "Uncategorized";
  const dir = path.join(root, moduleName, "Videos");
  await fs.mkdir(dir, { recursive: true });

  const fileName = safeName(`${item.catalog.pageTitle || item.pageTitle || "Video"} - ${item.entryId}.mp4`);
  const output = uniquePath(path.join(dir, fileName));
  const manifestOutput = `${output}.manifest.json`;

  console.log(`downloading ${item.entryId} -> ${output}`);
  await runFfmpeg(item.url, output);
  await fs.writeFile(manifestOutput, JSON.stringify({
    downloadedAt: new Date().toISOString(),
    entryId: item.entryId,
    module: moduleName,
    pageTitle: item.catalog.pageTitle || item.pageTitle,
    sourceFile: item.catalog.sourceFile || item.sourceFile,
    pageUrl: item.catalog.pageUrl || item.pageUrl,
    hlsManifest: item.url
  }, null, 2), "utf8");
}

function latestManifests(items) {
  const byEntry = new Map();
  for (const item of items) {
    if (!/index\.m3u8/i.test(item.url || "")) continue;
    const entryId = entryIdFromUrl(item.url) || item.entryId;
    if (!entryId) continue;
    byEntry.set(entryId, { ...item, entryId });
  }
  return [...byEntry.values()];
}

function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "warning",
      "-y",
      "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
      "-i", input,
      "-c", "copy",
      "-bsf:a", "aac_adtstoasc",
      output
    ], { stdio: ["ignore", "inherit", "pipe"] });

    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function entryIdFromUrl(url) {
  const decoded = safeDecode(url);
  const match = decoded.match(/entryId\/([0-9]_[a-z0-9]+)/i)
    || decoded.match(/entry[_-]?id[=/]([0-9]_[a-z0-9]+)/i);
  return match?.[1] || null;
}

function safeName(value) {
  const cleaned = String(value || "video")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return cleaned || "video.mp4";
}

function uniquePath(candidate) {
  const parsed = path.parse(candidate);
  let current = candidate;
  let index = 2;
  while (fsSync.existsSync(current)) {
    current = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
  return current;
}

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}
