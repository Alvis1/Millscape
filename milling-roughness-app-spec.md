# Build spec v2 — Milling Roughness Explorer + 3D Anomaly Viewer (browser app)

> Paste this whole file into Claude Code as the brief. It is a complete PRD. Build it, run it, confirm `npm run dev` and `npm run build` both work before finishing. This v2 adds: the anomaly-detection pipeline from the research paper, a 3D roughness height-map viewer, a configurable units panel, the full 4-panel layout, and the complete (part 1–5 + reference) dataset.

---

## 0. Goal

A **fully client-side, browser-based** single-page app for machining/AM research that lets a user:

1. **Import** surface-profile line-scan files (CSV/TXT) by drag-and-drop.
2. **Describe** each imported profile with its mill settings (**spindle speed [rpm]**, **feed rate [mm/min]**, **milling mode** down/up, optional name) — editable at any time.
3. Compute **standardized roughness** (ISO-filtered Ra/Rq/Rz) and run **anomaly detection** (per the paper) on each profile.
4. **Explore** a predicted roughness *response surface* over spindle × feed, interpolating between the imported points, with honest uncertainty.
5. **Inspect in 3D** the roughness of the currently selected point, with vertical exaggeration, a height gradient, and detected anomalies highlighted in red.
6. Find the settings giving the **smoothest finish at the lowest spindle speed**, and compare surfaces **before vs after** milling against the as-printed reference.

No backend. All parsing/computation in the browser (research data stays local). Persist the working set in `localStorage`; JSON export/import of a session. Deployable to **GitHub Pages**.

---

## 1. Tech

