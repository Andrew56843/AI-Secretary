import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import test, { type TestContext } from "node:test";

const serverSource = `
const express = require('express');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1kb' }));
app.post('/echo', (req, res) => res.json({ body: req.body }));
app.get('/alive', (_req, res) => res.json({ ok: true }));
app.get('/ip', (req, res) => res.json({ ip: req.ip, ips: req.ips }));
app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({ error: error.type || 'request.error' });
});
app.listen(0, '127.0.0.1', function () {
  console.log(JSON.stringify({ port: this.address().port }));
});
setTimeout(() => process.exit(124), 4500).unref();
`;

async function isolatedServer(t: TestContext) {
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", serverSource], {
    cwd: new URL("../../", import.meta.url),
    env: { NODE_ENV: "test", SystemRoot: process.env.SystemRoot },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => { diagnostic = `${diagnostic}${chunk.toString()}`.slice(-2048); });
  const lines = createInterface({ input: child.stdout });
  t.after(() => { lines.close(); child.kill(); });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Isolated HTTP server did not start")); }, 1500);
    lines.once("line", (line) => {
      clearTimeout(timeout);
      try {
        const message = JSON.parse(line) as { port?: number };
        assert.ok(Number.isInteger(message.port) && message.port! > 0);
        resolve(message.port!);
      } catch (error) { reject(error); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Isolated HTTP server exited (${code ?? signal}): ${diagnostic}`));
    });
  });
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    assertRunning() {
      assert.equal(child.exitCode, null, diagnostic);
      assert.equal(child.signalCode, null, diagnostic);
    },
  };
}

function trailingGzipRequest(port: number, encoded: Buffer) {
  const trailing = Buffer.from("invalid-trailing-frame", "utf8");
  return new Promise<number>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1", port, path: "/echo", method: "POST", signal: AbortSignal.timeout(1000),
      headers: {
        "content-type": "application/json", "content-encoding": "gzip",
        "content-length": encoded.length + trailing.length,
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.write(encoded);
    setTimeout(() => request.end(trailing), 25);
  });
}

test("patched HTTP parsing survives malformed compressed bodies and enforces size and proxy limits", { timeout: 5000 }, async (t) => {
  const server = await isolatedServer(t);
  const request = (route: string, options: RequestInit = {}) => fetch(`${server.url}${route}`, {
    ...options, signal: AbortSignal.timeout(1000),
  });
  const assertAlive = async () => {
    server.assertRunning();
    const response = await request("/alive");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  };

  await t.test("ordinary JSON and a valid gzip body retain their data", async () => {
    const body = { message: "small regression request", count: 2 };
    for (const compressed of [false, true]) {
      const response = await request("/echo", {
        method: "POST",
        headers: { "content-type": "application/json", ...(compressed ? { "content-encoding": "gzip" } : {}) },
        body: compressed ? gzipSync(JSON.stringify(body)) : JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { body });
    }
  });

  await t.test("late trailing gzip bytes cannot terminate the server after a response", async () => {
    const status = await trailingGzipRequest(server.port, gzipSync('{"message":"small compressed request"}'));
    // A decoder may finish JSON before the late bytes arrive; either response must leave the process alive.
    assert.ok(status === 200 || status === 400, `Unexpected compressed-body status ${status}`);
    await delay(50);
    await assertAlive();
  });

  await t.test("invalid JSON and truncated gzip are rejected without a process failure", async () => {
    const gzip = gzipSync('{"message":"small request"}');
    for (const body of ['{"incomplete":', gzip.subarray(0, gzip.length - 8)]) {
      const compressed = Buffer.isBuffer(body);
      const response = await request("/echo", {
        method: "POST",
        headers: { "content-type": "application/json", ...(compressed ? { "content-encoding": "gzip" } : {}) },
        body,
      });
      assert.equal(response.status, 400);
      await response.arrayBuffer();
      await assertAlive();
    }
  });

  await t.test("the configured limit applies to both plain and inflated JSON", async () => {
    const json = JSON.stringify({ value: "x".repeat(2048) });
    for (const compressed of [false, true]) {
      const response = await request("/echo", {
        method: "POST",
        headers: { "content-type": "application/json", ...(compressed ? { "content-encoding": "gzip" } : {}) },
        body: compressed ? gzipSync(json) : json,
      });
      assert.equal(response.status, 413);
      await response.arrayBuffer();
      await assertAlive();
    }
  });

  await t.test("one trusted proxy hop never accepts an arbitrary leftmost forwarded IP", async () => {
    const response = await request("/ip", { headers: { "x-forwarded-for": "203.0.113.4, 198.51.100.23" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ip: "198.51.100.23", ips: ["198.51.100.23"] });
    await assertAlive();
  });
});
