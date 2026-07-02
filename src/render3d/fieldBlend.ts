// Displacement-map interpolation cache. Each example surface photo is decoded
// ONCE and resampled to a fixed FIELD_DIM×FIELD_DIM square grid, stored as a
// mean≈0, unit-RMS luminance field (the amplitude is applied later, at blend
// time, so the same cached field serves every working point). Blending is then
// a cheap weighted sum over these common-grid fields — which lets the 3D viewer
// morph continuously between neighbouring measured surfaces as the user drags
// the response surface.
//
// The blended texture is INDICATIVE: the photos are not spatially registered,
// so averaging their (differently-phased) tool-mark striations lowers interior
// contrast. Amplitude stays honest — the blend is renormalised so its RMS
// equals the interpolated Ra passed in (the same Nadaraya–Watson estimate the
// response surface draws).

export const FIELD_DIM = 160; // 25.6k vertices — comparable to the swept mesh

type LumField = Float32Array; // FIELD_DIM², mean≈0, unit RMS

export class FieldBlendCache {
  readonly dim = FIELD_DIM;
  private fields = new Map<string, LumField>();
  private pending = new Set<string>();
  /** Fired when a field finishes decoding (host coalesces + re-renders). */
  onReady: (() => void) | null = null;

  ready(id: string): boolean {
    return this.fields.has(id);
  }

  /** Decode + resample one photo into the cache (idempotent). */
  request(id: string, url: string): void {
    if (this.fields.has(id) || this.pending.has(id)) return;
    this.pending.add(id);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      this.pending.delete(id);
      const canvas = document.createElement('canvas');
      canvas.width = FIELD_DIM;
      canvas.height = FIELD_DIM;
      const cx = canvas.getContext('2d');
      if (!cx) return;
      cx.drawImage(img, 0, 0, FIELD_DIM, FIELD_DIM); // square resample
      const px = cx.getImageData(0, 0, FIELD_DIM, FIELD_DIM).data;
      const f = new Float32Array(FIELD_DIM * FIELD_DIM);
      let mean = 0;
      for (let i = 0; i < f.length; i++) {
        const l = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        f[i] = l;
        mean += l;
      }
      mean /= f.length;
      let ss = 0;
      for (let i = 0; i < f.length; i++) {
        f[i] -= mean;
        ss += f[i] * f[i];
      }
      const rms = Math.sqrt(ss / f.length) || 1;
      for (let i = 0; i < f.length; i++) f[i] /= rms; // unit RMS (no Ra yet)
      this.fields.set(id, f);
      this.onReady?.();
    };
    img.onerror = () => {
      this.pending.delete(id);
    };
    img.src = url;
  }

  /** Warm the cache for a set of datasets (idempotent per id). */
  preload(items: { id: string; url: string }[]): void {
    for (const it of items) this.request(it.id, it.url);
  }

  /**
   * Weighted blend of the cached fields for `neighbors` (only those already
   * decoded are used), written into `out` (length FIELD_DIM²), renormalised so
   * the result's RMS equals `ra` (µm). Returns the number of fields combined,
   * or 0 if none are ready.
   */
  blend(
    neighbors: { id: string; weight: number }[],
    ra: number,
    topK: number,
    out: Float32Array,
  ): number {
    const ready = neighbors
      .filter((n) => this.fields.has(n.id))
      .slice(0, Math.max(1, topK));
    if (ready.length === 0) return 0;
    let ws = 0;
    for (const n of ready) ws += n.weight;
    if (!(ws > 0)) ws = ready.length; // degenerate weights → equal blend
    out.fill(0);
    for (const n of ready) {
      const w = n.weight / ws;
      const f = this.fields.get(n.id)!;
      for (let i = 0; i < out.length; i++) out[i] += w * f[i];
    }
    // Renormalise amplitude to the interpolated Ra (µm-honest).
    let ss = 0;
    for (let i = 0; i < out.length; i++) ss += out[i] * out[i];
    const rms = Math.sqrt(ss / out.length) || 1;
    const k = ra / rms;
    for (let i = 0; i < out.length; i++) out[i] *= k;
    return ready.length;
  }
}
