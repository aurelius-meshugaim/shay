// POST /api/dream  { stone, description, email? }
// GET  /api/dream  → { emailDelivery: bool }   (capability probe for the UI)
//
// Embedded-stone pipeline (reworked 2026-06-13 — measurement → room → sketch
// → integration render; the old paste-as-final looked pasted):
//   1. RESTYLE a true-equirect template (stones/templates/spacious-1.jpg)
//      into the visitor's described room with an EMPTY display stage derived
//      from the stone's true measurements (sceneFromStone). True projection
//      is inherited from the template; the heavy restyle breaks the wrap seam
//      (healed once, at the very end).
//   2. SKETCH: detect where the model actually put the display surface
//      (median-of-3 pointing), composite the relit cutout there at the exact
//      derived geometry. The sketch is an INTERNAL artifact, never served.
//   3. INTEGRATION RENDER: one Gemini call re-renders a generous crop around
//      the sketch box so the stone is truly part of the scene (contact
//      shadow, room light, perspective) at the sketch's exact position/size;
//      the stone's original photo rides along as the appearance reference.
//      (A whole-pano re-render inflated the stone 3-8x — too small a subject.)
//   4. SIZE GATE: a pointing call boxes the rendered stone; if it inflated
//      >1.8x (or vanished) we fall back to the previous paste(+harmonize)
//      result. The shipped path is logged.
//   5. ROLL 50% (sharp) so the restyle's broken seam sits mid-frame, one
//      light Gemini repair heals it (light edits are wrap-safe, 4/4 probes),
//      roll back, normalize 2:1.
// ~50-57s total — inside the 60s budget (one repair, no crop-harmonize on
// the happy path).
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
    let r;
    try {
      r = await fetch(`${API}/${MODEL}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "2K" } },
        }),
      });
    } catch (e) { // network-level flake — retry like a 5xx
      if (attempt <= 2) { await new Promise((ok) => setTimeout(ok, attempt * 2000)); continue; }
      throw new Error(`${label}: ${e.message}${e.cause ? ` (${e.cause.message || e.cause.code})` : ""}`);
    }
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
// The room is generated WITHOUT the stone, then the stone is sketched in at
// exact geometry and the integration render bakes it into the scene (see OCW
// rnd/2026-06-13-stone-size-realism/SYNTHESIS.md). ONE derivation, built up
// from the stone's true measures, drives (a) the generation prompt's exact
// numbers, (b) the sketch geometry, (c) the response headers, (d) the
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

const REPAIR_PROMPT = `This is a 360-degree equirectangular panorama of a room. There may be a visible vertical seam artifact running down the middle of the image where two parts of the room meet with a hard discontinuity.

Repair ONLY that vertical seam zone: blend the architecture and surfaces across it so the room reads as one continuous space. Keep everything else pixel-faithful — same furniture, same displayed stone, same windows, same lighting, same equirectangular projection. A displayed stone may sit split across the left and right image edges — that split is correct wrap-around, NOT the seam: leave it perfectly intact. The left and right edges of the image are already continuous; keep them exactly continuous.`;

// One full seam pass: roll the broken wrap seam to mid-frame, light Gemini
// repair, roll back, normalize 2:1. Runs ONCE, at the very end of the dream
// pipeline (the integration render re-synthesizes globally, so earlier
// repairs would be wasted budget).
async function seamRepairFull(key, pano) {
  const rolled = await roll50(pano);
  const repaired = await gemini(key, [
    { text: REPAIR_PROMPT },
    { inlineData: { mimeType: "image/jpeg", data: rolled.toString("base64") } },
  ], "seam-repair");
  return finish(repaired);
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

  // NO seam repair here — the wrap seam the restyle broke is healed once, at
  // the very end (seamRepairFull), after the stone is integrated.
  return normalize(styled);
}

// Street-View-style step: re-render the SAME room from a moved camera, then
// run the same seam-repair pass (camera moves are heavy re-synthesis).
async function walkStep({ key, pano, direction }) {
  const movePrompt = `This is a 360-degree equirectangular panorama of a room, captured from its center at eye level.

Re-render the EXACT SAME room from a new camera position: the camera has walked about three meters ${direction}, still at eye level. Every object, piece of furniture, material, window view and light source stays identical — same room, same time of day, only the viewpoint moves. If a displayed stone sits on a pedestal, plinth, table or the floor, KEEP it exactly where it stands — same spot in the room, same physical size, same colors and banding, its shadow staying consistent with the room's light from the new viewpoint.

CRITICAL: output a full 360x180 equirectangular panorama — floor at the bottom edge, ceiling at the top edge, left and right edges perfectly continuous with each other. Photorealistic. No people, no text.`;

  const moved = await gemini(key, [
    { text: movePrompt },
    { inlineData: { mimeType: "image/jpeg", data: pano.toString("base64") } },
  ], "walk");

  const rolled = await roll50(moved);
  const repaired = await gemini(key, [
    { text: REPAIR_PROMPT },
    { inlineData: { mimeType: "image/jpeg", data: rolled.toString("base64") } },
  ], "walk-seam-repair");
  return finish(repaired);
}

// models drift on aspect; normalize to exact 2:1 so the viewer maps a full sphere
async function normalize(buf) {
  const { width: w, height: h } = await sharp(buf).metadata();
  if (w !== 2 * h) return sharp(buf).resize(2 * h, h, { fit: "fill" }).jpeg({ quality: 92 }).toBuffer();
  return buf;
}

async function finish(repaired) {
  return normalize(await roll50(repaired)); // roll back → original facing restored
}

// Text/vision call (no image output) — used for pedestal detection.
async function geminiText(key, parts, label) {
  for (let attempt = 1; ; attempt++) {
    let r;
    try {
      r = await fetch(`${API}/gemini-2.5-flash:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      });
    } catch (e) { // network-level flake — retry like a 5xx
      if (attempt <= 2) { await new Promise((ok) => setTimeout(ok, attempt * 2000)); continue; }
      throw new Error(`${label}: ${e.message}${e.cause ? ` (${e.cause.message || e.cause.code})` : ""}`);
    }
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
    : `the tall, slender display pedestal standing alone in the IMMEDIATE FOREGROUND — the piece of furniture NEAREST the camera, with NOTHING on its top (about ${scene.standH} cm tall). NOT a coffee table, side table, console, desk or shelf that has candles, books, bottles or any objects on it — only the completely empty pedestal closest to the camera`;
  // [y, x] normalized to 0-1000 is the coordinate convention Gemini's pointing
  // is trained on — raw pixel coords on a 2880-wide equirect came back wild.
  // Single points are noisy (±100px in y) → 3 parallel calls, median wins.
  // Full-resolution input on purpose: a 1280-wide downscale made all three
  // pointers miss above the horizon (2026-06-13) — do not "optimize" this.
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

