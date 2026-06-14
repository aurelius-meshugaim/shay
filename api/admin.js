// POST /api/admin — gallery administration (admin.shaym.beauty).
// Auth: x-admin-pass header checked against env ADMIN_PASSWORD.
//
// The 4-variant pipeline (analysis → brainstorm → design → 4 generations)
// exceeds one function's 60s budget, so the admin page drives it in stages:
//   create   {name?, width_cm, height_cm, depth_cm, photos:[b64 ≤3]} → {id}
//   analyze  {id}                → analysis/brainstorm/design saved to meta
//   variant  {id, kind}          → one generated variant uploaded to storage
//   finalize {id}                → status 'available' → appears in gallery
// New stones live entirely in Supabase (rows + storage bucket "stones");
// the static manifest keeps serving the two legacy stones.

const TEXT_MODEL = "gemini-2.5-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";
const API = "https://generativelanguage.googleapis.com/v1beta/models";
const VARIANTS = ["blur", "outdoor", "indoor", "creative"];

const sb = () => ({
  url: process.env.SUPABASE_URL,
  headers: {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  },
});

async function row(id) {
  const { url, headers } = sb();
  const r = await fetch(`${url}/rest/v1/stones?id=eq.${encodeURIComponent(id)}&select=*`, { headers });
  return r.ok ? (await r.json())[0] : null;
}

async function patch(id, fields) {
  const { url, headers } = sb();
  const r = await fetch(`${url}/rest/v1/stones?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`db patch: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function upload(path, buf) {
  const { url, headers } = sb();
  const r = await fetch(`${url}/storage/v1/object/stones/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "image/jpeg", "x-upsert": "true" },
    body: buf,
  });
  if (!r.ok) throw new Error(`storage upload: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return `${url}/storage/v1/object/public/stones/${path}`;
}

async function gemini(model, parts, { imageOut = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${API}/${model}:generateContent?key=${process.env.GEMINI_AI_STUDIO}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        ...(imageOut ? { generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "2K" } } } : {}),
      }),
    });
    if ((r.status === 429 || r.status >= 500) && attempt <= 2) {
      await new Promise((ok) => setTimeout(ok, attempt * 3000));
      continue;
    }
    if (!r.ok) throw new Error(`${model}: HTTP ${r.status}`);
    const data = await r.json();
    const out = data.candidates?.[0]?.content?.parts ?? [];
    if (imageOut) {
      const img = out.find((p) => p.inlineData);
      if (img) return Buffer.from(img.inlineData.data, "base64");
      if (attempt <= 2) continue;
      throw new Error(`${model}: no image`);
    }
    const text = out.filter((p) => p.text).map((p) => p.text).join("");
    if (text) return text;
    if (attempt <= 2) continue;
    throw new Error(`${model}: no text`);
  }
}

function parseJson(text, stage) {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/```\s*([\s\S]*?)```/);
  try { return JSON.parse(m ? m[1] : text); }
  catch { throw new Error(`${stage}: bad JSON from model`); }
}

