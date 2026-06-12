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
const RL_MAX = 6, RL_WIN = 60 * 60 * 1000;
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

function dims(stoneMeta) {
  const d = stoneMeta?.dimensions;
  if (!d) return { sizeText: "about 14 cm wide (hand-sized)", scaleWord: "a hand-sized collectible mineral", placement: "on an elegant display pedestal or small table" };
  const sizeText = `${d.width_cm} cm wide, ${d.height_cm} cm tall, ${d.depth_cm} cm deep`;
  const big = d.width_cm >= 40;
  return {
    sizeText,
    scaleWord: big ? "a substantial sculptural stone" : "a hand-sized collectible mineral",
    placement: big
      ? "standing directly on the floor as a sculptural centerpiece"
      : "on an elegant display pedestal or small table",
  };
}

async function generate({ base, key, name, sizeText, scaleWord, placement, desc }) {
  const restylePrompt = `The first image is a 360-degree equirectangular panorama of an interior, captured from the center of the room at eye level. The second image is a photograph of a stone ("${name}") whose real size is ${sizeText}.

Completely redesign the interior into the visitor's own home, as they describe it: ${desc}

NON-NEGOTIABLE RULES, regardless of the description:
1. The room is SPACIOUS — high ceilings, walls at a generous distance from the camera; the visitor stands in the middle of an open, airy space. If the description implies a small space, render its spirit in a generous version of it.
2. The room is RICH and lived-in: layered textiles, artwork on the walls, plants, books, lamps, warm material detail — a loved, fully furnished home in the spirit of the description, never an empty showroom.
3. The stone stands at the CENTER OF THE ROOM: ${placement}, about three to four meters in front of the camera, at the horizontal center of the image. It is the focal point the whole room is arranged around — visible, but with breathing room around it.
4. The stone's size is EXACTLY its real size — ${sizeText}, ${scaleWord}, NOT larger and NOT smaller. A stone rendered at a different size than ${sizeText} is wrong.

Use the exact stone from the second photograph: preserve its true colors, banding, texture and silhouette, and light it consistently with the room.

CRITICAL: keep the equirectangular projection of the first image exactly — same camera position, full 360x180 sphere, floor at the bottom edge, ceiling at the top edge, left and right edges perfectly continuous with each other. Photorealistic. No people, no text, no watermarks.`;

  const styled = await gemini(key, [
    { text: restylePrompt },
    { inlineData: { mimeType: "image/jpeg", data: base.template.toString("base64") } },
    { inlineData: { mimeType: "image/jpeg", data: base.stone.toString("base64") } },
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

Re-render the EXACT SAME room from a new camera position: the camera has walked about three meters ${direction}, still at eye level. Every object, piece of furniture, material, window view and light source stays identical — same room, same time of day, only the viewpoint moves. Keep the displayed stone exactly as it is, at its same physical size and place in the room.

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

async function sendEmail({ resendKey, to, name, jpeg }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Stones <stones@shaym.beauty>",
      to: [to],
      subject: `${name} — in your home, in 360°`,
      html: `<p>Your dream is ready: <strong>${name}</strong>, at home with you.</p>
<p>The attached image is a full 360° panorama — open it at
<a href="https://shaym.beauty">shaym.beauty</a> or in any 360 viewer.</p>`,
      attachments: [{ filename: "your-home-360.jpg", content: jpeg.toString("base64") }],
    }),
  });
  if (!r.ok) throw new Error(`resend: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
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
  const [stoneRes, tplRes, manifestRes] = await Promise.all([
    fetch(`${host}/stones/${stone}/original.jpg`),
    fetch(`${host}/${TEMPLATE}`),
    fetch(`${host}/stones/manifest.json`),
  ]);
  if (!stoneRes.ok || !tplRes.ok) {
    res.statusCode = 400;
    return res.json({ error: "Unknown stone." });
  }
  const base = {
    stone: Buffer.from(await stoneRes.arrayBuffer()),
    template: Buffer.from(await tplRes.arrayBuffer()),
  };
  const manifest = manifestRes.ok ? await manifestRes.json() : [];
  let meta = manifest.find((s) => s.id === stone);
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    // DB is the source of truth for identity + dimensions; manifest is fallback
    const h = { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
    const row = await fetch(`${process.env.SUPABASE_URL}/rest/v1/stones?id=eq.${stone}&select=name,width_cm,height_cm,depth_cm`, { headers: h })
      .then((r) => (r.ok ? r.json() : [])).then((a) => a[0]).catch(() => null);
    if (row) meta = { name: row.name, dimensions: { width_cm: Number(row.width_cm), height_cm: Number(row.height_cm), depth_cm: Number(row.depth_cm) } };
  }
  const args = { base, key: KEY, name: meta?.name || stone, ...dims(meta), desc };

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    // fire-and-forget dream log
    fetch(`${process.env.SUPABASE_URL}/rest/v1/dreams`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stone_id: stone, description: desc, email: to || null, ip }),
    }).catch(() => {});
  }

  if (to) {
    // Respond now; finish + deliver in the background (within maxDuration).
    res.statusCode = 202;
    res.json({ queued: true });
    waitUntil(
      generate(args)
        .then((jpeg) => sendEmail({ resendKey: process.env.RESEND_API_KEY, to, name: args.name, jpeg }))
        .catch((e) => console.error("dream-email failed:", e.message)),
    );
    return;
  }

  try {
    const jpeg = await generate(args);
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.end(jpeg);
  } catch (e) {
    console.error("dream failed:", e.message);
    res.statusCode = 502;
    return res.json({ error: "The dream engine stumbled. Try again in a moment." });
  }
};
