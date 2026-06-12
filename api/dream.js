// POST /api/dream  { stone: "flint", description: "..." }
// → image/jpeg: a 360° equirectangular panorama of the visitor's described
//   home with the actual stone (its original photo) staged inside it.
//
// Backbone: gemini-3.1-flash-image (same model as pipeline/run.mjs), image+text
// conditioning — the stone photo rides along so the real stone appears, which
// is why this is Gemini and not a text-only skybox service.
// Key: GEMINI_AI_STUDIO in the Vercel project env (mirrors Doppler oria/dev).

const IMAGE_MODEL = "gemini-3.1-flash-image";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.json({ error: "POST only" });
  }
  const KEY = process.env.GEMINI_AI_STUDIO;
  if (!KEY) {
    res.statusCode = 500;
    return res.json({ error: "GEMINI_AI_STUDIO is not configured" });
  }

  const { stone = "flint", description = "" } = req.body || {};
  const desc = String(description).trim();
  if (desc.length < 3 || desc.length > 600) {
    res.statusCode = 400;
    return res.json({ error: "Describe your home in 3–600 characters." });
  }
  if (!/^[a-z0-9-]+$/.test(stone)) {
    res.statusCode = 400;
    return res.json({ error: "Unknown stone." });
  }

  // The stone's original photo lives in this same deployment as a static asset.
  const proto = req.headers["x-forwarded-proto"] || "https";
  const stoneUrl = `${proto}://${req.headers.host}/stones/${stone}/original.jpg`;
  const stoneRes = await fetch(stoneUrl);
  if (!stoneRes.ok) {
    res.statusCode = 400;
    return res.json({ error: "Unknown stone." });
  }
  const stoneB64 = Buffer.from(await stoneRes.arrayBuffer()).toString("base64");

  const prompt = `Create a single seamless 360-degree equirectangular panorama (full horizontal wrap: the left and right edges must continue into each other).

The scene — the visitor's own home, as they describe it: ${desc}

Critically: the exact stone from the attached photograph must appear in the scene as a treasured displayed object — on a pedestal, mantel, shelf or table at a natural focal point. Preserve the stone's true colors, banding, texture and shape from the photo. Render it at a believable physical size for a collectible mineral specimen.

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
    const r = await fetch(`${API}/${IMAGE_MODEL}:generateContent?key=${KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if ((r.status === 429 || r.status >= 500) && attempt <= 2) {
      await new Promise((ok) => setTimeout(ok, attempt * 4000));
      continue;
    }
    if (!r.ok) {
      res.statusCode = 502;
      return res.json({ error: `Generation failed (HTTP ${r.status}). Try again in a moment.` });
    }
    const data = await r.json();
    const img = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!img) {
      res.statusCode = 502;
      return res.json({ error: "The model returned no image. Try rephrasing your description." });
    }
    const buf = Buffer.from(img.inlineData.data, "base64");
    res.statusCode = 200;
    res.setHeader("Content-Type", img.inlineData.mimeType || "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.end(buf);
  }
};
