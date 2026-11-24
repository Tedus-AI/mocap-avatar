/* =====================================================================
   retarget.js — MediaPipe 座標 → VRM 正規化骨架旋轉
   ---------------------------------------------------------------------
   做法（適用任何 VRM0/VRM1 模型）：
   1. 讀取正規化骨架（normalized humanoid rig）的 T-pose 靜止位置，
      算出每根骨頭的「靜止方向」與模型自己的 左/上/前 座標基底。
   2. MediaPipe 世界座標先轉成「語意座標」：+X=角色左、+Y=上、+Z=朝向觀眾。
      鏡像模式＝把 X 反轉並交換左右。
   3. 由上而下逐根骨頭「瞄準」：已知父骨頭的世界旋轉，求出讓本骨頭指向目標的
      最小旋轉，換成本地旋轉。軀幹、手掌用兩軸基底求完整旋轉（含扭轉）。
   概念參考 XR Animator（ButzYung, CC BY-NC-SA 4.0），程式為重新撰寫。
   ===================================================================== */
import * as THREE from "three";

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Q = () => new THREE.Quaternion();
const IDQ = new THREE.Quaternion();

// MediaPipe Pose 索引（以「被拍的人」為準）
export const P = {
  nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28, lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32,
};

const FINGERS = [
  // [VRM 骨頭名稱前綴, MediaPipe Hand 索引鏈]
  ["Thumb",  ["Metacarpal", "Proximal", "Distal"], [1, 2, 3, 4]],
  ["Index",  ["Proximal", "Intermediate", "Distal"], [5, 6, 7, 8]],
  ["Middle", ["Proximal", "Intermediate", "Distal"], [9, 10, 11, 12]],
  ["Ring",   ["Proximal", "Intermediate", "Distal"], [13, 14, 15, 16]],
  ["Little", ["Proximal", "Intermediate", "Distal"], [17, 18, 19, 20]],
];

/** 由兩個向量（主軸 a、次軸 b）建立正交基底矩陣 */
function basis(a, b, out = new THREE.Matrix4()) {
  const x = a.clone().normalize();
  const z = V().crossVectors(x, b).normalize();
  const y = V().crossVectors(z, x).normalize();
  return out.makeBasis(x, y, z);
}
/** 求把基底 (a0,b0) 轉到 (a1,b1) 的旋轉 */
function frameRot(a0, b0, a1, b1) {
  if (a1.lengthSq() < 1e-8 || b1.lengthSq() < 1e-8) return Q();
  const m0 = basis(a0, b0), m1 = basis(a1, b1);
  const m = m1.multiply(m0.transpose());
  return Q().setFromRotationMatrix(m);
}
/** 最小旋轉：讓 from 方向轉到 to 方向 */
function aim(from, to) {
  if (to.lengthSq() < 1e-8) return Q();
  return Q().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
}

export class Rig {
  constructor(vrm) {
    this.vrm = vrm;
    this.h = vrm.humanoid;
    this.root = this.h.normalizedHumanBonesRoot;
    this.node = (n) => this.h.getNormalizedBoneNode(n);
    this.target = new Map();   // 骨頭名稱 → 目標本地旋轉
    this.hipsOffset = V();      // 目標臀部位移（語意座標，公尺）
    this.hasUpperChest = !!this.node("upperChest");
    this._measureRest();
  }

