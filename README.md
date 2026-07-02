# MillScape — Milling Roughness Explorer + 3D Anomaly Viewer

A fully **client-side, browser-based** research tool for machining / additive-manufacturing surface analysis. Import surface line-scan profiles, compute standardized ISO roughness, run a paper-faithful anomaly-detection pipeline, explore a predicted roughness **response surface** over spindle speed × feed rate, and inspect the surface relief in an interactive **3D height-map viewer** with detected anomalies highlighted in red.

No backend. All parsing and computation run in the browser — your research data never leaves the machine. The working set is mirrored to `localStorage`, and an entire session round-trips through JSON export/import. Deployable to GitHub Pages as a static bundle.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/  (static, GitHub-Pages-ready)
npm run preview  # serve the production build locally
```

On first launch the app seeds the **example dataset** (parts 1–5, up + down traces, plus the as-printed reference F1) so every panel is populated immediately. Use **Clear all** and drag in your own files, or **Load example** to restore it.

### Deploying to GitHub Pages

The build uses a **relative base** (`base: './'` in `vite.config.ts`), so the bundle in `dist/` works from any sub-path such as `https://<user>.github.io/<repo>/`. Push the contents of `dist/` to your `gh-pages` branch (or point Pages at it). If you deploy to a custom domain **root**, set `base: '/'`.

---

## What you can do

1. **Import** CSV/TXT line-scan files by drag-and-drop (or *+ Add data*). A popup lists each file with fields for its mill settings and, on first import, the unit factors.
2. **Describe** each profile — spindle speed [rpm], feed rate [mm/min], milling mode (down/up/reference), name — editable at any time by clicking a row.
3. **Roughness** — ISO 16610-21 Gaussian-filtered Ra / Rq / Rz, in µm.
4. **Anomaly detection** — the five-stage pipeline from the source study, producing discrete anomaly *zones* and a before/after comparison against the reference.
5. **Response surface** — an interpolated Ra heatmap over spindle × feed, with honest leave-one-out uncertainty, iso-feed-per-rev lines, measured points, a smoothest ★, and a live crosshair. Click or drag to set the working point.
6. **Speed trade-off** — predicted Ra vs spindle at the current feed-per-rev, marking the current point and the minimum.
7. **3D relief** — the selected profile as an exaggerated, GPU-lit height map with a viridis/turbo gradient and anomaly zones in red; orbit, zoom, reset, and an honest vertical-exaggeration slider.

---

## Domain & physics (from the source study)

- **FDM 3D-printed PLA** coupons, milled as post-processing to reduce roughness.
- Tool: **HSS end mill, Ø20 mm, TiAlN-coated**, 4 cutting edges = **2 effective teeth** (`z = 2`), confirmed by the measured feed-mark spacing = feed-per-rev ÷ 2.
- Machine: PerfectJet MCV-M8, depth of cut = 1 mm (constant).
- Metrology: **AltiSurf 520** confocal profilometer — each profile is **1 µm sampling over an 8 mm scan (n = 8001)**.

**Two real knobs** are spindle speed and feed rate. Everything else is derived and never asked:

| Quantity | Formula |
|---|---|
| Cutting speed `vc` [m/min] | `π · D · n / 1000` |
| Feed per rev `fpr` [mm] | `vf / n` |
| Feed per tooth `fz` [mm] | `vf / (n · z)` |
| Cusp-height floor `h` [µm] | `fz² / (8 · (D/2))` |

Cutting speed is **not** independent — it is fixed by spindle speed.

---

## Units

Raw files use mixed, often mislabelled units: the `x` column is in **metres** (`0.008` → an 8 mm trace; `dx 1e-6` → 1 µm) and the `y` column is in **millimetres** (~0.003–0.035). Both are frequently labelled `[m]`.

**Internally, every computation is in micrometres (µm).** Two separate concerns:

- **Input factors** (set in the import popup) convert raw file numbers → µm. Defaults: `x × 1e6` (metres→µm), `height × 1e3` (mm→µm).
- **Display units** (Units panel) are purely cosmetic. Standard: **x in mm, height in µm** — the surface-metrology convention, matching the study (8 mm trace; sub-µm–few-µm Ra). **Reset to standard** restores them.

**Sanity checks** (baked in as warnings/tooltips):

- With the standard, the pipeline reproduces the study's values — as-printed **F1 Ra ≈ 0.28 µm**, milled **BU2 Ra ≈ 1.10 µm** (verified: the app computes 0.280 and 1.100).
- Trace length should be a few mm; a warning fires if the x-unit implies < 0.1 mm or > 100 mm.
- **Kinematic floor:** measured Ra must exceed the feed-mark cusp `h ≈ fz²/(8·(D/2))`; if the height unit makes Ra < h, the height scale is likely wrong.
- The manuscript's Fig. 4 y-axis reads `[mm]`, but those values (and the Ra/Rq/Rz figures) are in **µm** — a label typo. The standard here (height in µm) is the correct one.

---

## Roughness method (ISO 16610-21 Gaussian profile filter)

All maths in µm (dx = 1 µm after unit scaling).