- **Vite + TypeScript**. Vanilla for UI logic; use **Three.js** (r160+, via npm) only for the 3D viewer. No other heavy deps.
- 2D charts (response surface, profile plots) on **Canvas 2D** — no charting library.
- 3D viewer: Three.js with an **orthographic camera**; implement simple drag-orbit + wheel-zoom (don't rely on a specific OrbitControls build).
- File handling: File API (drag-and-drop + picker).
- State: small in-memory store mirrored to `localStorage`; JSON **Export/Import session**.
- Zero network calls. Strict TS, ESLint + Prettier. `npm run build` → static bundle for gh-pages (document `base`).
- Modules: `parse/`, `roughness/` (ISO filter), `anomaly/` (detection pipeline), `interp/`, `render2d/` (surface + profile), `render3d/` (Three.js), `store/`, `ui/`.

---

## 2. Domain, hardware & physics — **from the source study; get this right**

Material and process (context for copy and defaults):
- **FDM 3D-printed PLA** coupons, milled as post-processing to reduce roughness.
- Tool: **HSS end mill, Ø20 mm, 4 cutting edges (two joined ⇒ 2 *effective* teeth)**, TiAlN-coated. → use **flute/effective-tooth count z = 2** for feed-per-tooth (the measured feed-mark spacing = feed-per-rev ÷ 2 confirms this).
- Machine: PerfectJet MCV-M8 vertical CNC. **Depth of cut = 1 mm** (constant).
- Metrology: **AltiSurf 520** confocal profilometer, CL2 head. Each profile: **1 µm sampling over an 8 mm scan, n = 8001 points**.
- Milling done in two opposite directions A/B = **up-milling and down-milling**; file codes `<Part><U|D><variant>` → `U`=up, `D`=down.

Per-dataset metadata (user-entered): `spindleSpeed` n [rpm], `feedRate` vf [mm/min], `millingMode` `"down"|"up"|"reference"`, `name`.

Global tool settings (editable, defaults): `toolDiameter` D=**20** mm, `effectiveTeeth` z=**2**, `lambdaC` λc=**200 µm** (see §5/§6), interpolation `bandwidth` h=**0.16**.

Derived (compute, never ask): `vc = π·D·n/1000` [m/min]; `fpr = vf/n` [mm]; `fz = vf/(n·z)` [mm]. **Cutting speed is not independent** — it is fixed by spindle speed. Two real knobs: spindle speed, feed rate.

---

## 3. Units — configurable, with a correct standard and a reset

The raw files use **mixed, mislabelled units**: the `x` column is in **metres** (0.008 → an 8 mm trace; dx 1e-6 → 1 µm), and the `y` column is in **millimetres** (values ~0.003–0.035). Both are often mislabelled `[m]`.

Unit factors are for **display**; internally, always convert both axes to **µm** for all computation (roughness, anomaly windows, λc). Provide a **Units panel** with independent, editable display units per axis (m / mm / µm, or a raw ×10ⁿ factor), plus a **"Reset to standard"** button:
- **Standard (default): x-axis in millimetres (10⁻³ m), height/roughness in micrometres (10⁻⁶ m).** This is the surface-metrology convention (an 8 mm trace, sub-µm–few-µm Ra) and matches the study — profile x runs 0–8 mm, heights and Ra/Rq/Rz are in µm.
- Allow the user to change either axis and Reset to restore the above.

**Sanity checks (bake in as tooltips/guards):** with the standard, the pipeline reproduces the study's reported values — as-printed reference F1 Ra ≈ 0.28–0.29 µm, milled BU2 Ra ≈ 1.1–1.2 µm.
- Trace length should be a few mm; warn if the x-unit makes it <0.1 mm or >100 mm.
- Kinematic floor: measured Ra must exceed the feed-mark cusp `h ≈ fz²/(8·(D/2))`. If the chosen height unit makes Ra < h, flag **"height scale likely wrong."**
- Note in-app: the manuscript's Figure 4 y-axis is labelled `[mm]`, but those values (and the Ra/Rq figures) are in **µm** — a label typo. The standard here (height in µm) is the correct one.

---

## 4. File parsing (robust, dual-format)

One parser: split each line on **comma OR semicolon**; keep a row only if the first two tokens both parse as finite floats (auto-skips `Variation`, `x;y`, `[m];[m]` headers); handle `1.00E-06`; ignore blank/short lines. Return `{x:number[], y:number[]}` (raw), then apply the unit factors from §3. Require ≥ ~200 points; warn on non-uniform x spacing. Accept many files at once.

---

## 5. Roughness computation (ISO 16610-21 Gaussian profile filter)

All internal computation in **µm** (after §3 scaling; dx = 1 µm).
- Waviness `w(x)` = Gaussian-filtered profile; **roughness residual `r = y − w`**.
- Gaussian σ in samples: `σ = 0.18738 · λc / dx` (ISO weighting; α = √(ln2/π), σ = αλc/√(2π)). Implement as a separable 1-D Gaussian convolution, ±4σ kernel, reflect-padded ends.
- **Default λc = 200 µm** (matches the paper; the paper also describes it as a Gaussian-equivalent 201-sample moving average — offer that as an alternate). Also allow {0.25, 0.8, 2.5} mm and a plain **linear-detrend** mode (clearly labelled non-standard — it inflates wavy profiles).
- Trim λc/2 from each end. On the trimmed, mean-subtracted `r`: `Ra=mean(|r|)`, `Rq=√mean(r²)`, `Rz=mean(top-5 peaks) − mean(bottom-5 valleys)`. Report in µm. Warn if evaluation length < 5·λc.

---

## 6. Anomaly detection pipeline (implement exactly — from the paper)

Run per profile on the roughness residual `r(x)` (λc = 200 µm split from §5). Five stages:

1. **Signal decomposition** — `r = y − w`, w = Gaussian λc ≈ 200 µm. Detect on `r` only (never on raw `y`, which would bias toward curved ends).
2. **Point-wise Hampel identifier** — rolling window **w = 31 samples (~31 µm)**; rolling median `r̃ᵢ` and MAD; `Zᵢ = |rᵢ − r̃ᵢ| / (1.4826·MADᵢ)`; flag points with **Zᵢ > 3.5**. (Median/MAD chosen for robustness to ~50% contamination.)
3. **Structural window scoring** — sliding windows **50–100 µm**; compute local Rq/Rz; flag a window when **local Rq > 2× global Rq** (or local Rz above a similarly defined threshold). Catches extended burrs/chatter that point tests miss.
4. **Zone aggregation** — merge point- and window-flags separated by **≤ 20 µm** into discrete **anomaly zones** (the reported/visualised unit). Per profile record: zone count, mean & max zone width, and Ra/Rq/Rz restricted to flagged regions.
5. **Before/after differencing** — compare each milled profile to the **as-printed reference F1**: Δ(zone count), Δ(zone width), ΔRa/ΔRq/ΔRz. Report as an "anomaly reduction" (e.g. 18 → 5 zones = **72% reduction**).

Expose all thresholds (31, 3.5, 50–100, 2×, 20) as adjustable settings with these defaults. The anomaly zones' x-positions drive the red highlights in both the 2D profile plot and the 3D viewer (§10).

---

## 7. Interpolation engine (predict between measured points)

Feature space per point: `(log2(n), fpr)`, each axis normalized by the current dataset's range. Predictor: **Gaussian-kernel (Nadaraya–Watson) regression, separately per milling mode**: `wᵢ = exp(−d²/2h²)`, `Ra = Σwᵢ·Raᵢ / Σwᵢ`; nearest-point fallback if Σw underflows. Bandwidth `h` default 0.16, exposed as a **smoothing slider**. **Extrapolation flag** when rpm or fpr is outside the imported range → dim/hatch and label low-confidence. **Uncertainty:** compute live **leave-one-out MAE** and show it prominently (with the current data it is ≈ ±0.5 µm ≈ 56% of mean — the app's honesty metric); if a mode has < ~4 points, say interpolation isn't meaningful yet.

