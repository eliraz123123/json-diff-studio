import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

// Monitors fetch URLs that customers type in, so every request must be unable to reach
// the host's own network: loopback, private ranges, link-local (cloud metadata) and so on.
const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blocked.addSubnet(address, prefix, "ipv4");
// No "::ffff:0:0/96" entry: BlockList already applies the IPv4 rules to IPv4-mapped
// addresses, and that subnet would also match every plain IPv4 address.
for (const [address, prefix] of [
  ["::", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
]) blocked.addSubnet(address, prefix, "ipv6");

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SAFE_HEADERS = new Set(["accept", "user-agent", "content-type"]);

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

// Validating inside `lookup` checks the address that is actually dialled, so a DNS answer
// that changes between a pre-check and the connection (DNS rebinding) cannot slip through.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const bad = addresses.find(entry => isBlockedAddress(entry.address));
    if (bad) {
      const blockedError = new Error(`${hostname} resolves to a private or reserved address (${bad.address})`);
      blockedError.code = "EBLOCKED";
      return callback(blockedError);
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

export async function safeRequest(input, options = {}) {
  let url = new URL(input);
  let method = options.method ?? "GET";
  let headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  let body = options.body;
  const maxRedirects = options.maxRedirects ?? 3;

  for (let redirects = 0; ; redirects += 1) {
    const response = await requestOnce(url, { ...options, method, headers, body });
    if (!REDIRECTS.has(response.status) || !response.headers.location || maxRedirects === 0) return response;
    if (redirects >= maxRedirects) throw new Error(`Stopped after ${maxRedirects} redirects`);
    const next = new URL(response.headers.location, url);
    if (next.origin !== url.origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => SAFE_HEADERS.has(name)));
    }
    if (response.status === 303 || (method === "POST" && response.status <= 302)) {
      method = "GET";
      body = undefined;
    }
    url = next;
  }
}

function requestOnce(url, { method, headers, body, timeoutMs = 15_000, maxBytes = 5_000_000, allowPrivate = false }) {
  return new Promise((resolve, reject) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return reject(new Error("Only http and https URLs are supported"));
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && net.isIP(hostname) && isBlockedAddress(hostname)) {
      return reject(new Error(`${hostname} is a private or reserved address`));
    }

    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const transport = url.protocol === "https:" ? https : http;
    const requestHeaders = { "accept-encoding": "gzip, deflate, br", ...headers };
    if (body !== undefined) requestHeaders["content-length"] = Buffer.byteLength(body);
    let request;
    try {
      request = transport.request(url, { method, headers: requestHeaders, lookup: allowPrivate ? undefined : safeLookup }, response => {
        const chunks = [];
        let size = 0;
        response.on("data", chunk => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new Error(`Response is larger than ${maxBytes} bytes`));
            request.destroy();
          } else chunks.push(chunk);
        });
        response.on("error", error => finish(error));
        response.on("end", () => {
          try {
            const raw = Buffer.concat(chunks);
            const text = decode(raw, response.headers["content-encoding"], maxBytes).toString("utf8");
            finish(null, { status: response.statusCode, headers: response.headers, body: text, url: url.href });
          } catch (error) {
            finish(new Error(`Could not decode response: ${error.message}`));
          }
        });
      });
    } catch (error) {
      return finish(error);
    }
    timer = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs / 1000} seconds`));
      request.destroy();
    }, timeoutMs);
    request.on("error", error => finish(error));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function decode(buffer, encoding, maxBytes) {
  const options = { maxOutputLength: maxBytes };
  if (encoding === "gzip") return zlib.gunzipSync(buffer, options);
  if (encoding === "deflate") return zlib.inflateSync(buffer, options);
  if (encoding === "br") return zlib.brotliDecompressSync(buffer, options);
  return buffer;
}
