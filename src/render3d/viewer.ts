// 3D roughness relief (panel D). A finely subdivided plane is displaced by the
// ISO roughness residual used as a height map. For a 1-D line scan the profile
// is swept along the depth axis (faithful — no fabricated cross-profile
// texture); an areal grid import renders a true 2-D height map. Orthographic
// camera with a hand-rolled orbit (no OrbitControls build dependency), a
// vertical-exaggeration slider (literal geometric scaling of height vs lateral,
// so it stays honest), a viridis/turbo height gradient, and anomaly zones in red.
import * as THREE from 'three';
import type { AnomalyZone, Dataset } from '../types';
import { viridis, turbo } from '../color';
import { canvasPalette, theme, type ThemeName } from '../theme';

const SCENE_WIDTH = 3.2; // scene units spanning the full lateral trace length
const DEPTH = 1.1; // scene units of the swept depth axis

export interface ReliefInfo {
  minH: number; // true height range (µm)
  maxH: number;
  isGrid: boolean;
  /** True when the relief comes from a surface-photo displacement map, so the
   *  height range is a photo-derived (Ra-scaled) estimate, not a true metrology
   *  measurement. */
  isImage: boolean;
  cols: number;
  rows: number;
}

/** Photos are a surface field of the same order as the 8 mm line scan; assume
 *  an 8 mm lateral extent so the exaggeration slider stays µm-consistent with
 *  the swept/areal paths. */