const imagePart = (buf) => ({ inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") } });

async function fetchOriginal(stoneRow) {
  const url = stoneRow.images?.original;
  if (!url) throw new Error("stone has no original image");
  const r = await fetch(url);
  if (!r.ok) throw new Error("could not fetch original");
  return Buffer.from(await r.arrayBuffer());
}

// ---- pipeline stages (ported from pipeline/run.mjs) -------------------------

async function stageAnalyze(stoneRow) {
  const buf = await fetchOriginal(stoneRow);
  const analysisPrompt = `Analyze the stone in this photo.
Also estimate the stone's real-world HEIGHT in centimeters — the vertical extent of the physical stone as it sits in the photo. Use whatever scale cues are visible (a hand or fingers, ground texture, nearby objects, depth of field, framing). If no reliable cue exists, give your single best estimate for a stone of this apparent type and framing. Return ONE number, never a range.
Return ONLY JSON:
{
  "name": "a poetic two-word display name for this stone",
  "colors": ["..."],
  "texture": "...",
  "character": "the stone's personality/mood in one sentence",
  "distinctive_features": ["..."],
  "height_cm": <number — your single best estimate of the stone's height in centimeters>,
  "height_reasoning": "one short sentence: which scale cue you used"
}`;
  const analysis = parseJson(await gemini(TEXT_MODEL, [imagePart(buf), { text: analysisPrompt }]), "analysis");

  const brainstorm = parseJson(await gemini(TEXT_MODEL, [{ text: `Here is an analysis of a stone:
${JSON.stringify(analysis, null, 2)}

Brainstorm scene ideas for re-photographing this exact stone in new settings. For each category below, propose 4 distinct, vivid ideas (one line each) that flatter THIS stone's specific colors, texture and character:

- "blur": the stone tack-sharp against a sophisticated, softly blurred background — think fine-art product photography, elegant bokeh, complementary color palette.
- "outdoor": a natural outdoor setting.
- "indoor": an interior setting.
- "creative": an unexpected, artistic, imaginative setting — surreal allowed.

Return ONLY JSON: { "blur": ["..",..], "outdoor": [...], "indoor": [...], "creative": [...] }` }]), "brainstorm");

  const design = parseJson(await gemini(TEXT_MODEL, [{ text: `Stone analysis:
${JSON.stringify(analysis, null, 2)}

Brainstormed scene ideas per category:
${JSON.stringify(brainstorm, null, 2)}

For each category (blur, outdoor, indoor, creative): pick the single strongest idea for THIS stone and expand it into a polished image-generation prompt. Each prompt must:
1. Begin with: "Take the exact stone from the provided photo — preserve its shape, texture, colors and every distinctive feature faithfully —"
2. Then describe placement, setting, lighting, camera/lens feel, and mood in rich detail.
3. For "blur": the background must be sophisticatedly blurred (shallow depth of field, refined bokeh), stone in crisp focus.
4. Composition: the stone is the centered subject — dead center of the frame, hero of the shot.

Also write a short poetic caption (under 12 words) per category.

Return ONLY JSON:
{ "blur": {"prompt": "...", "caption": "..."}, "outdoor": {...}, "indoor": {...}, "creative": {...} }` }]), "design");

  const fields = { meta: { analysis, design } };
  if (!stoneRow.name || stoneRow.name === stoneRow.id) fields.name = analysis.name;
  if (!stoneRow.character) fields.character = analysis.character;
  // Height is always Gemini-estimated (the upload form no longer collects it).
  const estH = Number(analysis.height_cm);
  if (estH > 0 && estH < 10000) { fields.height_cm = estH; fields.dimensions_approx = true; }
  await patch(stoneRow.id, fields);
  return { name: fields.name || stoneRow.name, character: analysis.character, height_cm: fields.height_cm ?? null };
}

// Transparent cutout for the viewer's 3D stone layer: Gemini re-renders the
// stone on chroma green, sharp keys it out (same recipe as pipeline/make-cutout.mjs).
async function stageCutout(stoneRow) {
  const sharp = require("sharp");
  const buf = await fetchOriginal(stoneRow);
  const prompt = `Isolate the stone from this photo: render the EXACT same stone — identical shape, texture, colors, lighting and angle — floating on a completely uniform pure green background (#00FF00). NOTHING else from the photo may remain — no ground, no shadow, no surface under the stone. Only the stone itself, surrounded on ALL sides (including below) by flat chroma green. Do not alter the stone itself in any way.`;
  const green = await gemini(IMAGE_MODEL, [imagePart(buf), { text: prompt }], { imageOut: true });
  const { data: px, info } = await sharp(green).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < px.length; i += 4) {
    const [R, G, B] = [px[i], px[i + 1], px[i + 2]];
    if (G > 110 && G > R * 1.45 && G > B * 1.45) px[i + 3] = 0;
    else if (G > 90 && G > R * 1.2 && G > B * 1.2) px[i + 3] = Math.round(255 * 0.35);
  }
  const cutout = await sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
    .trim({ threshold: 10 })
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const { url, headers } = sb();
  const r = await fetch(`${url}/storage/v1/object/stones/cutouts/${stoneRow.id}.png`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "image/png", "x-upsert": "true" },
    body: cutout,
  });
  if (!r.ok) throw new Error(`cutout upload: ${r.status}`);
  const publicUrl = `${url}/storage/v1/object/public/stones/cutouts/${stoneRow.id}.png`;
  await patch(stoneRow.id, { images: { ...(stoneRow.images || {}), cutout: publicUrl } });
  return { cutout: publicUrl };
}

const COMPOSITION_RULE =
  " Composition requirement: the stone is perfectly centered in the frame, both horizontally and vertically — it is the clear central subject of the image.";

