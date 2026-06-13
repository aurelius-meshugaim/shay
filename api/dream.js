// POST /api/dream  { stone, description, email? }
// GET  /api/dream  → { emailDelivery: bool }   (capability probe for the UI)
//
// Three-call all-Gemini pipeline (probed 2026-06-12, see OCW
// space/rnd/2026-06-12-shay-dream-360/probe/PROBE.md):
//   1. RESTYLE a true-equirect template (stones/templates/spacious-1.jpg)
//      into the visitor's described room AND insert the real stone at its
//      manifest dimensions. True projection is inherited from the template;
//      the heavy restyle breaks the wrap seam.
//   2. ROLL 50% (sharp) so the broken seam sits mid-frame, then a light
//      Gemini repair pass heals it (light edits are wrap-safe, 4/4 probes).
//   3. ROLL back so the stone faces the viewer's initial yaw.
// ~35s total — inside the 60s budget.
//
// Without email: respond with the JPEG. With email: respond 202 immediately,
// finish the pipeline via waitUntil, deliver through Resend (needs
// RESEND_API_KEY in the project env; until it exists GET reports
// emailDelivery:false and the UI hides the offer).

const sharp = require("sharp");
const { waitUntil } = require("@vercel/functions");

const MODEL = "gemini-3.1-flash-image";
const API = "https://generativelanguage.googleapis.com/v1beta/models";
const TEMPLATE = "stones/templates/spacious-1.jpg";

// Best-effort per-instance rate limit (no shared store yet — see README).
const hits = new Map(); // ip → [timestamps]
// generous: dreams + walks + speculative prefetches all count one each
const RL_MAX = 40, RL_WIN = 60 * 60 * 1000;
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter((t) => now - t < RL_WIN);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RL_MAX;
}

async function gemini(key, parts, label) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${API}/${MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "2K" } },
      }),
    });
    if ((r.status === 429 || r.status >= 500) && attempt <= 2) {
      await new Promise((ok) => setTimeout(ok, attempt * 3000));
      continue;
    }
    if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
    const data = await r.json();
    const img = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!img) {
      if (attempt <= 2) continue; // e.g. IMAGE_RECITATION — retry
      throw new Error(`${label}: no image returned`);
    }
    return Buffer.from(img.inlineData.data, "base64");
  }
}

