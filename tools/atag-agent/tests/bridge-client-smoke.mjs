// Real HTTP integration: the existing TypeScript adapter talks to a Rust binary.
// Run after cargo build/test, with Node >=22.18. All data stays in a temp directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "../../../web/lib/agent/bridge-client.ts";
import { discoverBridge } from "../../../web/lib/agent/discovery.ts";
import ports from "../../../web/lib/agent/discovery-ports.json" with { type: "json" };
import { BrowserWorkspaceClient } from "../../../web/lib/workspace/browser-workspace-client.ts";
import { MemoryWorkspaceStore } from "../../../web/lib/workspace/store.ts";
import { parseConfigPackage } from "../../../web/lib/ble/protocol.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const binary = resolve(process.argv[2] ?? join(root, "target/debug", process.platform === "win32" ? "atag-agent.exe" : "atag-agent"));
const directory = await mkdtemp(join(tmpdir(), "atag-agent-http-"));
const env = { ...process.env };
delete env.ATAG_ANISETTE_URL;
delete env.ATAG_AGENT_DATA_DIR;
// Occupy the legacy port with a different HTTP service and leave Agent on automatic selection.
const occupied = createServer((_request, response) => response.end(JSON.stringify({
  service: "another-service",
  protocolVersion: 1,
  agentVersion: "0.1.0",
  capabilities: { anisette: true, appleRelay: true },
})));
await new Promise((resolve, reject) => {
  occupied.once("error", (error) => error.code === "EADDRINUSE" ? resolve() : reject(error));
  occupied.listen(ports[0], "127.0.0.1", resolve);
});
const server = spawn(binary, ["--data-dir", directory, "serve", "--allow-origin", "http://localhost:5173"], { env, stdio: ["ignore", "pipe", "pipe"] });
const exited = once(server, "exit");
let logs = "";
server.stdout.on("data", chunk => { logs += chunk; });
// Capture stderr to keep accidental upstream or configuration details out of logs.
server.stderr.resume();
try {
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("agent startup timed out")), 10_000);
    server.on("error", error => { clearTimeout(timer); reject(error); });
    server.on("exit", () => { clearTimeout(timer); reject(new Error("agent exited during startup")); });
    server.stdout.on("data", () => {
      const match = logs.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  assert.ok(ports.slice(1).includes(Number(new URL(baseUrl).port)));
  const requestFromWeb = (url, init) => {
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    return fetch(url, { ...init, headers: { ...init.headers, Origin: "http://localhost:5173" } });
  };
  const discovered = await discoverBridge("", {
    fetch: (url, init) => {
      if (new URL(url).origin === baseUrl || (occupied.listening && Number(new URL(url).port) === ports[0])) {
        return requestFromWeb(url, init);
      }
      return Promise.reject(new Error("Outside the integration test"));
    },
  });
  assert.equal(discovered?.client.baseUrl, baseUrl);
  const { client, health } = discovered;
  assert.equal(health.service, "atag-agent");
  assert.equal(health.protocolVersion, 1);
  assert.equal(health.capabilities.appleRelay, true);
  // Exercise Rust's normalized Anisette output, including its locale header.
  const provider = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({"X-Apple-I-MD":"synthetic-otp","X-Apple-I-MD-M":"synthetic-machine"}));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const anisette = await client.getAnisette(`http://127.0.0.1:${provider.address().port}`, "synthetic-user", "synthetic-device");
    assert.equal(anisette.headers.loc, "en_US");
    assert.equal(anisette.headers["x-apple-i-md"], "synthetic-otp");
  } finally {
    await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  }
  const bad = new BridgeClient(baseUrl, (url, init) => fetch(url, { ...init, headers: { ...init.headers, Origin: "https://untrusted.example.test" } }));
  await assert.rejects(bad.connect(), { code: "UNAUTHORIZED" });
  await assert.rejects(client.fetchCiphertexts({ dsid: "synthetic", searchPartyToken: "not-real", uid: "uid", deviceId: "client", accountLabel: null }, "http://127.0.0.1:1", [], "2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z"), { code: "INVALID_REQUEST" });
  await assert.rejects(client.forwardApple({endpoint:"gsa",method:"POST",headers:{Host:"forbidden.example"},bodyBase64:""}), {code:"INVALID_REQUEST"});
  const old = await fetch(baseUrl + "/v1/devices");
  assert.equal(old.status, 404);
  assert.equal((await fetch(baseUrl + "/v1/authorize")).status, 404);
  // All user work is in a separately owned browser repository, independent of this HTTP service.
  const store = new MemoryWorkspaceStore();
  const workspace = new BrowserWorkspaceClient(store);
  for (const mode of ["fixed", "rotating"]) {
    const bundle = await workspace.createProvisioningBundle({ name: "临时集成测试", mode, ...(mode === "rotating" ? { rotationIntervalMinutes: 15 } : {}) });
    assert.equal(parseConfigPackage(new Uint8Array(Buffer.from(bundle.configurationBase64, "base64"))).ok, true);
    await workspace.updateDevice(bundle.deviceId, { name: "已重命名", icon: "keys", color: "#123456" });
  }
  const backup = await workspace.exportBackup("synthetic-test-password");
  const restored = new BrowserWorkspaceClient(new MemoryWorkspaceStore());
  await restored.restoreBackup(backup, "synthetic-test-password");
  assert.equal((await restored.listDevices()).length, 2);
  assert.equal((await new BrowserWorkspaceClient(store).listDevices()).length, 2);
  assert.deepEqual(await readdir(directory), []);
  console.log("Rust Anisette/Apple relay ↔ TypeScript transport and browser-owned backup integration passed (no Apple calls)");

} finally {
  if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
  await exited;
  if (occupied.listening) await new Promise((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
