#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

const root = process.argv[2] || "C:\\Users\\NewAdmin\\Documents\\Academy of Art University\\2026\\Gam623";
const port = Number(process.env.CHROME_COURSE_COLLECTOR_PORT || 38476);
const jobs = new Map();
const embeddedJobs = new Map();
const videoJobs = new Map();

await fs.mkdir(root, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === "OPTIONS") return endJson(res, 204, {});

    if (req.method === "GET" && req.url === "/health") {
      return endJson(res, 200, {
        ok: true,
        root,
        port,
        jobs: [...jobs.values()].map(publicJob),
        embeddedJobs: [...embeddedJobs.values()].map(publicEmbeddedJob),
        videoJobs: [...videoJobs.values()].map(publicVideoJob)
      });
    }

    if (req.method === "GET" && req.url?.startsWith("/video-probe")) {
      return endHtml(res, 200, videoProbeHtml());
    }

    if (req.method === "GET" && req.url?.startsWith("/video-driver")) {
      return endHtml(res, 200, videoDriverHtml());
    }

    if (req.method === "POST" && req.url === "/jobs/start") {
      const body = await readJson(req);
      const job = startJob(body);
      return endJson(res, 200, { ok: true, job: publicJob(job) });
    }

    if (req.method === "GET" && req.url?.startsWith("/jobs/active")) {
      const active = [...jobs.values()].find(job => job.status === "running");
      return endJson(res, 200, { ok: true, job: active ? publicJob(active) : null });
    }

    if (req.method === "POST" && req.url === "/jobs/page") {
      const body = await readJson(req);
      const update = await recordJobPage(body);
      return endJson(res, 200, { ok: true, ...update });
    }

    if (req.method === "POST" && req.url === "/jobs/event") {
      const body = await readJson(req);
      const job = jobs.get(body.jobId);
      if (job) pushEvent(job, body.message || body.type || "event", body);
      return endJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/embedded/start") {
      const body = await readJson(req);
      const job = await startEmbeddedJob(body);
      return endJson(res, 200, { ok: true, job: publicEmbeddedJob(job) });
    }

    if (req.method === "GET" && req.url?.startsWith("/embedded/active")) {
      const active = [...embeddedJobs.values()].find(job => job.status === "running");
      return endJson(res, 200, { ok: true, job: active ? publicEmbeddedJob(active) : null });
    }

    if (req.method === "GET" && req.url?.startsWith("/embedded/next")) {
      const active = [...embeddedJobs.values()].find(job => job.status === "running");
      if (!active) return endJson(res, 200, { ok: true, job: null, urls: [] });
      const parsed = new URL(req.url, `http://127.0.0.1:${port}`);
      const count = Number(parsed.searchParams.get("count") || 10);
      const urls = nextEmbeddedBatch(active, count);
      return endJson(res, 200, { ok: true, job: publicEmbeddedJob(active), urls });
    }

    if (req.method === "POST" && req.url === "/embedded/page") {
      const body = await readJson(req);
      const update = await recordEmbeddedPage(body);
      return endJson(res, 200, { ok: true, ...update });
    }

    if (req.method === "POST" && req.url === "/videos/start") {
      const body = await readJson(req);
      const job = await startVideoJob(body);
      return endJson(res, 200, { ok: true, job: publicVideoJob(job) });
    }

    if (req.method === "GET" && req.url?.startsWith("/videos/current")) {
      const active = [...videoJobs.values()].find(job => job.status === "running");
      return endJson(res, 200, { ok: true, job: active ? publicVideoJob(active) : null });
    }

    if (req.method === "GET" && req.url?.startsWith("/videos/next")) {
      const active = [...videoJobs.values()].find(job => job.status === "running");
      if (!active) return endJson(res, 200, { ok: true, job: null, entry: null });
      const entry = nextVideoEntry(active);
      return endJson(res, 200, { ok: true, job: publicVideoJob(active), entry });
    }

    if (req.method === "POST" && req.url === "/videos/capture") {
      const body = await readJson(req);
      const update = recordVideoCapture(body);
      return endJson(res, 200, { ok: true, ...update });
    }

    if (req.method === "POST" && req.url === "/archive-page") {
      const body = await readJson(req);
      const saved = await archivePage(body);
      return endJson(res, 200, { ok: true, saved });
    }

    if (req.method === "POST" && req.url === "/save-file") {
      const body = await readJson(req, 2 * 1024 * 1024 * 1024);
      const saved = await saveFile(body);
      return endJson(res, 200, { ok: true, saved });
    }

    endJson(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    endJson(res, 500, { ok: false, error: err.message || String(err) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Chrome Course Collector listening on http://127.0.0.1:${port}`);
  console.log(`Writing to ${root}`);
});

async function archivePage(body) {
  const moduleName = detectModule(body) || "Uncategorized";
  const title = safeName(body.title || body.label || "Brightspace Page");
  const dir = path.join(root, moduleName, "Collected Pages");
  await fs.mkdir(dir, { recursive: true });

  const htmlPath = uniquePath(path.join(dir, `${title}.html`));
  const jsonPath = uniquePath(path.join(dir, `${title}.manifest.json`));
  const html = body.html || wrapTextPage(body);

  await fs.writeFile(htmlPath, html, "utf8");
  await fs.writeFile(jsonPath, JSON.stringify({
    collectedAt: new Date().toISOString(),
    moduleName,
    title: body.title,
    label: body.label,
    url: body.url,
    text: body.text,
    extraction: body.extraction,
    notes: [
      "Collected from the authenticated Chrome tab via the local Chrome Course extension.",
      "Direct downloadable files are stored separately when the extension can fetch them."
    ]
  }, null, 2), "utf8");

  return [htmlPath, jsonPath];
}

function startJob(body) {
  if (!body.startUrl) throw new Error("startUrl is required");
  const id = `job-${Date.now()}`;
  const job = {
    id,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    courseCode: body.courseCode || "Gam_623",
    startUrl: body.startUrl,
    maxPages: Number(body.maxPages || 240),
    downloadDirect: body.downloadDirect !== false,
    pending: [body.startUrl],
    visited: [],
    failed: [],
    saved: [],
    events: [],
    courseId: detectCourseId(body.startUrl),
    allowedHost: safeHost(body.startUrl)
  };
  jobs.set(id, job);
  pushEvent(job, "job started", { startUrl: body.startUrl });
  return job;
}

async function startEmbeddedJob(body) {
  const id = `embedded-${Date.now()}`;
  const urls = uniqueStrings(await discoverEmbeddedUrls(root));
  const job = {
    id,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    courseCode: body.courseCode || "Gam_623",
    pending: urls,
    inFlight: [],
    processed: [],
    failed: [],
    saved: [],
    mediaCandidates: [],
    maxPages: Number(body.maxPages || urls.length || 500),
    downloadDirect: body.downloadDirect !== false,
    events: []
  };
  embeddedJobs.set(id, job);
  pushEvent(job, "embedded scan started", { queued: urls.length });
  return job;
}

async function discoverEmbeddedUrls(scanRoot) {
  const urls = [];
  const files = await walkFiles(scanRoot, file => /\.(html|json)$/i.test(file));
  const patterns = [
    /(?:src|data-location)=["']([^"']*\/content\/enforced\/[^"']+)["']/gi,
    /https:\/\/[^"'<>\s]+(?:kaltura|brightcove|panopto|wistia|vimeo|youtube)[^"'<>\s]*/gi
  ];

  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const raw = match[1] || match[0];
        urls.push(normalizeEmbeddedUrl(raw));
      }
    }
  }
  return urls.filter(Boolean);
}

