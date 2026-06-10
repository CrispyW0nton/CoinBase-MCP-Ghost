import fs from "node:fs/promises";
import path from "node:path";
import { launchChromeDebug, listTabs, openNewTab, withSession } from "./chrome.js";
import {
  attach as coinbaseAttach,
  recon as coinbaseRecon,
  marketStream as coinbaseMarketStream,
  snapshotState as coinbaseSnapshotState,
  portfolioSnapshot as coinbasePortfolioSnapshot,
  placeOrder as coinbasePlaceOrder,
  paperLedgerState as coinbasePaperLedgerState,
  confirmLive as coinbaseConfirmLive,
  reconcilePreviewIntent as coinbaseReconcilePreviewIntent,
  diagnoseTransport as coinbaseDiagnoseTransport
} from "./coinbase.js";
import { replayBacktest as coinbaseBacktest } from "./replay.js";

const DEFAULT_DEBUG_URL = "http://127.0.0.1:9222";

export const tools = [
  {
    name: "chrome_launch",
    description: "Launch a Chrome window with the DevTools Protocol enabled, or open a new tab if it is already running.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        url: { type: "string", default: "about:blank" },
        chromePath: { type: "string" },
        userDataDir: { type: "string" },
        extraArgs: { type: "array", items: { type: "string" } },
        waitMs: { type: "number", default: 10000 }
      }
    }
  },
  {
    name: "chrome_open_tab",
    description: "Open a new tab through an existing Chrome DevTools Protocol endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        url: { type: "string", default: "about:blank" }
      }
    }
  },
  {
    name: "chrome_tabs",
    description: "List Chrome tabs exposed by the local Chrome DevTools Protocol endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL }
      }
    }
  },
  {
    name: "chrome_navigate",
    description: "Navigate the selected Chrome tab to a URL and wait briefly for the page to load.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        tabId: { type: "string" },
        urlContains: { type: "string" },
        titleContains: { type: "string" },
        url: { type: "string" },
        waitMs: { type: "number", default: 1000 }
      }
    }
  },
  {
    name: "chrome_snapshot",
    description: "Summarize the selected page with visible text, links, buttons, inputs, selects, and forms for automation planning.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        tabId: { type: "string" },
        urlContains: { type: "string" },
        titleContains: { type: "string" },
        maxTextLength: { type: "number", default: 6000 },
        maxElements: { type: "number", default: 120 }
      }
    }
  },
  {
    name: "chrome_click",
    description: "Click an element by CSS selector or visible text. Useful for control panels and file-manager buttons.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        tabId: { type: "string" },
        urlContains: { type: "string" },
        titleContains: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        exact: { type: "boolean", default: false },
        waitMs: { type: "number", default: 750 }
      }
    }
  },
  {
    name: "chrome_type",
    description: "Type into an input or textarea by CSS selector, label text, placeholder, name, id, or aria-label.",
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        tabId: { type: "string" },
        urlContains: { type: "string" },
        titleContains: { type: "string" },
        selector: { type: "string" },
        label: { type: "string" },
        value: { type: "string" },
        clear: { type: "boolean", default: true },
        submit: { type: "boolean", default: false },
        waitMs: { type: "number", default: 250 }
      }
    }
  },
  {
    name: "chrome_select",
    description: "Set a select dropdown by CSS selector or label text, matching option value or visible text.",
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        tabId: { type: "string" },
        urlContains: { type: "string" },
        titleContains: { type: "string" },
        selector: { type: "string" },
        label: { type: "string" },
        value: { type: "string" },
        waitMs: { type: "number", default: 250 }
      }
    }
  },
  {
    name: "chrome_press",
    description: "Send a keyboard key to the selected page, optionally after focusing an element.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        tabId: { type: "string" },
        urlContains: { type: "string" },
        titleContains: { type: "string" },
        selector: { type: "string" },
        key: { type: "string" },
        waitMs: { type: "number", default: 250 }
      }
    }
  },
  {
    name: "chrome_screenshot",
    description: "Capture a PNG screenshot of the selected page.",
    inputSchema: {
      type: "object",
      required: ["outputPath"],
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        tabId: { type: "string" },
        urlContains: { type: "string" },
        titleContains: { type: "string" },
        outputPath: { type: "string" },
        fullPage: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "chrome_eval",
    description: "Evaluate JavaScript in the selected tab. Use for small, explicit inspection or panel automation snippets.",
    inputSchema: {
      type: "object",
      required: ["expression"],
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        tabId: { type: "string" },
        urlContains: { type: "string" },
        titleContains: { type: "string" },
        expression: { type: "string" },
        waitMs: { type: "number", default: 0 }
      }
    }
  },
  {
    name: "chrome_extract_media",
    description: "Extract media, document, iframe, and link candidates from a selected Chrome tab.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        tabId: { type: "string" },
        urlContains: { type: "string" },
        titleContains: { type: "string" }
      }
    }
  },
  {
    name: "coinbase_diagnose_transport",
    description: "Passive transport diagnostic for Coinbase real-time data. Attaches before same-tab navigation, observes WS/SSE/poll/WebTransport on page and worker targets, writes a recon network-map + WS TAP VIABLE verdict. Never clicks or opens a Coinbase socket.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        urlContains: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], default: ["coinbase.com/advanced-trade", "coinbase.com/advanced-portfolio"] },
        durationMs: { type: "number", default: 45000 },
        outputRoot: { type: "string" }
      }
    }
  },
  {
    name: "coinbase_backtest",
    description: "OFFLINE ONLY. Replay journal JSONL through the same causal order-book-imbalance signal layer, compute IC/train-test/deflated-Sharpe metrics, and write research/IC_REPORT_<UTC>.md. No Chrome, Coinbase REST/SDK, sockets, credentials, or clicks.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", default: "BTC-USD" },
        journalDir: { type: "string", default: "journal" },
        files: { type: "array", items: { type: "string" } },
        startDate: { type: "string" },
        endDate: { type: "string" },
        horizonSeconds: { type: "number" },
        horizonObservations: { type: "number", default: 1 },
        depthLevels: { type: "number", default: 10 },
        trainFraction: { type: "number", default: 0.7 },
        trials: { type: "number", default: 1 },
        outputDir: { type: "string", default: "research" },
        writeReport: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "coinbase_attach",
    description: "Attach (fail-closed) to an already-open, already-signed-in Coinbase Advanced Trade tab in the debug profile. Returns { attached, signedIn, tab, probeResults }. Never falls back to an unrelated tab.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        urlContains: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], default: ["coinbase.com/advanced-trade", "coinbase.com/advanced-portfolio"] }
      }
    }
  },
  {
    name: "coinbase_recon",
    description: "One-shot deep reconnaissance of the live Advanced Trade page. Writes ./recon/<symbol>-<ts>/ (dom-map.json, network-map.json, behavioral.json, screenshots/, RECON_REPORT.md). Read-only; never submits an order.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        urlContains: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], default: ["coinbase.com/advanced-trade", "coinbase.com/advanced-portfolio"] },
        networkSeconds: { type: "number", default: 60 },
        sampleSeconds: { type: "number", default: 30 },
        outputRoot: { type: "string" }
      }
    }
  },
  {
    name: "coinbase_market_stream",
    description: "Mirror the page's own Coinbase WebSocket frames over CDP for durationMs, normalize into Tick/L2Update/Trade/Candle (decimal.js), fan out to an in-memory ring buffer + append-only JSONL journal, and detect sequence gaps. Read-only; opens no socket of its own.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        urlContains: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], default: ["coinbase.com/advanced-trade", "coinbase.com/advanced-portfolio"] },
        durationMs: { type: "number", default: 30000 }
      }
    }
  },
  {
    name: "coinbase_snapshot_state",
    description: "Return the current in-memory ring-buffer state collected by coinbase_market_stream (counts, last tick/trade, recent N events).",
    inputSchema: {
      type: "object",
      properties: {
        n: { type: "number", default: 200 }
      }
    }
  },
  {
    name: "coinbase_portfolio_snapshot",
    description: "Read balances + open orders directly from the Advanced Trade DOM (never from an API), using the discovered selectors with a stability-ranked fallback chain. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        debugUrl: { type: "string", default: DEFAULT_DEBUG_URL },
        urlContains: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], default: ["coinbase.com/advanced-trade", "coinbase.com/advanced-portfolio"] }
      }
    }
  },
  {
    name: "coinbase_place_order",
    description: "EXECUTION SCAFFOLD (dryRun hardcoded true). Validates a would-be order against config risk limits (mode/killSwitch/maxNotionalUsd). OBSERVE_ONLY rejects all; PAPER logs a simulated fill at best bid/ask. NEVER clicks the order form. No real order is ever placed in this pass.",
    inputSchema: {
      type: "object",
      required: ["side", "type", "clientOrderId"],
      properties: {
        side: { type: "string", enum: ["buy", "sell"] },
        type: { type: "string", enum: ["market", "limit"] },
        baseSize: { type: "string" },
        quoteSize: { type: "string" },
        limitPrice: { type: "string" },
        timeInForce: { type: "string", enum: ["GTC", "IOC", "FOK"], default: "GTC" },
        clientOrderId: { type: "string" },
        dryRun: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "coinbase_paper_ledger",
    description: "Read the in-memory PAPER trading ledger: running position, realized/unrealized P&L, recent simulated fills, and advisory half-Kelly sizing from measured PAPER outcomes. Read-only.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "coinbase_confirm_live",
    description: "Stubbed LIVE ladder third factor. Records an explicit confirmation phrase for audit but never arms or submits live orders.",
    inputSchema: {
      type: "object",
      properties: {
        phrase: { type: "string", description: "Must be CONFIRM_LIVE_STUB_ONLY to be accepted by the stub; still cannot arm LIVE." }
      }
    }
  },
  {
    name: "coinbase_reconcile_preview_intent",
    description: "Pure preview-vs-intent diff for future safety checks. Accepts intended order fields and a preview-shaped object; performs no clicking or DOM interaction.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "object" },
        preview: { type: "object" }
      }
    }
  }
];

