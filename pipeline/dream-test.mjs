#!/usr/bin/env node
// One-shot proof for the "dream it home" 360 route: stone photo + a house
// description → equirectangular panorama from Gemini. Validates the prompt
// recipe before wiring it into api/dream.js.
//
// Run:  doppler run -p oria -c dev -- node pipeline/dream-test.mjs "<description>"

import { setDefaultResultOrder } from "node:dns";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

setDefaultResultOrder("ipv4first");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KEY = process.env.GEMINI_AI_STUDIO;
if (!KEY) { console.error("GEMINI_AI_STUDIO not set"); process.exit(1); }

const IMAGE_MODEL = "gemini-3.1-flash-image";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

const description = process.argv[2] ||
  "a warm scandinavian living room with a fireplace, big windows looking onto a snowy pine forest, wooden floors";

const stone = await readFile(path.join(ROOT, "stones/flint/original.jpg"));

const prompt = `Create a single seamless 360-degree equirectangular panorama (2:1 aspect ratio, full sphere: floor at the bottom edge, ceiling/sky at the top edge, left and right edges wrapping continuously into each other).

The scene: ${description}

Critically: the exact stone from the attached photograph must appear in the scene as a treasured displayed object — on a pedestal, mantel, shelf or table at a natural focal point of the room. Preserve the stone's true colors, banding, texture and shape from the photo. Render it at a believable physical size for a collectible mineral specimen.

Style: photorealistic, warm inviting light, the home feels lived-in and personal. No people, no text, no watermarks. Equirectangular projection only — straight vertical lines may curve horizontally as the projection requires.`;

const body = {
  contents: [{ parts: [
    { text: prompt },
    { inlineData: { mimeType: "image/jpeg", data: stone.toString("base64") } },
  ]}],
  generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "21:9", imageSize: "2K" } },
};

console.log("Calling", IMAGE_MODEL, "…");
const t0 = Date.now();
const res = await fetch(`${API}/${IMAGE_MODEL}:generateContent?key=${KEY}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 800)}`); process.exit(1); }
const data = await res.json();
const img = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
if (!img) { console.error("No image:", JSON.stringify(data).slice(0, 800)); process.exit(1); }

const out = path.join(ROOT, "stones/flint/dream-sample.jpg");
await writeFile(out, Buffer.from(img.inlineData.data, "base64"));
console.log(`✓ ${out} (${img.inlineData.mimeType}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