async function stageVariant(stoneRow, kind) {
  if (!VARIANTS.includes(kind)) throw new Error("unknown variant");
  const design = stoneRow.meta?.design?.[kind];
  if (!design) throw new Error("run analyze first");
  const buf = await fetchOriginal(stoneRow);
  const img = await gemini(IMAGE_MODEL, [imagePart(buf), { text: design.prompt + COMPOSITION_RULE }], { imageOut: true });
  const url = await upload(`${stoneRow.id}/${kind}.jpg`, img);
  const images = { ...(stoneRow.images || {}), [kind]: { src: url, caption: design.caption } };
  await patch(stoneRow.id, { images });
  return { kind, url };
}

// ---- handler ----------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.statusCode = 405; return res.json({ error: "POST only" }); }
  if (!process.env.ADMIN_PASSWORD || req.headers["x-admin-pass"] !== process.env.ADMIN_PASSWORD) {
    res.statusCode = 401;
    return res.json({ error: "Wrong password." });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    res.statusCode = 500;
    return res.json({ error: "Storage is not configured." });
  }

  const { action } = req.body || {};
  try {
    if (action === "ping") return res.json({ ok: true });
    if (action === "create") {
      const { name = "", width_cm, height_cm, depth_cm, photos = [] } = req.body;
      // Height is estimated by Gemini in the analyze stage; width/depth are optional manual extras.
      const dims = [width_cm, height_cm, depth_cm].map((d) => (Number(d) > 0 && Number(d) < 10000 ? Number(d) : null));
      if (!Array.isArray(photos) || photos.length < 1 || photos.length > 3) { res.statusCode = 400; return res.json({ error: "1 to 3 photos." }); }
      const base = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const id = (base || "stone") + "-" + Math.random().toString(36).slice(2, 6);
      const images = {};
      for (let i = 0; i < photos.length; i++) {
        const buf = Buffer.from(String(photos[i]), "base64");
        if (buf.length < 1000 || buf.length > 8_000_000) { res.statusCode = 400; return res.json({ error: `Photo ${i + 1} is empty or too large.` }); }
        const url = await upload(`${id}/${i === 0 ? "original" : `original-${i + 1}`}.jpg`, buf);
        images[i === 0 ? "original" : `original_${i + 1}`] = url;
      }
      const { url, headers } = sb();
      const r = await fetch(`${url}/rest/v1/stones`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          id, name: String(name).trim() || id, width_cm: dims[0], height_cm: dims[1], depth_cm: dims[2],
          dimensions_approx: false, status: "processing", images,
        }),
      });
      if (!r.ok) throw new Error(`db insert: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return res.json({ id });
    }

    const stone = await row(String(req.body.id || ""));
    if (!stone) { res.statusCode = 404; return res.json({ error: "Unknown stone." }); }

    if (action === "analyze") return res.json(await stageAnalyze(stone));
    if (action === "cutout") return res.json(await stageCutout(stone));
    if (action === "variant") return res.json(await stageVariant(stone, String(req.body.kind)));
    if (action === "finalize") {
      const missing = VARIANTS.filter((v) => !stone.images?.[v]);
      if (missing.length) { res.statusCode = 400; return res.json({ error: `Missing variants: ${missing.join(", ")}` }); }
      await patch(stone.id, { status: "available" });
      if (process.env.RESEND_API_KEY && process.env.OFFER_NOTIFY) {
        const { stoneEmail, send } = require("./_email.js");
        const dims = [["width_cm", "wide"], ["height_cm", "tall"], ["depth_cm", "deep"]]
          .filter(([k]) => stone[k] > 0).map(([k, w]) => `${stone[k]} cm ${w}`).join(" · ");
        await send({
          resendKey: process.env.RESEND_API_KEY,
          to: process.env.OFFER_NOTIFY,
          subject: `${stone.name} is ready — live in the gallery`,
          html: stoneEmail({
            preheader: `${stone.name} finished processing and is live on shaym.beauty.`,
            heading: `${stone.name} is ready`,
            intro: stone.character || "Processed, framed, and hanging in the gallery.",
            image: stone.images?.blur?.src || stone.images?.original || null,
            rows: [
              { label: "Stone", value: stone.name },
              ...(dims ? [{ label: "Size", value: dims }] : []),
              { label: "Id", value: stone.id },
            ],
            cta: { label: "See it live", url: "https://shaym.beauty" },
          }),
        }).catch((e) => console.error("ready email:", e.message));
      }
      return res.json({ ok: true, id: stone.id });
    }
    res.statusCode = 400;
    return res.json({ error: "Unknown action." });
  } catch (e) {
    console.error("admin failed:", action, e.message);
    res.statusCode = 502;
    return res.json({ error: e.message });
  }
};
