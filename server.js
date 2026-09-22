import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/diff.js": ["diff.js", "text/javascript; charset=utf-8"]
};
const port = Number(process.env.PORT || 4173);

createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const entry = files[path];
  if (!entry) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  try {
    const content = await readFile(join(root, entry[0]));
    response.writeHead(200, { "Content-Type": entry[1] });
    response.end(content);
  } catch {
    response.writeHead(500);
    response.end("Could not load file");
  }
}).listen(port, () => console.log(`JSON Diff Studio: http://localhost:${port}`));
