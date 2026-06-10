(globalThis.__chromeCourseCollectorContent ??= (() => {
const COLLECTOR = "http://127.0.0.1:38476";

void postJson("/videos/capture", {
  event: "content-ready",
  url: location.href,
  title: document.title
}).catch(() => {});

window.addEventListener("message", event => {
  if (event.source !== window) return;
  if (event.data?.type === "video-probe-active") {
    chrome.runtime.sendMessage({ type: "video-probe-active", entry: event.data.entry });
  }
  if (event.data?.type === "video-probe-done") {
    chrome.runtime.sendMessage({ type: "video-probe-done", entry: event.data.entry });
  }
  if (event.data?.type === "video-embed-status") {
    void postJson("/videos/capture", {
      event: "video-embed-status",
      url: location.href,
      title: document.title,
      ...event.data
    }).catch(() => {});
  }
  if (event.data?.type === "video-network") {
    void postJson("/videos/capture", {
      event: "video-network",
      pageUrl: location.href,
      title: document.title,
      url: event.data.url,
      requestType: event.data.requestType
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message).then(sendResponse).catch(err => {
    sendResponse({ ok: false, message: err.message || String(err) });
  });
  return true;
});

let activeCourseRun = false;
let activeEmbeddedRun = false;
let activeVideoRun = false;
setInterval(() => {
  if (!location.href.includes("online.academyart.edu/d2l/")) return;
  void pollForJob();
  void pollForEmbeddedJob();
}, 3500);
setInterval(() => {
  if (!location.href.includes("online.academyart.edu/")) return;
  void pollForVideoJob();
}, 2500);

async function pollForJob() {
  if (activeCourseRun) return;
  activeCourseRun = true;
  try {
    const response = await fetch(`${COLLECTOR}/jobs/active`);
    if (!response.ok) return;
    const { job } = await response.json();
    if (!job || job.status !== "running") return;

    const key = `chrome-course-job:${job.id}:${location.href}`;
    const lastAttempt = Number(sessionStorage.getItem(key) || 0);
    if (lastAttempt && Date.now() - lastAttempt < 30000) return;
    sessionStorage.setItem(key, String(Date.now()));

    const page = extractCurrentPage();
    await collectEmbeddedPages(page, job);
    let downloaded = 0;
    if (job.downloadDirect) downloaded = await downloadDirectCandidates(page);

    const update = await postJson("/jobs/page", {
      jobId: job.id,
      url: location.href,
      page,
      downloaded
    });

    if (update.nextUrl && update.nextUrl !== location.href) {
      setTimeout(() => {
        location.href = update.nextUrl;
      }, 1200);
    }
  } catch (err) {
    await safePostEvent({ type: "poll error", message: err.message || String(err), url: location.href });
  } finally {
    activeCourseRun = false;
  }
}

async function pollForEmbeddedJob() {
  if (activeEmbeddedRun) return;
  activeEmbeddedRun = true;
  try {
    const active = await fetch(`${COLLECTOR}/embedded/active`);
    if (!active.ok) return;
    const { job } = await active.json();
    if (!job || job.status !== "running") return;

    const next = await fetch(`${COLLECTOR}/embedded/next?count=8`);
    if (!next.ok) return;
    const batch = await next.json();
    for (const url of batch.urls || []) {
      try {
        const response = await fetch(url, { credentials: "include" });
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !contentType.includes("text/html")) {
          await postJson("/embedded/page", { jobId: job.id, url, error: `${response.status} ${contentType}` });
          continue;
        }
        const html = await response.text();
        const page = extractHtmlPage(html, url, url);
        page.module = url;
        await downloadDirectCandidates(page);
        await postJson("/embedded/page", { jobId: job.id, url, page });
      } catch (err) {
        await postJson("/embedded/page", { jobId: job.id, url, error: err.message || String(err) });
      }
    }
  } finally {
    activeEmbeddedRun = false;
  }
}

async function pollForVideoJob() {
  if (activeVideoRun) return;
  activeVideoRun = true;
  try {
    const response = await fetch(`${COLLECTOR}/videos/current`);
    if (!response.ok) return;
    const { job } = await response.json();
    if (!job || job.status !== "running") return;

    let entry = job.active;
    if (!entry) {
      const next = await fetch(`${COLLECTOR}/videos/next`).then(r => r.json());
      entry = next.entry;
      if (!entry) return;
      await activateVideoEntry(entry);
      if (entry.pageUrl && !sameUrl(location.href, entry.pageUrl)) {
        location.href = entry.pageUrl;
        return;
      }
    }

    if (entry.pageUrl && !sameUrl(location.href, entry.pageUrl)) {
      location.href = entry.pageUrl;
      return;
    }

    const key = `chrome-course-video:${job.id}:${entry.entryId}`;
    const lastAttempt = Number(sessionStorage.getItem(key) || 0);
    if (lastAttempt && Date.now() - lastAttempt < 45000) return;
    sessionStorage.setItem(key, String(Date.now()));

    await postJson("/videos/capture", {
      event: "video-page-active",
      entry,
      url: location.href,
      title: document.title,
      playerCount: document.querySelectorAll("[data-kaltura-entry-id], .aau-video, .video iframe").length
    }).catch(() => {});
    tryStartPlayers();
    await activateVideoEntry(entry);
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "video-probe-done", entry });
      void postJson("/videos/capture", { event: "done", entry }).catch(() => {});
    }, 18000);
  } catch (err) {
    await postJson("/videos/capture", {
      event: "video-poll-error",
      url: location.href,
      title: document.title,
      error: err.message || String(err)
    }).catch(() => {});
  } finally {
    activeVideoRun = false;
  }
}

