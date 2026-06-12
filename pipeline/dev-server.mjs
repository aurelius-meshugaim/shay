#!/usr/bin/env node
// Local harness for the dream flow: serves the static site AND mounts the real
// api/dream.js handler the way Vercel would (parsed JSON body, res.json/end).
//
//   doppler run -p oria -c dev -- node pipeline/dev-server.mjs        # real Gemini
//   MOCK=1 node pipeline/dev-server.mjs                               # instant cached pano
//
// MOCK=1 answers /api/dream with stones/flint/dream-sample.jpg so the UI and
// viewer can be exercised without burning a generation.

import { setDefaultResultOrder } from "node:dns";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

setDefaultResultOrder("ipv4first");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8090);
const MOCK = !!process.env.MOCK;
const requireCjs = createRequire(import.meta.url);
const handler = requireCjs(path.join(ROOT, "api/dream.js"));
const offerHandler = requireCjs(path.join(ROOT, "api/offer.js"));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  try {
    if (req.url === "/api/offer") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { req.body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { req.body = {}; }
      res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
      return offerHandler(req, res);
    }
    if (req.url === "/api/dream") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { req.body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
      catch { req.body = {}; }
      req.headers["x-forwarded-proto"] = "http";
      res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
      if (MOCK) {
        if (req.method === "GET") return res.json({ emailDelivery: true });
        const desc = String(req.body.description || "").trim();
        if (desc.length < 3) { res.statusCode = 400; return res.json({ error: "Describe your home in 3–600 characters." }); }
        if (req.body.email) { res.statusCode = 202; return res.json({ queued: true }); }
        await new Promise((ok) => setTimeout(ok, Number(process.env.MOCK_DELAY || 800))); // visible loading state
        res.setHeader("Content-Type", "image/jpeg");
        return res.end(await readFile(path.join(ROOT, "stones/flint/dream-sample.jpg")));
      }
      return handler(req, res);
    }
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html");
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(PORT, () => console.log(`dev server (mock=${MOCK}) → http://localhost:${PORT}`));
