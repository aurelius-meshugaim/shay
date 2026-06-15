// POST /api/dream  { stone, description }           → image/jpeg panorama + X-Dream-Id header
// POST /api/dream  { emailExisting, email }         → { ok:true }  (email the saved dream)
// GET  /api/dream                                    → { emailDelivery: bool }
// GET  /api/dream?id=<uuid>                         → { image, stone_id, description }
//
// Simple one-shot pipeline: Gemini generates the equirectangular 360° pano with
// the stone staged inside. On success the pano is saved to Supabase storage and a
// dreams row is created (or patched) — the same URL powers both the in-page result
// slide and the deep-link from the email.

const IMAGE_MODEL = "gemini-3.1-flash-image";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

const { r2put } = require("./_storage.js");

// ---- rate limiter (per-instance only) ----
const hits = new Map();
const RL_MAX = 30, RL_WIN = 60 * 60 * 1000;
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter((t) => now - t < RL_WIN);
  arr.push(now); hits.set(ip, arr);
  return arr.length > RL_MAX;
}

// ---- generate the pano via Gemini ----
async function generatePano({ key, stoneB64, desc }) {
  const prompt = `Create a single seamless 360-degree equirectangular panorama (full horizontal wrap: the left and right edges must continue into each other).

The scene — the visitor's own home, as they describe it: ${desc}

Critically: the exact stone from the attached photograph must appear in the scene as a treasured displayed object — on a pedestal, mantel, shelf or table. Preserve the stone's true colors, banding, texture and shape from the photo. Render it at a believable physical size for a collectible mineral specimen.

Distance and framing (strict): the stone must always sit at least several metres away from the viewer, across the room — on a far pedestal, mantel, shelf or against a distant wall — with clear, open floor space between the camera and the stone. There must ALWAYS be a visible gap of empty room between the viewer and the stone; it must never be near, never loom, never fill or crowd the foreground, never sit just in front of the camera. It should read as a SMALL, distant focal point — occupying only a modest portion of the view — that you would have to walk across the room to reach. Err on the side of placing it too far rather than too close.

Placement in the frame (important): position the stone at the exact HORIZONTAL CENTER of the equirectangular image (its middle column) and at the viewer's eye level (the vertical middle / horizon line). Someone entering the panorama looking straight ahead must see the stone centred dead-ahead in their view.

Style: photorealistic, warm inviting light, the home feels lived-in and personal. No people, no text, no watermarks. Equirectangular projection only — straight vertical lines may curve horizontally as the projection requires.`;

  const body = {
    contents: [{ parts: [
      { text: prompt },
      { inlineData: { mimeType: "image/jpeg", data: stoneB64 } },
    ]}],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "21:9", imageSize: "2K" },
    },
  };

  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${API}/${IMAGE_MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if ((r.status === 429 || r.status >= 500) && attempt <= 2) {
      await new Promise((ok) => setTimeout(ok, attempt * 4000));
      continue;
    }
    if (!r.ok) throw new Error(`Generation failed (HTTP ${r.status})`);
    const data = await r.json();
    const img = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!img) {
      if (attempt <= 2) continue;
      throw new Error("The model returned no image.");
    }
    return Buffer.from(img.inlineData.data, "base64");
  }
}

// ---- Supabase helpers ----
function sbHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

// Insert a dreams row, upload the pano to storage, patch the image URL back.
// Returns the dreamId (UUID). Best-effort — errors are swallowed.
async function saveDream({ supabaseUrl, supabaseKey, stone, desc, ip, jpeg }) {
  if (!supabaseUrl || !supabaseKey) return null;
  const h = sbHeaders(supabaseKey);
  // insert row
  const row = await fetch(`${supabaseUrl}/rest/v1/dreams`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ stone_id: stone, description: desc, ip }),
  }).then((r) => (r.ok ? r.json() : [])).then((a) => a[0] || null).catch(() => null);
  if (!row) return null;
  const id = row.id;
  // upload image to R2 (served from cdn.shaym.beauty)
  let imageUrl;
  try {
    imageUrl = await r2put(`dreams/${id}.jpg`, jpeg, "image/jpeg");
  } catch (e) {
    console.error("dream image upload:", e.message);
    return id; // row exists but no image; still return id
  }
  // patch image URL
  await fetch(`${supabaseUrl}/rest/v1/dreams?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...h, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ image: imageUrl }),
  }).catch(() => {});
  return id;
}

// ---- email delivery ----
const { stoneEmail, send: sendMail } = require("./_email.js");

async function sendDreamEmail({ resendKey, to, name, desc, dreamId, imageUrl }) {
  const viewUrl = dreamId ? `https://shaym.beauty/?dream=${dreamId}` : "https://shaym.beauty";
  return sendMail({
    resendKey,
    to,
    subject: `${name} — in your home, in 360°`,
    html: stoneEmail({
      preheader: `Your dream is ready — ${name}, at home with you.`,
      heading: "Your dream is ready",
      intro: `<em>"${desc.replace(/&/g, "&amp;").replace(/</g, "&lt;")}"</em><br/><br/>` +
        `<strong style="color:#fff">${name}</strong> is standing in your room. Step inside and look around.`,
      image: imageUrl || null,
      rows: [{ label: "Stone", value: name }],
      cta: { label: "See it in 360°", url: viewUrl },
    }),
  });
}