// Relight the cutout to the room before pasting — deterministic Reinhard-style
// channel matching against the surface region it lands on, plus a feathered
// alpha edge. This is what makes the stone belong to the room's light without
// ever letting a model touch its structure (size/shape stay pixel-exact).
async function relightCutout(stonePng, panoJpeg, box, W, H) {
  // room sample: the surface band under/around the stone
  const rw = Math.round(Math.min(W, box.pxW * 2.4)), rh = Math.round(Math.min(H, Math.max(12, box.pxH * 1.4)));
  const rl = Math.max(0, Math.min(W - rw, Math.round(box.left + box.pxW / 2 - rw / 2)));
  const rt = Math.max(0, Math.min(H - rh, Math.round(box.top + box.pxH * 0.55)));
  const region = await sharp(panoJpeg).extract({ left: rl, top: rt, width: rw, height: rh }).stats();
  const meanR = region.channels.slice(0, 3).map((c) => c.mean);

  const { data: px, info } = await sharp(stonePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0; const sum = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 128) { sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2]; n++; }
  if (!n) return stonePng;
  const meanS = sum.map((v) => v / n);
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const K = 0.7; // transfer strength
  const lumTarget = 1 + K * (Math.min(1.3, Math.max(0.55, lum(meanR) / lum(meanS))) - 1);
  const ratios = meanR.map((mr, c) => Math.min(1.6, Math.max(0.5, 1 + K * (mr / meanS[c] - 1))));
  const scale = lumTarget / Math.max(0.01, lum(ratios));
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) px[i + c] = Math.max(0, Math.min(255, Math.round(px[i + c] * ratios[c] * scale)));
  }
  // feathered alpha: soften the cut edge so the boundary melts into the scene
  const alpha = Buffer.alloc(info.width * info.height);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) alpha[j] = px[i + 3];
  const soft = await sharp(alpha, { raw: { width: info.width, height: info.height, channels: 1 } }).blur(1.1).raw().toBuffer();
  for (let i = 0, j = 0; i < px.length; i += 4, j++) px[i + 3] = Math.min(px[i + 3], soft[j]);
  return sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