async function walkFiles(dir, predicate, output = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, predicate, output);
    else if (!predicate || predicate(full)) output.push(full);
  }
  return output;
}

function normalizeEmbeddedUrl(raw) {
  if (!raw) return null;
  const decoded = raw.replace(/&amp;/g, "&");
  try {
    return new URL(decoded, "https://online.academyart.edu").href;
  } catch {
    return null;
  }
}

function nextEmbeddedBatch(job, count) {
  const urls = [];
  while (urls.length < count && job.pending.length > 0 && job.processed.length + job.inFlight.length < job.maxPages) {
    const url = job.pending.shift();
    if (job.processed.includes(url) || job.inFlight.includes(url)) continue;
    job.inFlight.push(url);
    urls.push(url);
  }
  if (urls.length === 0 && job.inFlight.length === 0) {
    job.status = "complete";
    pushEvent(job, "embedded scan complete", {
      processed: job.processed.length,
      failed: job.failed.length,
      mediaCandidates: job.mediaCandidates.length
    });
  }
  return urls;
}

async function recordEmbeddedPage(body) {
  const job = embeddedJobs.get(body.jobId);
  if (!job) throw new Error(`Unknown embedded job: ${body.jobId}`);
  const url = body.url || body.page?.url;
  job.inFlight = job.inFlight.filter(item => item !== url);

  if (body.error) {
    job.failed.push({ url, error: body.error });
    pushEvent(job, "embedded page failed", { url, error: body.error });
  } else {
    const saved = await archivePage(body.page);
    job.saved.push(...saved);
    job.processed.push(url);
    job.mediaCandidates.push(...(body.page?.extraction?.media || []).map(item => ({ ...item, sourcePage: url })));
    enqueueEmbedded(job, body.page?.extraction?.embeddedPages || []);
    pushEvent(job, "embedded page archived", {
      url,
      title: body.page?.title,
      media: body.page?.extraction?.media?.length || 0,
      pending: job.pending.length,
      processed: job.processed.length
    });
  }
  job.updatedAt = new Date().toISOString();
  return { job: publicEmbeddedJob(job) };
}

