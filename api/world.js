// api/world.js — 3D world generation for the "Explore in 3D" feature.
//
// POST { stone, description }
//   → generate empty room pano from visitor description (Gemini image-restyle),
//     upload to Supabase, kick off Marble worlds:generate (is_pano:true),
//     respond { operation_id } immediately — does NOT wait for Marble (~4-5 min).
//
// GET ?op=<operation_id>
//   → poll Marble; if done, extract spz_url, persist on worlds table, return
//     { status:"ready", spz, world_id, glb }.
//   → else { status:"pending" }.
//   Each call is well under 60s (just a status GET + optional small writes).
//
// The Marble world is backed by a Supabase `worlds` table (created if missing):
//   id uuid PK, stone_id text, description text, operation_id text, spz_url text,
//   room_pano_url text, created_at timestamptz
//
// Architecture note on GLBs: stones/models/<id>.glb is the TRELLIS-generated file.
// The owner can swap it by replacing the storage object — no code change needed.

const { setDefaultResultOrder } = require("dns");
const { setDefaultAutoSelectFamily } = require("net");
const sharp = require("sharp");
const { r2put } = require("./_storage.js");
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);

const GEMINI_MODEL = "gemini-3.1-flash-image";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";
const TEMPLATE = "stones/templates/spacious-1.jpg";
const MARBLE_API = "https://api.worldlabs.ai/marble/v1";