// Horizontal wrap-roll by a fraction of the width (0.5 = 180°).
async function roll(buf, frac = 0.5) {
  frac = ((frac % 1) + 1) % 1;
  const { width: w, height: h } = await sharp(buf).metadata();
  const cut = Math.round(w * frac);
  if (cut === 0 || cut === w) return buf;
  const left = await sharp(buf).extract({ left: 0, top: 0, width: cut, height: h }).toBuffer();
  const right = await sharp(buf).extract({ left: cut, top: 0, width: w - cut, height: h }).toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: "#000" } })
    .composite([{ input: right, left: 0, top: 0 }, { input: left, left: w - cut, top: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();
}
const roll50 = (buf) => roll(buf, 0.5);

// ---- bottom-up scale chain -------------------------------------------------
// The room is generated WITHOUT the stone — the client renders the stone's
// cutout as a 3D layer, so its size is guaranteed by geometry (see OCW
// rnd/2026-06-13-stone-size-realism/SYNTHESIS.md). ONE derivation, built up
// from the stone's true measures, drives (a) the generation prompt's exact
// numbers, (b) the composite geometry, (c) the response headers, (d) the
// viewer's 3D-layer constants (index.html mirrors these formulas — keep in sync).
//   stand from stone:  stone center at contemplation height ~125 cm
//                      ⇒ stand_h = clamp(125 − stone_h/2, 60, 110) cm (<40cm stones);
//                      big stones sit on the floor (low 10cm plinth if h < 70cm)
//   camera from stone: target angular presence ~7.5° horizontal
//                      ⇒ D = (stone_w/2) / tan(3.75°), clamped [0.55, 3.5] m
//   room from stand:   walls ≥ max(3×D, 3.5 m), ceiling ≥ 2.8 m
const CAM_H = 1.6;        // m — camera eye height in the equirect convention
const PRESENCE_DEG = 7.5; // ° — target horizontal angular size of the stone
function sceneFromStone(dimensions) {
  const d = dimensions || {};
  const wcm = d.width_cm || d.height_cm || d.depth_cm || 14;
  const hcm = d.height_cm || wcm * 0.7;
  const dcm = d.depth_cm || Math.round(wcm * 0.7);
  const big = Math.max(wcm, hcm, dcm) >= 40;

  // stand from stone (cm); top ≈ 2.5× footprint (plinths tighter, 1.4×)
  let standH, topW, topD;
  if (big) {
    standH = hcm < 70 ? 10 : 0; // low plinth or bare floor
    topW = Math.round((wcm * 1.4) / 10) * 10;
    topD = Math.round((dcm * 1.4) / 10) * 10;
  } else {
    standH = Math.round(Math.min(110, Math.max(60, 125 - hcm / 2)));
    topW = Math.max(15, Math.round((wcm * 2.5) / 5) * 5);
    topD = Math.max(15, Math.round((dcm * 2.5) / 5) * 5);
  }

  // camera from stone (m), rounded to 5 cm. Floor is 0.9m, not closer: the
  // generator stages pedestals at ~1-2m no matter what the prompt says
  // (verified 2026-06-13 — "exactly 0.55m" still rendered at ~2m), and the
  // composite must agree with where the pano can plausibly show a stand.
  const halfAngle = (PRESENCE_DEG / 2) * Math.PI / 180;
  const D = Math.round(Math.min(3.5, Math.max(0.9, (wcm / 200) / Math.tan(halfAngle))) * 20) / 20;

  // room from stand (m)
  const wallMin = Math.max(Math.round(3 * D * 10) / 10, 3.5);

  const surfaceH = standH / 100; // m — height the stone's underside sits at
  const roomSpec = `The nearest walls are at least ${wallMin} meters away from the camera and the ceiling is at least 2.8 meters high — the room stays open and spacious around it.`;
  const stage = big
    ? (standH
        ? `A low, sturdy display plinth exactly ${standH} cm tall, its flat top about ${topW} by ${topD} centimeters, sits on the floor at the horizontal center of the image, exactly ${D} meters from the camera. Its top is COMPLETELY EMPTY — nothing on it. The room is arranged around this empty plinth as if awaiting a massive sculpture. ${roomSpec}`
        : `A clear, open stretch of floor lies at the horizontal center of the image, exactly ${D} meters from the camera — kept completely empty, as if awaiting a massive sculpture. Nothing stands there. ${roomSpec}`)
    : `An elegant, slender display pedestal exactly ${standH} cm tall, its flat top about ${topW} by ${topD} centimeters, stands at the horizontal center of the image, exactly ${D} meters from the camera — in the immediate foreground, clearly the nearest piece of furniture, appearing tall and prominent in the frame with its top seen slightly from above. Its top is COMPLETELY EMPTY — nothing on it. No other pedestal, side table or console competes with it. The room is arranged around this empty pedestal as if awaiting a small treasured object. ${roomSpec}`;

  return { big, standH, topW, topD, D, wallMin, surfaceH, stage };
}

async function generate({ base, key, stage, desc }) {
  const restylePrompt = `This image is a 360-degree equirectangular panorama of an interior, captured from the center of the room at eye level.

Completely redesign the interior into the visitor's own home, as they describe it: ${desc}

NON-NEGOTIABLE RULES, regardless of the description:
1. The room is SPACIOUS — high ceilings, walls at a generous distance from the camera; the visitor stands in the middle of an open, airy space. If the description implies a small space, render its spirit in a generous version of it.
2. The room is RICH and lived-in: layered textiles, artwork on the walls, plants, books, lamps, warm material detail — a loved, fully furnished home in the spirit of the description, never an empty showroom.
3. ${stage}

CRITICAL: keep the equirectangular projection of the input exactly — same camera position, full 360x180 sphere, floor at the bottom edge, ceiling at the top edge, left and right edges perfectly continuous with each other. Photorealistic. No people, no text, no watermarks.`;

  const styled = await gemini(key, [
    { text: restylePrompt },
    { inlineData: { mimeType: "image/jpeg", data: base.template.toString("base64") } },
  ], "restyle");

  const rolled = await roll50(styled);

  const repairPrompt = `This is a 360-degree equirectangular panorama of a room. There may be a visible vertical seam artifact running down the middle of the image where two parts of the room meet with a hard discontinuity.

Repair ONLY that vertical seam zone: blend the architecture and surfaces across it so the room reads as one continuous space. Keep everything else pixel-faithful — same furniture, same displayed stone, same windows, same lighting, same equirectangular projection. The left and right edges of the image are already continuous; keep them exactly continuous.`;

  const repaired = await gemini(key, [
    { text: repairPrompt },
    { inlineData: { mimeType: "image/jpeg", data: rolled.toString("base64") } },
  ], "seam-repair");

  return finish(repaired);
}

// Street-View-style step: re-render the SAME room from a moved camera, then
// run the same seam-repair pass (camera moves are heavy re-synthesis).
async function walkStep({ key, pano, direction }) {
  const movePrompt = `This is a 360-degree equirectangular panorama of a room, captured from its center at eye level.

Re-render the EXACT SAME room from a new camera position: the camera has walked about three meters ${direction}, still at eye level. Every object, piece of furniture, material, window view and light source stays identical — same room, same time of day, only the viewpoint moves. If a small displayed stone sits on a pedestal or table, REMOVE it and any shadow it casts — render its display surface empty.

CRITICAL: output a full 360x180 equirectangular panorama — floor at the bottom edge, ceiling at the top edge, left and right edges perfectly continuous with each other. Photorealistic. No people, no text.`;

  const moved = await gemini(key, [
    { text: movePrompt },
    { inlineData: { mimeType: "image/jpeg", data: pano.toString("base64") } },
  ], "walk");

  const rolled = await roll50(moved);
  const repairPrompt = `This is a 360-degree equirectangular panorama of a room. There may be a visible vertical seam artifact running down the middle where two parts of the room meet with a hard discontinuity. Repair ONLY that seam zone: blend the architecture and surfaces across it so the room reads continuous. Keep everything else pixel-faithful, same equirectangular projection, left and right edges exactly continuous.`;
  const repaired = await gemini(key, [
    { text: repairPrompt },
    { inlineData: { mimeType: "image/jpeg", data: rolled.toString("base64") } },
  ], "walk-seam-repair");
  return finish(repaired);
}

async function finish(repaired) {
  const back = await roll50(repaired); // roll back → original facing restored
  // models drift on aspect; normalize to exact 2:1 so the viewer maps a full sphere
  const { width: w, height: h } = await sharp(back).metadata();
  if (w !== 2 * h) return sharp(back).resize(2 * h, h, { fit: "fill" }).jpeg({ quality: 92 }).toBuffer();
  return back;
}

// Text/vision call (no image output) — used for pedestal detection.
async function geminiText(key, parts, label) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${API}/gemini-2.5-flash:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    if ((r.status === 429 || r.status >= 500) && attempt <= 2) {
      await new Promise((ok) => setTimeout(ok, 2000));
      continue;
    }
    if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
    const data = await r.json();
    const text = (data.candidates?.[0]?.content?.parts ?? []).filter((p) => p.text).map((p) => p.text).join("");
    if (text) return text;
    if (attempt <= 2) continue;
    throw new Error(`${label}: no text`);
  }
}