function enqueueEmbedded(job, items) {
  for (const item of items) {
    const url = normalizeEmbeddedUrl(typeof item === "string" ? item : item.url);
    if (!url) continue;
    if (job.pending.includes(url) || job.inFlight.includes(url) || job.processed.includes(url)) continue;
    job.pending.push(url);
  }
}

function publicEmbeddedJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    courseCode: job.courseCode,
    pending: job.pending.length,
    inFlight: job.inFlight.length,
    processed: job.processed.length,
    failed: job.failed.length,
    saved: job.saved.length,
    mediaCandidates: job.mediaCandidates.length,
    recentEvents: job.events.slice(-20)
  };
}

async function startVideoJob(body) {
  const catalogPath = path.join(root, "video_catalog.json");
  const catalog = JSON.parse((await fs.readFile(catalogPath, "utf8")).replace(/^\uFEFF/, ""));
  const modules = new Set(Array.isArray(body.modules) ? body.modules : []);
  const entries = await Promise.all(catalog
    .filter(item => item.provider === "kaltura")
    .filter(item => modules.size === 0 || modules.has(item.module))
    .slice(0, Number(body.limit || catalog.length))
    .map(enrichVideoEntry));
  const id = `videos-${Date.now()}`;
  const job = {
    id,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pending: entries,
    active: null,
    catalogByEntry: new Map(entries.map(entry => [entry.entryId, entry])),
    processed: [],
    captures: [],
    events: []
  };
  videoJobs.set(id, job);
  pushEvent(job, "video scan started", { queued: entries.length });
  return job;
}

function nextVideoEntry(job) {
  if (job.active) return job.active;
  if (job.pending.length === 0) {
    job.status = "complete";
    pushEvent(job, "video scan complete", {
      processed: job.processed.length,
      captures: job.captures.length
    });
    return null;
  }
  job.active = job.pending.shift();
  pushEvent(job, "video entry active", {
    module: job.active.module,
    pageTitle: job.active.pageTitle,
    entryId: job.active.entryId
  });
  return job.active;
}