const INTEGRATE_PROMPT = `The first image is a photograph of a room interior. A stone has been roughly collaged onto the display surface at the center of the photo — it currently looks pasted on: flat shading, a hard cut edge, no contact with the surface. The second image shows the same stone's true appearance.

Re-render the first image photorealistically so the stone is TRULY part of the scene: resting on its display surface with solid contact, a correct soft contact shadow and ambient occlusion where it meets the surface, its lighting and color cast fully consistent with the room's light sources, in true perspective — and at EXACTLY the same size and EXACTLY the same horizontal position as the collage shows. The collage is the precise size and position reference: do NOT enlarge, shrink, or rotate the stone. ONE exception: if the collage shows the stone hovering in the air, sunken into, or clipping through its display surface, correct ONLY its vertical position by the smallest amount needed so it rests naturally ON TOP of the display surface nearest to where the collage placed it — its size must still not change at all. Use the second image to keep the stone's true colors, banding, texture and silhouette faithful.

Change NOTHING else: same camera, same framing, same surface and furniture, same background, same lighting, same colors everywhere outside the stone's immediate surroundings. Photorealistic. No people, no text, no watermarks.`;

// Did the integration render keep the stone honest? Box it with a pointing
// call (same 0-1000 [y,x] convention as detectSurface) and compare widths
// against the sketch geometry. Missing stone or >1.8x inflation trips the gate.
async function sizeGate(crop, key, sketchFrac) {
  let txt;
  try {
    txt = await geminiText(key, [
      { text: `A stone specimen is displayed on a surface near the center of this photo. Give the tight bounding box of the stone itself (not its stand or pedestal). Answer with ONLY JSON: {"box_2d": [ymin, xmin, ymax, xmax]} with coordinates normalized to 0-1000. If no stone is visible, answer {"box_2d": null}. No other text.` },
      { inlineData: { mimeType: "image/jpeg", data: crop.toString("base64") } },
    ], "size-gate");
  } catch (e) {
    // the gate itself failing is no evidence against the render — accept
    console.error("size gate errored — accepting integration:", e.message);
    return { ok: true, note: "gate-error" };
  }
  const m = txt.match(/\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]/);
  if (!m) return { ok: false, reason: `stone missing (gate said: ${txt.slice(0, 80)})` };
  const widthFrac = (parseFloat(m[4]) - parseFloat(m[2])) / 1000;
  const ratio = widthFrac / sketchFrac;
  if (ratio > 1.8) return { ok: false, reason: `inflated ${ratio.toFixed(2)}x (sketch ${Math.round(sketchFrac * 1000)}‰ → render ${Math.round(widthFrac * 1000)}‰ of crop)` };
  return { ok: true, ratio };
}

// Feather a patch back into a base image so its rectangle never shows as a
// tonal seam (shared by the integration recompose and the harmonize fallback).
async function featherIn(base, patch, left, top, w, h) {
  const F = Math.max(12, Math.round(Math.min(w, h) * 0.08)); // feather width
  const maskSvg = Buffer.from(
    `<svg width="${w}" height="${h}"><rect x="${F}" y="${F}" width="${w - 2 * F}" height="${h - 2 * F}" fill="white"/></svg>`);
  const mask = await sharp(maskSvg).resize(w, h).blur(F / 2).extractChannel(0).raw().toBuffer();
  const soft = await sharp(patch).resize(w, h, { fit: "fill" }).removeAlpha()
    .joinChannel(mask, { raw: { width: w, height: h, channels: 1 } })
    .png().toBuffer();
  return sharp(base).composite([{ input: soft, left, top }]).jpeg({ quality: 95 }).toBuffer();
}