  /** 讀取 T-pose 靜止姿勢下各骨頭位置（rig 根節點座標系） */
  _measureRest() {
    const names = Object.keys(this.h.humanBones);
    // 先全部歸零
    for (const n of names) this.node(n)?.quaternion.identity();
    this.root.updateMatrixWorld(true);
    const inv = this.root.matrixWorld.clone().invert();
    this.pos = {};
    for (const n of names) {
      const nd = this.node(n); if (!nd) continue;
      this.pos[n] = V().setFromMatrixPosition(nd.matrixWorld).applyMatrix4(inv);
    }
    this.hipsRest = this.node("hips").position.clone();
    const p = this.pos;
    // 模型自身基底：左、上、前
    const left = V().subVectors(p.leftUpperArm, p.rightUpperArm).normalize();
    const up = V(0, 1, 0);
    const fwd = V().crossVectors(left, up).normalize();
    this.M = new THREE.Matrix4().makeBasis(left, up, fwd);   // 語意 → rig
    this.Mq = Q().setFromRotationMatrix(this.M);
    this.rd = {};  // 靜止方向
    const dir = (a, b) => (p[a] && p[b]) ? V().subVectors(p[b], p[a]).normalize() : null;
    for (const s of ["left", "right"]) {
      this.rd[s + "UpperArm"] = dir(s + "UpperArm", s + "LowerArm");
      this.rd[s + "LowerArm"] = dir(s + "LowerArm", s + "Hand");
      this.rd[s + "UpperLeg"] = dir(s + "UpperLeg", s + "LowerLeg");
      this.rd[s + "LowerLeg"] = dir(s + "LowerLeg", s + "Foot");
      this.rd[s + "Foot"] = dir(s + "Foot", s + "Toes") || this.sem(V(0, -0.35, 1)).normalize();
      const midRoot = p[s + "MiddleProximal"] ? s + "MiddleProximal" : null;
      this.rd[s + "HandFwd"] = midRoot ? dir(s + "Hand", midRoot) : this.rd[s + "LowerArm"].clone();
      const idx = p[s + "IndexProximal"], lit = p[s + "LittleProximal"];
      this.rd[s + "HandSide"] = (idx && lit) ? V().subVectors(idx, lit).normalize() : this.sem(V(0, 0, 1));
      for (const [f, segs] of FINGERS) {
        for (let i = 0; i < segs.length; i++) {
          const b = s + f + segs[i];
          if (!p[b]) continue;
          const nb = s + f + segs[i + 1];
          let d = p[nb] ? dir(b, nb) : null;
          if (!d) { const pb = s + f + segs[i - 1]; d = p[pb] ? dir(pb, b) : this.rd[s + "HandFwd"].clone(); }
          this.rd[b] = d;
        }
      }
    }
    // 腿長（給落地與位移用）
    this.legLen = p.leftUpperLeg && p.leftFoot ? p.leftUpperLeg.distanceTo(p.leftFoot) : 0.8;
    this.footRestY = p.leftFoot ? p.leftFoot.y : 0.08;
  }

  /** 語意座標向量 → rig 座標 */
  sem(v) { return v.clone().applyMatrix4(this.M); }

