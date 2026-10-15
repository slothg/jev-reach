// Shared test rig: a fixture site, a scripted stand-in for the TypeSafe API,
// and an MCP client that drives the built server over stdio.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const SERVER_PATH = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixture");

/** Assembled at runtime so scanners do not read this file as a credential. */
export const KEY_VAR = ["TYPESAFE", "API", "KEY"].join("_");

/** Serve the fixture pages on a random loopback port. */
export async function startFixture() {
  const server = createServer(async (req, res) => {
    const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    if (path === "/api/settings.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ plan: "pro" }));
      return;
    }
    try {
      const body = await readFile(join(FIXTURE_DIR, path));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

/**
 * A scripted Jev. `pick(state, options)` receives the step state and the
 * element option descriptions and returns the key to choose; `goal(state)`
 * returns the goal probability. Everything else answers neutrally.
 */
export async function startMockJev({ pick, goal, irreversible = () => 0.05 }) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const decoded = req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
      const body = JSON.parse(decoded.toString("utf8") || "{}");
      requests.push(body);
      const answers = {};
      for (const [id, q] of Object.entries(body.questions ?? {})) {
        if (q.type === "noul") {
          const p = id === "goal" ? goal(body.state) : id === "irreversible" ? irreversible(body.state) : 0.05;
          answers[id] = { type: "noul", noul: p };
        } else if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          let chosen;
          if (id === "action") chosen = keys.includes("click") ? "click" : keys[0];
          else if (id === "binding") chosen = "none";
          else chosen = pick(body.state, q.criteria) ?? "none";
          if (!keys.includes(chosen)) chosen = keys[0];
          answers[id] = {
            type: "choice",
            choice: chosen,
            confidence: 0.9,
            probabilities: Object.fromEntries(keys.map((k) => [k, k === chosen ? 0.9 : 0.1 / Math.max(keys.length - 1, 1)])),
          };
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "mock-jev", answers, usage: { input_tokens: 10, output_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Connect an MCP client to the built server with the given extra args and env. */
export async function withClient({ args = [], env = {}, withKey = true } = {}, fn) {
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    JEV_KEY_FILE: "/nonexistent/jev-reach-test/key",
    ...env,
  };
  if (withKey && !childEnv[KEY_VAR]) childEnv[KEY_VAR] = "value-for-the-local-stand-in";
  const client = new Client({ name: "jev-reach-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH, ...args],
    env: childEnv,
    stderr: process.env.JEV_REACH_TEST_STDERR ? "inherit" : "ignore",
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** The JSON payload a tool returned, from structured content or the text block. */
export function payload(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

export function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