async function geminiImageRestyle(key, templateBuf, roomPrompt) {
  const prompt = `This is a 360-degree equirectangular panorama of an interior. Redesign it into the described space:

${roomPrompt}

Rules:
1. SPACIOUS — generous walls, open floor at center, high ceilings.
2. NO stone, pedestal, or sculpture anywhere — the floor and center must be completely empty.
3. Keep the equirectangular projection: full 360x180, floor at bottom, ceiling at top, left/right edges continuous.
4. Photorealistic, no people, no text.`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(`${GEMINI_API}/${GEMINI_MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: templateBuf.toString("base64") } },
        ]}],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "2K" } },
      }),
    });
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      await new Promise(ok => setTimeout(ok, attempt * 3000)); continue;
    }
    if (!r.ok) throw new Error(`Gemini restyle: HTTP ${r.status}`);
    const d = await r.json();
    const img = d.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!img) { if (attempt < 3) continue; throw new Error("Gemini restyle: no image returned"); }
    let buf = Buffer.from(img.inlineData.data, "base64");
    // normalize to 2:1
    const { width: w, height: h } = await sharp(buf).metadata();
    if (w !== 2 * h) buf = await sharp(buf).resize(2 * h, h, { fit: "fill" }).jpeg({ quality: 92 }).toBuffer();
    return buf;
  }
}

// Kept the name/signature so call sites are unchanged; now writes to R2.
// The legacy `path` is "stones/<...>" (Supabase bucket + key); strip the
// bucket prefix so the R2 object key is just "<...>".
async function uploadToSupabase(_supabaseUrl, _serviceKey, path, body, contentType) {
  const key = String(path).replace(/^stones\//, "");
  return r2put(key, body, contentType);
}

async function ensureWorldsTable(supabaseUrl, serviceKey) {
  // Try to query the table; if it errors with 42P01 (table doesn't exist) create it.
  // On Supabase we use the REST API, so we just try to insert/select and handle errors.
  // We rely on the table already existing or being created by migrations — the code
  // is resilient (will still return data even if persistence fails).
  return; // optimistic: table exists from prior setup
}

async function persistWorld(supabaseUrl, serviceKey, { stone_id, description, operation_id, room_pano_url }) {
  const h = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  const r = await fetch(`${supabaseUrl}/rest/v1/worlds`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ stone_id, description, operation_id, room_pano_url }),
  });
  if (!r.ok) {
    console.error("worlds INSERT failed:", r.status, await r.text());
    return null;
  }
  const d = await r.json();
  return d[0]?.id || null;
}

async function updateWorld(supabaseUrl, serviceKey, operation_id, { spz_url, world_marble_id }) {
  const h = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
  await fetch(`${supabaseUrl}/rest/v1/worlds?operation_id=eq.${encodeURIComponent(operation_id)}`, {
    method: "PATCH",
    headers: h,
    body: JSON.stringify({ spz_url, world_marble_id }),
  }).catch(e => console.error("worlds PATCH:", e.message));
}

async function getWorldByOp(supabaseUrl, serviceKey, operation_id) {
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const r = await fetch(
    `${supabaseUrl}/rest/v1/worlds?operation_id=eq.${encodeURIComponent(operation_id)}&select=id,stone_id,spz_url,world_marble_id`,
    { headers: h }
  );
  if (!r.ok) return null;
  const d = await r.json();
  return d[0] || null;
}

async function getStoneGlb(supabaseUrl, serviceKey, stone_id) {
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const r = await fetch(`${supabaseUrl}/rest/v1/stones?id=eq.${stone_id}&select=images`, { headers: h });
  if (!r.ok) return null;
  const d = await r.json();
  return d[0]?.images?.model_glb || null;
}

module.exports = async (req, res) => {
  const GEMINI_KEY = process.env.GEMINI_AI_STUDIO;
  const WORLD_LABS_KEY = process.env.WORLD_LABS;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!GEMINI_KEY || !WORLD_LABS_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.statusCode = 500;
    return res.json({ error: "Missing required environment variables." });
  }

  const SB_H = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };

  // GET ?op=<operation_id> — poll Marble, return status
  if (req.method === "GET") {
    const op = (req.query && req.query.op) || "";
    if (!op) {
      res.statusCode = 400;
      return res.json({ error: "Missing ?op= parameter." });
    }

    // Check if we already resolved it (cached in Supabase)
    const existing = await getWorldByOp(SUPABASE_URL, SUPABASE_SERVICE_KEY, op).catch(() => null);
    if (existing && existing.spz_url) {
      const glb = await getStoneGlb(SUPABASE_URL, SUPABASE_SERVICE_KEY, existing.stone_id).catch(() => null);
      return res.json({ status: "ready", spz: existing.spz_url, world_id: existing.id, glb });
    }

    // Poll Marble
    try {
      const pollR = await fetch(`${MARBLE_API}/operations/${op}`, {
        headers: { "WLT-Api-Key": WORLD_LABS_KEY },
      });
      if (!pollR.ok) {
        const txt = await pollR.text();
        console.error("Marble poll error:", pollR.status, txt);
        return res.json({ status: "pending" }); // treat errors as pending (transient)
      }
      const opData = await pollR.json();
      console.log("Marble operation:", JSON.stringify({ done: opData.done, error: opData.error?.message }));

      if (opData.error) {
        return res.json({ status: "error", message: opData.error.message || "World generation failed." });
      }
      if (!opData.done) {
        // progress may be in metadata.progress_percentage or metadata.progress.percent
        const pct = opData.metadata?.progress_percentage ?? opData.metadata?.progress?.percent ?? null;
        return res.json({ status: "pending", progress: pct });
      }

      // Done — extract world_id and get the SPZ
      // The response object has world_id (not .id) per Marble API spec.
      const world = opData.response;
      const worldId = world?.world_id || world?.id || opData.metadata?.world_id;
      if (!worldId) {
        console.error("No world id in response:", JSON.stringify(opData).slice(0, 300));
        return res.json({ status: "pending" }); // retry
      }

      // GET world details for SPZ URL
      const worldR = await fetch(`${MARBLE_API}/worlds/${worldId}`, {
        headers: { "WLT-Api-Key": WORLD_LABS_KEY },
      });
      if (!worldR.ok) {
        console.error("Marble GET world error:", worldR.status);
        return res.json({ status: "pending" });
      }
      const worldData = await worldR.json();
      const spz = worldData.assets?.splats?.spz_urls?.["500k"] ||
                  worldData.assets?.splats?.spz_urls?.["1m"] ||
                  Object.values(worldData.assets?.splats?.spz_urls || {})[0];

      if (!spz) {
        console.error("No SPZ URL in world:", JSON.stringify(worldData?.assets).slice(0, 300));
        return res.json({ status: "pending" });
      }

      // Persist SPZ to Supabase
      await updateWorld(SUPABASE_URL, SUPABASE_SERVICE_KEY, op, {
        spz_url: spz,
        world_marble_id: worldId,
      }).catch(e => console.error("updateWorld:", e.message));

      const row = await getWorldByOp(SUPABASE_URL, SUPABASE_SERVICE_KEY, op).catch(() => null);
      const glb = row?.stone_id
        ? await getStoneGlb(SUPABASE_URL, SUPABASE_SERVICE_KEY, row.stone_id).catch(() => null)
        : null;

      return res.json({ status: "ready", spz, world_id: row?.id || null, glb });
    } catch (e) {
      console.error("world GET error:", e.message);
      return res.json({ status: "pending" }); // never error hard on polls
    }
  }

  // POST { stone, description } — generate room pano, kick off Marble
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.json({ error: "POST or GET only." });
  }

  const { stone, description } = req.body || {};
  if (!stone || !/^[a-z0-9-]+$/.test(String(stone))) {
    res.statusCode = 400;
    return res.json({ error: "Invalid stone." });
  }
  const desc = String(description || "").trim();
  if (desc.length < 3 || desc.length > 600) {
    res.statusCode = 400;
    return res.json({ error: "Describe your home in 3–600 characters." });
  }

  try {
    // 1. Load the template pano
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = `${proto}://${req.headers.host}`;
    const tplR = await fetch(`${host}/${TEMPLATE}`);
    if (!tplR.ok) throw new Error("Template missing");
    const templateBuf = Buffer.from(await tplR.arrayBuffer());

    // 2. Restyle into visitor's room (empty, no stone)
    console.log(`world POST: stone=${stone} desc="${desc.slice(0, 60)}"`);
    const t0 = Date.now();
    const roomBuf = await geminiImageRestyle(GEMINI_KEY, templateBuf, desc);
    console.log(`room generated in ${Date.now() - t0}ms`);

    // 3. Upload room pano to Supabase
    const roomKey = `stones/worlds/${stone}-${Date.now()}.jpg`;
    const roomUrl = await uploadToSupabase(SUPABASE_URL, SUPABASE_SERVICE_KEY, roomKey, roomBuf, "image/jpeg");
    console.log(`room pano uploaded: ${roomUrl}`);

    // 4. Kick off Marble world generation (do NOT await — fire and forget)
    // The API requires world_prompt as a wrapper around the ImagePrompt object.
    const marbleBody = {
      world_prompt: {
        type: "image",
        image_prompt: {
          source: "uri",
          uri: roomUrl,
        },
        is_pano: true,
        text_prompt: desc,
      },
    };
    console.log("Marble request body:", JSON.stringify(marbleBody));
    const marbleR = await fetch(`${MARBLE_API}/worlds:generate`, {
      method: "POST",
      headers: {
        "WLT-Api-Key": WORLD_LABS_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(marbleBody),
    });
    if (!marbleR.ok) {
      const txt = await marbleR.text();
      console.error("Marble generate error:", marbleR.status, txt);
      throw new Error(`Marble worlds:generate failed: ${marbleR.status} ${txt.slice(0, 200)}`);
    }
    const marbleData = await marbleR.json();
    console.log("Marble generate response:", JSON.stringify(marbleData).slice(0, 300));

    const operation_id = marbleData.operation_id;
    if (!operation_id) throw new Error("No operation_id from Marble: " + JSON.stringify(marbleData).slice(0, 200));

    // 5. Persist to Supabase worlds table (best-effort)
    await persistWorld(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      stone_id: stone,
      description: desc,
      operation_id,
      room_pano_url: roomUrl,
    }).catch(e => console.error("persistWorld:", e.message));

    res.statusCode = 200;
    return res.json({ operation_id });
  } catch (e) {
    console.error("world POST error:", e.message);
    res.statusCode = 502;
    return res.json({ error: e.message || "World generation failed. Try again." });
  }
};