  /* ------------------------------------------------------------------
     主要入口：依追蹤結果算出所有骨頭的目標本地旋轉
     opts: { mirror, fullBody, useHands, idleT }
     ------------------------------------------------------------------ */
  solve(frame, opts) {
    const T = this.target;
    const mirror = !!opts.mirror;
    const pose = frame.pose;
    const sides = mirror ? { L: "right", R: "left" } : { L: "left", R: "right" };  // 人的左 → 角色的哪一邊
    // MediaPipe 世界座標 → 語意 → rig
    const cv = (p) => this.sem(V(mirror ? -p.x : p.x, -p.y, -p.z));
    const vis = (i) => pose ? (pose.world[i]?.visibility ?? pose.lm[i]?.visibility ?? 0) : 0;

    // 世界旋轉暫存（rig 座標）
    const W = {};
    const setLocal = (name, parentW, worldQ) => {
      W[name] = worldQ;
      T.set(name, parentW.clone().invert().multiply(worldQ));
    };
    const aimBone = (name, parentW, targetDir) => {
      const rest = this.rd[name]; if (!rest || !this.node(name)) { W[name] = parentW.clone(); return; }
      const cur = rest.clone().applyQuaternion(parentW);
      const wq = aim(cur, targetDir).multiply(parentW);
      setLocal(name, parentW, wq);
    };

    // ---------- 軀幹 ----------
    let hipsW = Q();
    if (pose) {
      const w = pose.world;
      const sh = (i) => cv(w[i]);
      const shL = sh(P.lSh), shR = sh(P.rSh);
      const shLine = mirror ? V().subVectors(shR, shL) : V().subVectors(shL, shR);   // 指向角色左方
      const shMid = V().addVectors(shL, shR).multiplyScalar(0.5);
      const hipL = cv(w[P.lHip]), hipR = cv(w[P.rHip]);
      const hipMid = V().addVectors(hipL, hipR).multiplyScalar(0.5);
      const hipsOk = vis(P.lHip) > 0.5 && vis(P.rHip) > 0.5;
      const left0 = this.sem(V(1, 0, 0)), up0 = this.sem(V(0, 1, 0));
      let torsoUp = hipsOk ? V().subVectors(shMid, hipMid) : up0.clone();

      if (opts.fullBody && hipsOk) {
        const hipLine = mirror ? V().subVectors(hipR, hipL) : V().subVectors(hipL, hipR);
        hipsW = frameRot(left0, up0, hipLine, torsoUp);
      } else if (hipsOk) {
        // 上半身模式：臀部只跟一點點身體前傾，保持穩定
        hipsW = IDQ.clone().slerp(frameRot(left0, up0, left0, torsoUp), 0.25);
      }
      setLocal("hips", Q(), hipsW);

      const chestW = frameRot(left0, up0, shLine, torsoUp);
      const rel = hipsW.clone().invert().multiply(chestW);
      const parts = this.hasUpperChest ? [["spine", 0.4], ["chest", 0.3], ["upperChest", 0.3]] : [["spine", 0.45], ["chest", 0.55]];
      let pw = hipsW;
      for (const [n, k] of parts) {
        const local = IDQ.clone().slerp(rel, k);
        T.set(n, local); W[n] = pw.clone().multiply(local); pw = W[n];
      }
      const topW = pw;
      for (const s of ["left", "right"]) { T.set(s + "Shoulder", Q()); W[s + "Shoulder"] = topW.clone(); }

      // ---------- 手臂 ----------
      for (const person of ["L", "R"]) {
        const av = sides[person];
        const iSh = person === "L" ? P.lSh : P.rSh, iEl = person === "L" ? P.lEl : P.rEl, iWr = person === "L" ? P.lWr : P.rWr;
        const ok = vis(iEl) > 0.45 && vis(iWr) > 0.35;
        const pw2 = W[av + "Shoulder"];
        if (ok) {
          aimBone(av + "UpperArm", pw2, V().subVectors(cv(w[iEl]), cv(w[iSh])));
          aimBone(av + "LowerArm", W[av + "UpperArm"], V().subVectors(cv(w[iWr]), cv(w[iEl])));
        } else {
          this._relaxArm(av, pw2, W, aimBone);
        }
        // 手掌
        const hand = frame.hands?.[person];
        if (ok && hand && opts.useHands) {
          this._solveHand(av, hand, mirror, W, setLocal, aimBone);
        } else if (ok) {
          const iIdx = person === "L" ? P.lIndex : P.rIndex, iPk = person === "L" ? P.lPinky : P.rPinky;
          const wr = cv(w[iWr]), idx = cv(w[iIdx]), pk = cv(w[iPk]);
          const fwd = V().addVectors(idx, pk).multiplyScalar(0.5).sub(wr);
          const side = V().subVectors(idx, pk);
          const handW = frameRot(this.rd[av + "HandFwd"], this.rd[av + "HandSide"], fwd, side);
          // 避免手腕折太誇張：只取一半
          const parent = W[av + "LowerArm"];
          const full = parent.clone().invert().multiply(handW);
          const local = IDQ.clone().slerp(full, 0.5);
          T.set(av + "Hand", local); W[av + "Hand"] = parent.clone().multiply(local);
          this._relaxFingers(av);
        } else {
          T.set(av + "Hand", Q()); W[av + "Hand"] = W[av + "LowerArm"].clone();
          this._relaxFingers(av);
        }
      }

      // ---------- 腿 ----------
      for (const person of ["L", "R"]) {
        const av = sides[person];
        const iHip = person === "L" ? P.lHip : P.rHip, iKn = person === "L" ? P.lKnee : P.rKnee;
        const iAn = person === "L" ? P.lAnk : P.rAnk, iFt = person === "L" ? P.lFoot : P.rFoot;
        const ok = opts.fullBody && vis(iKn) > 0.5 && vis(iAn) > 0.45;
        if (ok) {
          aimBone(av + "UpperLeg", hipsW, V().subVectors(cv(w[iKn]), cv(w[iHip])));
          aimBone(av + "LowerLeg", W[av + "UpperLeg"], V().subVectors(cv(w[iAn]), cv(w[iKn])));
          if (vis(iFt) > 0.4) aimBone(av + "Foot", W[av + "LowerLeg"], V().subVectors(cv(w[iFt]), cv(w[iAn])));
          else T.set(av + "Foot", Q());
        } else {
          // 腿保持站立：抵銷臀部旋轉讓腳垂直
          const stand = hipsW.clone().invert();
          const yawOnly = this._yawOf(hipsW);
          T.set(av + "UpperLeg", stand.multiply(yawOnly));
          T.set(av + "LowerLeg", Q()); T.set(av + "Foot", Q());
        }
      }

      // ---------- 臀部位移（全身模式） ----------
      if (opts.fullBody && hipsOk && pose.lm) {
        const lm = pose.lm;
        const cx = (lm[P.lHip].x + lm[P.rHip].x) / 2;
        const aspect = frame.aspect || 1.333;
        const sx = (cx - 0.5) * aspect * 1.6 * (mirror ? -1 : 1);
        this.hipsOffset.set(THREE.MathUtils.clamp(sx, -1.2, 1.2), 0, 0);
      } else this.hipsOffset.set(0, 0, 0);

      // ---------- 頭（無臉部追蹤時用耳朵、鼻子估） ----------
      if (!frame.face && vis(P.nose) > 0.5 && vis(P.lEar) > 0.3 && vis(P.rEar) > 0.3) {
        const eL = cv(w[P.lEar]), eR = cv(w[P.rEar]), nose = cv(w[P.nose]);
        const earLine = mirror ? V().subVectors(eR, eL) : V().subVectors(eL, eR);
        const fwd = V().subVectors(nose, V().addVectors(eL, eR).multiplyScalar(0.5));
        const headW = frameRot(left0, this.sem(V(0, 0, 1)), earLine, fwd);
        this._applyHead(IDQ.clone().slerp(topW.clone().invert().multiply(headW), 0.6), topW);
      }
    } else {
      // 沒有偵測到人：回到放鬆站姿
      this._idle(W, aimBone, opts.idleT || 0);
    }

    // ---------- 臉（頭部旋轉）----------
    if (frame.face?.matrix) {
      const m = new THREE.Matrix4().fromArray(frame.face.matrix);
      const qCam = Q().setFromRotationMatrix(m);
      // 相機座標（x 右、y 上、z 朝相機）＝語意座標（非鏡像時）；鏡像＝對 X 反射
      if (mirror) { qCam.y = -qCam.y; qCam.z = -qCam.z; }
      const qRig = this.Mq.clone().multiply(qCam).multiply(this.Mq.clone().invert());
      const topW = W[this.hasUpperChest ? "upperChest" : "chest"] || Q();
      this._applyHead(topW.clone().invert().multiply(qRig), topW);
    }
  }