async function activateVideoEntry(entry) {
  chrome.runtime.sendMessage({ type: "video-probe-active", entry });
}

function sameUrl(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = "";
    b.hash = "";
    return a.href === b.href;
  } catch {
    return left === right;
  }
}

function tryStartPlayers() {
  tryEmbedKalturaVideos();
  const selectors = [
    "[data-kaltura-entry-id]",
    ".aau-video",
    ".video",
    "button",
    "[role='button']",
    "iframe"
  ];
  const events = ["pointerdown", "mousedown", "mouseup", "click"];
  const targets = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
  for (const target of targets) {
    try {
      target.scrollIntoView({ block: "center", inline: "center" });
      for (const type of events) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    } catch {
      // Cross-origin frames and detached nodes are expected on some pages.
    }
  }
}

function tryEmbedKalturaVideos() {
  if (document.querySelector("script[data-codex-page-embed]")) return;
  const script = document.createElement("script");
  script.dataset.codexPageEmbed = "true";
  script.src = chrome.runtime.getURL("page_embed.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

async function handleMessage(message) {
  if (message.action === "collectCurrent") {
    const page = extractCurrentPage();
    await postJson("/archive-page", page);
    if (message.downloadDirect) await downloadDirectCandidates(page);
    return { ok: true, message: `Collected current page:\n${page.title}` };
  }

  if (message.action === "archiveLinks") {
    const start = extractCurrentPage();
    await postJson("/archive-page", start);
    const links = start.extraction.brightspaceLinks.slice(0, 120);
    let archived = 1;
    let downloaded = 0;

    for (const link of links) {
      try {
        const response = await fetch(link.url, { credentials: "include" });
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !contentType.includes("text/html")) continue;

        const html = await response.text();
        const page = extractHtmlPage(html, link.url, link.text);
        await postJson("/archive-page", page);
        archived += 1;

        if (message.downloadDirect) {
          downloaded += await downloadDirectCandidates(page);
        }
      } catch {
        // Some Brightspace links require navigation or block fetch; keep going.
      }
    }

    return { ok: true, message: `Archived ${archived} pages.\nDownloaded ${downloaded} direct files.` };
  }

  throw new Error(`Unknown action: ${message.action}`);
}

function extractCurrentPage() {
  return {
    url: location.href,
    title: document.title,
    label: document.title,
    html: document.documentElement.outerHTML,
    text: document.body?.innerText || "",
    extraction: extractFromDocument(document, location.href)
  };
}

function extractHtmlPage(html, url, label) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return {
    url,
    title: parsed.title || label || url,
    label,
    html,
    text: parsed.body?.innerText || "",
    extraction: extractFromDocument(parsed, url)
  };
}

