# Open tasks — stones / shaym.beauty

- [ ] **Favicon → Shay** (2026-06-13, Oria): replace the circled-entropy favicon
      with Shay as the favicon. Needs the asset/mark to use — a photo of Shay,
      a monogram, or a stone-derived mark; ask Oria which when picked up.
- [ ] **About Us page** (2026-06-13, Oria): add an about page (who Shay is,
      what the gallery is, the dream-it-home idea). Copy + design TBD.

## Residual polish (from the 360 v2 work)
- [ ] Stone identity can soften in generation (banding less crisp than original).
- [ ] Rate limiting is per-serverless-instance best-effort; move to Supabase
      counter when traffic justifies.
- [ ] Flint dimensions are an estimate (14×9×7 cm, `approx: true`) — get true
      measurements from Shay; boulder likewise (85×62×55 cm).
- [ ] Walk viewpoints aren't cached — each step regenerates (~35s). Supabase
      Storage cache when it matters.