---

## 8. Layout (follow the supplied wireframe)

Four regions:
- **A — Import bar (top, full width).** "Drag data here to import." Dropping files opens an **import popup** listing the dropped files, each with input fields for mill settings (rpm, feed, mode, name) and, first time, the unit factors. Clicking any imported dataset later reopens this popup to **edit** it.
- **B — Controls column (left, tall).** Manual number inputs + sliders for spindle speed and feed rate; the Units panel; global tool settings; live info read-outs (cutting speed, feed/rev, feed/tooth, predicted Ra/Rq/Rz, LOO uncertainty, anomaly-zone count for the current profile); milling-mode toggle (down/up); "Jump to smoothest."
- **C — Response surface (centre, top).** The interactive Ra-over-spindle×feed heatmap (§9).
- **D — 3D roughness viewer (centre, bottom).** 3D height-map of the current point (§10): 3/4 view, orthographic, rotatable.

Responsive: stack to one column on mobile. Visible keyboard focus; respect `prefers-reduced-motion`.

---

## 9. Response-surface visualization (panel C)

x = spindle speed, y = feed rate, colour = predicted Ra (viridis; low=smooth=dark, high=rough=bright) evaluated on a grid via §7 for the selected mode. Overlays: dashed **iso feed-per-rev** lines; **measured points** coloured by actual Ra with white ring + hover tooltip (name, rpm, feed, fpr, Ra, anomaly zones); a **★** on the smoothest measured point; a **live crosshair** at the current setting; **click/drag to set** spindle+feed; a numeric **colorbar**. Below it, a **speed-tradeoff line**: predicted Ra vs spindle at the current feed-per-rev, marking the current point and the minimum.

---

## 10. 3D roughness height-map viewer (panel D) — **new**

Purpose: show the actual surface relief for the currently selected point, exaggerated, with anomalies in red.

