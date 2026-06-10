#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const args = parseArgs(process.argv.slice(2));
const root = args.root || "C:\\Users\\NewAdmin\\Documents\\Academy of Art University\\2026\\Gam623";
const port = Number(args.port || 9222);
const waitMs = Number(args.waitMs || 22000);
const pageLimit = Number(args.pageLimit || 0);
const entryLimit = Number(args.entryLimit || 0);
const modules = new Set((args.modules || "").split(",").map(s => s.trim()).filter(Boolean));
const output = args.output || path.join(root, "video_captures.json");

const entries = await loadEntries();
const pages = groupBy(entries.filter(entry => entry.pageUrl), entry => entry.pageUrl);
const pageJobs = [...pages.entries()].slice(0, pageLimit || undefined);

if (pageJobs.length === 0) {
  throw new Error("No video entries had source Brightspace page URLs.");
}

const target = await getDebugTarget();
const cdp = await connectCdp(target.webSocketDebuggerUrl);
await cdp.send("Network.enable", {});
await cdp.send("Page.enable", {});
await cdp.send("Runtime.enable", {});

const captures = loadExistingCaptures();
let activePage = null;
let activeEntries = [];

cdp.on("Network.requestWillBeSent", event => {
  const url = event.request?.url || "";
  if (!isKalturaCandidate(url)) return;
  const entryId = entryIdFromUrl(url);
  const matched = entryId ? entries.find(entry => entry.entryId === entryId) : null;
  const fallback = activeEntries[0] || {};
  const capture = {
    at: new Date().toISOString(),
    entryId: matched?.entryId || entryId || fallback.entryId || null,
    module: matched?.module || fallback.module || null,
    pageTitle: matched?.pageTitle || fallback.pageTitle || null,
    sourceFile: matched?.sourceFile || fallback.sourceFile || null,
    pageUrl: matched?.pageUrl || activePage,
    url,
    type: event.type || null
  };
  const key = `${capture.entryId || "unknown"}|${capture.url}`;
  if (captures.some(item => `${item.entryId || "unknown"}|${item.url}` === key)) return;
  captures.push(capture);
  console.log(`capture ${capture.entryId || "unknown"} ${url}`);
  void saveCaptures();
});

for (const [pageUrl, pageEntries] of pageJobs) {
  activePage = pageUrl;
  activeEntries = pageEntries;
  console.log(`opening ${pageEntries[0].module} / ${pageEntries[0].pageTitle} (${pageEntries.length} entr${pageEntries.length === 1 ? "y" : "ies"})`);
  await cdp.send("Page.navigate", { url: pageUrl });
  await waitForLoad(cdp, 12000).catch(() => {});
  await sleep(2500);
  await tryStartPlayers(cdp);
  await sleep(waitMs);
  await saveCaptures();
}

await cdp.close();
await saveCaptures();
console.log(`saved ${captures.length} captured request URL(s) to ${output}`);

async function loadEntries() {
  const catalogPath = path.join(root, "video_catalog.json");
  const catalog = JSON.parse((await fs.readFile(catalogPath, "utf8")).replace(/^\uFEFF/, ""));
  const selected = catalog
    .filter(item => item.provider === "kaltura")
    .filter(item => modules.size === 0 || modules.has(item.module))
    .slice(0, entryLimit || undefined);
  return Promise.all(selected.map(enrichEntry));
}

async function enrichEntry(entry) {
  return { ...entry, pageUrl: await sourceUrlForEntry(entry) };
}

async function sourceUrlForEntry(entry) {
  if (!entry.sourceFile) return null;
  const htmlPath = path.join(root, entry.sourceFile);
  for (const manifestPath of await manifestCandidatesForHtml(htmlPath)) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8").catch(() => "{}"));
    if (manifest.url || manifest.label) return manifest.url || manifest.label;
  }
  return null;
}

async function manifestCandidatesForHtml(htmlPath) {
  const parsed = path.parse(htmlPath);
  const baseName = parsed.name.replace(/ \(\d+\)$/i, "");
  const direct = [
    htmlPath.replace(/\.html$/i, ".manifest.json"),
    path.join(parsed.dir, `${baseName}.manifest.json`)
  ];
  const siblings = await fs.readdir(parsed.dir).catch(() => []);
  const matching = siblings
    .filter(name => name.toLowerCase().startsWith(`${baseName.toLowerCase()}.manifest`))
    .map(name => path.join(parsed.dir, name));
  return [...new Set([...direct, ...matching])];
}

async function getDebugTarget() {
  const base = `http://127.0.0.1:${port}`;
  const listResponse = await fetch(`${base}/json/list`);
  if (!listResponse.ok) throw new Error(`Chrome debugging is not available on ${base}`);
  let targets = await listResponse.json();
  let target = targets.find(item => item.type === "page" && !item.url.startsWith("devtools://"));
  if (!target) {
    const created = await fetch(`${base}/json/new?about:blank`, { method: "PUT" });
    if (!created.ok) throw new Error(`Could not create a Chrome debug target: ${created.status}`);
    target = await created.json();
  }
  return target;
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method && listeners.has(message.method)) {
      for (const listener of listeners.get(message.method)) listener(message.params || {});
    }
  });

  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolveSend, rejectSend) => {
          pending.set(id, { resolve: resolveSend, reject: rejectSend });
          setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            rejectSend(new Error(`CDP timeout: ${method}`));
          }, 30000);
        });
      },
      on(method, listener) {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(listener);
      },
      close() {
        ws.close();
      }
    }));
    ws.once("error", reject);
  });
}

function waitForLoad(cdp, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("load timeout")), timeoutMs);
    cdp.on("Page.loadEventFired", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function tryStartPlayers(cdp) {
  const expression = `(() => {
    const events = ["pointerdown", "mousedown", "mouseup", "click"];
    const targets = [
      ...document.querySelectorAll("[data-kaltura-entry-id]"),
      ...document.querySelectorAll("button, [role='button'], .aau-video, .video, iframe")
    ];
    for (const target of targets) {
      try {
        target.scrollIntoView({ block: "center", inline: "center" });
        for (const type of events) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch {}
    }
    return { title: document.title, clicked: targets.length };
  })()`;
  await cdp.send("Runtime.evaluate", { expression, awaitPromise: false }).catch(() => {});
}

function loadExistingCaptures() {
  if (!fsSync.existsSync(output)) return [];
  try {
    return JSON.parse(fsSync.readFileSync(output, "utf8"));
  } catch {
    return [];
  }
}

async function saveCaptures() {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(captures, null, 2), "utf8");
}

function isKalturaCandidate(url) {
  return /kaltura|akadns|akamaihd/i.test(url)
    && /entry[_-]?id|playManifest|manifest|m3u8|mp4|flavor|asset|serveFlavor|hls|dash|segment|frag|clipTo|api_v3|service\/multirequest/i.test(url);
}

function entryIdFromUrl(url) {
  const decoded = safeDecode(url);
  const patterns = [
    /entry[_-]?id[=/]([0-9]_[a-z0-9]+)/i,
    /entryId[=/]([0-9]_[a-z0-9]+)/i,
    /\/([0-9]_[a-z0-9]+)(?:[/?&#]|$)/i
  ];
  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function groupBy(values, getKey) {
  const groups = new Map();
  for (const value of values) {
    const key = getKey(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