  _applyHead(localTotal, topW) {
    if (this.node("neck")) {
      this.target.set("neck", IDQ.clone().slerp(localTotal, 0.4));
      const neckW = topW.clone().multiply(this.target.get("neck"));
      const headWorld = topW.clone().multiply(localTotal);
      this.target.set("head", neckW.invert().multiply(headWorld));
    } else this.target.set("head", localTotal);
  }

  _yawOf(q) {
    const f = V(0, 0, 1).applyQuaternion(q); f.y = 0;
    if (f.lengthSq() < 1e-6) return Q();
    return aim(V(0, 0, 1), f);
  }

  _relaxArm(av, pw, W, aimBone) {
    const sgn = av === "left" ? 1 : -1;
    aimBone(av + "UpperArm", pw, this.sem(V(0.28 * sgn, -1, 0.05)));
    aimBone(av + "LowerArm", W[av + "UpperArm"], this.sem(V(0.12 * sgn, -1, 0.18)));
  }
  _relaxFingers(av) {
    for (const [f, segs] of FINGERS) for (const s of segs) {
      const n = av + f + s; if (!this.node(n)) continue;
      // 微彎：繞「前方×下方」軸彎一點
      const bend = f === "Thumb" ? 0.1 : 0.25;
      const axis = this.sem(V(0, 0, av === "left" ? -1 : 1));
      this.target.set(n, Q().setFromAxisAngle(axis.normalize(), bend));
    }
  }

  _solveHand(av, hand, mirror, W, setLocal, aimBone) {
    const pts = hand.world || hand.lm;
    const sx = hand.world ? 1 : (hand.aspect || 1.333);
    const cv = (p) => this.sem(V((mirror ? -p.x : p.x) * sx, -p.y, -p.z * (hand.world ? 1 : sx)));
    const H = pts.map(cv);
    const fwd = V().subVectors(H[9], H[0]);
    const side = V().subVectors(H[5], H[17]);
    const handW = frameRot(this.rd[av + "HandFwd"], this.rd[av + "HandSide"], fwd, side);
    setLocal(av + "Hand", W[av + "LowerArm"], handW);
    for (const [f, segs, idx] of FINGERS) {
      let parent = W[av + "Hand"];
      for (let i = 0; i < segs.length; i++) {
        const n = av + f + segs[i];
        if (!this.node(n)) continue;
        aimBone(n, parent, V().subVectors(H[idx[i + 1]], H[idx[i]]));
        parent = W[n];
      }
    }
  }