// Previous-generation finale, kept callable as the size-gate FALLBACK:
// Gemini harmonizes ONLY a crop around the pasted stone (contact shadow,
// light spill), feathered back in, exact cutout re-pasted on top.
async function harmonizePaste(sketch, stonePng, box, W, H, key) {
  const cw = Math.min(W, box.pxW * 3.5), ch = Math.min(H, box.pxH * 3.5);
  const cl = Math.max(0, Math.min(W - cw, Math.round(box.left + box.pxW / 2 - cw / 2)));
  const ct = Math.max(0, Math.min(H - ch, Math.round(box.top + box.pxH / 2 - ch / 2)));
  const crop = await sharp(sketch).extract({ left: cl, top: ct, width: Math.round(cw), height: Math.round(ch) }).jpeg({ quality: 95 }).toBuffer();
  const harmonized = await gemini(key, [
    { text: `A small stone object sits on the surface at the center of this photo. Its colors are already matched to the room, but it lacks grounding: add the soft contact shadow it would cast on the surface beneath it, gentle ambient occlusion where it meets the surface, and a subtle reflection or light spill if the surface is glossy. CRITICAL: do NOT move, resize, recolor or reshape the stone itself, and change nothing else in the image.` },
    { inlineData: { mimeType: "image/jpeg", data: crop.toString("base64") } },
  ], "embed-harmonize");
  const pano = await featherIn(sketch, harmonized, cl, ct, Math.round(cw), Math.round(ch));
  // size guard: the exact cutout goes back on top
  return sharp(pano).composite([{ input: stonePng, left: box.left, top: box.top }]).jpeg({ quality: 92 }).toBuffer();
}

// Embed the stone INTO the room (reworked 2026-06-13 — embedded, not pasted):
// 1. relight the cutout to the room's light (deterministic), feather its edge
// 2. SKETCH: paste at the geometrically exact size — internal artifact only
// 3. INTEGRATION RENDER: Gemini re-renders a generous crop around the sketch
//    box with the stone truly in the scene — sketch as position/size
//    reference, original photo as appearance reference — feathered back in
// 4. SIZE GATE: stone inflated >1.8x or missing → previous paste(+harmonize)
//    path ships instead (harmonize only if the 60s budget still allows)
// Local-harness debugging: DEBUG_DREAM=/some/dir dumps the internal artifacts
// (sketch, integration render) so a human can judge the stages. No-op on Vercel.
async function debugDump(name, buf) {
  if (!process.env.DEBUG_DREAM) return;
  try { await sharp(buf).toFile(`${process.env.DEBUG_DREAM}/${Date.now() % 1e7}-${name}.jpg`); } catch {}
}

