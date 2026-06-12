#!/usr/bin/env node
// One-time per stone: build a transparent PNG cutout from original.jpg and
// store it in Supabase (storage cutouts/<id>.png + DB images.cutout).
// The viewer renders this as the 3D stone layer — the same object, sharp,
// from every viewpoint. Upgraded to a real GLB mesh when image-to-3D lands.
//
// Run: SUPABASE_URL=.. SUPABASE_SERVICE_KEY=.. doppler run -p oria -c dev --preserve-env -- \
//        node pipeline/make-cutout.mjs <stoneId> <originalPathOrUrl>

import { setDefaultResultOrder } from "node:dns";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

setDefaultResultOrder("ipv4first");
const sharp = createRequire(import.meta.url)("sharp");

const [id, src] = process.argv.slice(2);
const KEY = process.env.GEMINI_AI_STUDIO;
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!id || !src || !KEY || !SB_URL || !SB_KEY) { console.error("usage + env required"); process.exit(1); }

const orig = src.startsWith("http")
  ? Buffer.from(await (await fetch(src)).arrayBuffer())
  : await readFile(src);

// 1) Gemini: same stone, pure chroma-green background (green survives
//    thresholding far better than white — stones contain white, never #00ff00)
const prompt = `Isolate the stone from this photo: render the EXACT same stone — identical shape, texture, colors, lighting and angle — floating on a completely uniform pure green background (#00FF00). NOTHING else from the photo may remain — no ground, no soil, no leaves, no pebbles, no shadow, no surface under the stone. Only the stone itself, surrounded on ALL sides (including below) by flat chroma green. Do not alter the stone itself in any way.`;

const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${KEY}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contents: [{ parts: [
      { text: prompt },
      { inlineData: { mimeType: "image/jpeg", data: orig.toString("base64") } },
    ]}],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "2K" } },
  }),
});
if (!r.ok) { console.error(`gemini HTTP ${r.status}`); process.exit(1); }
const data = await r.json();
const img = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
if (!img) { console.error("no image:", JSON.stringify(data).slice(0, 300)); process.exit(1); }
const green = Buffer.from(img.inlineData.data, "base64");

// 2) chroma-key → alpha, trim, cap at 1024px
const { data: px, info } = await sharp(green).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < px.length; i += 4) {
  const [R, G, B] = [px[i], px[i + 1], px[i + 2]];
  if (G > 110 && G > R * 1.45 && G > B * 1.45) px[i + 3] = 0;          // chroma green → transparent
  else if (G > 90 && G > R * 1.2 && G > B * 1.2) px[i + 3] = Math.round(255 * 0.35); // edge fringe → soften
}
const cutout = await sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
  .trim({ threshold: 10 })
  .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
  .png()
  .toBuffer();

// 3) upload + record
const up = await fetch(`${SB_URL}/storage/v1/object/stones/cutouts/${id}.png`, {
  method: "POST",
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "image/png", "x-upsert": "true" },
  body: cutout,
});
if (!up.ok) { console.error(`upload ${up.status}: ${(await up.text()).slice(0, 200)}`); process.exit(1); }
const url = `${SB_URL}/storage/v1/object/public/stones/cutouts/${id}.png`;

const rowR = await fetch(`${SB_URL}/rest/v1/stones?id=eq.${id}&select=images`, {
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
const existing = rowR.ok ? (await rowR.json())[0]?.images || {} : {};
const pat = await fetch(`${SB_URL}/rest/v1/stones?id=eq.${id}`, {
  method: "PATCH",
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
  body: JSON.stringify({ images: { ...existing, cutout: url } }),
});
if (!pat.ok) { console.error(`db patch ${pat.status}`); process.exit(1); }
console.log(`✓ ${id} → ${url}`);