- **Data reality:** the imported profiles are **1-D line scans**, so by default displace a **finely subdivided plane** using the roughness residual as a **height map** (Three.js/WebGL, GPU-shaded with recomputed per-vertex normals and real lighting), sweeping the 1-D profile along the depth axis (this is faithful; do **not** fabricate cross-profile texture). Also support importing an **areal/grid file** (rows × cols of heights) to render a **true 2-D height map** from the same subdivided-plane pipeline; auto-detect grid vs profile on import.
- Which profile: if the current point is a **measured** condition, show its profile; if it's **interpolated**, show the **nearest measured** condition's profile and label it as such (interpolation yields only a scalar Ra, not a full profile).
- **Camera:** orthographic, default 3/4 view; drag to orbit (azimuth/elevation), wheel to zoom, button to reset view.
- **Vertical exaggeration slider** (e.g. ×1–×200) scaling the height axis only, with the true height range shown numerically so the exaggeration is honest.
- **Colour:** height **gradient** (e.g. viridis/turbo) mapped to true height.
- **Anomalies in red:** overlay the anomaly zones from §6 as red bands/segments on the relief (map each flagged x-range onto the ribbon). Toggle on/off; show zone count.
- Keep it lightweight: downsample the display mesh if needed for smooth interaction, but run detection on full resolution.

---

## 11. Controls & read-outs (panel B)

Sliders + numeric inputs: spindle speed [rpm], feed rate [mm/min] (ranges auto-fit imported data, padded). Live derived: cutting speed (m/min), feed/rev (mm), feed/tooth (mm). Milling-mode toggle. Global settings: tool Ø, effective teeth, λc, smoothing, roughness method, anomaly thresholds. Big predicted **Ra ± uncertainty**; Rq, Rz, anomaly-zone count secondary; interpolation/extrapolation flag. "Jump to smoothest." Units panel with Reset.

---

## 12. Data manager (import + describe + edit — the requested workflow)

Panel listing all datasets: name, part, rpm, feed, mode, Ra/Rq/Rz, anomaly zones, before/after Δ vs F1, and **edit/delete**. **Add dataset(s)** → drop/pick files → per-file form (rpm, feed, mode, name; first-time unit factors); validate positive numbers; warn on duplicate rpm+feed+mode. Editing recomputes roughness + anomalies and refreshes all panels. **Load example dataset** seeds the §15 set (mark as example; includes the as-printed reference so before/after works). **Export/Import session** as JSON (raw profiles + metadata + settings) for exact round-trip.

---

## 13. Design direction

Metrology / CNC control-panel aesthetic: dark graphite panels (`#0e1116` / `#161b22`), monospace tabular numerics, a cutting-orange accent (`#ff7a2f`) reserved for live/interactive elements (sliders, crosshair, current-point marker). The response surface and the 3D relief are the two hero elements; keep everything else quiet. Name things by what the user controls ("Spindle speed", "Feed rate"), never by internals.

---

## 14. Honesty requirements (must appear in the UI, not just docs)

State the roughness standard and λc in use. Show LOO uncertainty, updated with the data. Distinguish **measured (trusted)** vs **interpolated (indicative)** vs **extrapolation (low-confidence)**. In 3D, always show the true height range next to the exaggeration factor, and label whether the shown profile is the measured one or a nearest-neighbour stand-in. If a mode has too few points or no trend, say so.

---

## 15. Embedded example dataset (seed for "Load example")

ISO-filtered at **λc = 200 µm**, in **µm**; tool Ø20 mm, z = 2. Parts 1–5 (each with an up- and down-milling trace) plus the as-printed reference F1 (no mill settings; used for before/after). These reproduce the study's reported roughness. Live recomputation applies to user-imported profiles.

