// GET /api/stones — the gallery's source of truth.
// DB (Supabase) owns identity: name, dimensions, status, and the auction
// state (top offer per stone). The deployed manifest owns assets: variant
// image paths + captions. This endpoint merges the two; if the DB is
// unreachable the manifest alone still renders a gallery (degraded, no
// auction state).

module.exports = async (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = `${proto}://${req.headers.host}`;
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;

  const manifest = await fetch(`${host}/stones/manifest.json`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);

  let rows = [], tops = [];
  if (URL && KEY) {
    const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };
    [rows, tops] = await Promise.all([
      fetch(`${URL}/rest/v1/stones?select=id,name,width_cm,height_cm,depth_cm,dimensions_approx,character,status,images`, { headers: h })
        .then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${URL}/rest/v1/offers?select=stone_id,amount_usd&order=amount_usd.desc`, { headers: h })
        .then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]);
  }

  const topOffer = {};
  for (const o of tops) if (!(o.stone_id in topOffer)) topOffer[o.stone_id] = Number(o.amount_usd);

  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const stones = manifest.map((m) => {
    const db = byId[m.id];
    return {
      id: m.id,
      name: db?.name || m.name,
      character: db?.character || m.character,
      status: db?.status || "available",
      dimensions: db
        ? { width_cm: db.width_cm && Number(db.width_cm), height_cm: db.height_cm && Number(db.height_cm), depth_cm: db.depth_cm && Number(db.depth_cm), approx: db.dimensions_approx }
        : m.dimensions || null,
      top_offer_usd: topOffer[m.id] ?? null,
      original: m.original,
      variants: m.variants,
    };
  });

  // DB-native stones (uploaded via admin, images in Supabase Storage)
  const inManifest = new Set(manifest.map((m) => m.id));
  for (const r of rows) {
    if (inManifest.has(r.id) || r.status !== "available" || !r.images?.original) continue;
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
      dimensions: { width_cm: r.width_cm && Number(r.width_cm), height_cm: r.height_cm && Number(r.height_cm), depth_cm: r.depth_cm && Number(r.depth_cm), approx: r.dimensions_approx },
      top_offer_usd: topOffer[r.id] ?? null,
      original: r.images.original,
      variants,
    });
  }

  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
  return res.json({ stones });
};