const IMAGE_FIELD_UM = 8000;
/** Max mesh dimension when sampling a photo (detail vs. vertex budget). */
const IMAGE_MAX_DIM = 200;

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private mesh: THREE.Mesh | null = null;
  private geom: THREE.BufferGeometry | null = null;
  private baseHeights: Float32Array = new Float32Array(0); // µm, per vertex
  private colsN = 0;
  private lateralScale = 1; // scene units per µm (height, at exaggeration ×1)

  private azimuth = Math.PI * 0.25;
  private elevation = Math.PI * 0.28;
  private zoom = 1;
  private exaggeration = 60;
  private colormap: 'viridis' | 'turbo' = 'viridis';
  private showAnomalies = true;
  private zones: AnomalyZone[] = [];
  private xData: number[] = [];
  private info: ReliefInfo = {
    minH: 0,
    maxH: 0,
    isGrid: false,
    isImage: false,
    cols: 0,
    rows: 0,
  };

  /** Bumped on every setDataset so a slow async image load that resolves after
   *  the user has already switched profiles is discarded instead of clobbering
   *  the newer mesh. */
  private loadToken = 0;
  /** Called whenever the relief (and thus `info`) changes, including after an
   *  async photo load — lets the host refresh the height-range read-out. */
  onInfo: (() => void) | null = null;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private frame = 0;
  private disposed = false;

  constructor(private container: HTMLElement) {
    const bg = canvasPalette(theme.get()).three;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(bg, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.cursor = 'grab';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(bg);

    this.camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.01, 100);

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(2.5, 4, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.6);
    fill.position.set(-3, 1.5, -2);
    this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    this.bindEvents();
    this.resize();
    this.updateCamera();
    this.loop();
  }

  private bindEvents(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.azimuth -= dx * 0.008;
      this.elevation = Math.max(
        0.05,
        Math.min(Math.PI / 2 - 0.02, this.elevation + dy * 0.006),
      );
      this.updateCamera();
    });
    const end = (e: PointerEvent) => {
      this.dragging = false;
      el.style.cursor = 'grab';
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const f = Math.exp(-e.deltaY * 0.0012);
        this.zoom = Math.max(0.35, Math.min(6, this.zoom * f));
        this.updateCamera();
      },
      { passive: false },
    );
  }

  resize(): void {
    const w = this.container.clientWidth || 480;
    const h = this.container.clientHeight || 360;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    const view = 2.0;
    this.camera.left = -view * aspect;
    this.camera.right = view * aspect;
    this.camera.top = view;
    this.camera.bottom = -view;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private updateCamera(): void {
    const r = 8;
    const ce = Math.cos(this.elevation);
    this.camera.position.set(
      r * ce * Math.cos(this.azimuth),
      r * Math.sin(this.elevation),
      r * ce * Math.sin(this.azimuth),
    );
    this.camera.lookAt(0, 0, 0);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  resetView(): void {
    this.azimuth = Math.PI * 0.25;
    this.elevation = Math.PI * 0.28;
    this.zoom = 1;
    this.updateCamera();
  }

  setExaggeration(v: number): void {
    this.exaggeration = v;
    this.applyHeights();
  }
  setColormap(c: 'viridis' | 'turbo'): void {
    this.colormap = c;
    this.applyColors();
  }
  setShowAnomalies(v: boolean): void {
    this.showAnomalies = v;
    this.applyColors();
  }
  setTheme(name: ThemeName): void {
    const bg = canvasPalette(name).three;
    this.renderer.setClearColor(bg, 1);
    this.scene.background = new THREE.Color(bg);
    this.render();
  }
  getInfo(): ReliefInfo {
    return this.info;
  }

  /** Build the relief mesh from a dataset. Preference order: surface-photo
   *  displacement map (example set) → areal height grid → swept 1-D line scan. */
  setDataset(dataset: Dataset | null): void {
    const token = ++this.loadToken;
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.geom?.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
      this.geom = null;
    }
    if (!dataset || !dataset.roughness) {
      this.info = { minH: 0, maxH: 0, isGrid: false, isImage: false, cols: 0, rows: 0 };
      this.render();
      this.onInfo?.();
      return;
    }

    this.zones = this.showZonesFor(dataset);
    const grid = dataset.profile.grid;
    if (dataset.imageUrl) {
      this.buildFromImage(dataset, dataset.imageUrl, token);
    } else if (grid) {
      this.buildGrid(dataset, grid.rows, grid.cols);
    } else {
      this.buildSwept(dataset);
    }
  }

  /** Surface photo → displacement map. Luminance drives per-vertex height,
   *  rescaled so the relief's RMS ≈ the profile's measured Ra (µm) — keeping the
   *  vertical scale honest and the exaggeration slider consistent with the other
   *  paths. Async (image decode); guarded by `token` against dataset switches. */
  private buildFromImage(dataset: Dataset, url: string, token: number): void {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (this.disposed || token !== this.loadToken) return;
      const aspect = img.naturalHeight / img.naturalWidth || 1;
      const cols = img.naturalWidth >= img.naturalHeight
        ? IMAGE_MAX_DIM
        : Math.max(2, Math.round(IMAGE_MAX_DIM / aspect));
      const rows = img.naturalWidth >= img.naturalHeight
        ? Math.max(2, Math.round(IMAGE_MAX_DIM * aspect))
        : IMAGE_MAX_DIM;

      const canvas = document.createElement('canvas');
      canvas.width = cols;
      canvas.height = rows;
      const cx = canvas.getContext('2d');
      if (!cx) return;
      cx.drawImage(img, 0, 0, cols, rows);
      const px = cx.getImageData(0, 0, cols, rows).data;

      // Perceptual luminance per cell, mean-subtracted then unit-RMS normalized.
      const lum = new Float32Array(cols * rows);
      let mean = 0;
      for (let i = 0; i < cols * rows; i++) {
        const l = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        lum[i] = l;
        mean += l;
      }
      mean /= cols * rows || 1;
      let ss = 0;
      for (let i = 0; i < lum.length; i++) {
        lum[i] -= mean;
        ss += lum[i] * lum[i];
      }
      const rms = Math.sqrt(ss / (lum.length || 1)) || 1;
      // Scale so the photo relief's RMS matches the measured Ra (µm).
      const ra = dataset.roughness?.Ra ?? 1;
      const scale = ra / rms;
      for (let i = 0; i < lum.length; i++) lum[i] *= scale;

      this.xData = [];
      this.lateralScale = SCENE_WIDTH / IMAGE_FIELD_UM;
      const depthExtent = SCENE_WIDTH * (rows / (cols || 1));
      this.buildPlane(cols, rows, (c, r) => lum[r * cols + c], true, depthExtent, true);
    };
    img.onerror = () => {
      if (this.disposed || token !== this.loadToken) return;
      // Fall back to the swept line scan if the photo can't be decoded.
      this.buildSwept(dataset);
    };
    img.src = url;
  }

  private showZonesFor(dataset: Dataset): AnomalyZone[] {
    return dataset.anomaly ? dataset.anomaly.zones : [];
  }

  /** 1-D line scan → extrude residual along the depth axis. */
  private buildSwept(dataset: Dataset): void {
    const rough = dataset.roughness!;
    const xFull = rough.x;
    const rFull = rough.residual;
    const traceLen = Math.max(1e-6, xFull[xFull.length - 1] - xFull[0]);

    // Downsample columns for a smooth display mesh (detection stays full-res).
    const maxCols = 360;
    const cols = Math.max(2, Math.min(maxCols, xFull.length));
    const rows = 64;
    const heights = new Float32Array(cols);
    const colX = new Array<number>(cols);
    for (let c = 0; c < cols; c++) {
      const idx = Math.round((c / (cols - 1)) * (xFull.length - 1));
      heights[c] = rFull[idx];
      colX[c] = xFull[idx];
    }
    this.xData = colX;
    this.lateralScale = SCENE_WIDTH / traceLen; // scene units per µm

    this.buildPlane(cols, rows, (c) => heights[c], false, DEPTH);
  }

  /** Areal grid → true 2-D height map (mean-subtracted heights). */
  private buildGrid(dataset: Dataset, rows: number, cols: number): void {
    const y = dataset.profile.y;
    let mean = 0;
    for (const v of y) mean += v;
    mean /= y.length || 1;
    // Downsample to a manageable mesh.
    const maxDim = 220;
    const dc = Math.max(2, Math.min(maxDim, cols));
    const dr = Math.max(2, Math.min(maxDim, rows));
    const field = new Float32Array(dc * dr);
    for (let r = 0; r < dr; r++) {
      for (let c = 0; c < dc; c++) {
        const sc = Math.round((c / (dc - 1 || 1)) * (cols - 1));
        const sr = Math.round((r / (dr - 1 || 1)) * (rows - 1));
        field[r * dc + c] = y[sr * cols + sc] - mean;
      }
    }
    this.xData = [];
    // Height scale must be scene-units-per-µm (like the swept path), computed
    // from the PHYSICAL lateral extent = cols × sample pitch — not the mesh
    // resolution — so exaggeration stays honest and resolution-independent.
    const xs = dataset.profile.x;
    const pitch = xs.length > 1 ? Math.abs(xs[1] - xs[0]) || 1 : 1; // µm per cell
    const widthUm = cols * pitch;
    this.lateralScale = SCENE_WIDTH / (widthUm || 1);
    // Preserve the true aspect ratio: depth extent = width × (rows/cols).
    const depthExtent = SCENE_WIDTH * (rows / (cols || 1));
    this.buildPlane(dc, dr, (c, r) => field[r * dc + c], true, depthExtent);
  }

  /** Shared plane builder. `heightAt(col,row)` returns µm height. */
  private buildPlane(
    cols: number,
    rows: number,
    heightAt: (c: number, r: number) => number,
    isGrid: boolean,
    depthExtent: number,
    isImage = false,
  ): void {
    this.colsN = cols;
    const geom = new THREE.BufferGeometry();
    const nVerts = cols * rows;
    const positions = new Float32Array(nVerts * 3);
    const base = new Float32Array(nVerts);
    let minH = Infinity;
    let maxH = -Infinity;

    const halfW = SCENE_WIDTH / 2;
    const halfD = depthExtent / 2;
    const denomC = cols > 1 ? cols - 1 : 1;
    const denomR = rows > 1 ? rows - 1 : 1;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const x = -halfW + (c / denomC) * SCENE_WIDTH;
        const z = -halfD + (r / denomR) * (halfD * 2);
        const hUm = heightAt(c, r);
        base[i] = hUm;
        if (hUm < minH) minH = hUm;
        if (hUm > maxH) maxH = hUm;
        positions[i * 3] = x;
        positions[i * 3 + 1] = 0;
        positions[i * 3 + 2] = z;
      }
    }

    const indices: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = r * cols + c + 1;
        const d = (r + 1) * cols + c;
        const e = (r + 1) * cols + c + 1;
        indices.push(a, d, b, b, d, e);
      }
    }

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(nVerts * 3), 3),
    );
    geom.setIndex(indices);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.08,
      side: THREE.DoubleSide,
      flatShading: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    this.scene.add(mesh);
    this.mesh = mesh;
    this.geom = geom;
    this.baseHeights = base;
    this.info = {
      minH: isFinite(minH) ? minH : 0,
      maxH: isFinite(maxH) ? maxH : 0,
      isGrid,
      isImage,
      cols,
      rows,
    };

    this.applyHeights();
    this.applyColors();
    this.onInfo?.();
  }

  private applyHeights(): void {
    if (!this.geom) return;
    const pos = this.geom.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const yScale = this.lateralScale * this.exaggeration; // scene units per µm
    for (let i = 0; i < this.baseHeights.length; i++) {
      arr[i * 3 + 1] = this.baseHeights[i] * yScale;
    }
    pos.needsUpdate = true;
    this.geom.computeVertexNormals();
    this.geom.computeBoundingSphere();
    this.render();
  }

  private applyColors(): void {
    if (!this.geom) return;
    const color = this.geom.getAttribute('color') as THREE.BufferAttribute;
    const arr = color.array as Float32Array;
    const { minH, maxH } = this.info;
    const span = maxH - minH || 1;
    const cmap = this.colormap === 'turbo' ? turbo : viridis;

    for (let i = 0; i < this.baseHeights.length; i++) {
      const t = (this.baseHeights[i] - minH) / span;
      let [r, g, b] = cmap(t);
      if (this.showAnomalies && !this.info.isGrid) {
        const c = i % this.colsN;
        const xv = this.xData[c];
        if (xv != null && this.inZone(xv)) {
          r = 235;
          g = 45;
          b = 45;
        }
      }
      arr[i * 3] = r / 255;
      arr[i * 3 + 1] = g / 255;
      arr[i * 3 + 2] = b / 255;
    }
    color.needsUpdate = true;
    this.render();
  }

  private inZone(x: number): boolean {
    for (const z of this.zones) if (x >= z.x0 && x <= z.x1) return true;
    return false;
  }

  private render(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  // Render-on-demand; a light rAF keeps things smooth during drag/resize.
  private loop = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    if (this.dragging) this.render();
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    if (this.mesh) (this.mesh.material as THREE.Material).dispose();
    this.geom?.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