// Where did the model ACTUALLY put the display surface? Convention says
// pedestal-at-center, but generated heights/distances vary — detection makes
// the paste land ON the surface instead of hovering at convention coords.
async function detectSurface(jpeg, key, W, H, scene) {
  const what = scene.big
    ? (scene.standH ? "the empty top surface of the low display plinth" : "the clear open floor area meant for a sculpture")
    : `the tall, slender display pedestal standing alone with NOTHING on it (about ${scene.standH} cm tall — not a bookshelf, console or desk that has objects on it)`;
  // [y, x] normalized to 0-1000 is the coordinate convention Gemini's pointing
  // is trained on — raw pixel coords on a 2880-wide equirect came back wild.
  // Single points are noisy (±100px in y) → 3 parallel calls, median wins.
  const parts = [
    { text: `This is an equirectangular interior panorama. Near the horizontal center of the image there is ${what}. Point to the exact spot on that surface where a displayed object would touch it (the center of the surface's visible top face). Answer with ONLY JSON: {"point": [y, x]} with coordinates normalized to 0-1000. No other text.` },
    { inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } },
  ];
  const settled = await Promise.allSettled([1, 2, 3].map(() => geminiText(key, parts, "detect-surface")));
  const pts = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    const m = s.value.match(/\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]/);
    if (!m) continue;
    const x = (parseFloat(m[2]) / 1000) * W, y = (parseFloat(m[1]) / 1000) * H;
    if (x > 0 && x < W && y > H / 2 && y < H) pts.push({ x, y });
  }
  if (!pts.length) throw new Error(`detect: no valid point in ${settled.map((s) => JSON.stringify(s.status === "fulfilled" ? s.value.slice(0, 60) : s.reason?.message)).join(" | ")}`);
  const med = (a) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  return { x: Math.round(med(pts.map((p) => p.x))), y: Math.round(med(pts.map((p) => p.y))) };
}

