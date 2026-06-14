#!/usr/bin/env node
// Migrate flint + boulder from repo files to Supabase storage + DB.
// Run: node pipeline/migrate-to-db.mjs
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (from Vercel or .env)

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SB_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SB_URL || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY required");
  process.exit(1);
}

const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// Read manifest for captions and character
const manifest = JSON.parse(
  await readFile(path.join(ROOT, "stones/manifest.json"), "utf8")
);

async function uploadToStorage(storagePath, localFile, contentType = "image/jpeg") {
  if (!existsSync(localFile)) {
    console.warn(`  SKIP (file missing): ${localFile}`);
    return null;
  }
  const buf = await readFile(localFile);
  // try PUT first (upsert), fall back to POST
  const r = await fetch(`${SB_URL}/storage/v1/object/stones/${storagePath}`, {
    method: "POST",
    headers: { ...h, "Content-Type": contentType, "x-upsert": "true" },
    body: buf,
  });
  if (!r.ok) {
    const txt = await r.text();
    console.warn(`  UPLOAD FAILED ${storagePath}: ${r.status} ${txt}`);
    return null;
  }
  const url = `${SB_URL}/storage/v1/object/public/stones/${storagePath}`;
  console.log(`  uploaded: ${url}`);
  return url;
}

async function patchStoneImages(id, imagesPatch) {
  // Fetch current images first
  const row = await fetch(
    `${SB_URL}/rest/v1/stones?id=eq.${id}&select=images`,
    { headers: h }
  ).then((r) => r.json()).then((a) => a[0]);

  const current = row?.images || {};
  const merged = { ...current, ...imagesPatch };

  const r = await fetch(`${SB_URL}/rest/v1/stones?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...h, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ images: merged }),
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error(`  PATCH FAILED for ${id}: ${r.status} ${txt}`);
    return false;
  }
  console.log(`  DB row patched for ${id}`);
  return true;
}

async function migrateStone(m) {
  const id = m.id;
  const variants = ["blur", "outdoor", "indoor", "creative"];
  console.log(`\nMigrating ${id}...`);

  const imagesPatch = {};

  // original
  const origPath = path.join(ROOT, "stones", id, "original.jpg");
  const origUrl = await uploadToStorage(`${id}/original.jpg`, origPath);
  if (origUrl) imagesPatch.original = origUrl;

  // variants
  for (const v of variants) {
    const localFile = path.join(ROOT, "stones", id, `${v}.jpg`);
    const url = await uploadToStorage(`${id}/${v}.jpg`, localFile);
    if (url) {
      imagesPatch[v] = {
        src: url,
        caption: m.variants?.[v]?.caption || "",
      };
    }
  }

  await patchStoneImages(id, imagesPatch);
}

for (const m of manifest) {
  await migrateStone(m);
}

console.log("\nMigration complete.");