async function embedStone(jpeg, cutout, dimensions, scene, key, original, startedAt) {
  const { width: W, height: H } = await sharp(jpeg).metadata();
  let box = stoneBox(W, H, dimensions, scene);
  let lonDeg = 180, dist = scene.D;
  const tD = Date.now();
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
        // ANY out-of-band distance means the pointer hit a different surface
        // (floor/rug below, or a coffee table/sofa BEHIND — seen 2026-06-13
        // twice: star between pedestal legs, flint onto the sofa). Don't trust
        // a clamped edge: snap fully home to the derived scene.
        dist = scene.D;
        sy = Math.round(H / 2 + (Math.atan((CAM_H - surfaceH) / dist) / Math.PI) * H);
        console.log(`detect dist ${raw.toFixed(2)}m outside [${lo.toFixed(2)}, ${hi.toFixed(2)}] → snap to derived D=${dist}m, y ${s.y}→${sy}`);
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
  console.log(`detect: ${Date.now() - tD}ms`);
  const rawPng = await sharp(cutout).resize(box.pxW, box.pxH, { fit: "fill" }).png().toBuffer();
  const stonePng = await relightCutout(rawPng, jpeg, box, W, H).catch(() => rawPng);
  // the SKETCH: room + collaged stone at exact geometry — internal, never served
  const sketch = await sharp(jpeg)
    .composite([{ input: stonePng, left: box.left, top: box.top }])
    .jpeg({ quality: 95 })
    .toBuffer();
  await debugDump("sketch", sketch);

  // INTEGRATION RENDER — on a generous crop, not the whole pano: a full-pano
  // re-render couldn't hold a ~44px stone at size (2/2 runs inflated it 3-8x,
  // 2026-06-13 — the model makes the subject prominent). In a crop the stone
  // is a major subject, so "same size" is a constraint the model can honor.
  // The crop is built at up to 4x scale so the model sees a SHARP stone (the
  // cutout pasted at matching scale, not an upscaled paste), then the result
  // comes back down and feathers into the pano — stone pixels stay
  // model-generated (embedded), never the cutout's.
  let pano = null, path = "paste";
  const cw = Math.round(Math.min(W, Math.max(box.pxW * 3.5, 220)));
  const ch = Math.round(Math.min(H, Math.max(box.pxH * 3.5, 220)));
  const cl = Math.max(0, Math.min(W - cw, Math.round(box.left + box.pxW / 2 - cw / 2)));
  const ct = Math.max(0, Math.min(H - ch, Math.round(box.top + box.pxH / 2 - ch / 2)));
  try {
    const t0 = Date.now();
    const up = Math.min(4, Math.max(1, Math.round(900 / cw))); // model-input scale
    const roomCrop = await sharp(jpeg).extract({ left: cl, top: ct, width: cw, height: ch })
      .resize(cw * up, ch * up, { kernel: "lanczos3" }).toBuffer();
    const stoneUp = await sharp(cutout).resize(box.pxW * up, box.pxH * up, { fit: "fill" }).png().toBuffer();
    const stoneUpLit = await relightCutout(stoneUp, jpeg, box, W, H).catch(() => stoneUp);
    const sketchCrop = await sharp(roomCrop)
      .composite([{ input: stoneUpLit, left: (box.left - cl) * up, top: (box.top - ct) * up }])
      .jpeg({ quality: 92 }).toBuffer();
    await debugDump("sketch-crop", sketchCrop);
    // appearance reference: original photo (cutout if missing), shrunk — it
    // only informs colors/banding/silhouette, full res is wasted upload
    const refSrc = original || cutout;
    const ref = await sharp(refSrc).resize(768, 768, { fit: "inside", withoutEnlargement: true }).png().toBuffer().catch(() => refSrc);
    const integratedCrop = await gemini(key, [
      { text: INTEGRATE_PROMPT },
      { inlineData: { mimeType: "image/jpeg", data: sketchCrop.toString("base64") } },
      { inlineData: { mimeType: "image/png", data: ref.toString("base64") } },
    ], "integrate");
    await debugDump("integrated-crop", integratedCrop);
    const tGate = Date.now();
    const gate = await sizeGate(integratedCrop, key, box.pxW / cw);
    console.log(`integrate ${tGate - t0}ms, gate ${Date.now() - tGate}ms → ${gate.ok ? `OK (ratio ${gate.ratio?.toFixed(2) ?? "n/a"})` : `TRIPPED: ${gate.reason}`}`);
    if (gate.ok) {
      pano = await featherIn(jpeg, integratedCrop, cl, ct, cw, ch);
      path = "integrated";
    }
  } catch (e) {
    console.error("integration render failed → paste fallback:", e.message);
  }

  if (!pano) {
    pano = sketch;
    // previous-generation harmonize, only while the 60s budget still affords
    // it (final seam pass still ahead needs ~15-18s)
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    if (elapsed < 34000) {
      try { pano = await harmonizePaste(sketch, stonePng, box, W, H, key); path = "paste+harmonize"; }
      catch (e) { console.error("fallback harmonize skipped:", e.message); }
    } else console.log(`fallback harmonize skipped — ${Math.round(elapsed / 1000)}s elapsed, budget too tight`);
  }
  return { pano, lonDeg, dist, surfaceH: scene.surfaceH, embedded: true, path };
}

const { stoneEmail, send: sendMail } = require("./_email.js");

