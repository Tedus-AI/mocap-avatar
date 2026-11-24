/* =====================================================================
   tracker.js — MediaPipe Tasks Vision：身體 / 手 / 臉
   依裝置效能分級，手機自動降低負載
   ===================================================================== */
import { LandmarkFilter } from "./filters.js?v=__BUILD_VERSION__";
export const TV_VER = "0.10.14";
const TV_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VER}`;
const MODELS = {
  poseLite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  poseFull: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  poseHeavy: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
  hand: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
};

/** 效能等級：每幾幀跑一次手／臉 */
export const TIERS = {
  low:  { label: "省電",  pose: "poseLite",  handEvery: 2, faceEvery: 3 },
  mid:  { label: "平衡",  pose: "poseFull",  handEvery: 1, faceEvery: 2 },
  high: { label: "高品質", pose: "poseHeavy", handEvery: 1, faceEvery: 1 },
};
export function autoTier() {
  const ua = navigator.userAgent;
  const isPhone = /iPhone|Android.+Mobile/.test(ua);
  const isTablet = /iPad/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)) || /Android/.test(ua) && !isPhone;
  if (isPhone) return "low";
  if (isTablet) return "mid";
  return "mid";
}

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + " 逾時，請檢查網路後重試")), ms); })])
    .finally(() => clearTimeout(t));
}

export class Tracker {
  constructor() {
    this.vision = null; this.fileset = null;
    this.pose = null; this.hand = null; this.face = null;
    this.tier = "mid"; this.useHands = true; this.useFace = true;
    this.n = 0; this.lastTs = 0;
    this.last = { pose: null, hands: {}, face: null };
    this.delegate = "GPU";
    this.lockOn = true; this.lock = null;   // 鎖定主角：{c:[x,y], s, t}
    // One Euro 濾波：身體（世界座標＋畫面座標）、左右手
    this.fWorld = new LandmarkFilter(); this.fLm = new LandmarkFilter();
    this.fHand = { L: [new LandmarkFilter(), new LandmarkFilter()], R: [new LandmarkFilter(), new LandmarkFilter()] };
    this.setSmooth(45);
  }

  /** 平滑度 0~100 → 濾波參數（越大越穩、反應略慢） */
  setSmooth(v) {
    // 預設 45 時＝XR Animator 的參數（minCutoff 1、beta 1、dCutoff 2，見其 mocap_lib_module.js）
    const minCutoff = Math.pow(2.5, (45 - v) / 45);   // 0→2.5Hz、45→1Hz、100→0.33Hz
    for (const f of [this.fWorld, this.fLm, ...this.fHand.L, ...this.fHand.R]) f.setParams(minCutoff, 1.0, 2.0);
  }

  async _lib() {
    if (!this.vision) this.vision = await withTimeout(import(`${TV_BASE}/vision_bundle.mjs`), 25000, "載入追蹤程式庫");
    if (!this.fileset) this.fileset = await withTimeout(this.vision.FilesetResolver.forVisionTasks(`${TV_BASE}/wasm`), 25000, "載入 WASM");
  }

  async _create(kind, make) {
    // GPU 失敗就改 CPU 重試一次
    try { return await withTimeout(make(this.delegate), 45000, `載入${kind}模型`); }
    catch (e) {
      if (this.delegate === "CPU") throw e;
      console.warn(kind, "GPU 失敗，改用 CPU", e);
      this.delegate = "CPU";
      return await withTimeout(make("CPU"), 45000, `載入${kind}模型`);
    }
  }

  /** 依目前設定載入需要的模型；onStep(文字) 回報進度 */
  async init({ tier, useHands, useFace }, onStep = () => {}) {
    this.tier = tier; this.useHands = useHands; this.useFace = useFace;
    onStep("載入追蹤程式庫…");
    await this._lib();
    const V = this.vision, fs = this.fileset;
    const poseModel = TIERS[tier].pose;
    const numPoses = tier === "low" ? 1 : 2;   // 手機省電：只偵測 1 人，靠「跳動排除」鎖定；其他：偵測 2 人挑主角
    if (!this.pose || this._poseModel !== poseModel || this._numPoses !== numPoses) {
      onStep(`載入身體追蹤模型（${{ poseLite: "輕量", poseFull: "標準", poseHeavy: "高精度，約 30MB" }[poseModel]}）…`);
      this.pose?.close?.();
      this.pose = await this._create("身體", (d) => V.PoseLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: MODELS[poseModel], delegate: d },
        runningMode: "VIDEO", numPoses,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      }));
      this._poseModel = poseModel; this._numPoses = numPoses;
    }
    if (useHands && !this.hand) {
      onStep("載入手部追蹤模型…");
      this.hand = await this._create("手部", (d) => V.HandLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: MODELS.hand, delegate: d },
        runningMode: "VIDEO", numHands: 2,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      }));
    }
    if (useFace && !this.face) {
      onStep("載入臉部追蹤模型…");
      this.face = await this._create("臉部", (d) => V.FaceLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: MODELS.face, delegate: d },
        runningMode: "VIDEO", numFaces: 2,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      }));
    }
  }

  setOptions({ tier, useHands, useFace }) {
    if (tier) this.tier = tier;
    if (useHands !== undefined) { this.useHands = useHands; if (!useHands) this.last.hands = {}; }
    if (useFace !== undefined) { this.useFace = useFace; if (!useFace) this.last.face = null; }
  }

  /** 每幀呼叫；回傳最新結果（手/臉沒跑的幀沿用上次） */
  /** src 可以是 <video> 或已旋轉的 <canvas>；w/h 為其像素尺寸 */
  detect(video, w = video.videoWidth, h = video.videoHeight) {
    if (!this.pose || !w || (video.readyState !== undefined && video.readyState < 2)) return null;
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    const tier = TIERS[this.tier];
    const n = this.n++;
    const aspect = w / h;

    const pr = this.pose.detectForVideo(video, ts);
    const t = ts / 1000;
    const cands = (pr.landmarks || []).map((lm, i) => ({ lm, world: pr.worldLandmarks[i], ...torsoStats(lm, aspect) }));
    const chosen = this._pickSubject(cands, t);
    let pose;
    if (chosen) pose = { lm: this.fLm.apply(chosen.lm, t), world: this.fWorld.apply(chosen.world, t) };
    else if (this.last.pose && this.lock && t - this.lock.t < 0.6) pose = this.last.pose;   // 被排除的幀：短暫沿用上一個姿勢
    else pose = null;
    this.last.pose = pose;

    if (this.useHands && this.hand && n % tier.handEvery === 0) {
      const hr = this.hand.detectForVideo(video, ts);
      const hs = assignHands(hr, pose, aspect);
      for (const k of ["L", "R"]) if (hs[k]) {
        hs[k].world = this.fHand[k][0].apply(hs[k].world, t);
        hs[k].lm = this.fHand[k][1].apply(hs[k].lm, t);
      }
      this.last.hands = hs;
    }
    if (this.useFace && this.face && n % tier.faceEvery === 0) {
      const fr = this.face.detectForVideo(video, ts);
      if (fr.faceLandmarks?.length) {
        // 有好幾張臉（海報、旁人）時，選鼻尖最接近主角身體鼻子的那張
        let fi = 0;
        if (fr.faceLandmarks.length > 1 && pose) {
          const nx = pose.lm[0].x, ny = pose.lm[0].y;
          let bd = Infinity;
          fr.faceLandmarks.forEach((f, i) => { const d = Math.hypot(f[1].x - nx, f[1].y - ny); if (d < bd) { bd = d; fi = i; } });
        }
        const blend = {};
        for (const c of fr.faceBlendshapes?.[fi]?.categories || []) blend[c.categoryName] = c.score;
        this.last.face = { blend, matrix: fr.facialTransformationMatrixes?.[fi]?.data, lm: fr.faceLandmarks[fi] };
      } else this.last.face = null;
    }
    return { pose, hands: this.last.hands, face: this.useFace ? this.last.face : null, aspect };
  }

  /** 鎖定主角：從候選人中挑出跟上一幀同一個人；突然跳很遠的視為抓錯，排除 */
  _pickSubject(cands, t) {
    if (!cands.length) return null;
    if (!this.lockOn) return cands[0];
    const L = this.lock;
    const largest = () => cands.reduce((a, b) => (b.s > a.s ? b : a));
    // 還沒鎖定，或已經 1.5 秒沒看到主角 → 鎖定畫面中最大（最近）的人
    if (!L || t - L.t > 1.5) {
      const c = largest(); this.lock = { c: c.c, s: c.s, t, jumps: 0 }; return c;
    }
    const dt = Math.max(0.001, t - L.t);
    let best = null;
    for (const c of cands) {
      let d = Math.hypot(c.c[0] - L.c[0], c.c[1] - L.c[1]) / L.s;
      const ratio = c.s / L.s; if (ratio > 1.6 || ratio < 0.6) d += 1;   // 大小突然變很多
      if (!best || d < best.d) best = { ...c, d };
    }
    // 容許的移動量：基本 0.6 個身體大小，隔越久放寬（每秒 3 個），最多 1.5（避免旁邊的人搶走鎖定）
    if (best.d <= 0.6 + Math.min(3 * dt, 0.9)) {
      L.c = best.c;                       // 中心直接跟著主角（平滑會落後，快速動作時誤判）
      L.s += (best.s - L.s) * 0.3; L.t = t;
      return best;
    }
    this.rejected = (this.rejected || 0) + 1;
    return null;
  }
  relock() { this.lock = null; }

  /** 只跑一次身體偵測，判斷人是不是「站正」的（自動判斷畫面旋轉用） */
  uprightScore(src) {
    // 用獨立的「單張圖片」模型：影片模式會沿用上一幀的追蹤位置，換方向後會找不到人
    if (!this.poseImg) {
      if (!this._poseImgP && this.vision) {
        this._poseImgP = this._create("方向判斷", (d) => this.vision.PoseLandmarker.createFromOptions(this.fileset, {
          baseOptions: { modelAssetPath: MODELS.poseLite, delegate: d }, runningMode: "IMAGE", numPoses: 1,
        })).then((m) => { this.poseImg = m; }).catch((e) => { console.warn(e); this._poseImgP = null; });
      }
      return undefined;   // 模型還在載入
    }
    const r = this.poseImg.detect(src);
    const lm = r.landmarks?.[0]; if (!lm) return null;
    const shY = (lm[11].y + lm[12].y) / 2, hipY = (lm[23].y + lm[24].y) / 2;
    // 頭在肩膀上方、肩膀在臀部上方 → 正
    return (shY - lm[0].y) + (hipY - shY) * 0.5;
  }
}

/** 軀幹中心與大小（畫面座標，x 乘上長寬比） */
function torsoStats(lm, aspect) {
  const sx = (lm[11].x + lm[12].x) / 2 * aspect, sy = (lm[11].y + lm[12].y) / 2;
  const hx = (lm[23].x + lm[24].x) / 2 * aspect, hy = (lm[23].y + lm[24].y) / 2;
  const sw = Math.hypot((lm[11].x - lm[12].x) * aspect, lm[11].y - lm[12].y);
  return { c: [(sx + hx) / 2, (sy + hy) / 2], s: Math.max(Math.hypot(sx - hx, sy - hy), sw, 0.02) };
}

/** 把偵測到的手分配給「人的左手 L / 右手 R」：以手腕位置對 Pose 手腕最近者為準 */
function assignHands(hr, pose, aspect) {
  const out = {};
  const hs = hr.landmarks || [];
  for (let i = 0; i < hs.length; i++) {
    const lm = hs[i], wr = lm[0];
    let side;
    if (pose) {
      const L = pose.lm[15], R = pose.lm[16];
      const dL = Math.hypot((wr.x - L.x) * aspect, wr.y - L.y), dR = Math.hypot((wr.x - R.x) * aspect, wr.y - R.y);
      side = dL < dR ? "L" : "R";
      if (Math.min(dL, dR) > 0.25) continue;   // 離手腕太遠，可能是別人的手
    } else {
      // MediaPipe 的左右標籤假設畫面已鏡像 → 對未鏡像影像要反過來
      side = hr.handednesses?.[i]?.[0]?.categoryName === "Left" ? "R" : "L";
    }
    if (out[side]) continue;
    out[side] = { lm, world: hr.worldLandmarks?.[i], aspect };
  }
  return out;
}
