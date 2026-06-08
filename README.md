# Stones

A gallery of stones. Drop stone photos in `input/`, run the pipeline, and each
stone gets a 4-stage Gemini treatment — **analysis → brainstorm → design →
generate** — producing four re-scened variants:

- **Sophisticated blur** — stone tack-sharp on an elegant, softly blurred background (this is the gallery tile)
- **Outdoor**
- **Indoor**
- **Creative**

Click a tile to open the lightbox and browse the variants (plus the original
photo). Arrows / dots / swipe / ←→ keys all navigate.

## Pipeline

```sh
doppler run -p oria -c dev -- node pipeline/run.mjs
```

- Key: `GEMINI_AI_STUDIO` in Doppler (project `oria`, config `dev`) — never on disk.
- Models: `gemini-2.5-flash` for the text stages, `gemini-3.1-flash-image` for generation (original photo goes in as input, so the variants keep the real stone faithful).
- Idempotent & resumable: every stage is cached in `stones/<slug>/meta.json`; a crashed or rate-limited run picks up where it left off. Delete `stones/<slug>/` to regenerate a stone from scratch.
- Output: `stones/<slug>/{original.*, blur.jpg, outdoor.jpg, indoor.jpg, creative.jpg, meta.json}` and a `stones/manifest.json` the gallery reads.

## Running the gallery

Fully static — no build step.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Status

- Pipeline + gallery verified end-to-end on `input/sample-river.png` (2026-06-07).
- Waiting on the real stone photos — drop them in `input/` and rerun the pipeline.

## References

- [KP Conrad Photography — Contact](https://kpconradphotography.com/contact/)