async function sendEmail({ resendKey, to, name, desc, dreamId, imageUrl }) {
  const viewUrl = dreamId ? `https://shaym.beauty/?dream=${dreamId}` : "https://shaym.beauty";
  return sendMail({
    resendKey,
    to,
    subject: `${name} — in your home, in 360°`,
    html: stoneEmail({
      preheader: `Your dream is ready — ${name}, at home with you.`,
      heading: "Your dream is ready",
      intro: `<em>“${desc.replace(/&/g, "&amp;").replace(/</g, "&lt;")}”</em><br/><br/>` +
        `<strong style="color:#fff">${name}</strong> is standing in your room. Step inside and look around.`,
      image: imageUrl || null,
      rows: [{ label: "Stone", value: name }],
      cta: { label: "See it in 360°", url: viewUrl },
    }),
  });
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    // ?id=<uuid> → a saved dream (powers the email's "see it in the app" link)
    const id = (req.query && req.query.id) || "";
    if (id && /^[0-9a-f-]{36}$/.test(id) && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const h = { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
      const row = await fetch(`${process.env.SUPABASE_URL}/rest/v1/dreams?id=eq.${id}&select=image,stone_id,description`, { headers: h })
        .then((r) => (r.ok ? r.json() : [])).then((a) => a[0]).catch(() => null);
      if (!row || !row.image) { res.statusCode = 404; return res.json({ error: "Dream not found." }); }
      res.setHeader("Cache-Control", "s-maxage=3600");
      return res.json(row);
    }
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

  const startedAt = Date.now();

  // embed the stone into the env (detect surface → sketch → integration render
  // → size gate, paste fallback)
  async function withStone(jpeg) {
    const bare = { pano: jpeg, lonDeg: 180, dist: plan.D, surfaceH: plan.surfaceH, embedded: false, path: "bare" };
    const cutoutUrl = row?.images?.cutout;
    if (!cutoutUrl) return bare;
    try {
      // the stone's original photo = appearance reference for the integration
      // render. DB stones carry a URL; legacy manifest stones live in the repo.
      const originalP = Promise.any(
        [row?.images?.original, `${host}/stones/${stone}/original.jpg`, `${host}/stones/${stone}/original.png`]
          .filter(Boolean)
          .map((u) => fetch(u).then(async (r) => { if (!r.ok) throw new Error("miss"); return Buffer.from(await r.arrayBuffer()); })),
      ).catch(() => null);
      const c = await fetch(cutoutUrl);
      if (!c.ok) return bare;
      return await embedStone(jpeg, Buffer.from(await c.arrayBuffer()), meta?.dimensions, plan, KEY, await originalP, startedAt);
    } catch (e) {
      console.error("embed skipped, serving bare pano:", e.message);
      return bare;
    }
  }

  // full sync pipeline: room → embed → ONE seam pass at the very end
  async function dreamPipeline() {
    const tR = Date.now();
    const styled = await generate(args);
    const tE = Date.now();
    const embedded = await withStone(styled);
    const tS = Date.now();
    const pano = await seamRepairFull(KEY, embedded.pano);
    console.log(`dream timings: restyle=${((tE - tR) / 1000).toFixed(1)}s embed=${((tS - tE) / 1000).toFixed(1)}s seam=${((Date.now() - tS) / 1000).toFixed(1)}s total=${((Date.now() - tR) / 1000).toFixed(1)}s path=${embedded.path}`);
    return { ...embedded, pano };
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
      dreamPipeline()
        .then(async ({ pano }) => {
          await saveDream(pano); // permanent URL the email links into
          const imageUrl = dreamId && process.env.SUPABASE_URL
            ? `${process.env.SUPABASE_URL}/storage/v1/object/public/stones/dreams/${dreamId}.jpg` : null;
          return sendEmail({ resendKey: process.env.RESEND_API_KEY, to, name: meta?.name || stone, desc, dreamId, imageUrl });
        })
        .catch((e) => console.error("dream-email failed:", e.message)),
    );
    return;
  }

  try {
    const { pano, lonDeg, dist, surfaceH, embedded } = await dreamPipeline(); // stone generated INTO the room (or paste fallback — both baked)
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Stone-Lon", String(Math.round(lonDeg * 10) / 10));   // viewer faces the stone here
    res.setHeader("X-Stone-Dist", String(Math.round(dist * 100) / 100));
    res.setHeader("X-Stone-Surface-H", String(Math.round(surfaceH * 100) / 100)); // m — derived stand top
    if (embedded) res.setHeader("X-Stone-Embedded", "1"); // stone is IN the pixels → viewer skips its 3D billboard
    res.end(pano);
    waitUntil(saveDream(pano).catch(() => {})); // archive the same embedded copy
    return;
  } catch (e) {
    console.error("dream failed:", e.message);
    res.statusCode = 502;
    return res.json({ error: "The dream engine stumbled. Try again in a moment." });
  }
};