function recordVideoCapture(body) {
  const job = [...videoJobs.values()].find(candidate => candidate.status === "running" || candidate.active);
  if (!job) return { job: null };

  if (body.event && body.event !== "request" && body.event !== "done") {
    pushEvent(job, `video ${body.event}`, {
      url: body.url,
      title: body.title,
      entryId: body.entry?.entryId,
      error: body.error,
      playerCount: body.playerCount,
      found: body.found,
      embedded: body.embedded,
      hasKWidget: body.hasKWidget,
      frames: Array.isArray(body.frames) ? body.frames.slice(0, 20) : undefined,
      media: Array.isArray(body.media) ? body.media.slice(0, 20) : undefined,
      sample: Array.isArray(body.sample) ? body.sample.slice(0, 3) : undefined
    });
  }

  if ((body.event === "request" || body.event === "video-network") && body.url) {
    const parsedEntryId = entryIdFromUrl(body.url);
    const entry = parsedEntryId ? job.catalogByEntry?.get(parsedEntryId) : null;
    const captureEntry = entry || body.entry || job.active || {};
    const key = `${captureEntry.entryId || parsedEntryId || "unknown"}|${body.url}`;
    if (!job.captures.some(item => `${item.entryId}|${item.url}` === key)) {
      job.captures.push({
        at: new Date().toISOString(),
        entryId: captureEntry.entryId || parsedEntryId,
        module: captureEntry.module,
        pageTitle: captureEntry.pageTitle,
        sourceFile: captureEntry.sourceFile,
        pageUrl: captureEntry.pageUrl,
        url: body.url,
        type: body.type
      });
      saveVideoCaptureLog(job);
    }
  }

  if (body.event === "done" && job.active?.entryId === body.entry?.entryId) {
    job.processed.push(job.active);
    job.active = null;
  }

  job.updatedAt = new Date().toISOString();
  return { job: publicVideoJob(job) };
}

function saveVideoCaptureLog(job) {
  try {
    fsSync.writeFileSync(path.join(root, "video_capture_log.json"), JSON.stringify(job.captures, null, 2), "utf8");
  } catch {
    // The in-memory job still tracks captures if the log cannot be written.
  }
}

async function enrichVideoEntry(entry) {
  const pageUrl = await sourceUrlForEntry(entry);
  return { ...entry, pageUrl };
}

async function sourceUrlForEntry(entry) {
  if (!entry.sourceFile) return null;
  const htmlPath = path.join(root, entry.sourceFile);
  const manifestPaths = await manifestCandidatesForHtml(htmlPath);
  for (const manifestPath of manifestPaths) {
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
  return uniqueStrings([...direct, ...matching]);
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

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function publicVideoJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    pending: job.pending.length,
    active: job.active,
    processed: job.processed.length,
    captures: job.captures.length,
    recentCaptures: job.captures.slice(-10),
    recentEvents: job.events.slice(-20)
  };
}

function videoProbeHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<title>Kaltura Probe</title>
<style>
body { font: 14px system-ui, sans-serif; margin: 20px; background: #111; color: #eee; }
#player { width: 960px; height: 540px; background: #000; }
pre { white-space: pre-wrap; }
</style>
<h1>Kaltura Probe</h1>
<div id="player"></div>
<pre id="status">Loading...</pre>
<script src="https://cdnapisec.kaltura.com/p/2616331/sp/261633100/embedIframeJs/uiconf_id/44681931/partner_id/2616331"></script>
<script>
const statusEl = document.querySelector("#status");
let player;

main().catch(err => {
  statusEl.textContent = err.stack || err.message || String(err);
});

async function main() {
  if (!globalThis.KalturaPlayer) throw new Error("KalturaPlayer did not load");
  player = KalturaPlayer.setup({
    targetId: "player",
    provider: {
      partnerId: 2616331,
      uiConfId: 44681931
    },
    playback: {
      autoplay: true,
      muted: true
    }
  });

  while (true) {
    const next = await fetch("/videos/next").then(r => r.json());
    if (!next.entry) {
      statusEl.textContent = "No more entries.";
      break;
    }
    await probe(next.entry);
  }
}

async function probe(entry) {
  statusEl.textContent = "Probing " + entry.module + " / " + entry.pageTitle + " / " + entry.entryId;
  window.postMessage({ type: "video-probe-active", entry }, "*");
  try {
    await player.loadMedia({ entryId: entry.entryId });
    try { await player.play(); } catch {}
    await sleep(14000);
  } catch (err) {
    statusEl.textContent += "\\n" + (err.message || String(err));
    await sleep(3000);
  }
  window.postMessage({ type: "video-probe-done", entry }, "*");
  await sleep(500);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
</script>`;
}

function videoDriverHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<title>Brightspace Video Driver</title>
<style>
body { font: 14px system-ui, sans-serif; margin: 20px; background: #111; color: #eee; }
pre { white-space: pre-wrap; }
</style>
<h1>Brightspace Video Driver</h1>
<pre id="status">Preparing next video...</pre>
<script>
const statusEl = document.querySelector("#status");
main().catch(err => {
  statusEl.textContent = err.stack || err.message || String(err);
});

async function main() {
  const next = await fetch("/videos/next").then(r => r.json());
  if (!next.entry) {
    statusEl.textContent = "No more video entries.";
    return;
  }

  const entry = next.entry;
  statusEl.textContent = "Opening " + entry.module + " / " + entry.pageTitle + " / " + entry.entryId;
  window.postMessage({ type: "video-probe-active", entry }, "*");
  await sleep(400);

  if (!entry.pageUrl) {
    statusEl.textContent += "\\nNo Brightspace source URL was found for this entry.";
    window.postMessage({ type: "video-probe-done", entry }, "*");
    return;
  }

  location.href = entry.pageUrl;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
</script>`;
}

async function recordJobPage(body) {
  const job = jobs.get(body.jobId);
  if (!job) throw new Error(`Unknown job: ${body.jobId}`);

  job.updatedAt = new Date().toISOString();
  const pageUrl = body.url || body.page?.url;
  if (body.error) {
    job.failed.push({ url: pageUrl, error: body.error });
    pushEvent(job, "page failed", { url: pageUrl, error: body.error });
  } else if (job.visited.includes(pageUrl)) {
    pushEvent(job, "page already archived", { url: pageUrl });
  } else {
    const saved = await archivePage(body.page);
    job.saved.push(...saved);
    addVisited(job, pageUrl);
    enqueueLinks(job, body.page?.extraction);
    pushEvent(job, "page archived", {
      url: body.page?.url,
      title: body.page?.title,
      pending: job.pending.length,
      visited: job.visited.length
    });
  }

  const nextUrl = nextPending(job);
  if (!nextUrl) {
    job.status = "complete";
    pushEvent(job, "job complete", {
      visited: job.visited.length,
      failed: job.failed.length,
      saved: job.saved.length
    });
  }

  return { job: publicJob(job), nextUrl };
}

function enqueueLinks(job, extraction = {}) {
  const links = extraction.brightspaceLinks || [];

  for (const link of links) {
    const url = typeof link === "string" ? link : link.url;
    if (!isAllowedJobUrl(job, url)) continue;
    if (job.visited.includes(url) || job.pending.includes(url)) continue;
    job.pending.push(url);
  }
}

function nextPending(job) {
  while (job.pending.length > 0) {
    if (job.visited.length >= job.maxPages) {
      job.status = "complete";
      pushEvent(job, "max page limit reached", { maxPages: job.maxPages });
      return null;
    }
    const url = job.pending.shift();
    if (!job.visited.includes(url) && isAllowedJobUrl(job, url)) return url;
  }
  return null;
}

function addVisited(job, url) {
  if (url && !job.visited.includes(url)) job.visited.push(url);
}

function isAllowedJobUrl(job, url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (job.allowedHost && parsed.host !== job.allowedHost) return false;
  if (!job.courseId) return /\/d2l\//i.test(parsed.pathname);
  return (
    parsed.href.includes(`/d2l/home/${job.courseId}`) ||
    parsed.href.includes(`/d2l/le/content/${job.courseId}`) ||
    parsed.href.includes(`/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${job.courseId}`) ||
    parsed.href.includes(`/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${job.courseId}`) ||
    parsed.href.includes(`/d2l/common/dialogs/quickLink/`) ||
    parsed.href.includes(`/d2l/le/lessons/`) ||
    parsed.href.includes(`/d2l/lor/`)
  );
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    courseCode: job.courseCode,
    startUrl: job.startUrl,
    maxPages: job.maxPages,
    downloadDirect: job.downloadDirect,
    pending: job.pending.length,
    visited: job.visited.length,
    failed: job.failed.length,
    saved: job.saved.length,
    recentEvents: job.events.slice(-20)
  };
}

