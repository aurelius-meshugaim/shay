// POST /api/offer  { stone, amount_usd, email }
// Persists an auction offer per stone into Supabase (offers table) and, when
// Resend is configured, sends two designed emails: a notification to the
// gallery (OFFER_NOTIFY) and a confirmation to the bidder.

const { stoneEmail, send } = require("./_email.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.json({ error: "POST only" });
  }
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) {
    res.statusCode = 500;
    return res.json({ error: "Offers are not configured yet." });
  }

  const { stone = "", amount_usd = 0, email = "" } = req.body || {};
  const amount = Number(amount_usd);
  const to = String(email).trim();
  if (!/^[a-z0-9-]+$/.test(stone)) { res.statusCode = 400; return res.json({ error: "Unknown stone." }); }
  if (!(amount > 0) || amount > 100_000_000) { res.statusCode = 400; return res.json({ error: "Enter an offer above 0." }); }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { res.statusCode = 400; return res.json({ error: "That email doesn't look right." }); }

  const r = await fetch(`${URL}/rest/v1/offers`, {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ stone_id: stone, amount_usd: amount, email: to }),
  });
  if (!r.ok) {
    console.error("offer insert failed:", r.status, (await r.text()).slice(0, 200));
    res.statusCode = 502;
    return res.json({ error: "Could not record the offer — try again." });
  }

  if (process.env.RESEND_API_KEY) {
    // shared designed template for both directions; failures never block the offer
    const proto = req.headers["x-forwarded-proto"] || "https";
    const info = await fetch(`${proto}://${req.headers.host}/api/stones`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.stones?.find((s) => s.id === stone))
      .catch(() => null);
    const name = info?.name || stone;
    const heroSrc = info?.looks?.[0]?.src || info?.original || null;
    const img = heroSrc
      ? (heroSrc.startsWith("http") ? heroSrc : `https://shaym.beauty/${heroSrc}`)
      : null;
    const usd = "$" + amount.toLocaleString("en-US", { maximumFractionDigits: 0 });
    const sizeRow = info?.dimensions
      ? [{ label: "Size", value: [["width_cm", "wide"], ["height_cm", "tall"], ["depth_cm", "deep"]]
          .filter(([k]) => info.dimensions[k] > 0).map(([k, w]) => `${info.dimensions[k]} cm ${w}`).join(" · ") }]
      : [];
    const jobs = [];
    if (process.env.OFFER_NOTIFY) {
      jobs.push(send({
        resendKey: process.env.RESEND_API_KEY,
        to: process.env.OFFER_NOTIFY,
        subject: `New offer: ${usd} on ${name}`,
        html: stoneEmail({
          preheader: `${usd} on ${name} from ${to}`,
          heading: "A new offer just landed",
          big: usd,
          image: img,
          rows: [{ label: "Stone", value: name }, ...sizeRow, { label: "From", value: to }],
          cta: { label: "Open the gallery", url: "https://shaym.beauty" },
        }),
      }));
    }
    jobs.push(send({
      resendKey: process.env.RESEND_API_KEY,
      to,
      subject: `Your offer on ${name} is in`,
      html: stoneEmail({
        preheader: `We received your offer of ${usd} for ${name}.`,
        heading: `Your offer on ${name} is in`,
        intro: "Thank you — we received it, and we'll be in touch at this address.",
        big: usd,
        image: img,
        rows: [{ label: "Stone", value: name }, ...sizeRow],
        cta: { label: "Back to the stones", url: "https://shaym.beauty" },
      }),
    }));
    await Promise.allSettled(jobs).then((rs) =>
      rs.forEach((x) => x.status === "rejected" && console.error("offer email:", x.reason?.message)));
  }

  return res.json({ ok: true });
};
