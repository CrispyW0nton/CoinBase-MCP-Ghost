chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});

const activeEntriesByTab = new Map();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && changeInfo.status !== "loading") return;
  if (!isCollectorPage(tab.url || "")) return;
  chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "video-probe-active" && sender.tab?.id != null) {
    activeEntriesByTab.set(sender.tab.id, message.entry);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "video-probe-done" && sender.tab?.id != null) {
    void postCapture({
      entry: message.entry,
      event: "done",
      tabId: sender.tab.id
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "video-start-players" && sender.tab?.id != null) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: embedKalturaVideosInPage
    }).then(results => {
      sendResponse({ ok: true, results });
    }).catch(err => {
      sendResponse({ ok: false, message: err.message || String(err) });
    });
    return true;
  }

  return false;
});

chrome.webRequest.onBeforeRequest.addListener(
  details => {
    if (details.tabId < 0) return;
    const entry = activeEntriesByTab.get(details.tabId) || null;
    if (!isInterestingMediaRequest(details.url)) return;

    void postCapture({
      entry,
      event: "request",
      tabId: details.tabId,
      url: details.url,
      type: details.type,
      timeStamp: details.timeStamp
    });
  },
  { urls: ["*://*.kaltura.com/*", "*://*.kaltura.com:*/*", "*://*.akadns.net/*", "*://*.akamaihd.net/*"] }
);

function isInterestingMediaRequest(url) {
  return /kaltura|akadns|akamaihd/i.test(url);
}

function isCollectorPage(url) {
  return /^https:\/\/online\.academyart\.edu\//i.test(url)
    || /^http:\/\/127\.0\.0\.1:38476\/video-/i.test(url);
}

async function postCapture(payload) {
  try {
    await fetch("http://127.0.0.1:38476/videos/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    // The local collector may be stopped; do not interrupt browser use.
  }
}

function embedKalturaVideosInPage() {
  const post = data => window.postMessage({ type: "video-embed-status", ...data }, "*");
  const embed = () => {
    const videos = [...document.querySelectorAll(".aau-video[data-kaltura-entry-id]")];
    if (!window.kWidget?.embed) {
      post({ hasKWidget: false, found: videos.length, embedded: 0 });
      return false;
    }
    let embedded = 0;
    for (const element of videos) {
      if (element.classList.contains("kWidgetIframeContainer")) continue;
      const entryId = element.getAttribute("data-kaltura-entry-id");
      if (!entryId || !element.id) continue;
      try {
        window.kWidget.embed({
          targetId: element.id,
          wid: "_2616331",
          uiconf_id: 44681931,
          flashvars: {},
          cache_st: 1590179107,
          entry_id: entryId
        });
        embedded += 1;
      } catch (err) {
        post({ hasKWidget: true, found: videos.length, embedded, error: err.message || String(err) });
      }
    }
    post({ hasKWidget: true, found: videos.length, embedded });
    return true;
  };

  if (embed()) return;
  if (!document.querySelector("script[data-codex-kaltura-loader]")) {
    const loader = document.createElement("script");
    loader.dataset.codexKalturaLoader = "true";
    loader.src = "https://cdnapisec.kaltura.com/p/2616331/sp/261633100/embedIframeJs/uiconf_id/44681931/partner_id/2616331";
    loader.onload = () => setTimeout(embed, 250);
    document.head.appendChild(loader);
  }
  setTimeout(embed, 2000);
  setTimeout(embed, 5000);
}
