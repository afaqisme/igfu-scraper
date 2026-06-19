import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { handler as apifyHandler } from "./netlify/functions/apify.js";

const PORT = Number(process.env.PORT || 4173);
const DIST = join(process.cwd(), "dist");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const noCache = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

createServer(async (req, res) => {
  try {
    if (req.url === "/.netlify/functions/apify" && req.method === "POST") {
      const body = await readBody(req);
      const result = await apifyHandler({
        httpMethod: "POST",
        body,
        headers: req.headers,
      });
      res.writeHead(result.statusCode || 200, { ...noCache, ...(result.headers || {}) });
      res.end(result.body || "");
      return;
    }

    const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
    const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = safePath === "/" ? join(DIST, "index.html") : join(DIST, safePath);
    const file = await readFile(filePath).catch(() => readFile(join(DIST, "index.html")));
    res.writeHead(200, { ...noCache, "Content-Type": types[extname(filePath)] || "text/html; charset=utf-8" });
    res.end(file);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
}).listen(PORT, () => {
  console.log(`IGFU Scraper running at http://localhost:${PORT}`);
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
