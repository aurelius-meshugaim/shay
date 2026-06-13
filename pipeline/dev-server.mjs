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
import { setDefaultAutoSelectFamily } from "node:net";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

setDefaultResultOrder("ipv4first");
// Happy-Eyeballs family autoselection intermittently ETIMEDOUTs on hosts with
// broken IPv6 (Gemini calls failed ~2/3 of the time, 2026-06-13) — force v4.
setDefaultAutoSelectFamily(false);

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8090);
const MOCK = !!process.env.MOCK;
const requireCjs = createRequire(import.meta.url);
const handler = requireCjs(path.join(ROOT, "api/dream.js"));
const API_ROUTES = {}; // /api/<name> → api/<name>.js, Vercel-style
for (const f of (await import("node:fs")).readdirSync(path.join(ROOT, "api")))
  if (f.endsWith(".js")) API_ROUTES["/api/" + f.slice(0, -3)] = requireCjs(path.join(ROOT, "api", f));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  try {
    const route = API_ROUTES[req.url.split("?")[0]];
    if (route && req.url.split("?")[0] !== "/api/dream") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { req.body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { req.body = {}; }
      req.query = Object.fromEntries(new URL(req.url, "http://x").searchParams);
      req.headers["x-forwarded-proto"] = "http";
      res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
      return route(req, res);
    }
    if (req.url.split("?")[0] === "/api/dream") {
      req.query = Object.fromEntries(new URL(req.url, "http://x").searchParams);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { req.body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
      catch { req.body = {}; }
      req.headers["x-forwarded-proto"] = "http";
      res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
      if (MOCK) {
        if (req.method === "GET") return res.json({ emailDelivery: true });
        if (req.body.walk) {
          await new Promise((ok) => setTimeout(ok, Number(process.env.MOCK_DELAY || 800)));
          res.setHeader("Content-Type", "image/jpeg");
          return res.end(await readFile(path.join(ROOT, "stones/flint/dream-sample.jpg")));
        }
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
