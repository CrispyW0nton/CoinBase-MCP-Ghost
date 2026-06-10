// src/journal.js
// ---------------------------------------------------------------------------
// Two read-only sinks for normalized market-data events:
//   1. RingBuffer  — last N events in memory, for coinbase_snapshot_state.
//   2. JsonlJournal — append-only on-disk log at ./journal/<symbol>/<date>.jsonl
//
// DESIGN DECISION — append-only JSONL.
//   Kleppmann, "Designing Data-Intensive Applications" (Ch. 3 "Storage and
//   Retrieval", the log-structured / append-only discussion, and Ch. 11
//   "Stream Processing"): an append-only log is the simplest durable substrate
//   for an event stream, is trivially recoverable, and preserves total order
//   as written. We use one line per event (newline-delimited JSON) so the
//   journal is greppable, tail-able, and replayable without a parser lock.
//
// DESIGN DECISION — ring-buffer sizing.
//   Kleppmann (Ch. 11) distinguishes bounded vs unbounded buffers; an
//   unbounded in-memory buffer is a memory leak waiting to happen on a feed
//   that ticks many times per second. We bound it. Default capacity 50_000
//   events ≈ several minutes of a busy BTC-USD L2 feed, which is enough for
//   the snapshot/debug use case without unbounded growth. The disk journal is
//   the durable record; the ring buffer is only a recent-history window.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { serializeEvent } from "./schema.js";

export class RingBuffer {
  constructor(capacity = 50_000) {
    this.capacity = capacity;
    this.buf = [];
  }

  push(evt) {
    this.buf.push(evt);
    if (this.buf.length > this.capacity) {
      // Drop oldest. Array.shift is O(n); for the snapshot/debug use case at
      // our capacities this is acceptable and keeps the code trivially correct.
      this.buf.shift();
    }
  }

  // Return the most recent `n` events (serialized JSON-safe), newest last.
  recent(n = this.capacity) {
    const slice = this.buf.slice(Math.max(0, this.buf.length - n));
    return slice.map(serializeEvent);
  }

  // Most recent event of a given type, or null.
  lastOfType(type) {
    for (let i = this.buf.length - 1; i >= 0; i--) {
      if (this.buf[i].type === type) return serializeEvent(this.buf[i]);
    }
    return null;
  }

  counts() {
    const out = {};
    for (const evt of this.buf) out[evt.type] = (out[evt.type] || 0) + 1;
    return out;
  }

  size() {
    return this.buf.length;
  }

  clear() {
    this.buf = [];
  }
}

export class JsonlJournal {
  // baseDir defaults to ./journal at the process cwd.
  constructor({ baseDir = path.join(process.cwd(), "journal"), symbol = "BTC-USD" } = {}) {
    this.baseDir = baseDir;
    this.symbol = symbol;
    this.stream = null;
    this.currentPath = null;
  }

  #pathForToday() {
    const date = new Date().toISOString().slice(0, 10); // yyyy-mm-dd (UTC)
    return path.join(this.baseDir, this.symbol, `${date}.jsonl`);
  }

  #ensureStream() {
    const target = this.#pathForToday();
    if (this.stream && this.currentPath === target) return;
    if (this.stream) this.stream.end();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.stream = fs.createWriteStream(target, { flags: "a" });
    this.currentPath = target;
  }

  append(evt) {
    this.#ensureStream();
    const line = JSON.stringify(serializeEvent(evt));
    this.stream.write(line + "\n");
    return this.currentPath;
  }

  async close() {
    if (this.stream) {
      await new Promise(resolve => this.stream.end(resolve));
      this.stream = null;
    }
  }

  // Count lines in today's journal — used by the smoke test.
  async lineCount() {
    const target = this.#pathForToday();
    try {
      const data = await fsp.readFile(target, "utf8");
      return data.split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  path() {
    return this.currentPath ?? this.#pathForToday();
  }
}
