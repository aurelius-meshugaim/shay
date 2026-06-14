// GET /api/stones — DB-only source of truth.
// All stones (including flint + boulder) now live in Supabase: identity, images,
// variants, captions. stones/manifest.json is no longer read at runtime (files
// remain in repo as migration artefacts only).

module.exports = async (req, res) => {
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;

  let rows = [], tops = [];
  if (URL && KEY) {
    const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };
    [rows, tops] = await Promise.all([
      fetch(`${URL}/rest/v1/stones?select=id,name,width_cm,height_cm,depth_cm,dimensions_approx,character,status,images&status=eq.available`, { headers: h })
        .then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${URL}/rest/v1/offers?select=stone_id,amount_usd&order=amount_usd.desc`, { headers: h })
        .then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]);
  }

  const topOffer = {};
  for (const o of tops) if (!(o.stone_id in topOffer)) topOffer[o.stone_id] = Number(o.amount_usd);

  const stones = [];
  for (const r of rows) {
    if (!r.images?.original) continue; // skip stones with no gallery images

    const variants = {};
    for (const k of ["blur", "outdoor", "indoor", "creative"]) {
      if (r.images[k]) variants[k] = { src: r.images[k].src, caption: r.images[k].caption || "" };
    }
    if (Object.keys(variants).length < 4) continue; // incomplete processing

    stones.push({
      id: r.id,
      name: r.name,
      character: r.character || "",
      status: r.status,
      dimensions: {
        width_cm: r.width_cm && Number(r.width_cm),
        height_cm: r.height_cm && Number(r.height_cm),
        depth_cm: r.depth_cm && Number(r.depth_cm),
        approx: r.dimensions_approx,
      },
      top_offer_usd: topOffer[r.id] ?? null,
      original: r.images.original,
      variants,
      cutout: r.images.cutout || null,
      model_glb: r.images.model_glb || null,
    });
  }

  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
  return res.json({ stones });
};
