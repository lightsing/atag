import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientError,pollOperation,validateAgentBaseUrl} from "../lib/client-support.ts";
async function rejectsWith(promise,code){await assert.rejects(promise,error=>error instanceof ClientError&&error.code===code);}

test("validates agent base URLs", () => {
  assert.deepEqual(validateAgentBaseUrl(" http://127.0.0.1:18432/ "), { ok: true, url: "http://127.0.0.1:18432" });
  assert.equal(validateAgentBaseUrl("https://agent.local/base/").url, "https://agent.local/base");
  for (const bad of ["", "127.0.0.1:18432", "ftp://127.0.0.1", "http://u:p@127.0.0.1", "http://127.0.0.1/?x=1", "http://127.0.0.1/#a"]) {
    assert.equal(validateAgentBaseUrl(bad).ok, false, bad);
  }
});

const op = (status, extra = {}) => ({
  id: "op_1", deviceId: "tag_1", kind: "refresh_reports", status,
  createdAt: "2026-11-08T05:00:00Z", updatedAt: "2026-11-08T05:00:00Z", result: null, error: null, ...extra,
});

test("pollOperation polls until terminal, reports progress", async () => {
  const sequence = [op("running"), op("succeeded", { result: { newReportCount: 0 } })];
  const seen = [];
  const final = await pollOperation({ getOperation: async () => sequence.shift() }, op("queued"), {
    intervalMs: 1,
    onUpdate: (o) => seen.push(o.status),
  });
  assert.equal(final.status, "succeeded");
  assert.deepEqual(seen, ["running", "succeeded"]);
});

test("pollOperation gives up after the limit and honours abort", async () => {
  let clock = 0;
  const stuck = { getOperation: async () => { clock += 30_000; return op("running"); } };
  await rejectsWith(pollOperation(stuck, op("queued"), { intervalMs: 1, now: () => clock }), "TIMEOUT");

  const controller = new AbortController();
  const polling = pollOperation({ getOperation: async () => op("running") }, op("queued"), { intervalMs: 50, signal: controller.signal });
  controller.abort();
  await rejectsWith(polling, "CANCELLED");
});