function extractFromDocument(doc, baseUrl) {
  const absolute = value => {
    try { return value ? new URL(value, baseUrl).href : null; } catch { return null; }
  };
  const text = value => (value || "").replace(/\s+/g, " ").trim();
  const allAnchors = deepQuery(doc, "a[href]");
  const allMedia = deepQuery(doc, "video, audio, source, track, iframe[src], embed[src], object[data]");
  const allFrameNodes = deepQuery(doc, "iframe[src], [data-location]");
  const allLinks = allAnchors.map(anchor => {
    const url = absolute(anchor.getAttribute("href"));
    return {
      url,
      text: text(anchor.innerText || anchor.textContent || anchor.title),
      title: text(anchor.title),
      extension: extension(url),
      module: text(anchor.closest("[aria-label*='Module' i]")?.getAttribute("aria-label") || "")
    };
  }).filter(item => item.url);

  const media = allMedia.map(node => ({
    url: absolute(node.currentSrc || node.src || node.getAttribute("src") || node.getAttribute("data")),
    text: text(node.title || node.getAttribute("aria-label") || node.closest("[aria-label]")?.getAttribute("aria-label")),
    extension: extension(node.currentSrc || node.src || node.getAttribute("src") || node.getAttribute("data"))
  })).filter(item => item.url);

  const embeddedPages = allFrameNodes.map(node => ({
    url: absolute(node.getAttribute("src") || node.getAttribute("data-location")),
    title: text(node.title || node.getAttribute("data-title") || node.getAttribute("aria-label") || node.id),
    extension: extension(node.getAttribute("src") || node.getAttribute("data-location"))
  })).filter(item => item.url && (
    item.url.includes("/content/enforced/") ||
    /kaltura|brightcove|panopto|wistia|vimeo|youtube|player/i.test(item.url)
  ));

  const documents = allLinks.filter(item => /\.(pdf|docx?|pptx?|xlsx?|zip)$/i.test(item.url));
  const directMedia = [...media, ...allLinks].filter(item => (
    /\.(mp4|m4v|mov|webm|mp3|wav|m3u8|mpd)$/i.test(item.url) ||
    /kaltura|brightcove|panopto|wistia|vimeo|youtube|player/i.test(item.url)
  ));
  const brightspaceLinks = allLinks.filter(item => (
    item.url.includes("/d2l/le/") ||
    item.url.includes("/d2l/lms/") ||
    item.url.includes("/d2l/common/") ||
    item.url.includes("/d2l/lor/") ||
    item.url.includes("/d2l/home/")
  ));

  return {
    documents: uniqueByUrl(documents),
    media: uniqueByUrl(directMedia),
    embeddedPages: uniqueByUrl(embeddedPages),
    brightspaceLinks: uniqueByUrl(brightspaceLinks),
    breadcrumbs: deepQuery(doc, "[aria-current], nav a, d2l-navigation a").map(node => text(node.innerText || node.textContent)).filter(Boolean)
  };
}

async function collectEmbeddedPages(page, job) {
  const embedded = (page.extraction.embeddedPages || []).slice(0, 12);
  const nestedMedia = [];
  const nestedFrames = [];

  for (const frame of embedded) {
    try {
      const response = await fetch(frame.url, { credentials: "include" });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("text/html")) continue;

      const html = await response.text();
      const inner = extractHtmlPage(html, frame.url, frame.title || page.title);
      inner.module = page.title || page.label;
      inner.label = `${page.title || "Brightspace Page"} / ${frame.title || inner.title}`;
      await postJson("/archive-page", inner);

      nestedMedia.push(...inner.extraction.media.map(item => ({
        ...item,
        sourceFrame: frame.url,
        sourcePage: page.url
      })));
      nestedFrames.push(...inner.extraction.embeddedPages.map(item => ({
        ...item,
        sourceFrame: frame.url,
        sourcePage: page.url
      })));

      if (job.downloadDirect) {
        await downloadDirectCandidates(inner);
      }
    } catch (err) {
      await safePostEvent({
        jobId: job.id,
        type: "embedded fetch failed",
        message: err.message || String(err),
        url: frame.url
      });
    }
  }

  page.extraction.media = uniqueByUrl([...(page.extraction.media || []), ...nestedMedia]);
  page.extraction.embeddedPages = uniqueByUrl([...(page.extraction.embeddedPages || []), ...nestedFrames]);
}

async function downloadDirectCandidates(page) {
  const candidates = uniqueByUrl([
    ...page.extraction.documents,
    ...page.extraction.media
  ]).slice(0, 80);
  let saved = 0;

  for (const item of candidates) {
    try {
      const response = await fetch(item.url, { credentials: "include" });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (blob.size > 1500 * 1024 * 1024) continue;
      const dataUrl = await blobToDataUrl(blob);
      await postJson("/save-file", {
        url: item.url,
        sourcePage: page.url,
        module: item.module || page.title || page.label,
        fileName: fileNameFromUrl(item.url),
        contentType: response.headers.get("content-type"),
        dataUrl
      });
      saved += 1;
    } catch {
      // Streamed players, signed resources, and blocked cross-origin files are left in the manifest.
    }
  }

  return saved;
}

function deepQuery(root, selector) {
  const found = [];
  const visit = node => {
    if (!node) return;
    if (node.querySelectorAll) found.push(...node.querySelectorAll(selector));
    const nodes = node.querySelectorAll ? node.querySelectorAll("*") : [];
    for (const child of nodes) {
      if (child.shadowRoot) visit(child.shadowRoot);
    }
  };
  visit(root);
  return found;
}

function uniqueByUrl(items) {
  return [...new Map(items.filter(item => item.url).map(item => [item.url, item])).values()];
}

function extension(url) {
  try {
    const match = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]{2,8})$/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function fileNameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    return name || "download.bin";
  } catch {
    return "download.bin";
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function postJson(path, body) {
  const response = await fetch(`${COLLECTOR}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Collector ${path} failed: ${response.status}`);
  return response.json();
}

async function safePostEvent(body) {
  try {
    await fetch(`${COLLECTOR}/jobs/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    // Nothing useful to do if the local collector is not reachable.
  }
}
return true;
})());
