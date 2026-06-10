#!/usr/bin/env node
import { tools, callTool } from "./tools.js";

const protocolVersion = "2024-11-05";
let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}

async function handle(request) {
  if (!request || request.jsonrpc !== "2.0") return;

  const { id, method, params } = request;
  try {
    if (method === "initialize") {
      result(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "coinbase-mcp-ghost", version: "0.2.0" }
      });
      return;
    }

    if (method === "notifications/initialized") return;

    if (method === "tools/list") {
      result(id, { tools });
      return;
    }

    if (method === "tools/call") {
      const output = await callTool(params?.name, params?.arguments ?? {});
      result(id, output);
      return;
    }

    error(id, -32601, `Unknown method: ${method}`);
  } catch (err) {
    error(id, -32000, err.message || String(err), err.stack);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch (err) {
      error(null, -32700, err.message || String(err));
    }
  }
});

process.stdin.on("end", () => {
  if (!buffer.trim()) return;
  try {
    void handle(JSON.parse(buffer));
  } catch (err) {
    error(null, -32700, err.message || String(err));
  }
});
