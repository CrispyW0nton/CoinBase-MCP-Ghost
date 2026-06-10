import WebSocket from "ws";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const DEFAULT_DEBUG_URL = "http://127.0.0.1:9222";

export async function fetchVersion(debugUrl = DEFAULT_DEBUG_URL) {
  const response = await fetch(`${trimSlash(debugUrl)}/json/version`);
  if (!response.ok) {
    throw new Error(`Chrome debug endpoint returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function isDebugEndpointReady(debugUrl = DEFAULT_DEBUG_URL) {
  try {
    await fetchVersion(debugUrl);
    return true;
  } catch {
    return false;
  }
}

export async function listTabs(debugUrl = DEFAULT_DEBUG_URL) {
  const response = await fetch(`${trimSlash(debugUrl)}/json/list`);
  if (!response.ok) {
    throw new Error(`Chrome debug endpoint returned ${response.status} ${response.statusText}`);
  }

  const tabs = await response.json();
  return tabs
    .filter(tab => tab.type === "page")
    .map(tab => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      webSocketDebuggerUrl: tab.webSocketDebuggerUrl
    }));
}

export async function openNewTab({ debugUrl = DEFAULT_DEBUG_URL, url = "about:blank" } = {}) {
  const response = await fetch(`${trimSlash(debugUrl)}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });
  if (!response.ok) {
    throw new Error(`Chrome new-tab endpoint returned ${response.status} ${response.statusText}`);
  }

  const tab = await response.json();
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    webSocketDebuggerUrl: tab.webSocketDebuggerUrl
  };
}

export async function launchChromeDebug({
  debugUrl = DEFAULT_DEBUG_URL,
  chromePath,
  userDataDir,
  url = "about:blank",
  extraArgs = [],
  waitMs = 10000
} = {}) {
  const wasReady = await isDebugEndpointReady(debugUrl);
  if (wasReady) {
    const tab = await openNewTab({ debugUrl, url });
    return {
      launched: false,
      debugUrl,
      tab,
      version: await fetchVersion(debugUrl)
    };
  }

  const executable = chromePath || defaultChromePath();
  const profile = userDataDir || defaultProfileDir();
  const port = portFromDebugUrl(debugUrl);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...extraArgs,
    url || "about:blank"
  ];

  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  const version = await waitForDebugEndpoint(debugUrl, waitMs);
  const tabs = await listTabs(debugUrl).catch(() => []);
  return {
    launched: true,
    debugUrl,
    chromePath: executable,
    userDataDir: profile,
    pid: child.pid,
    version,
    tab: tabs[0] || null
  };
}

export async function pickTab({ debugUrl, tabId, urlContains, titleContains } = {}) {
  const tabs = await listTabs(debugUrl);
  const lowerUrl = urlContains?.toLowerCase();
  const lowerTitle = titleContains?.toLowerCase();

  const tab =
    (tabId ? tabs.find(candidate => candidate.id === tabId) : null) ??
    (lowerUrl ? tabs.find(candidate => candidate.url.toLowerCase().includes(lowerUrl)) : null) ??
    (lowerTitle ? tabs.find(candidate => candidate.title.toLowerCase().includes(lowerTitle)) : null) ??
    tabs[0];

  if (!tab) throw new Error("No Chrome page tabs found. Is Chrome running with --remote-debugging-port=9222?");
  return tab;
}

export class ChromeSession {
  constructor(tab) {
    this.tab = tab;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.tab.webSocketDebuggerUrl);
    this.ws.on("message", data => this.#onMessage(data));
    this.ws.on("error", err => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      for (const waiters of this.eventWaiters.values()) {
        for (const { reject } of waiters) reject(err);
      }
      this.eventWaiters.clear();
    });

    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });

    return this;
  }

  close() {
    this.ws?.close();
  }

  command(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome session is not connected");
    }

    const id = this.nextId++;
    const payload = { id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  async evaluate(expression, options = {}) {
    const response = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      ...options
    });

    if (response.exceptionDetails) {
      const text = response.exceptionDetails.text || "Runtime.evaluate failed";
      throw new Error(text);
    }

    return response.result?.value;
  }

  waitForEvent(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) ?? [];
      const entry = {
        resolve: params => {
          clearTimeout(timer);
          resolve(params);
        },
        reject
      };
      const timer = setTimeout(() => {
        const nextWaiters = (this.eventWaiters.get(method) ?? []).filter(waiter => waiter !== entry);
        this.eventWaiters.set(method, nextWaiters);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      waiters.push(entry);
      this.eventWaiters.set(method, waiters);
    });
  }

  #onMessage(data) {
    const message = JSON.parse(data.toString());
    if (message.method && this.eventWaiters.has(message.method)) {
      const waiters = this.eventWaiters.get(message.method);
      const waiter = waiters.shift();
      if (waiters.length === 0) this.eventWaiters.delete(message.method);
      if (waiter) waiter.resolve(message.params);
      return;
    }

    if (!message.id || !this.pending.has(message.id)) return;

    const { resolve, reject } = this.pending.get(message.id);
    this.pending.delete(message.id);

    if (message.error) {
      reject(new Error(`${message.error.message}: ${message.error.data || ""}`.trim()));
    } else {
      resolve(message.result);
    }
  }
}

export async function withSession(selection, fn) {
  const tab = await pickTab(selection);
  const session = await new ChromeSession(tab).connect();
  try {
    return await fn(session, tab);
  } finally {
    session.close();
  }
}

async function waitForDebugEndpoint(debugUrl, waitMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < waitMs) {
    try {
      return await fetchVersion(debugUrl);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`Chrome debug endpoint did not become ready at ${debugUrl}: ${lastError?.message || "timeout"}`);
}

function defaultChromePath() {
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
    ];
    return candidates.find(Boolean);
  }

  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  return process.env.CHROME_PATH || "google-chrome";
}

function defaultProfileDir() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "ChromeMCPProfile");
  }
  return path.join(os.homedir(), ".chrome-mcp-profile");
}

function portFromDebugUrl(debugUrl = DEFAULT_DEBUG_URL) {
  try {
    const parsed = new URL(debugUrl);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return "9222";
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trimSlash(value = DEFAULT_DEBUG_URL) {
  return value.replace(/\/+$/, "");
}