  _idle(W, aimBone, t) {
    const T = this.target;
    const breath = Math.sin(t * 1.6) * 0.015;
    T.set("hips", Q()); W.hips = Q();
    for (const n of ["spine", "chest", "upperChest"]) { T.set(n, Q().setFromAxisAngle(this.sem(V(1, 0, 0)), breath)); }
    let pw = Q();
    for (const n of ["spine", "chest", "upperChest"]) if (T.get(n)) pw = pw.clone().multiply(T.get(n));
    for (const av of ["left", "right"]) {
      W[av + "Shoulder"] = pw; T.set(av + "Shoulder", Q());
      this._relaxArm(av, pw, W, aimBone);
      T.set(av + "Hand", Q()); this._relaxFingers(av);
      T.set(av + "UpperLeg", Q()); T.set(av + "LowerLeg", Q()); T.set(av + "Foot", Q());
    }
    T.set("neck", Q()); T.set("head", Q());
    this.hipsOffset.set(0, 0, 0);
  }

  /** 平滑套用到骨頭；k 越大越即時 */
  apply(dt, k) {
    const a = 1 - Math.exp(-dt * k);
    for (const [n, q] of this.target) {
      const nd = this.node(n); if (!nd) continue;
      nd.quaternion.slerp(q, a);
    }
    // 臀部位移
    const hips = this.node("hips");
    const off = this.sem(this.hipsOffset);
    const want = this.hipsRest.clone().add(off);
    const a2 = 1 - Math.exp(-dt * Math.min(k, 10));
    hips.position.x += (want.x - hips.position.x) * a2;   // y 交給 ground() 處理
    hips.position.z += (want.z - hips.position.z) * a2;
  }

  /** 落地：讓最低的腳貼地（全身模式用） */
  ground(enabled) {
    const hips = this.node("hips");
    if (!enabled) { hips.position.y += (this.hipsRest.y - hips.position.y) * 0.2; return; }
    this.root.updateMatrixWorld(true);
    const inv = this.root.matrixWorld.clone().invert();
    let minY = Infinity;
    for (const n of ["leftFoot", "rightFoot", "leftToes", "rightToes"]) {
      const nd = this.node(n); if (!nd) continue;
      minY = Math.min(minY, V().setFromMatrixPosition(nd.matrixWorld).applyMatrix4(inv).y);
    }
    if (isFinite(minY)) hips.position.y += (this.footRestY - minY) * 0.5;
  }
}

/* ---------------------- 臉部表情：blendshapes → VRM ---------------------- */
export function faceExpressions(blend, mirror) {
  const g = (n) => blend[n] ?? 0;
  let bL = g("eyeBlinkLeft"), bR = g("eyeBlinkRight");
  if (mirror) [bL, bR] = [bR, bL];
  // 兩眼差距小就視為一起眨，避免單眼誤判
  if (Math.abs(bL - bR) < 0.35) { const m = (bL + bR) / 2; bL = bR = m; }
  const remap = (v, lo, hi) => THREE.MathUtils.clamp((v - lo) / (hi - lo), 0, 1);
  const jaw = g("jawOpen"), funnel = g("mouthFunnel"), pucker = g("mouthPucker");
  const smile = (g("mouthSmileLeft") + g("mouthSmileRight")) / 2;
  const stretch = (g("mouthStretchLeft") + g("mouthStretchRight")) / 2;
  return {
    blinkLeft: remap(bL, 0.25, 0.7), blinkRight: remap(bR, 0.25, 0.7),
    aa: remap(jaw - pucker * 0.5, 0.05, 0.55),
    oh: remap(funnel, 0.1, 0.5) * 0.9,
    ou: remap(pucker, 0.2, 0.7) * 0.9,
    ee: remap(stretch + smile * 0.3, 0.1, 0.5) * 0.6,
    ih: remap(stretch, 0.2, 0.6) * 0.3,
    happy: remap(smile, 0.35, 0.8) * 0.8,
    surprised: remap(g("browInnerUp"), 0.45, 0.9) * remap(jaw, 0.2, 0.5) * 0.7,
  };
}
