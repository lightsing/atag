import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverBridge } from "../lib/agent/discovery.ts";
import ports from "../lib/agent/discovery-ports.json" with { type: "json" };

const agent = `http://127.0.0.1:${ports[1]}`;

function prompt(t) {
  const permission = Object.assign(new EventTarget(), { state: "prompt" });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      permissions: {
        async query({ name }) {
          assert.equal(name, "loopback-network");
          return permission;
        },
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  });
  return {
    permission,
    decide(state) {
      permission.state = state;
      permission.dispatchEvent(new Event("change"));
    },
  };
}

function agentBehindPrompt(permission) {
  const started = Promise.withResolvers();
  const attempts = [];
  return {
    attempts,
    started: started.promise,
    fetch(url, { signal }) {
      if (url !== agent + "/v1/health") return Promise.reject(new TypeError("Connection refused"));
      attempts.push(signal);
      if (permission.state === "granted") {
        return Promise.resolve(Response.json({
          service: "atag-agent",
          protocolVersion: 1,
          agentVersion: "test",
          capabilities: { anisette: true, appleRelay: true },
        }));
      }
      started.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
}

test("automatic discovery waits through a long Chrome prompt and connects when granted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { permission, decide } = prompt(t);
  const fake = agentBehindPrompt(permission);
  const waiting = [];
  const connecting = discoverBridge("", {
    fetch: fake.fetch,
    onPermissionPending: (pending) => waiting.push(pending),
  });
  const initial = await fake.started;

  t.mock.timers.tick(30_000);
  assert.equal(initial.aborted, false);
  assert.deepEqual(waiting, [true]);
  assert.equal(fake.attempts.length, 1);

  decide("granted");
  assert.equal((await connecting).client.baseUrl, agent);
  assert.equal(initial.aborted, true);
  assert.equal(fake.attempts.length, 2);
  assert.deepEqual(waiting, [true, false]);
});

test("blocking the permission ends discovery with a site settings message", async (t) => {
  const { permission, decide } = prompt(t);
  const fake = agentBehindPrompt(permission);
  const connecting = discoverBridge("", { fetch: fake.fetch });
  const initial = await fake.started;
  decide("denied");
  await assert.rejects(connecting, { code: "AGENT_UNAVAILABLE", message: /站点设置/ });
  assert.equal(initial.aborted, true);
  assert.equal(fake.attempts.length, 1);
});

test("canceling discovery while permission is pending prevents a late connection", async (t) => {
  const { permission, decide } = prompt(t);
  const fake = agentBehindPrompt(permission);
  const controller = new AbortController();
  const connecting = discoverBridge("", { fetch: fake.fetch, signal: controller.signal });
  const initial = await fake.started;
  controller.abort();
  await assert.rejects(connecting, { code: "CANCELLED" });
  decide("granted");
  assert.equal(initial.aborted, true);
  assert.equal(fake.attempts.length, 1);
});

test("discovery still finishes when no port is listening and there is no prompt to answer", async (t) => {
  prompt(t);
  const found = await discoverBridge("", {
    fetch: async () => { throw new TypeError("Connection refused"); },
  });
  assert.equal(found, null);
});

test("discovery keeps its five-second timeout after permission is granted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { decide } = prompt(t);
  decide("granted");
  const started = Promise.withResolvers();
  const connecting = discoverBridge("", {
    fetch: (_url, { signal }) => {
      started.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const request = await started.promise;
  t.mock.timers.tick(4_999);
  assert.equal(request.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(await connecting, null);
  assert.equal(request.aborted, true);
});