// Geometry of the stone's box inside a 2:1 equirect, driven by the SAME
// derived scene the prompt was built from (shared with the viewer's 3D layer).
function stoneBox(W, H, dimensions, scene) {
  const d = dimensions || {};
  const wcm = d.width_cm || d.height_cm || d.depth_cm || 14;
  const hcm = d.height_cm || wcm * 0.7;
  const D = scene.D;                          // m from camera (derived)
  const centerY = scene.surfaceH + hcm / 200; // m above floor (derived stand top)
  const pxW = Math.max(8, Math.round((2 * Math.atan(wcm / 200 / D)) / (2 * Math.PI) * W));
  const pxH = Math.max(8, Math.round((2 * Math.atan(hcm / 200 / D)) / Math.PI * H));
  const pitch = Math.atan((CAM_H - centerY) / D); // + = below horizon
  const cy = Math.round(H / 2 + (pitch / Math.PI) * H);
  return { pxW, pxH, left: Math.round(W / 2 - pxW / 2), top: Math.round(cy - pxH / 2) };
}

// Embed the stone INTO the room (R&D rnd/2026-06-13 probe recipe):
// 1. paste the cutout at the geometrically exact size
// 2. Gemini harmonizes ONLY a crop around it (contact shadow, light spill)
// 3. the cutout is re-pasted on top — the model never owns the stone's pixels
async function embedStone(jpeg, cutout, dimensions, scene, key) {
  const { width: W, height: H } = await sharp(jpeg).metadata();
  let box = stoneBox(W, H, dimensions, scene);
  let lonDeg = 180, dist = scene.D;
  try {
    const s = await detectSurface(jpeg, key, W, H, scene);
    const surfaceH = scene.surfaceH;                       // m: derived stand top
    const pitch = ((s.y - H / 2) / H) * Math.PI;           // + below horizon
    console.log(`surface detect: x=${s.x} y=${s.y} pitch=${pitch.toFixed(3)} (W=${W} H=${H})`);
    lonDeg = (s.x / W) * 360;                              // trust x even when pitch is shallow
    // The stage prompt pins the stand at the image center; every detection that
    // actually locked it has come back within ±3° (6 runs, 2026-06-13), while
    // bigger deviations were always a different surface (console, stairs).
    // Outlier x ⇒ the whole point is suspect: fall back to the derived scene
    // (box already holds the derived geometry at the staged center).
    if (Math.abs(lonDeg - 180) > 4) {
      console.log(`detect lon ${lonDeg.toFixed(1)}° off staged center → derived scene fallback`);
      lonDeg = 180;
    } else if (pitch > 0.04) {
      // detection refines distance, but only within a band around the derived D;
      // out-of-band implies the pointer missed the surface (e.g. back edge /
      // window behind it — seen 2026-06-13), so re-anchor y to the derived
      // scene at the clamped distance instead of pasting at the stray point.
      const lo = Math.max(0.35, scene.D * 0.6), hi = Math.min(4, scene.D * 1.5);
      const raw = (CAM_H - surfaceH) / Math.tan(pitch);
      dist = Math.min(hi, Math.max(lo, raw));
      let sy = s.y;
      if (raw < lo || raw > hi) {
        // A low-side miss on a pedestal scene means the pointer hit the floor,
        // rug or lower shelf BELOW the top (seen 2026-06-13: star hung between
        // the pedestal legs) — re-anchor to the derived D, not the band edge.
        if (raw < lo && !scene.big) dist = scene.D;
        sy = Math.round(H / 2 + (Math.atan((CAM_H - surfaceH) / dist) / Math.PI) * H);
        console.log(`detect dist ${raw.toFixed(2)}m outside [${lo.toFixed(2)}, ${hi.toFixed(2)}] → dist ${dist}m, re-anchor y ${s.y}→${sy}`);
      }
      const d = dimensions || {};
      const wcm = d.width_cm || d.height_cm || d.depth_cm || 14;
      const hcm = d.height_cm || wcm * 0.7;
      const pxW = Math.max(8, Math.round((2 * Math.atan(wcm / 200 / dist)) / (2 * Math.PI) * W));
      const pxH = Math.max(8, Math.round((2 * Math.atan(hcm / 200 / dist)) / Math.PI * H));
      box = {
        pxW, pxH,
        left: Math.max(0, Math.min(W - pxW, Math.round(s.x - pxW / 2))),
        top: Math.max(0, Math.min(H - pxH, Math.round(sy - pxH + pxH * 0.04))), // bottom kisses the surface
      };
    }
  } catch (e) { console.error("surface detect fell back to convention:", e.message); }
  const stonePng = await sharp(cutout).resize(box.pxW, box.pxH, { fit: "fill" }).png().toBuffer();
  let pano = await sharp(jpeg)
    .composite([{ input: stonePng, left: box.left, top: box.top }])
    .jpeg({ quality: 95 })
    .toBuffer();

  // crop ~3x the stone's box, clamped to the image
  const cw = Math.min(W, box.pxW * 3.5), ch = Math.min(H, box.pxH * 3.5);
  const cl = Math.max(0, Math.min(W - cw, Math.round(box.left + box.pxW / 2 - cw / 2)));
  const ct = Math.max(0, Math.min(H - ch, Math.round(box.top + box.pxH / 2 - ch / 2)));
  const crop = await sharp(pano).extract({ left: cl, top: ct, width: Math.round(cw), height: Math.round(ch) }).jpeg({ quality: 95 }).toBuffer();

  try {
    const harmonized = await gemini(key, [
      { text: `A small stone object was digitally pasted onto the surface at the center of this photo. Integrate it into the scene: add the soft contact shadow it would cast on the surface beneath it, and subtle light interaction consistent with the room's lighting. CRITICAL: do NOT move, resize, recolor or reshape the stone itself, and change nothing else in the image.` },
      { inlineData: { mimeType: "image/jpeg", data: crop.toString("base64") } },
    ], "embed-harmonize");
    const back = await sharp(harmonized).resize(Math.round(cw), Math.round(ch), { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
    pano = await sharp(pano).composite([{ input: back, left: cl, top: ct }]).jpeg({ quality: 95 }).toBuffer();
    // size guard: the exact cutout goes back on top
    pano = await sharp(pano).composite([{ input: stonePng, left: box.left, top: box.top }]).jpeg({ quality: 92 }).toBuffer();
  } catch (e) {
    console.error("harmonize skipped:", e.message); // plain composite still ships
  }
  return { pano, lonDeg, dist, surfaceH: scene.surfaceH };
}

const { stoneEmail, send: sendMail } = require("./_email.js");

async function sendEmail({ resendKey, to, name, desc, jpeg }) {
  return sendMail({
    resendKey,
    to,
    subject: `${name} — in your home, in 360°`,
    html: stoneEmail({
      preheader: `Your dream is ready — ${name}, at home with you.`,
      heading: "Your dream is ready",
      intro: `<em>“${desc.replace(/&/g, "&amp;").replace(/</g, "&lt;")}”</em><br/><br/>` +
        `The attached image is a full 360° panorama of your home with <strong style="color:#fff">${name}</strong> in it — open it in any 360 viewer, or come back and dream another room.`,
      rows: [{ label: "Stone", value: name }],
      cta: { label: "Dream another room", url: "https://shaym.beauty" },
    }),
    attachments: [{ filename: "your-home-360.jpg", content: jpeg.toString("base64") }],
  });
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.json({ emailDelivery: !!process.env.RESEND_API_KEY });
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.json({ error: "POST only" });
  }
  const KEY = process.env.GEMINI_AI_STUDIO;
  if (!KEY) {
    res.statusCode = 500;
    return res.json({ error: "GEMINI_AI_STUDIO is not configured" });
  }

  const ip = (req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  if (limited(ip)) {
    res.statusCode = 429;
    return res.json({ error: "The dream engine needs a breather — try again in a little while." });
  }

  // Street-View walk: client sends the current pano back + the yaw it faces.
  // We roll the pano so that facing sits at the image center, ask the model to
  // walk "toward the center", and the client re-opens facing the walk target.
  if (req.body && req.body.walk) {
    const { pano = "", yawDeg = 180 } = req.body;
    if (typeof pano !== "string" || pano.length < 1000 || pano.length > 4_000_000) {
      res.statusCode = 400;
      return res.json({ error: "Bad panorama payload." });
    }
    try {
      const facingFrac = (Number(yawDeg) || 180) / 360 - 0.5; // u of facing − center
      const oriented = await roll(Buffer.from(pano, "base64"), facingFrac);
      const jpeg = await walkStep({
        key: KEY,
        pano: oriented,
        direction: "straight ahead — toward whatever stands at the horizontal center of this image",
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      return res.end(jpeg);
    } catch (e) {
      console.error("walk failed:", e.message);
      res.statusCode = 502;
      return res.json({ error: "Couldn't take that step — try again." });
    }
  }

  const { stone = "flint", description = "", email = "" } = req.body || {};
  const desc = String(description).trim();
  if (desc.length < 3 || desc.length > 600) {
    res.statusCode = 400;
    return res.json({ error: "Describe your home in 3–600 characters." });
  }
  if (!/^[a-z0-9-]+$/.test(stone)) {
    res.statusCode = 400;
    return res.json({ error: "Unknown stone." });
  }
  const to = String(email).trim();
  if (to && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    res.statusCode = 400;
    return res.json({ error: "That email doesn't look right." });
  }
  if (to && !process.env.RESEND_API_KEY) {
    res.statusCode = 503;
    return res.json({ error: "Email delivery isn't set up yet." });
  }

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = `${proto}://${req.headers.host}`;

  // DB is the source of truth for identity, dimensions and (for admin-uploaded
  // stones) the original image's storage URL; manifest is the legacy fallback.
  let row = null;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const h = { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
    row = await fetch(`${process.env.SUPABASE_URL}/rest/v1/stones?id=eq.${stone}&select=name,width_cm,height_cm,depth_cm,images`, { headers: h })
      .then((r) => (r.ok ? r.json() : [])).then((a) => a[0]).catch(() => null);
  }
  const tplRes = await fetch(`${host}/${TEMPLATE}`);
  if (!tplRes.ok) {
    res.statusCode = 500;
    return res.json({ error: "Template missing." });
  }
  const base = { template: Buffer.from(await tplRes.arrayBuffer()) };
  let meta = null;
  if (row) meta = { name: row.name, dimensions: { width_cm: Number(row.width_cm) || null, height_cm: Number(row.height_cm) || null, depth_cm: Number(row.depth_cm) || null } };
  else {
    const manifest = await fetch(`${host}/stones/manifest.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    meta = manifest.find((s) => s.id === stone) || null;
  }
  const plan = sceneFromStone(meta?.dimensions);
  const args = { base, key: KEY, stage: plan.stage, desc };

  // dream log — returns the row id so the finished panorama can be attached
  let dreamId = null;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    dreamId = await fetch(`${process.env.SUPABASE_URL}/rest/v1/dreams`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ stone_id: stone, description: desc, email: to || null, ip }),
    }).then((r) => (r.ok ? r.json() : [])).then((a) => a[0]?.id || null).catch(() => null);
  }

  // embed the stone into the env (detect surface → composite → crop-harmonize)
  async function withStone(jpeg) {
    const bare = { pano: jpeg, lonDeg: 180, dist: plan.D, surfaceH: plan.surfaceH };
    const cutoutUrl = row?.images?.cutout;
    if (!cutoutUrl) return bare;
    try {
      const c = await fetch(cutoutUrl);
      if (!c.ok) return bare;
      return await embedStone(jpeg, Buffer.from(await c.arrayBuffer()), meta?.dimensions, plan, KEY);
    } catch (e) {
      console.error("embed skipped, serving bare pano:", e.message);
      return bare;
    }
  }

  // permanence: store the finished illustration and link it to the log row
  async function saveDream(jpeg) {
    if (!dreamId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
    const h = { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
    const up = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/stones/dreams/${dreamId}.jpg`, {
      method: "POST",
      headers: { ...h, "Content-Type": "image/jpeg", "x-upsert": "true" },
      body: jpeg,
    }).catch(() => null);
    if (!up || !up.ok) return;
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/dreams?id=eq.${dreamId}`, {
      method: "PATCH",
      headers: { ...h, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ image: `${process.env.SUPABASE_URL}/storage/v1/object/public/stones/dreams/${dreamId}.jpg` }),
    }).catch(() => {});
  }

  if (to) {
    // Respond now; finish + deliver in the background (within maxDuration).
    // The emailed JPEG gets the stone composited server-side at geometric size.
    res.statusCode = 202;
    res.json({ queued: true });
    waitUntil(
      generate(args)
        .then(withStone)
        .then(async ({ pano }) => {
          await saveDream(pano);
          return sendEmail({ resendKey: process.env.RESEND_API_KEY, to, name: meta?.name || stone, desc, jpeg: pano });
        })
        .catch((e) => console.error("dream-email failed:", e.message)),
    );
    return;
  }

  try {
    const { pano, lonDeg, dist, surfaceH } = await withStone(await generate(args)); // embedded: surface-detected, shadowed, exact pixels
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Stone-Lon", String(Math.round(lonDeg * 10) / 10));   // viewer aligns its 3D layer here
    res.setHeader("X-Stone-Dist", String(Math.round(dist * 100) / 100));
    res.setHeader("X-Stone-Surface-H", String(Math.round(surfaceH * 100) / 100)); // m — derived stand top
    res.end(pano);
    waitUntil(saveDream(pano).catch(() => {})); // archive the same embedded copy
    return;
  } catch (e) {
    console.error("dream failed:", e.message);
    res.statusCode = 502;
    return res.json({ error: "The dream engine stumbled. Try again in a moment." });
  }
};
