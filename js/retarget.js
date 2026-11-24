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
/** 把「指向左方」的向量水平轉角限制在 ±max 內（單鏡頭很難分辨正面與側面，深度雜訊會讓身體突然轉向） */
function clampYaw(v, left0, max) {
  const up = new THREE.Vector3(0, 1, 0);
  const h = v.clone().projectOnPlane(up), h0 = left0.clone().projectOnPlane(up).normalize();
  const len = h.length(); if (len < 1e-6) return v;
  const ang = Math.atan2(new THREE.Vector3().crossVectors(h0, h).dot(up), h0.dot(h));
  if (Math.abs(ang) <= max) return v;
  const nh = h0.applyAxisAngle(up, Math.sign(ang) * max).multiplyScalar(len);
  return nh.add(up.multiplyScalar(v.y));
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
    this.lastSeen = {};        // 肢體最後一次被看清楚的時間（秒）
    this.calQ = null;          // 校準：扣掉鏡頭傾斜／沒正對鏡頭（語意座標的旋轉）
    this.faceCalQ = null;      // 校準：扣掉鏡頭高低造成的抬頭／低頭
    this.HOLD = 0.8;           // 看不清楚時，維持上一個姿勢多久再慢慢放鬆
    this._measureRest();
    try { this._measureBody(); } catch (e) { console.warn("身體輪廓量測失敗，略過防穿模", e); this.body = null; }
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
    const calQ = opts.noCal ? null : this.calQ;   // 角色示範姿勢時不套用校準
    const cv = (p) => { const v = V(mirror ? -p.x : p.x, -p.y, -p.z); if (calQ) v.applyQuaternion(calQ); return this.sem(v); };
    const vis = (i) => pose ? (pose.world[i]?.visibility ?? pose.lm[i]?.visibility ?? 0) : 0;
    // 點在畫面內才可信：人靠近鏡頭時臀部在畫面外，MediaPipe 仍會「猜」一個位置，會讓身體歪掉
    const inFrame = (i) => { const q = pose?.lm[i]; return q && q.x > 0.02 && q.x < 0.98 && q.y > 0.02 && q.y < 0.98; };

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
      let shLine = mirror ? V().subVectors(shR, shL) : V().subVectors(shL, shR);   // 指向角色左方
      const shMid = V().addVectors(shL, shR).multiplyScalar(0.5);
      const hipL = cv(w[P.lHip]), hipR = cv(w[P.rHip]);
      const hipMid = V().addVectors(hipL, hipR).multiplyScalar(0.5);
      const hipsOk = vis(P.lHip) > 0.6 && vis(P.rHip) > 0.6 && inFrame(P.lHip) && inFrame(P.rHip);
      const left0 = this.sem(V(1, 0, 0)), up0 = this.sem(V(0, 1, 0));
      let torsoUp = hipsOk ? V().subVectors(shMid, hipMid) : up0.clone();

      shLine = clampYaw(shLine, left0, 1.4);   // 胸口最多轉 80°
      if (opts.fullBody && hipsOk) {
        let hipLine = mirror ? V().subVectors(hipR, hipL) : V().subVectors(hipL, hipR);
        // 臀部左右點很接近，深度雜訊大：和肩線各半混合，並限制轉角 ±70°
        hipLine = hipLine.normalize().add(shLine.clone().normalize());
        if (hipLine.lengthSq() < 0.01) hipLine = shLine.clone();
        hipLine = clampYaw(hipLine, left0, 1.2);
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
        const ok = vis(iEl) > 0.35 && vis(iWr) > 0.25;
        const pw2 = W[av + "Shoulder"];
        const now = opts.idleT || 0;
        if (ok) {
          this.lastSeen[av + "Arm"] = now;
          aimBone(av + "UpperArm", pw2, V().subVectors(cv(w[iEl]), cv(w[iSh])));
          aimBone(av + "LowerArm", W[av + "UpperArm"], V().subVectors(cv(w[iWr]), cv(w[iEl])));
        } else if (now - (this.lastSeen[av + "Arm"] ?? -9) < this.HOLD) {
          this._keep([av + "UpperArm", av + "LowerArm", av + "Hand"], pw2, W);   // 短暫被擋住：維持上一個姿勢
        } else {
          this._relaxArm(av, pw2, W, aimBone);
        }
        // 手掌
        const hand = frame.hands?.[person];
        const held = !ok && now - (this.lastSeen[av + "Arm"] ?? -9) < this.HOLD;
        if (held) { /* 手掌、手指也維持 */ }
        else if (ok && hand && opts.useHands) {
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

      // ---------- 防穿模：手進到身體／裙子裡就把手臂往前推 ----------
      for (const av of ["left", "right"]) this._avoidBody(av, W, hipsW);

      // ---------- 腿 ----------
      const legSeen = (iKn, iAn) => vis(iKn) > 0.4 && vis(iAn) > 0.35;
      for (const person of ["L", "R"]) {
        const av = sides[person];
        const iHip = person === "L" ? P.lHip : P.rHip, iKn = person === "L" ? P.lKnee : P.rKnee;
        const iAn = person === "L" ? P.lAnk : P.rAnk, iFt = person === "L" ? P.lFoot : P.rFoot;
        // 側身時遠側的腿被擋住（可見度低），但 MediaPipe 推估的位置通常和近側腿平行、相當準：
        // 另一條腿看得到、且這條腿的膝蓋腳踝都在畫面內 → 照樣採用（不然會變成一條腿直直站著）
        const other = person === "L" ? legSeen(P.rKnee, P.rAnk) : legSeen(P.lKnee, P.lAnk);
        const hidden = other && hipsOk && inFrame(iKn) && inFrame(iAn) && vis(iKn) > 0.1 && vis(iAn) > 0.1;
        const ok = opts.fullBody && (legSeen(iKn, iAn) || hidden);
        const nowL = opts.idleT || 0;
        if (ok) this.lastSeen[av + "Leg"] = nowL;
        if (!ok && opts.fullBody && nowL - (this.lastSeen[av + "Leg"] ?? -9) < this.HOLD) {
          this._keep([av + "UpperLeg", av + "LowerLeg", av + "Foot"], hipsW, W);
        } else if (ok) {
          const { thigh, shin } = this._legDirs(pose, w, cv, iHip, iKn, iAn, hipsW, frame.aspect || 1.333);
          aimBone(av + "UpperLeg", hipsW, thigh);
          aimBone(av + "LowerLeg", W[av + "UpperLeg"], shin);
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
      if (this.faceCalQ) qCam.premultiply(this.faceCalQ);
      const qRig = this.Mq.clone().multiply(qCam).multiply(this.Mq.clone().invert());
      const topW = W[this.hasUpperChest ? "upperChest" : "chest"] || Q();
      this._applyHead(topW.clone().invert().multiply(qRig), topW);
    }
  }

  /** 腿的方向：抑制深度雜訊＋關節限制
   *  1. 前後（深度）分量只取 70%：單鏡頭的深度最不準
   *  2. 畫面上腿是直的、且大腿沒有明顯縮短（不是正面深蹲）→ 視為直腿
   *  3. 膝蓋不能往前彎（反關節）→ 拉直 */
  _legDirs(pose, w, cv, iHip, iKn, iAn, hipsW, aspect) {
    const fwd = this.sem(V(0, 0, 1)).applyQuaternion(hipsW).normalize();
    const damp = (v) => v.sub(fwd.clone().multiplyScalar(v.dot(fwd) * 0.3));
    const thigh = damp(V().subVectors(cv(w[iKn]), cv(w[iHip])));
    let shin = damp(V().subVectors(cv(w[iAn]), cv(w[iKn])));
    const lm = pose.lm, H = lm[iHip], K = lm[iKn], A = lm[iAn];
    const t2 = [(K.x - H.x) * aspect, K.y - H.y], s2 = [(A.x - K.x) * aspect, A.y - K.y];
    const l1 = Math.hypot(...t2), l2 = Math.hypot(...s2);
    if (l1 > 1e-4 && l2 > 1e-4) {
      const cos = (t2[0] * s2[0] + t2[1] * s2[1]) / (l1 * l2);
      const bend2D = Math.acos(Math.max(-1, Math.min(1, cos))) * 57.3;   // 0 = 直
      const notForeshortened = l1 / l2 > 0.75;
      if (notForeshortened && bend2D < 25) {
        const k = bend2D < 15 ? 1 : (25 - bend2D) / 10;               // 15°內完全拉直，15~25° 漸變
        const straight = thigh.clone().normalize().multiplyScalar(shin.length());
        shin = shin.lerp(straight, k);
      }
    }
    // 反關節：小腿相對大腿往身體前方彎 → 拉直
    const tn = thigh.clone().normalize(), sn = shin.clone().normalize();
    if (sn.clone().sub(tn).dot(fwd) > 0.05) shin = tn.multiplyScalar(shin.length());
    return { thigh, shin };
  }

  /* ------------------------------------------------------------------
     防穿模：載入時從模型網格量出「身體正面輪廓」
     只取綁在軀幹（臀、脊椎、胸、大腿、及其下的裙子骨頭）的頂點，排除頭髮、手臂
     結果：每 2cm 高度，身體最前面的位置（相對臀部，語意座標：+Z 朝前）
     ------------------------------------------------------------------ */
  _measureBody() {
    const h = this.h, vrm = this.vrm;
    const torsoNames = ["hips", "spine", "chest", "upperChest", "leftUpperLeg", "rightUpperLeg"];
    const rawToName = new Map();
    for (const n of Object.keys(h.humanBones)) { const r = h.getRawBoneNode(n); if (r) rawToName.set(r, n); }
    const cache = new Map();
    const isTorso = (bone) => {
      if (cache.has(bone)) return cache.get(bone);
      let b = bone, res = false;
      while (b) { if (rawToName.has(b)) { res = torsoNames.includes(rawToName.get(b)); break; } b = b.parent; }
      cache.set(bone, res); return res;
    };
    vrm.scene.updateMatrixWorld(true);
    const Minv = this.M.clone().transpose();   // 正交矩陣：轉置＝反矩陣（rig → 語意）
    const toSem = this.root.matrixWorld.clone().invert().premultiply(Minv);
    const hips = this.pos.hips.clone().applyMatrix4(Minv);
    const Y0 = -0.7, STEP = 0.02, N = 80;
    const xMin = new Float32Array(N).fill(Infinity), xMax = new Float32Array(N).fill(-Infinity);
    const zMin = new Float32Array(N).fill(Infinity), zMax = new Float32Array(N).fill(-Infinity);
    const v = new THREE.Vector3(), m = new THREE.Matrix4();
    vrm.scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const g = o.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      if (!pos || !si || !sw) return;
      const bones = o.skeleton.bones;
      m.multiplyMatrices(toSem, o.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        let bj = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; bj = si.getComponent(i, k); } }
        const bone = bones[bj]; if (!bone || !isTorso(bone)) continue;
        v.fromBufferAttribute(pos, i).applyMatrix4(m).sub(hips);
        const bi = Math.floor((v.y - Y0) / STEP); if (bi < 0 || bi >= N) continue;
        if (v.x < xMin[bi]) xMin[bi] = v.x; if (v.x > xMax[bi]) xMax[bi] = v.x;
        if (v.z < zMin[bi]) zMin[bi] = v.z; if (v.z > zMax[bi]) zMax[bi] = v.z;
      }
    });
    // 每個高度：身體截面近似為橢圓（中心、半寬、半厚）；相鄰高度取聯集，填補空隙
    const E = [];
    for (let i = 0; i < N; i++) {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (let d = -1; d <= 1; d++) { const j = i + d; if (j < 0 || j >= N || !isFinite(xMin[j])) continue;
        a0 = Math.min(a0, xMin[j]); a1 = Math.max(a1, xMax[j]); b0 = Math.min(b0, zMin[j]); b1 = Math.max(b1, zMax[j]); }
      E.push(isFinite(a0) ? { cx: (a0 + a1) / 2, cz: (b0 + b1) / 2, a: (a1 - a0) / 2, b: (b1 - b0) / 2 } : null);
    }
    this.body = { E, Y0, STEP, N, Minv };
  }

  /** 防穿模：上臂、手肘、前臂、手腕、指尖若進入身體截面（橢圓＋安全距離），以肩膀為圓心把手臂轉出來 */
  _avoidBody(av, W, hipsW) {
    const B = this.body; if (!B || !W[av + "Hand"] || !W[av + "UpperArm"]) return;
    const p = this.pos;
    const chain = ["hips", "spine", "chest", "upperChest", av + "Shoulder", av + "UpperArm", av + "LowerArm", av + "Hand"]
      .filter((n) => p[n] && W[n]);
    const fk = () => {
      const Pp = { hips: p.hips.clone() };
      for (let i = 1; i < chain.length; i++) {
        const a = chain[i - 1], b = chain[i];
        Pp[b] = V().subVectors(p[b], p[a]).applyQuaternion(W[a]).add(Pp[a]);
      }
      return Pp;
    };
    const hipsInv = hipsW.clone().invert();
    const toRig = this.M.clone().premultiply(new THREE.Matrix4().makeRotationFromQuaternion(hipsW));   // 臀部語意座標 → rig
    const handLen = p[av + "MiddleProximal"] ? p[av + "MiddleProximal"].distanceTo(p[av + "Hand"]) * 1.9 : 0.08;
    const M_ARM = 0.025, M_HAND = 0.03;   // 安全距離
    const upper = av + "UpperArm", lower = av + "LowerArm", hand = av + "Hand";
    const parentW = W[chain[chain.indexOf(upper) - 1]];
    const sideSign = av === "left" ? 1 : -1;   // 只往自己那一側或前後推，不穿過身體到另一邊
    for (let iter = 0; iter < 5; iter++) {
      const Pp = fk();
      const sh = Pp[upper];
      const tip = this.rd[av + "HandFwd"].clone().applyQuaternion(W[hand]).multiplyScalar(handLen).add(Pp[hand]);
      const lerp = (a, b, t) => V().lerpVectors(a, b, t);
      // 先處理手掌、前臂（手在身體前面時把整隻手臂往前帶），沒有穿模才處理上臂（往外側推）
      const distal = [[lerp(Pp[lower], Pp[hand], 0.5), M_ARM], [Pp[hand], M_HAND], [tip, M_HAND]];
      const proximal = [[lerp(sh, Pp[lower], 0.75), M_ARM], [Pp[lower], M_ARM]];
      const shY = V().subVectors(sh, Pp.hips).applyQuaternion(hipsInv).applyMatrix4(B.Minv).y;
      let worst = null;
      for (const group of [distal, proximal]) {
      const isDistal = group === distal;
      for (const [pt, mg] of group) {
        const r = V().subVectors(pt, Pp.hips).applyQuaternion(hipsInv).applyMatrix4(B.Minv);   // 臀部語意座標
        if (!isDistal && r.y > shY - 0.12) continue;   // 上臂靠近肩關節的部分本來就在身體輪廓內，不檢查
        const bi = Math.floor((r.y - B.Y0) / B.STEP); if (bi < 0 || bi >= B.N) continue;
        const e = B.E[bi]; if (!e) continue;
        const a = e.a + mg, b = e.b + mg;
        const dx = r.x - e.cx, dz = r.z - e.cz;
        const val = (dx * dx) / (a * a) + (dz * dz) / (b * b);
        if (val >= 1) continue;
        // 推出方向：橢圓徑向；若徑向朝另一側（手跨到身體另一邊），改成往前推
        let tx, tz;
        const frontZ = e.cz + b * Math.sqrt(Math.max(0, 1 - (dx * dx) / (a * a)));
        if ((isDistal && Math.abs(dx) < 0.7 * a) || (dx * sideSign < 0 && Math.abs(dx) > 0.01)) {
          tx = r.x; tz = frontZ;   // 手在身體前方（或跨到另一側）：直接往前推
        } else {
          const k = 1 / Math.sqrt(Math.max(val, 1e-6)); tx = e.cx + dx * k; tz = e.cz + dz * k;   // 身體側邊、上臂：往外推
        }
        const disp = V(tx - r.x, 0, tz - r.z);
        if (this.debugAvoid) (this.debugAvoid[av] ||= []).push({ iter, r: r.toArray().map((x) => +x.toFixed(3)), e: [e.cx, e.cz, e.a, e.b].map((x) => +x.toFixed(3)), disp: disp.toArray().map((x) => +x.toFixed(3)) });
        const depth = disp.length();
        if (depth > 0.002 && (!worst || depth > worst.depth)) worst = { pt, depth, disp };
      }
      if (worst) break;
      }
      if (!worst) return;
      const to = worst.disp.clone().applyMatrix4(toRig).add(worst.pt);
      const q = aim(V().subVectors(worst.pt, sh), V().subVectors(to, sh));
      for (const n of [upper, lower, hand]) W[n] = q.clone().multiply(W[n]);
      this.target.set(upper, parentW.clone().invert().multiply(W[upper]));
    }
  }

  /** 不更新目標旋轉，只沿用上一次的值並算出世界旋轉（給子骨頭用） */
  _keep(names, parentW, W) {
    let pw = parentW;
    for (const n of names) {
      const t = this.target.get(n) || Q();
      W[n] = pw.clone().multiply(t); pw = W[n];
    }
  }

  /** 校準：把「現在的姿勢」當成角色站正（扣掉鏡頭傾斜、俯仰、人沒正對鏡頭）
   *  world/lm：數幀平均後的身體關鍵點；faceMatrix：臉部矩陣（可無） */
  calibrate(world, lm, faceMatrix, mirror, tposeWorld = null) {
    const s = (p) => V(mirror ? -p.x : p.x, -p.y, -p.z);
    const shL = s(world[P.lSh]), shR = s(world[P.rSh]);
    let shLine = mirror ? V().subVectors(shR, shL) : V().subVectors(shL, shR);
    if (tposeWorld) {
      // T 字：兩手腕的連線比肩線長很多，判斷「水平」與「正對鏡頭」更準（權重 70%）
      const wL = s(tposeWorld[P.lWr]), wR = s(tposeWorld[P.rWr]);
      const arm = mirror ? V().subVectors(wR, wL) : V().subVectors(wL, wR);
      if (arm.length() > 0.3) shLine = shLine.normalize().multiplyScalar(0.3).add(arm.normalize().multiplyScalar(0.7));
    }
    const ok = (i) => (lm[i].visibility ?? 1) > 0.6 && lm[i].x > 0.02 && lm[i].x < 0.98 && lm[i].y > 0.02 && lm[i].y < 0.98;
    let measured;
    if (ok(P.lHip) && ok(P.rHip)) {
      const up = V().addVectors(shL, shR).multiplyScalar(0.5).sub(V().addVectors(s(world[P.lHip]), s(world[P.rHip])).multiplyScalar(0.5));
      measured = frameRot(V(1, 0, 0), V(0, 1, 0), shLine, up);        // 傾斜＋俯仰＋轉向
    } else {
      // 只看得到上半身：用肩線扣掉左右傾斜與轉向，俯仰不動
      const h = shLine.clone(); h.y = 0;
      const yaw = aim(V(1, 0, 0), h.lengthSq() > 1e-6 ? h : V(1, 0, 0));
      const roll = aim(h.lengthSq() > 1e-6 ? h.normalize() : V(1, 0, 0), shLine.clone().normalize());
      measured = roll.multiply(yaw);
    }
    this.calQ = measured.invert();
    if (faceMatrix) {
      const q = Q().setFromRotationMatrix(new THREE.Matrix4().fromArray(faceMatrix));
      if (mirror) { q.y = -q.y; q.z = -q.z; }
      this.faceCalQ = q.invert();
    } else this.faceCalQ = null;
    this.calMirror = mirror;
  }
  clearCalibration() { this.calQ = null; this.faceCalQ = null; }

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
    const calQ = this.calQ;
    const cv = (p) => { const v = V((mirror ? -p.x : p.x) * sx, -p.y, -p.z * (hand.world ? 1 : sx)); if (calQ) v.applyQuaternion(calQ); return this.sem(v); };
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
