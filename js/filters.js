/* =====================================================================
   filters.js — One Euro 濾波器（Casiez et al., CHI 2012）
   慢動作時強力去抖動，快動作時自動放寬、不延遲。VTuber 動捕常用。
   ===================================================================== */
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1.0) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.x = null; this.dx = 0; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, dt) {
    if (this.x === null || !(dt > 0)) { this.x = x; this.dx = 0; return x; }
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

/** 一組關鍵點（x,y,z）各自濾波；超過 resetAfter 秒沒資料就重來 */
export class LandmarkFilter {
  constructor({ minCutoff = 1.2, beta = 0.6, resetAfter = 0.5 } = {}) {
    this.opts = { minCutoff, beta }; this.resetAfter = resetAfter; this.f = null; this.t = 0;
  }
  setParams(minCutoff, beta) {
    this.opts = { minCutoff, beta };
    if (this.f) for (const p of this.f) for (const c of p) { c.minCutoff = minCutoff; c.beta = beta; }
  }
  apply(pts, tSec) {
    if (!pts) return pts;
    const dt = tSec - this.t;
    if (!this.f || this.f.length !== pts.length || dt > this.resetAfter || dt <= 0) {
      this.f = pts.map(() => [0, 1, 2].map(() => new OneEuro(this.opts.minCutoff, this.opts.beta)));
    }
    this.t = tSec;
    return pts.map((p, i) => {
      const [fx, fy, fz] = this.f[i];
      return { ...p, x: fx.filter(p.x, dt), y: fy.filter(p.y, dt), z: fz.filter(p.z, dt) };
    });
  }
}