```json
[
  {"name":"AD1","part":1,"spindleSpeed":320, "feedRate":64, "millingMode":"down","Ra":0.16,"Rq":0.20,"Rz":1.55},
  {"name":"AU1","part":1,"spindleSpeed":320, "feedRate":64, "millingMode":"up",  "Ra":0.46,"Rq":0.56,"Rz":3.52},
  {"name":"AD2","part":1,"spindleSpeed":320, "feedRate":128,"millingMode":"down","Ra":0.45,"Rq":0.57,"Rz":4.10},
  {"name":"AU2","part":1,"spindleSpeed":320, "feedRate":128,"millingMode":"up",  "Ra":0.90,"Rq":1.14,"Rz":9.19},
  {"name":"BD1","part":2,"spindleSpeed":320, "feedRate":192,"millingMode":"down","Ra":0.37,"Rq":0.47,"Rz":3.30},
  {"name":"BU1","part":2,"spindleSpeed":320, "feedRate":192,"millingMode":"up",  "Ra":0.96,"Rq":1.21,"Rz":8.73},
  {"name":"BD2","part":2,"spindleSpeed":800, "feedRate":160,"millingMode":"down","Ra":0.37,"Rq":0.46,"Rz":2.93},
  {"name":"BU2","part":2,"spindleSpeed":800, "feedRate":160,"millingMode":"up",  "Ra":1.10,"Rq":1.39,"Rz":9.94},
  {"name":"CD1","part":3,"spindleSpeed":800, "feedRate":320,"millingMode":"down","Ra":0.72,"Rq":0.90,"Rz":5.41},
  {"name":"CU1","part":3,"spindleSpeed":800, "feedRate":320,"millingMode":"up",  "Ra":1.13,"Rq":1.44,"Rz":10.59},
  {"name":"CD2","part":3,"spindleSpeed":800, "feedRate":480,"millingMode":"down","Ra":1.04,"Rq":1.32,"Rz":9.02},
  {"name":"CU2","part":3,"spindleSpeed":800, "feedRate":480,"millingMode":"up",  "Ra":0.28,"Rq":0.35,"Rz":2.42},
  {"name":"DD1","part":4,"spindleSpeed":1600,"feedRate":320,"millingMode":"down","Ra":1.74,"Rq":2.18,"Rz":15.17},
  {"name":"DU1","part":4,"spindleSpeed":1600,"feedRate":320,"millingMode":"up",  "Ra":0.27,"Rq":0.35,"Rz":2.45},
  {"name":"DD2","part":4,"spindleSpeed":1600,"feedRate":640,"millingMode":"down","Ra":0.97,"Rq":1.21,"Rz":8.28},
  {"name":"DU2","part":4,"spindleSpeed":1600,"feedRate":640,"millingMode":"up",  "Ra":1.48,"Rq":1.85,"Rz":13.15},
  {"name":"ED1","part":5,"spindleSpeed":1600,"feedRate":960,"millingMode":"down","Ra":0.39,"Rq":0.49,"Rz":3.39},
  {"name":"EU1","part":5,"spindleSpeed":1600,"feedRate":960,"millingMode":"up",  "Ra":1.30,"Rq":1.63,"Rz":11.21},
  {"name":"F1", "part":0,"spindleSpeed":null,"feedRate":null,"millingMode":"reference","Ra":0.28,"Rq":0.35,"Rz":2.31}
]
```

Known quirks (surface as gentle warnings; don't silently "fix"): the **1600 rpm · 0.2 mm/rev** pair (DD1 rough / DU1 smooth) and the **800 rpm · 0.6 mm/rev** pair (CD2 rough / CU2 smooth) invert the usual up-rougher-than-down pattern — likely swapped U/D labels; offer a per-dataset "swap mode." Global smoothest = **AD1 (320 rpm, 64 mm/min, down) ≈ 0.16 µm**, which is also the lowest speed and feed (no trade-off). Down-milling Ra rises with cutting speed (R²≈0.7); up-milling shows no clean trend (R²≈0). LOO ≈ ±0.5 µm.

---

## 16. Deliverables & acceptance

- `npm install && npm run dev` runs; `npm run build` → gh-pages-ready static build (document `base`).
- Import ≥1 profile, enter rpm/feed/mode, and see: ISO Ra/Rq/Rz, anomaly zones, response surface, speed-tradeoff, live LOO uncertainty, and the 3D relief with red anomalies — all updating on edit.
- Units panel: standard reproduces F1≈0.28 / BU2≈1.10 µm; manual factors + reset work; sanity checks fire on bad units.
- 3D viewer: orthographic 3/4, orbit + zoom + reset, vertical-exaggeration slider (true range shown), height gradient, anomaly zones red, areal-grid import → true 2-D map.
- Session export → clear → import reproduces state exactly.
- README documents physics, units, roughness method, anomaly pipeline, and how to add data.
