/** Local scheduler checks use real lease logic without Chrome or remote AI. */
import test from "node:test";
import assert from "node:assert/strict";
import { PreviewQueue } from "../dist/preview.js";
import { OperationQueue, serializeTools } from "../dist/scheduler.js";

test("preview session keeps a whole test exclusive and hands off FIFO", async () => {
  const queue = new PreviewQueue();
  const events = [];
  for (const id of ["A", "B", "C"]) queue.register(id, async () => { events.push("clean " + id); });
  try {
    const a = await queue.acquire("A");
    assert.equal(a.owned, true);
    assert.equal((await queue.acquire("B")).position, 1);
    assert.equal((await queue.acquire("C")).position, 2);
    assert.equal((await queue.acquire("A")).leaseId, a.leaseId);
    const b = queue.acquire("B", 1000);
    await queue.release("A");
    assert.equal((await b).owned, true);
    assert.equal((await queue.acquire("C")).owned, false);
    await queue.release("B");
    assert.equal((await queue.acquire("C")).owned, true);
    assert.deepEqual(events, ["clean A", "clean B"]);
  } finally { queue.close(); }
});

test("preview session never wakes a waiter before the owner's cleanup completes", async () => {
  const queue = new PreviewQueue();
  let finishCleanup;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  queue.register("A", async () => cleanup);
  queue.register("B", async () => {});
  try {
    await queue.acquire("A");
    await queue.acquire("B");
    let returned = false;
    const waiting = queue.acquire("B", 1000).then(result => { returned = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    const releasing = queue.release("A");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false);
    assert.equal(queue.status("B").owned, false);
    finishCleanup();
    await releasing;
    assert.equal((await waiting).owned, true);
  } finally { finishCleanup(); queue.close(); }
});

test("preview session delegates share ownership and cleanup acknowledges revocation", async () => {
  let now = 0;
  const queue = new PreviewQueue(100, () => now);
  for (const id of ["A", "QA", "B"]) queue.register(id, async () => {});
  try {
    const a = await queue.acquire("A");
    await queue.acquire("QA", 0, a.leaseToken, true);
    const pin = queue.beginActivity("QA");
    now = 200;
    await queue.sweep();
    assert.equal(queue.status("A").status, "HELD");
    queue.endActivity("QA", pin);
    now = 400;
    await queue.sweep();
    assert.equal(queue.status("QA").status, "RELEASING");
    assert.equal((await queue.acquire("B")).owned, false);
    assert.throws(() => queue.assertOwner("QA"), /LEASE_LOST/);
    await queue.release("QA");
    assert.equal((await queue.acquire("B")).owned, true);
    await assert.rejects(queue.acquire("A", 0, a.leaseToken), /LEASE_INVALID/);
  } finally { queue.close(); }
});

test("preview session cancels waiters, ignores status heartbeats, and fences delayed work", async () => {
  let now = 0;
  const queue = new PreviewQueue(100, () => now, 1000);
  for (const id of ["A", "B", "C"]) queue.register(id, async () => {});
  try {
    await queue.acquire("A");
    const abort = new AbortController();
    const waiting = queue.acquire("B", 1000, undefined, false, abort.signal);
    await Promise.resolve();
    abort.abort();
    await assert.rejects(waiting, /aborted/i);
    assert.equal((await queue.acquire("C")).position, 1);
    now = 200;
    queue.status("A");
    await queue.sweep();
    assert.equal((await queue.acquire("C")).owned, true);
    assert.throws(() => queue.assertOwner("A"), /LEASE_LOST/);
    await queue.release("C", true);
    await assert.rejects(queue.acquire("C"), /SESSION_CLOSED/);
  } finally { queue.close(); }
});

test("preview session disconnected QA keeps the group blocked until Runtime cleanup is acknowledged", async () => {
  const queue = new PreviewQueue();
  for (const id of ["A", "QA", "B", "recovered"]) queue.register(id, async () => {});
  try {
    const a = await queue.acquire("A");
    await queue.acquire("QA", 0, a.leaseToken, true);
    queue.beginActivity("QA");
    await queue.release("QA", true);
    assert.equal(queue.status("A").status, "RELEASING");
    assert.equal((await queue.acquire("B")).owned, false);
    await assert.rejects(queue.acquire("recovered", 0, "wrong", true, undefined, "QA"), /LEASE_INVALID/);
    const cleanup = await queue.acquire("recovered", 0, a.leaseToken, true, undefined, "QA");
    assert.equal(cleanup.status, "RELEASING");
    await queue.release("recovered");
    await queue.release("A");
    assert.equal((await queue.acquire("B")).owned, true);
  } finally { queue.close(); }
});

test("preview session guards stock tools and permits queue controls without browser access", async () => {
  const queue = new OperationQueue();
  let calls = 0;
  for (const id of ["A", "B"]) queue.preview.register(id, async () => {});
  const server = { _registeredTools: {
    evaluate_script: { handler: async () => { calls++; return "executed"; } },
    debug_session_status: { handler: async () => queue.preview.status("B") },
  }};
  serializeTools(server, queue, "B");
  try {
    await queue.preview.acquire("A");
    const abort = new AbortController();
    const blocked = server._registeredTools.evaluate_script.handler({}, { signal: abort.signal });
    await Promise.resolve();
    assert.equal((await server._registeredTools.debug_session_status.handler({}, {})).owned, false);
    abort.abort();
    await assert.rejects(blocked, /aborted/i);
    assert.equal(calls, 0);
    await queue.preview.release("A");
    assert.equal(await server._registeredTools.evaluate_script.handler({}, {}), "executed");
    assert.equal(calls, 1);
  } finally { queue.preview.close(); }
});
