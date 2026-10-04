// The wrapper boots, exposes every stock tool plus `reach`, and refuses to
// walk without a key. No Chrome is launched: tools/list and the key check both
// run before the browser is touched.

import assert from "node:assert/strict";
import test from "node:test";
import { payload, withClient } from "./helpers.mjs";

test("the server lists the stock devtools tools and reach", async () => {
  await withClient({ args: ["--isolated", "--headless"] }, async (client) => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const expected of ["reach", "list_pages", "navigate_page", "take_snapshot", "list_console_messages", "list_network_requests", "take_screenshot"]) {
      assert.ok(names.has(expected), `missing tool ${expected}`);
    }
    const reach = tools.find((t) => t.name === "reach");
    assert.ok(reach.inputSchema.properties.goal, "reach takes a goal");
    assert.ok(reach.inputSchema.properties.values, "reach takes values");
  });
});

test("reach without a key fails before touching the browser", async () => {
  await withClient({ args: ["--isolated", "--headless"], withKey: false }, async (client) => {
    const result = await client.callTool({ name: "reach", arguments: { goal: "anything" } });
    assert.equal(result.isError, true);
    assert.match(payload(result).error, /No API key/);
  });
});

test("the first CLI option reaches the upstream parser", async () => {
  await withClient({ args: ["--no-category-performance", "--isolated", "--headless"] }, async (client) => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes("list_pages"));
    assert.ok(!names.includes("performance_start_trace"), "the first flag must not be discarded as an argv prefix");
  });
});
