// POST /api/offer  { stone, amount_usd, email }
// Persists an auction offer per stone into Supabase (offers table) and,
// when Resend is configured, notifies the gallery inbox.

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

  if (process.env.RESEND_API_KEY && process.env.OFFER_NOTIFY) {
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Stones <stones@shaym.beauty>",
        to: [process.env.OFFER_NOTIFY],
        subject: `New offer: $${amount.toLocaleString("en-US")} on ${stone}`,
        html: `<p>Stone: <strong>${stone}</strong></p><p>Offer: <strong>$${amount.toLocaleString("en-US")}</strong></p><p>From: ${to}</p>`,
      }),
    }).catch(() => {});
  }

  return res.json({ ok: true });
};
