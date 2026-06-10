(() => {
  const post = data => window.postMessage({ type: "video-embed-status", ...data }, "*");
  installNetworkCapture();

  function postNetwork(url, requestType) {
    if (!url || !/kaltura|akadns|akamaihd|m3u8|mp4|manifest|flavor|hls|dash/i.test(String(url))) return;
    window.postMessage({ type: "video-network", url: String(url), requestType }, "*");
  }

  function installNetworkCapture() {
    if (window.__codexKalturaNetworkCapture) return;
    window.__codexKalturaNetworkCapture = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function(input, init) {
        try {
          postNetwork(typeof input === "string" ? input : input?.url, "fetch");
        } catch {}
        return originalFetch.apply(this, arguments);
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try {
        postNetwork(url, "xhr");
      } catch {}
      return originalOpen.apply(this, arguments);
    };
  }

  const mediaUrls = () => [...document.querySelectorAll("video, audio, source")]
    .map(element => element.currentSrc || element.src || element.getAttribute("src"))
    .filter(Boolean);

  const embed = () => {
    const videos = [...document.querySelectorAll(".aau-video[data-kaltura-entry-id]")];
    const frames = [...document.querySelectorAll("iframe[src]")].map(frame => frame.src).filter(Boolean);
    const media = mediaUrls();
    const sample = videos.slice(0, 3).map(element => element.outerHTML.slice(0, 700));
    if (!window.kWidget?.embed) {
      post({ hasKWidget: false, found: videos.length, embedded: 0, frames, media, sample });
      return false;
    }

    let embedded = 0;
    for (const element of videos) {
      if (element.querySelector("iframe")) continue;
      element.classList.remove("kWidgetIframeContainer");
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
        post({ hasKWidget: true, found: videos.length, embedded, frames, media, sample, error: err.message || String(err) });
      }
    }

    post({ hasKWidget: true, found: videos.length, embedded, frames, media, sample });
    setTimeout(() => post({
      hasKWidget: true,
      found: videos.length,
      embedded,
      frames: [...document.querySelectorAll("iframe[src]")].map(frame => frame.src).filter(Boolean),
      media: mediaUrls(),
      sample: videos.slice(0, 3).map(element => element.outerHTML.slice(0, 700))
    }), 3000);
    setTimeout(() => post({
      hasKWidget: true,
      found: videos.length,
      embedded,
      frames: [...document.querySelectorAll("iframe[src]")].map(frame => frame.src).filter(Boolean),
      media: mediaUrls(),
      sample: videos.slice(0, 3).map(element => element.outerHTML.slice(0, 700))
    }), 8000);
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
})();