module.exports = async (req, res) => {
  // ---- GET ----
  if (req.method === "GET") {
    const id = (req.query && req.query.id) || "";
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (id && /^[0-9a-f-]{36}$/.test(id) && SUPABASE_URL && SUPABASE_KEY) {
      const h = sbHeaders(SUPABASE_KEY);
      const row = await fetch(
        `${SUPABASE_URL}/rest/v1/dreams?id=eq.${id}&select=image,stone_id,description`,
        { headers: h }
      ).then((r) => (r.ok ? r.json() : [])).then((a) => a[0]).catch(() => null);
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

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;

  const body = req.body || {};

  // ---- emailExisting branch: re-deliver a saved dream without regenerating ----
  if (body.emailExisting) {
    const { emailExisting: dreamId, email: to } = body;
    if (!/^[0-9a-f-]{36}$/.test(dreamId)) {
      res.statusCode = 400; return res.json({ error: "Invalid dream id." });
    }
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to).trim())) {
      res.statusCode = 400; return res.json({ error: "Valid email required." });
    }
    if (!RESEND_KEY) {
      res.statusCode = 503; return res.json({ error: "Email delivery isn't set up." });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      res.statusCode = 503; return res.json({ error: "Storage not configured." });
    }
    const h = sbHeaders(SUPABASE_KEY);
    const row = await fetch(
      `${SUPABASE_URL}/rest/v1/dreams?id=eq.${dreamId}&select=image,stone_id,description,stones(name)`,
      { headers: h }
    ).then((r) => (r.ok ? r.json() : [])).then((a) => a[0]).catch(() => null);
    if (!row || !row.image) {
      res.statusCode = 404; return res.json({ error: "Dream not found." });
    }
    const name = (row.stones && row.stones.name) || row.stone_id || "Stone";
    try {
      await sendDreamEmail({
        resendKey: RESEND_KEY, to: String(to).trim(),
        name, desc: row.description || "", dreamId, imageUrl: row.image,
      });
      return res.json({ ok: true });
    } catch (e) {
      console.error("emailExisting failed:", e.message);
      res.statusCode = 502; return res.json({ error: "Email delivery failed." });
    }
  }

  // ---- main dream generation ----
  const ip = (req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  if (limited(ip)) {
    res.statusCode = 429;
    return res.json({ error: "The dream engine needs a breather — try again in a little while." });
  }

  const { stone = "flint", description = "" } = body;
  const desc = String(description).trim();
  if (desc.length < 3 || desc.length > 600) {
    res.statusCode = 400;
    return res.json({ error: "Describe your home in 3–600 characters." });
  }
  if (!/^[a-z0-9-]+$/.test(stone)) {
    res.statusCode = 400;
    return res.json({ error: "Unknown stone." });
  }

  // Resolve stone's original image from DB (all stones including flint+boulder are
  // now fully in Supabase storage). Fall back to repo URL for dev/emergency only.
  let stoneUrl = null;
  if (SUPABASE_URL && SUPABASE_KEY) {
    const sbH = sbHeaders(SUPABASE_KEY);
    const stoneRow = await fetch(
      `${SUPABASE_URL}/rest/v1/stones?id=eq.${stone}&select=images`,
      { headers: sbH }
    ).then((r) => (r.ok ? r.json() : [])).then((a) => a[0]).catch(() => null);
    if (stoneRow?.images?.original) stoneUrl = stoneRow.images.original;
  }
  if (!stoneUrl) {
    // fallback: try repo-served path (dev servers where storage may not be set up)
    const proto = req.headers["x-forwarded-proto"] || "https";
    stoneUrl = `${proto}://${req.headers.host}/stones/${stone}/original.jpg`;
  }
  const stoneRes = await fetch(stoneUrl);
  if (!stoneRes.ok) {
    res.statusCode = 400;
    return res.json({ error: "Unknown stone." });
  }
  const stoneB64 = Buffer.from(await stoneRes.arrayBuffer()).toString("base64");

  try {
    const jpeg = await generatePano({ key: KEY, stoneB64, desc });

    // Save dream inline so we get the id for the response header.
    // waitUntil ensures Vercel keeps the function alive if the response flushes first.
    const dreamId = await saveDream({
      supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, stone, desc, ip, jpeg,
    }).catch(() => null);

    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    if (dreamId) res.setHeader("X-Dream-Id", dreamId);

    return res.end(jpeg);
  } catch (e) {
    console.error("dream failed:", e.message);
    res.statusCode = 502;
    return res.json({ error: "The dream engine stumbled. Try again in a moment." });
  }
};