function pushEvent(job, message, data = {}) {
  job.events.push({ at: new Date().toISOString(), message, data });
  job.updatedAt = new Date().toISOString();
  if (job.events.length > 300) job.events.splice(0, job.events.length - 300);
}

async function saveFile(body) {
  const moduleName = detectModule(body) || "Uncategorized";
  const media = isMediaName(body.fileName || body.url);
  const doc = isDocName(body.fileName || body.url);
  const bucket = media ? "Videos" : doc ? "Documents" : "Downloads";
  const dir = path.join(root, moduleName, bucket);
  await fs.mkdir(dir, { recursive: true });

  const rawName = body.fileName || fileNameFromUrl(body.url) || "download.bin";
  const fileName = safeName(rawName);
  const filePath = uniquePath(path.join(dir, fileName));
  const comma = body.dataUrl?.indexOf(",");
  if (!body.dataUrl || comma < 0) throw new Error("save-file requires a dataUrl");

  await fs.writeFile(filePath, Buffer.from(body.dataUrl.slice(comma + 1), "base64"));
  const manifestPath = `${filePath}.manifest.json`;
  await fs.writeFile(manifestPath, JSON.stringify({
    collectedAt: new Date().toISOString(),
    moduleName,
    sourcePage: body.sourcePage,
    url: body.url,
    contentType: body.contentType,
    fileName
  }, null, 2), "utf8");

  return [filePath, manifestPath];
}

function wrapTextPage(body) {
  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(body.title || "Brightspace Page")}</title>
<h1>${escapeHtml(body.title || body.label || "Brightspace Page")}</h1>
<p><a href="${escapeHtml(body.url || "")}">${escapeHtml(body.url || "")}</a></p>
<pre>${escapeHtml(body.text || "")}</pre>`;
}

function detectModule(body) {
  const haystack = [
    body.module,
    body.title,
    body.label,
    body.url,
    body.text,
    JSON.stringify(body.extraction?.breadcrumbs || [])
  ].filter(Boolean).join(" ");

  const match = haystack.match(/\bmodule\s*0?([1-9]|1[0-5])\b/i)
    || haystack.match(/\bweek\s*0?([1-9]|1[0-5])\b/i);
  if (!match) return null;

  const number = Number(match[1]);
  if (number >= 1 && number <= 3) return `Module ${number}`;
  return `Module${number}`;
}

function detectCourseId(url) {
  const match = String(url || "").match(/\/d2l\/home\/(\d+)/i)
    || String(url || "").match(/\/d2l\/le\/content\/(\d+)/i);
  return match?.[1] || null;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function fileNameFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return decodeURIComponent(path.basename(parsed.pathname));
  } catch {
    return null;
  }
}

function isMediaName(value = "") {
  return /\.(mp4|m4v|mov|webm|mp3|wav)$/i.test(value);
}

function isDocName(value = "") {
  return /\.(pdf|doc|docx|ppt|pptx|xls|xlsx|zip)$/i.test(value);
}

async function readJson(req, maxBytes = 100 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`request too large: ${size}`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function endJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(status === 204 ? "" : JSON.stringify(value));
}

function endHtml(res, status, value) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(value);
}

function safeName(value) {
  const cleaned = String(value || "untitled")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return cleaned || "untitled";
}

function uniquePath(candidate) {
  const parsed = path.parse(candidate);
  let current = candidate;
  let index = 2;
  while (true) {
    if (!fsSync.existsSync(current)) {
      return current;
    }
    try {
      current = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}