export async function callTool(name, args) {
  switch (name) {
    case "chrome_launch":
      return textResult(await chromeLaunch(args));
    case "chrome_open_tab":
      return textResult(await chromeOpenTab(args));
    case "chrome_tabs":
      return textResult(await chromeTabs(args));
    case "chrome_navigate":
      return textResult(await chromeNavigate(args));
    case "chrome_snapshot":
      return textResult(await chromeSnapshot(args));
    case "chrome_click":
      return textResult(await chromeClick(args));
    case "chrome_type":
      return textResult(await chromeType(args));
    case "chrome_select":
      return textResult(await chromeSelect(args));
    case "chrome_press":
      return textResult(await chromePress(args));
    case "chrome_screenshot":
      return textResult(await chromeScreenshot(args));
    case "chrome_eval":
      return textResult(await chromeEval(args));
    case "chrome_extract_media":
      return textResult(await chromeExtractMedia(args));
    case "coinbase_attach":
      return textResult(JSON.stringify(await coinbaseAttach(args), null, 2));
    case "coinbase_diagnose_transport":
      return textResult(JSON.stringify(await coinbaseDiagnoseTransport(args), null, 2));
    case "coinbase_backtest":
      return textResult(JSON.stringify(await coinbaseBacktest(args), null, 2));
    case "coinbase_recon":
      return textResult(JSON.stringify(await coinbaseRecon(args), null, 2));
    case "coinbase_market_stream":
      return textResult(JSON.stringify(await coinbaseMarketStream(args), null, 2));
    case "coinbase_snapshot_state":
      return textResult(JSON.stringify(await coinbaseSnapshotState(args), null, 2));
    case "coinbase_portfolio_snapshot":
      return textResult(JSON.stringify(await coinbasePortfolioSnapshot(args), null, 2));
    case "coinbase_place_order":
      return textResult(JSON.stringify(await coinbasePlaceOrder(args), null, 2));
    case "coinbase_paper_ledger":
      return textResult(JSON.stringify(await coinbasePaperLedgerState(args), null, 2));
    case "coinbase_confirm_live":
      return textResult(JSON.stringify(await coinbaseConfirmLive(args), null, 2));
    case "coinbase_reconcile_preview_intent":
      return textResult(JSON.stringify(coinbaseReconcilePreviewIntent(args), null, 2));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function chromeLaunch(args = {}) {
  const result = await launchChromeDebug({
    debugUrl: args.debugUrl || DEFAULT_DEBUG_URL,
    url: args.url || "about:blank",
    chromePath: args.chromePath,
    userDataDir: args.userDataDir,
    extraArgs: Array.isArray(args.extraArgs) ? args.extraArgs : [],
    waitMs: Number(args.waitMs ?? 10000)
  });
  return JSON.stringify(result, null, 2);
}

async function chromeOpenTab({ debugUrl = DEFAULT_DEBUG_URL, url = "about:blank" } = {}) {
  const tab = await openNewTab({ debugUrl, url });
  return JSON.stringify({ opened: true, debugUrl, tab }, null, 2);
}

async function chromeTabs({ debugUrl = DEFAULT_DEBUG_URL } = {}) {
  const tabs = await listTabs(debugUrl);
  return JSON.stringify({ tabs }, null, 2);
}

async function chromeNavigate(args) {
  if (!args.url) throw new Error("url is required");
  return withSession(args, async (session, tab) => {
    await session.command("Page.enable");
    const load = session.waitForEvent("Page.loadEventFired", 30000).catch(err => ({ warning: err.message }));
    await session.command("Page.navigate", { url: args.url });
    await load;
    await sleep(Number(args.waitMs ?? 1000));
    const state = await session.evaluate("({ title: document.title, url: location.href })");
    return JSON.stringify({ navigated: true, from: pickPublicTab(tab), page: state }, null, 2);
  });
}

async function chromeSnapshot(args) {
  return withSession(args, async session => {
    const snapshot = await session.evaluate(panelSnapshotScript(Number(args.maxTextLength ?? 6000), Number(args.maxElements ?? 120)));
    return JSON.stringify(snapshot, null, 2);
  });
}

async function chromeClick(args) {
  if (!args.selector && !args.text) throw new Error("selector or text is required");
  return withSession(args, async session => {
    const result = await session.evaluate(`(${clickScript})(${JSON.stringify({
      selector: args.selector,
      text: args.text,
      exact: args.exact === true
    })})`);
    await sleep(Number(args.waitMs ?? 750));
    return JSON.stringify(result, null, 2);
  });
}

async function chromeType(args) {
  if (!args.selector && !args.label) throw new Error("selector or label is required");
  return withSession(args, async session => {
    const result = await session.evaluate(`(${typeScript})(${JSON.stringify({
      selector: args.selector,
      label: args.label,
      value: args.value,
      clear: args.clear !== false,
      submit: args.submit === true
    })})`);
    await sleep(Number(args.waitMs ?? 250));
    return JSON.stringify(result, null, 2);
  });
}

async function chromeSelect(args) {
  if (!args.selector && !args.label) throw new Error("selector or label is required");
  return withSession(args, async session => {
    const result = await session.evaluate(`(${selectScript})(${JSON.stringify({
      selector: args.selector,
      label: args.label,
      value: args.value
    })})`);
    await sleep(Number(args.waitMs ?? 250));
    return JSON.stringify(result, null, 2);
  });
}

async function chromePress(args) {
  return withSession(args, async session => {
    if (args.selector) {
      await session.evaluate(`document.querySelector(${JSON.stringify(args.selector)})?.focus()`);
    }
    await session.command("Input.dispatchKeyEvent", { type: "keyDown", key: args.key });
    await session.command("Input.dispatchKeyEvent", { type: "keyUp", key: args.key });
    await sleep(Number(args.waitMs ?? 250));
    return JSON.stringify({ pressed: args.key, selector: args.selector || null }, null, 2);
  });
}

async function chromeScreenshot(args) {
  if (!args.outputPath) throw new Error("outputPath is required");
  return withSession(args, async session => {
    await ensureDir(path.dirname(args.outputPath));
    await session.command("Page.enable");

    let previousMetrics = null;
    if (args.fullPage === true) {
      const metrics = await session.command("Page.getLayoutMetrics");
      const content = metrics.contentSize;
      previousMetrics = true;
      await session.command("Emulation.setDeviceMetricsOverride", {
        mobile: false,
        width: Math.ceil(content.width),
        height: Math.ceil(content.height),
        deviceScaleFactor: 1
      });
    }

    const shot = await session.command("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: args.fullPage === true
    });
    await fs.writeFile(args.outputPath, Buffer.from(shot.data, "base64"));

    if (previousMetrics) {
      await session.command("Emulation.clearDeviceMetricsOverride").catch(() => {});
    }

    const stat = await fs.stat(args.outputPath);
    return JSON.stringify({ outputPath: args.outputPath, bytes: stat.size }, null, 2);
  });
}

async function chromeEval(args) {
  return withSession(args, async session => {
    const value = await session.evaluate(args.expression);
    await sleep(Number(args.waitMs ?? 0));
    return JSON.stringify({ value }, null, 2);
  });
}

async function chromeExtractMedia(args) {
  return withSession(args, async session => {
    const extraction = await session.evaluate(extractionScript());
    return JSON.stringify(extraction, null, 2);
  });
}

function extractionScript() {
  return `(() => {
    const absolute = value => {
      try { return value ? new URL(value, location.href).href : null; } catch { return null; }
    };
    const text = value => (value || "").replace(/\\s+/g, " ").trim();
    const extension = url => {
      try {
        const clean = new URL(url).pathname.toLowerCase();
        const match = clean.match(/\\.([a-z0-9]{2,8})$/);
        return match ? match[1] : "";
      } catch { return ""; }
    };
    const docExts = new Set(["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "zip"]);
    const mediaExts = new Set(["mp4", "mov", "webm", "m4v", "mp3", "wav", "m3u8", "mpd"]);
    const unique = values => [...new Map(values.filter(item => item.url).map(item => [item.url, item])).values()];

    const videos = [...document.querySelectorAll("video")].flatMap(video => {
      const sources = [video.currentSrc, video.src, ...[...video.querySelectorAll("source")].map(source => source.src)];
      return sources.map(url => ({
        kind: "video",
        url: absolute(url),
        label: text(video.getAttribute("aria-label") || video.title || video.closest("[aria-label]")?.getAttribute("aria-label")),
        poster: absolute(video.poster)
      }));
    });

    const embedded = [...document.querySelectorAll("audio source, audio, embed[src], object[data], iframe[src], track[src]")].map(node => ({
      kind: node.tagName.toLowerCase(),
      url: absolute(node.src || node.data),
      label: text(node.title || node.getAttribute("aria-label") || node.name)
    }));

    const anchors = [...document.querySelectorAll("a[href]")].map(anchor => {
      const url = absolute(anchor.href);
      const ext = extension(url);
      return {
        kind: "anchor",
        url,
        text: text(anchor.innerText || anchor.textContent || anchor.title),
        title: text(anchor.title),
        download: anchor.download || "",
        extension: ext
      };
    });

    const resources = performance.getEntriesByType("resource").map(entry => {
      const url = absolute(entry.name);
      const ext = extension(url);
      return {
        kind: "resource",
        url,
        initiatorType: entry.initiatorType,
        extension: ext,
        transferSize: entry.transferSize || 0
      };
    });

    const combined = [...videos, ...embedded, ...anchors, ...resources];
    const media = unique(combined.filter(item => mediaExts.has(item.extension) || /video|audio|media|m3u8|mpd/i.test(item.kind + " " + item.url)));
    const documents = unique(anchors.filter(item => docExts.has(item.extension)));

    return {
      title: document.title,
      url: location.href,
      media,
      documents,
      iframes: unique([...document.querySelectorAll("iframe[src]")].map(iframe => ({
        kind: "iframe",
        url: absolute(iframe.src),
        title: text(iframe.title || iframe.name)
      })))
    };
  })()`;
}

function panelSnapshotScript(maxTextLength, maxElements) {
  return `(() => {
    const clean = value => (value || "").replace(/\\s+/g, " ").trim();
    const short = value => clean(value).slice(0, 240);
    const cssPath = element => {
      if (!element || element.nodeType !== 1) return "";
      if (element.id) return "#" + CSS.escape(element.id);
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && parts.length < 4) {
        let part = current.tagName.toLowerCase();
        if (current.classList.length) part += "." + [...current.classList].slice(0, 2).map(name => CSS.escape(name)).join(".");
        const parent = current.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter(child => child.tagName === current.tagName);
          if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(" > ");
    };
    const isVisible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const elementInfo = element => ({
      tag: element.tagName.toLowerCase(),
      selector: cssPath(element),
      text: short(element.innerText || element.textContent || element.value || element.getAttribute("aria-label") || element.title),
      id: element.id || "",
      name: element.getAttribute("name") || "",
      type: element.getAttribute("type") || "",
      placeholder: element.getAttribute("placeholder") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      href: element.href || "",
      value: element.tagName === "SELECT" ? element.value : ""
    });
    const visible = selector => [...document.querySelectorAll(selector)].filter(isVisible).slice(0, ${maxElements}).map(elementInfo);
    return {
      title: document.title,
      url: location.href,
      text: clean(document.body?.innerText || "").slice(0, ${maxTextLength}),
      buttons: visible("button, input[type=button], input[type=submit], [role=button]"),
      links: visible("a[href]"),
      inputs: visible("input:not([type=hidden]), textarea"),
      selects: visible("select"),
      forms: visible("form")
    };
  })()`;
}

function clickScript({ selector, text, exact }) {
  const clean = value => (value || "").replace(/\s+/g, " ").trim();
  const visible = element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const matchesText = element => {
    const haystack = clean(element.innerText || element.textContent || element.value || element.getAttribute("aria-label") || element.title);
    const needle = clean(text);
    return exact ? haystack === needle : haystack.toLowerCase().includes(needle.toLowerCase());
  };
  const candidates = selector
    ? [document.querySelector(selector)].filter(Boolean)
    : [...document.querySelectorAll("button, a, input[type=button], input[type=submit], [role=button], label, option")].filter(matchesText);
  const target = candidates.find(visible) || candidates[0];
  if (!target) return { clicked: false, reason: "No matching element", selector, text };
  target.scrollIntoView({ block: "center", inline: "center" });
  target.focus?.();
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  target.click();
  return {
    clicked: true,
    tag: target.tagName.toLowerCase(),
    text: clean(target.innerText || target.textContent || target.value || target.getAttribute("aria-label") || target.title).slice(0, 240),
    selector,
    requestedText: text || null
  };
}

function typeScript({ selector, label, value, clear, submit }) {
  const clean = input => (input || "").replace(/\s+/g, " ").trim();
  const findByLabel = text => {
    const needle = clean(text).toLowerCase();
    const labelElement = [...document.querySelectorAll("label")].find(item => clean(item.innerText || item.textContent).toLowerCase().includes(needle));
    if (labelElement) {
      if (labelElement.htmlFor) {
        const byFor = document.getElementById(labelElement.htmlFor);
        if (byFor) return byFor;
      }
      const nested = labelElement.querySelector("input, textarea");
      if (nested) return nested;
    }
    return [...document.querySelectorAll("input:not([type=hidden]), textarea")].find(item => {
      const haystack = [item.id, item.name, item.placeholder, item.getAttribute("aria-label"), item.title].map(clean).join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  };
  const target = selector ? document.querySelector(selector) : findByLabel(label);
  if (!target) return { typed: false, reason: "No matching input", selector, label };
  target.scrollIntoView({ block: "center", inline: "center" });
  target.focus();
  if (clear) target.value = "";
  target.value += value ?? "";
  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value ?? "" }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    target.form?.requestSubmit?.();
  }
  return { typed: true, selector, label, name: target.name || "", id: target.id || "", valueLength: String(value ?? "").length };
}

function selectScript({ selector, label, value }) {
  const clean = input => (input || "").replace(/\s+/g, " ").trim();
  const findByLabel = text => {
    const needle = clean(text).toLowerCase();
    const labelElement = [...document.querySelectorAll("label")].find(item => clean(item.innerText || item.textContent).toLowerCase().includes(needle));
    if (labelElement?.htmlFor) {
      const byFor = document.getElementById(labelElement.htmlFor);
      if (byFor?.tagName === "SELECT") return byFor;
    }
    return [...document.querySelectorAll("select")].find(item => {
      const haystack = [item.id, item.name, item.getAttribute("aria-label"), item.title].map(clean).join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  };
  const target = selector ? document.querySelector(selector) : findByLabel(label);
  if (!target) return { selected: false, reason: "No matching select", selector, label };
  const wanted = clean(value).toLowerCase();
  const option = [...target.options].find(item => item.value === value || clean(item.textContent).toLowerCase() === wanted || clean(item.textContent).toLowerCase().includes(wanted));
  if (!option) return { selected: false, reason: "No matching option", options: [...target.options].map(item => ({ value: item.value, text: clean(item.textContent) })) };
  target.value = option.value;
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: true, selector, label, value: option.value, text: clean(option.textContent) };
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function pickPublicTab(tab) {
  return { id: tab.id, title: tab.title, url: tab.url };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
