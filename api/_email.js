// Shared email template — the site's look (dark #06080b, the cairn bg.webp
// banner, soft blue-grey accents), built with inline styles + tables so it
// survives real email clients. Underscore prefix = not a Vercel route.

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// rows: [{label, value}] · image: optional stone image url · cta: {label,url}
function stoneEmail({ preheader = "", heading, intro = "", rows = [], image = null, big = null, cta = null, footer = "Stones — a quiet collection" }) {
  const rowsHtml = rows.map(({ label, value }) => `
    <tr>
      <td style="padding:6px 0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8fa3b8;">${esc(label)}</td>
      <td style="padding:6px 0;font-size:14px;color:#ffffff;text-align:right;">${esc(value)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#06080b;">
<span style="display:none;max-height:0;overflow:hidden;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#06080b"
  background="https://shaym.beauty/bg.webp"
  style="background:#06080b url('https://shaym.beauty/bg.webp') center top / cover no-repeat;">
<tr><td align="center" style="padding:56px 16px 64px;">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
    <tr><td bgcolor="#0b0f15" style="background-color:rgba(8,11,15,.88);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:36px;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:6px;text-transform:uppercase;color:#9fb4c8;padding-bottom:10px;">stones</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:24px;font-weight:700;color:#ffffff;line-height:1.3;padding-bottom:8px;">${heading}</div>
      ${intro ? `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:300;color:#b9c6d2;line-height:1.6;padding-bottom:18px;">${intro}</div>` : ""}
      ${big ? `<div style="font-family:Helvetica,Arial,sans-serif;font-size:40px;font-weight:800;color:#d7e2ec;padding:6px 0 18px;">${esc(big)}</div>` : ""}
      ${image ? `<img src="${image}" width="488" alt="" style="display:block;width:100%;border-radius:14px;margin:4px 0 18px;" />` : ""}
      ${rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #1d2733;border-bottom:1px solid #1d2733;margin:6px 0 20px;font-family:Helvetica,Arial,sans-serif;">${rowsHtml}</table>` : ""}
      ${cta ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:999px;background:#d7e2ec;">
        <a href="${cta.url}" style="display:inline-block;padding:11px 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#06080b;text-decoration:none;">${esc(cta.label)}</a>
      </td></tr></table>` : ""}
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:300;color:#5d6d7d;padding-top:26px;">${esc(footer)} · <a href="https://shaym.beauty" style="color:#8fa3b8;">shaym.beauty</a></div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

async function send({ resendKey, to, subject, html, attachments }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Stones <stones@shaym.beauty>",
      to: [to],
      subject,
      html,
      ...(attachments ? { attachments } : {}),
    }),
  });
  if (!r.ok) throw new Error(`resend: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

module.exports = { stoneEmail, send };
