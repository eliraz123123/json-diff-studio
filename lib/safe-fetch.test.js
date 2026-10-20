import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { isBlockedAddress, safeRequest } from "./safe-fetch.js";

test("blocks loopback, private, link-local and mapped addresses", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("refuses private targets by IP literal and by hostname", async () => {
  await assert.rejects(safeRequest("http://127.0.0.1:9/"), /private or reserved/);
  await assert.rejects(safeRequest("http://[::1]:9/"), /private or reserved/);
  await assert.rejects(safeRequest("http://localhost:9/"), /private or reserved/);
  await assert.rejects(safeRequest("file:///etc/passwd"), /Only http and https/);
});

test("follows redirects, drops credentials across origins and decodes gzip", async t => {
  const seen = [];
  const other = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end(gzipSync(JSON.stringify({ ok: true })));
  });
  await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
  const first = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.writeHead(302, { location: `http://localhost:${other.address().port}/final` });
    res.end();
  });
  await new Promise(resolve => first.listen(0, "127.0.0.1", resolve));
  t.after(() => { first.close(); other.close(); });

  const response = await safeRequest(`http://127.0.0.1:${first.address().port}/`, {
    headers: { Authorization: "Bearer secret" },
    allowPrivate: true
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  assert.deepEqual(seen, ["Bearer secret", null]);
});

test("enforces the response size limit", async t => {
  const server = createServer((req, res) => res.end("x".repeat(2000)));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  await assert.rejects(
    safeRequest(`http://127.0.0.1:${server.address().port}/`, { allowPrivate: true, maxBytes: 1000 }),
    /larger than 1000 bytes/
  );
});

test("gives up on a server that never answers", async t => {
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await assert.rejects(
    safeRequest(`http://127.0.0.1:${server.address().port}/`, { allowPrivate: true, timeoutMs: 200 }),
    /Timed out/
  );
});
