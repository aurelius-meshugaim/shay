// Bulk-upload the אבנים stones to the live gallery, full quality, one at a time.
// Each stone: create (full-res original) → analyze (Gemini height + name + design)
// → cutout → 4 variants → finalize. Resumable via state.json.
import fs from "node:fs";
import path from "node:path";

const ENDPOINT = process.env.ENDPOINT || "https://shaym.beauty/api/admin";
const PASS = process.env.ADMIN_PASSWORD;
const SRC = process.env.SRC || "/home/oriamasas/shay/input/avanim";
const STATE = "/home/oriamasas/shay/pipeline/batch-state.json";
const VARIANTS = ["blur", "outdoor", "indoor", "creative"];

if (!PASS) { console.error("ADMIN_PASSWORD missing"); process.exit(1); }

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

async function call(body, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-pass": PASS },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${d.error || ""}`);
      return d;
    } catch (e) {
      if (i >= tries) throw e;
      log(`  retry ${i}/${tries - 1} (${body.action}${body.kind ? ":" + body.kind : ""}) — ${e.message}`);
      await sleep(i * 4000);
    }
  }
}

const files = fs.readdirSync(SRC).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
log(`${files.length} images in ${SRC}`);

let done = 0, failed = 0;
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const st = (state[f] ||= { stage: "new" });
  if (st.stage === "finalized") { done++; log(`(${i + 1}/${files.length}) ${f} — already done [${st.name} · ${st.height_cm}cm]`); continue; }
  log(`(${i + 1}/${files.length}) ${f} — starting (from ${st.stage})`);
  try {
    if (!st.id) {
      const b64 = fs.readFileSync(path.join(SRC, f)).toString("base64");
      const { id } = await call({ action: "create", name: "", photos: [b64] });
      st.id = id; st.stage = "created"; save();
      log(`  created → ${id}`);
    }
    if (["created"].includes(st.stage)) {
      const a = await call({ action: "analyze", id: st.id });
      st.name = a.name; st.height_cm = a.height_cm; st.stage = "analyzed"; save();
      log(`  analyzed → "${a.name}" · height ~${a.height_cm} cm`);
    }
    if (["analyzed"].includes(st.stage)) {
      await call({ action: "cutout", id: st.id });
      st.stage = "cutout"; save();
      log(`  cutout done`);
    }
    st.variants ||= [];
    for (const kind of VARIANTS) {
      if (st.variants.includes(kind)) continue;
      await call({ action: "variant", id: st.id, kind });
      st.variants.push(kind); save();
      log(`  variant ${kind} done`);
      await sleep(1500);
    }
    await call({ action: "finalize", id: st.id });
    st.stage = "finalized"; save();
    done++;
    log(`  ✓ FINALIZED ${st.name} (${st.height_cm} cm) — ${done} live`);
  } catch (e) {
    failed++;
    st.error = e.message; save();
    log(`  ✗ FAILED ${f}: ${e.message}`);
  }
  await sleep(1000);
}
log(`DONE. finalized=${done} failed=${failed} of ${files.length}`);