1. **Waviness** `w(x)` = Gaussian-filtered profile; **roughness residual** `r = y − w`.
2. Gaussian σ in samples: `σ = 0.18738 · λc / dx` (ISO weighting, α = √(ln2/π), σ = αλc/√(2π)). Implemented as a separable 1-D convolution with a ±4σ kernel and reflect-padded ends.
3. **Default λc = 200 µm** (matches the paper). Alternates: a **201-sample moving average** (the paper's Gaussian-equivalent), λc {0.25, 0.8, 2.5} mm, and a plainly-labelled **linear detrend** (non-standard — it inflates wavy profiles).
4. Trim λc/2 from each end. On the trimmed, mean-subtracted residual: `Ra = mean(|r|)`, `Rq = √mean(r²)`, `Rz = mean(top-5 peaks) − mean(bottom-5 valleys)`. A warning fires if the evaluation length < 5·λc.

---

## Anomaly-detection pipeline

Run per profile on the roughness residual `r(x)` (λc split). All thresholds are exposed in **Global settings** with the paper's defaults.

1. **Signal decomposition** — detect on `r` only (never raw `y`, which would bias toward the curved ends).
2. **Point-wise Hampel identifier** — rolling window **31 samples**; robust `Zᵢ = |rᵢ − median| / (1.4826 · MAD)`; flag `Zᵢ > 3.5`. Median/MAD are robust to heavy contamination.
3. **Structural window scoring** — sliding **50–100 µm** windows; flag a window whose local Rq exceeds **2× the global Rq** (or Rz similarly). Catches extended chatter/burrs that point tests miss.
4. **Zone aggregation** — merge point- and window-flags separated by **≤ 20 µm** into discrete **anomaly zones** (the reported unit): count, mean/max width, and Ra/Rq/Rz restricted to flagged regions.
5. **Before/after differencing** — compare each milled profile to the as-printed reference **F1**: Δ(zones), Δ(width), ΔRa/ΔRq/ΔRz, reported as an **anomaly reduction** percentage.

The zones' x-positions drive the red highlights in both the 2D profile plot and the 3D relief.

> **Note on the example data.** The study reports only scalar Ra/Rq/Rz, but the viewer and detector need real profiles. MillScape therefore *synthesizes* a faithful 1-D line scan per condition — band-limited (spatially-correlated) noise matching a confocal profilometer's few-µm spot, gentle periodic feed marks, and discrete narrow defects — then scales it so the pipeline's **computed** Ra reproduces the reported value. The as-printed reference carries many discrete defects; milling replaces them with periodic tool marks, so milled surfaces show **fewer** discrete anomalies (a genuine before/after reduction) even where their overall Ra is higher. Every number in the UI is computed from a profile, not hard-coded. Your imported profiles are always computed live.

---

## Interpolation & honesty

Predictor: **Gaussian-kernel (Nadaraya–Watson) regression**, run **separately per milling mode**, in a normalized `(log2 rpm, feed-per-rev)` feature space. Bandwidth `h` (default 0.16) is the **Smoothing** slider. Nearest-point fallback if weights underflow.

- **Extrapolation** outside the measured rpm/fpr range is dimmed/marked and labelled low-confidence.
- **Uncertainty:** a live **leave-one-out MAE** is shown prominently (with the example data ≈ ±0.5 µm — the app's honesty metric). A mode with < 4 points is flagged as "interpolation not meaningful yet."
- The UI everywhere distinguishes **measured (trusted)** vs **interpolated (indicative)** vs **extrapolation (low-confidence)**, states the roughness standard and λc in use, and always shows the true 3D height range next to the exaggeration factor.

Known quirks in the example set (surfaced, never silently "fixed"): the 1600 rpm · 0.2 mm/rev and 800 rpm · 0.6 mm/rev pairs invert the usual up-rougher-than-down pattern (likely swapped U/D labels). Global smoothest = **AD1 (320 rpm, 64 mm/min, down) ≈ 0.16 µm** — also the lowest speed and feed, so no trade-off.

---

## Adding your own data

**File format.** One or two numeric columns per line, split on **comma or semicolon**. Header lines (`Variation`, `x;y`, `[m];[m]`) are auto-skipped because they don't parse as numbers; scientific notation (`1.00E-06`) is fine. A row is kept only if its first two tokens are finite floats. ≥ ~200 points recommended; non-uniform x spacing raises a warning.

**Areal grids.** A file of many equal-width numeric rows (≥ 4 columns) is auto-detected as a **rows × cols height matrix** and rendered as a true 2-D height map in the 3D viewer.

**Workflow.** Drag files onto the top bar (or *+ Add data*) → fill in rpm, feed, mode, name (and, first time, unit factors) → **Import**. Click any row later to edit or delete; editing recomputes roughness + anomalies and refreshes every panel. Mark one profile as **Reference (as-printed)** to enable before/after differencing. **Export session** saves raw profiles + metadata + settings as JSON; **Import session** restores it exactly.

---

## Architecture

Vite + TypeScript (strict), ESLint + Prettier. Three.js (r160) only for the 3D viewer; all 2D charts are hand-drawn on Canvas 2D — no charting library. Zero network calls.

```
src/
  parse/      dual-format CSV/TXT + areal-grid parser, unit scaling
  roughness/  ISO 16610-21 Gaussian filter, Ra/Rq/Rz
  anomaly/    5-stage detection pipeline + before/after differencing
  interp/     Nadaraya–Watson regression, leave-one-out MAE
  render2d/   response surface, speed-tradeoff, profile plot (Canvas 2D)
  render3d/   Three.js orthographic height-map viewer
  store/      in-memory session mirrored to localStorage; JSON export/import
  ui/         layout, controls, import/edit popups, units panel, data manager
  data/       embedded example dataset + faithful profile synthesis
  compute.ts  kinematics + recompute orchestration
```

Recomputation is signature-gated: the heavy roughness+anomaly pass runs only when data or compute-settings change; working-point and display changes take the cheap render path.
