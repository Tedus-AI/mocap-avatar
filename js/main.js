/* =====================================================================
   main.js — 介面、狀態、主迴圈
   ===================================================================== */
import { AvatarStage } from "./avatar.js?v=__BUILD_VERSION__";
import { Tracker, TIERS, autoTier } from "./tracker.js?v=__BUILD_VERSION__";
import { hostRoom, joinRoom } from "./pairing.js?v=__BUILD_VERSION__";
import { MODELS, DEFAULT_MODEL } from "./models.js?v=__BUILD_VERSION__";
import qrcode from "../vendor/qrcode.mjs";

const VERSION = "__BUILD_VERSION__";   // 由 CI 自動蓋上，請勿手改
const IS_DEV = VERSION.startsWith("__");
const STORE_KEY = "mocapavatar.v1";
const $ = (id) => document.getElementById(id);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- 狀態（存在這台裝置） ---------------- */
const DEFAULTS = {
  mode: "upper", src: "local", facing: "user", mirror: true,
  useFace: true, useHands: true, tier: autoTier(), smooth: 45,
  showPip: true, showSkel: true, bg: "studio", model: DEFAULT_MODEL,
  rot: "auto",          // 畫面旋轉："auto" 或 0/90/180/270
  split: false,         // 分割畫面：左角色／右鏡頭
};
const S = { ...DEFAULTS };
function load() {
  try { Object.assign(S, JSON.parse(localStorage.getItem(STORE_KEY) || "{}")); } catch (e) {}
  if (!TIERS[S.tier]) S.tier = autoTier();
  S.rot = "auto";   // 手動旋轉只在這次使用有效，不保存（避免下次打開還是轉錯）
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) {} }
load();

/* ---------------- IndexedDB：自訂角色 / 背景圖 ---------------- */
const idb = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open("mocapavatar", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction("kv", mode); const q = fn(t.objectStore("kv")); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); };
  return {
    get: (k) => tx("readonly", (s) => s.get(k)).catch(() => null),
    set: (k, v) => tx("readwrite", (s) => s.put(v, k)).catch((e) => { console.warn(e); }),
    del: (k) => tx("readwrite", (s) => s.delete(k)).catch(() => {}),
  };
})();

/* ---------------- 元件 ---------------- */
const canvas = $("stage");
const stage = new AvatarStage(canvas);
const tracker = new Tracker();
const video = $("cam");
let stream = null, running = false, host = null, fileUrl = null;
let lastFrame = null, noPersonSince = 0, fpsN = 0, fpsT = performance.now();
let modelBusy = false;
let pipKey = "";   // 小畫面版面快取鍵（resize 時清空）

function resize() { const r = canvas.getBoundingClientRect(); stage.resize(Math.max(1, r.width), Math.max(1, r.height)); pipKey = ""; }
window.addEventListener("resize", resize);
resize();

/* ---------------- 提示 ---------------- */
let toastTimer;
function toast(msg, { err = false, ms = 3500, action } = {}) {
  const t = $("toast");
  t.innerHTML = esc(msg) + (action ? ` <button id="toastAct">${esc(action.label)}</button>` : "");
  t.classList.toggle("err", err); t.classList.add("on");
  t.style.pointerEvents = action ? "auto" : "none";
  if (action) $("toastAct").onclick = () => { t.classList.remove("on"); action.fn(); };
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.remove("on"), ms);
}
function pill(kind, text) {
  const p = $("statusPill"); p.className = "pill " + kind; p.querySelector("span").textContent = text;
}

/* ---------------- 角色 ---------------- */
async function loadModel(id, { silent = false } = {}) {
  if (modelBusy) return;
  modelBusy = true;
  const card = $$(`.mcard[data-id="${id}"]`)[0]; card?.classList.add("loading");
  const prevPill = $("statusPill").className;
  try {
    if (id === "my") {
      const rec = await idb.get("myVrm");
      if (!rec) throw new Error("找不到之前載入的角色");
      pill("busy", "載入角色…");
      await stage.load(rec.buf);
    } else {
      const m = MODELS.find((x) => x.id === id) || MODELS[0];
      id = m.id;
      pill("busy", `下載角色 ${m.name}（${m.mb}MB）…`);
      await stage.load(m.file + "?v=" + VERSION, (p) => pill("busy", `下載角色 ${m.name} ${Math.round(p * 100)}%`));
    }
    S.model = id; save(); renderModels();
    if (!silent) toast("已換成新角色");
  } catch (e) {
    console.error(e);
    toast("角色載入失敗：" + (e.message || e), { err: true });
    if (id !== DEFAULT_MODEL && !stage.vrm) { modelBusy = false; return loadModel(DEFAULT_MODEL); }
  } finally {
    modelBusy = false; card?.classList.remove("loading");
    if (!running) pill("idle", "尚未開始"); else $("statusPill").className = prevPill;
  }
}
async function renderModels() {
  $("modelGrid").innerHTML = MODELS.map((m) => `
    <button class="mcard ${S.model === m.id ? "on" : ""}" data-id="${m.id}" title="${esc(m.license)}・${esc(m.by)}">
      <img src="assets/thumbs/${m.id}.jpg?v=${VERSION}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <b>${esc(m.name)}</b><small>${m.mb}MB・${esc(m.license.split("（")[0])}</small></button>`).join("");
  const rec = await idb.get("myVrm");
  $("myModel").innerHTML = rec
    ? `<button class="mcard ${S.model === "my" ? "on" : ""}" data-id="my"><img alt="" src="${rec.thumb || ""}" onerror="this.style.visibility='hidden'">
        <b>${esc(rec.name)}</b><small>${Math.round(rec.buf.byteLength / 1048576)}MB・自訂</small>
        <span class="del" role="button" data-del="1" aria-label="移除">✕</span></button>`
    : `<p class="empty">還沒有載入自己的角色</p>`;
}
$("modelGrid").addEventListener("click", (e) => { const b = e.target.closest(".mcard"); if (b) loadModel(b.dataset.id); });
$("myModel").addEventListener("click", async (e) => {
  if (e.target.closest("[data-del]")) {
    if (!confirm("從這台裝置移除這個自訂角色？")) return;
    await idb.del("myVrm");
    if (S.model === "my") await loadModel(DEFAULT_MODEL, { silent: true });
    renderModels(); return;
  }
  const b = e.target.closest(".mcard"); if (b) loadModel("my");
});
$("btnLoadVrm").onclick = () => $("fileVrm").click();
$("fileVrm").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const buf = await f.arrayBuffer();
  try {
    pill("busy", "載入角色…");
    await stage.load(buf.slice(0));
    await idb.set("myVrm", { name: f.name.replace(/\.vrm$/i, ""), buf });
    S.model = "my"; save(); renderModels(); toast("已載入你的角色，下次會自動使用");
  } catch (err) { toast("無法載入：" + (err.message || err), { err: true }); }
  finally { if (!running) pill("idle", "尚未開始"); }
};

/* ---------------- 背景 ---------------- */
async function applyBg() {
  const bg = $("bg"); bg.className = ""; bg.style.backgroundImage = "";
  if (S.bg === "image") {
    const blob = await idb.get("bgImage");
    if (blob) { bg.className = "image"; bg.style.backgroundImage = `url(${URL.createObjectURL(blob)})`; }
  } else if (S.bg !== "studio") bg.className = S.bg;
  $$("#bgSwatches button").forEach((b) => b.classList.toggle("on", b.dataset.bg === S.bg));
}
$("bgSwatches").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.bg === "image") return $("fileBg").click();
  S.bg = b.dataset.bg; save(); applyBg();
});
$("fileBg").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  await idb.set("bgImage", f); S.bg = "image"; save(); applyBg();
};

/* ---------------- 面板開關 ---------------- */
let openSheet = null;
function showSheet(id) {
  if (openSheet) $(openSheet).classList.remove("on");
  openSheet = id;
  if (id) { $(id).classList.add("on"); $(id).setAttribute("aria-hidden", "false"); }
  $("scrim").classList.toggle("on", !!id);
  $$(".dk[data-sheet]").forEach((b) => b.classList.toggle("on", b.dataset.sheet === id));
  if (id === "sheetAvatar") renderModels();
}
$$("[data-sheet]").forEach((b) => b.addEventListener("click", () => showSheet(openSheet === b.dataset.sheet ? null : b.dataset.sheet)));
$$("[data-close]").forEach((b) => b.addEventListener("click", () => showSheet(null)));
$("scrim").onclick = () => showSheet(null);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") showSheet(null); });

/* ---------------- 設定 ---------------- */
function syncUI() {
  $$(".dock .seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
  $$("#startMode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
  $$("#srcChoices .choice").forEach((b) => b.classList.toggle("on", b.dataset.src === S.src));
  $$("#startFacing button").forEach((b) => b.classList.toggle("on", b.dataset.facing === S.facing));
  $("facingRow").classList.toggle("hidden", S.src !== "local");
  $("optFace").checked = S.useFace; $("optHands").checked = S.useHands; $("optMirror").checked = S.mirror;
  $("optPip").checked = S.showPip; $("optSkel").checked = S.showSkel; $("optSmooth").value = S.smooth;
  $$("#segTier button").forEach((b) => b.classList.toggle("on", b.dataset.tier === S.tier));
  $("tierHint").textContent = `${TIERS[S.tier].label}：` + ({ low: "手機建議：輕量身體模型，臉和手隔幀更新", mid: "平板／電腦建議：標準身體模型", high: "最精準的身體模型，需要有獨立顯卡的電腦" })[S.tier];
  const sp = !!S.split && running;   // 只在動捕進行中才分割
  if (document.body.classList.contains("split") !== sp) { document.body.classList.toggle("split", sp); requestAnimationFrame(resize); }
  $("optSplit").checked = !!S.split; $("btnSplit").classList.toggle("on", !!S.split);
  $("pip").classList.toggle("hidden", !(running && (S.showPip || S.split)));
  $("pip").classList.toggle("mirror", S.mirror);
  $("btnFlip").disabled = !(running && (S.src === "local" || S.src === "phone"));
  $$("#segRot button").forEach((b) => b.classList.toggle("on", b.dataset.rot === String(S.rot)));
  $("verTxt").textContent = IS_DEV ? "開發版" : VERSION;
}
function setMode(m) { S.mode = m; save(); stage.frame(m); syncUI(); }
$$(".dock .seg button, #startMode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$$("#srcChoices .choice").forEach((b) => b.addEventListener("click", () => { S.src = b.dataset.src; save(); syncUI(); }));
$$("#startFacing button").forEach((b) => b.addEventListener("click", () => { S.facing = b.dataset.facing; S.mirror = S.facing === "user"; save(); syncUI(); }));
$("optMirror").onchange = (e) => { S.mirror = e.target.checked; save(); syncUI(); };
$("optPip").onchange = (e) => { S.showPip = e.target.checked; save(); syncUI(); };
function setSplit(on) { S.split = on; save(); syncUI(); resize(); stage.frame(S.mode, true); }
$("optSplit").onchange = (e) => setSplit(e.target.checked);
$("btnSplit").onclick = () => setSplit(!S.split);
$("optSkel").onchange = (e) => { S.showSkel = e.target.checked; save(); clearOverlay(); };
$("optSmooth").oninput = (e) => { S.smooth = +e.target.value; tracker.setSmooth(S.smooth); save(); };
$("optFace").onchange = (e) => { S.useFace = e.target.checked; save(); applyTracking(); };
$("optHands").onchange = (e) => { S.useHands = e.target.checked; save(); applyTracking(); };
$("segTier").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.tier = b.dataset.tier; save(); syncUI(); applyTracking(); });
async function applyTracking() {
  tracker.setOptions({ tier: S.tier, useFace: S.useFace, useHands: S.useHands });
  if (!running) return;
  try { pill("busy", "更新追蹤設定…"); await tracker.init({ tier: S.tier, useFace: S.useFace, useHands: S.useHands }, (t) => pill("busy", t)); }
  catch (e) { toast("載入模型失敗：" + e.message, { err: true }); }
}
$("pipToggle").onclick = () => { $("pip").classList.toggle("small"); pipKey = ""; };
$("segRot").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  S.rot = b.dataset.rot === "auto" ? "auto" : +b.dataset.rot; save(); resetAutoRot(); syncUI();
});
$("pipRotate").onclick = () => {
  S.rot = (curRot() + 90) % 360; syncUI();
  toast(`畫面已手動旋轉為 ${S.rot}°。手機重新連線或轉向時會回到自動`);
};
$("btnView").onclick = () => stage.frame(S.mode);
$("btnFlip").onclick = async () => {
  if (S.src === "phone") {   // 手機當鏡頭：請手機切換前後鏡頭
    if (!host?.conn?.open) { toast("手機還沒連上", { err: true }); return; }
    host.send({ type: "flip" }); toast("已請手機切換鏡頭"); return;
  }
  S.facing = S.facing === "user" ? "environment" : "user"; S.mirror = S.facing === "user"; save();
  try { await startCamera(); syncUI(); toast(S.facing === "user" ? "已切到前鏡頭（鏡像開啟）" : "已切到後鏡頭（鏡像關閉）"); }
  catch (e) { toast(camError(e), { err: true }); }
};
const fsOK = document.fullscreenEnabled || document.webkitFullscreenEnabled;
if (!fsOK) $("btnFull").classList.add("hidden");
$("btnFull").onclick = () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen).call(document.documentElement);
};
$("btnRestart").onclick = () => { stopAll(); showSheet(null); $("start").classList.remove("hidden"); pill("idle", "尚未開始"); };

/* ---------------- 鏡頭 ---------------- */
function camError(e) {
  const n = e?.name || "";
  const ios = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  if (n === "NotAllowedError") return ios ? "鏡頭權限被拒絕：請到 iPhone「設定 › Safari › 相機」改成「允許」，再重新整理網頁。" : "鏡頭權限被拒絕：請點網址列左邊的圖示允許使用相機，再重新整理。";
  if (n === "NotFoundError" || n === "OverconstrainedError") return "找不到這個鏡頭。";
  if (n === "NotReadableError") return "鏡頭被其他 App 佔用中，請先關掉其他使用相機的程式。";
  return e?.message || String(e);
}
async function getCam(facing) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("這個瀏覽器不支援鏡頭（需要 HTTPS 網址）");
  // 直放時要直向畫面（全身才拍得到腳）
  const portrait = innerHeight > innerWidth && navigator.maxTouchPoints > 0;
  return navigator.mediaDevices.getUserMedia({ audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: portrait ? 720 : 1280 }, height: { ideal: portrait ? 1280 : 720 }, frameRate: { ideal: 30, max: 30 } } });
}

/* ---------------- 畫面旋轉：手機直放但傳來的影像沒轉正時，自動轉回來 ---------------- */
const srcCanvas = $("srcCanvas"), sctx = srcCanvas.getContext("2d");
const testCanvas = document.createElement("canvas"), tctx = testCanvas.getContext("2d");
let remoteInfo = null;                         // 手機回報 {portrait, facing, w, h}
let autoRot = 0, autoKey = "", autoLocked = false, autoLastTry = 0;
const curRot = () => (S.rot === "auto" ? autoRot : +S.rot) || 0;
function resetAutoRot() { autoKey = ""; autoLocked = false; }
function drawRot(ctx, r, vw, vh) {
  ctx.save();
  if (r === 90) { ctx.translate(vh, 0); ctx.rotate(Math.PI / 2); }
  else if (r === 180) { ctx.translate(vw, vh); ctx.rotate(Math.PI); }
  else if (r === 270) { ctx.translate(0, vw); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(video, 0, 0, vw, vh);
  ctx.restore();
}
/** 目前要餵給追蹤與小畫面的影像（必要時先旋轉） */
function sourceFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const r = curRot();
  if (!r) return { el: video, w: vw, h: vh, rot: 0 };
  const sw = r % 180 ? vh : vw, sh = r % 180 ? vw : vh;
  if (srcCanvas.width !== sw || srcCanvas.height !== sh) { srcCanvas.width = sw; srcCanvas.height = sh; }
  drawRot(sctx, r, vw, vh);
  return { el: srcCanvas, w: sw, h: sh, rot: r };
}
let upsideSince = 0;
/** 軀幹與「向上」的夾角：0°＝站正、180°＝上下顛倒（以目前送去追蹤的畫面為準） */
function torsoAngle(lm) {
  const dx = (lm[11].x + lm[12].x - lm[23].x - lm[24].x) / 2, dy = (lm[11].y + lm[12].y - lm[23].y - lm[24].y) / 2;
  const len = Math.hypot(dx, dy); if (len < 1e-4) return 0;
  return Math.acos(Math.max(-1, Math.min(1, -dy / len))) * 57.3;
}
/** 對原始影像試幾個旋轉角，回傳人「最站正」的那個；模型載入中回傳 undefined */
function testRotations(cands) {
  const vw = video.videoWidth, vh = video.videoHeight;
  let best = null;
  for (const r of cands) {
    testCanvas.width = r % 180 ? vh : vw; testCanvas.height = r % 180 ? vw : vh;
    drawRot(tctx, r, vw, vh);
    const sc = tracker.uprightScore(testCanvas);
    if (sc === undefined) return undefined;
    if (sc !== null && (!best || sc > best.sc)) best = { r, sc };
  }
  return best;
}
function updateAutoRot() {
  if (S.rot !== "auto") return;
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
  const now = performance.now();
  // A. 手機回報直放／橫放，但收到的影像方向不符 → 試 90°/270°
  const key = `${vw}x${vh}|${remoteInfo?.portrait}|${remoteInfo?.facing}`;
  const mismatch = !!remoteInfo && remoteInfo.portrait !== (vh > vw) && Math.abs(vw - vh) > 8;
  if (key !== autoKey) { autoKey = key; autoLocked = false; upsideSince = 0; autoRot = mismatch ? 90 : 0; }
  if (mismatch && !autoLocked && now - autoLastTry > 800) {
    autoLastTry = now;
    const best = testRotations([90, 270]);
    if (best && best.sc > 0.04) { autoRot = best.r; autoLocked = true; toast(`偵測到手機直放，畫面已自動轉正（${best.r}°）`); }
    return;
  }
  // B. 任何來源：人持續上下顛倒超過 1.2 秒 → 四個方向都試，選站正的
  const p = tracker.last.pose;
  const ok = p && [11, 12, 23, 24].every((i) => (p.lm[i].visibility ?? 1) > 0.5);
  if (ok && torsoAngle(p.lm) > 120) upsideSince ||= now; else upsideSince = 0;
  if (upsideSince && now - upsideSince > 1200 && now - autoLastTry > 800) {
    autoLastTry = now;
    const best = testRotations([0, 90, 180, 270]);
    if (best === undefined) return;
    if (best && best.sc > 0.04 && best.r !== autoRot) {
      autoRot = best.r; autoLocked = true; upsideSince = 0;
      toast(`偵測到畫面上下顛倒，已自動轉正（${best.r}°）`);
    }
  }
}

/* ---------------- 小畫面尺寸跟著影像比例 ---------------- */
function layoutPip(w, h, rot) {
  const p = $("pip"), small = p.classList.contains("small");
  const key = `${w}x${h}|${small}|${innerWidth}x${innerHeight}|${rot}|${S.split}|${S.rot}`;
  if (key === pipKey) return; pipKey = key;
  $("cam").classList.toggle("hidden", !!rot);
  srcCanvas.classList.toggle("hidden", !rot);
  $("pipInfo").textContent = `${h > w ? "直向" : "橫向"} ${w}×${h}${rot ? `・${S.rot === "auto" ? "自動" : "手動"}轉 ${rot}°` : ""}`;
  if (S.split) { p.style.width = ""; p.style.aspectRatio = ""; return; }   // 分割畫面：交給 CSS
  const phone = matchMedia("(max-width:560px)").matches;
  const low = matchMedia("(max-height:500px) and (orientation:landscape)").matches;
  let maxW = phone ? 140 : low ? 170 : 260, maxH = phone ? 200 : low ? 150 : 320;
  if (small) { maxW *= 0.55; maxH *= 0.55; }
  p.style.width = Math.round(Math.min(maxW, maxH * w / h)) + "px";
  p.style.aspectRatio = `${w} / ${h}`;
}
async function startCamera() {
  stopStream();
  stream = await getCam(S.facing);
  video.srcObject = stream; video.muted = true;
  await video.play();
}
function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; video.srcObject = null;
  if (fileUrl) { URL.revokeObjectURL(fileUrl); fileUrl = null; video.removeAttribute("src"); }
}
function stopAll() {
  remoteInfo = null; resetAutoRot();
  running = false; stopStream(); host?.close(); host = null; releaseWake(); syncUI(); clearOverlay();
}

/* ---------------- 開始 ---------------- */
function startStatus(msg, err = false) { const s = $("startStatus"); s.textContent = msg; s.classList.toggle("err", err); }
async function beginTracking() {
  await tracker.init({ tier: S.tier, useFace: S.useFace, useHands: S.useHands }, (t) => { startStatus(t); pill("busy", t); $("pairStatus").textContent = t; });
  running = true; noPersonSince = performance.now();
  $("start").classList.add("hidden"); $("pairHost").classList.add("hidden");
  stage.frame(S.mode); syncUI(); requestWake();
  pill("warn", "尋找人物中…");
  toast(S.mode === "upper" ? "坐在鏡頭前約 1 公尺，讓頭、肩膀和雙手入鏡" : "退到 2～3 公尺，讓全身入鏡", { ms: 5000 });
}
$("btnGo").onclick = async () => {
  const btn = $("btnGo"); btn.disabled = true;
  try {
    if (S.src === "local") {
      startStatus("開啟鏡頭中…（請按「允許」）");
      await startCamera();
      await beginTracking();
    } else if (S.src === "file") {
      $("fileVideo").click();
    } else {
      await startPairing();
    }
  } catch (e) {
    console.error(e);
    startStatus(camError(e), true); pill("err", "開始失敗");
    btn.textContent = "重試";
  } finally { btn.disabled = false; }
};
$("fileVideo").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    stopStream();
    fileUrl = URL.createObjectURL(f);
    video.srcObject = null; video.src = fileUrl; video.loop = true; video.muted = true;
    await video.play();
    S.mirror = false; save();
    await beginTracking();
  } catch (err) { startStatus("影片無法播放：" + (err.message || err), true); }
};

/* ---------------- 手機當鏡頭（電腦端） ---------------- */
async function startPairing() {
  if (!window.Peer) throw new Error("配對元件還沒載入完成，請稍等一下再按一次");
  $("start").classList.add("hidden"); $("pairHost").classList.remove("hidden");
  $("pairStatus").textContent = "建立配對中…";
  try {
    host = await hostRoom({
      onState: (s) => { $("pairStatus").textContent = { connecting: "手機連線中…", connected: "已連線！", closed: "手機已斷線" }[s] || s;
        if (s === "closed" && running) { pill("err", "手機已斷線"); toast("手機斷線了，請在手機上重新按「開始傳送」", { err: true, ms: 8000 }); } },
      onStream: async (s) => {
        stream = s; video.srcObject = s; video.muted = true;
        try { await video.play(); } catch (e) {}
        S.mirror = remoteInfo ? remoteInfo.facing === "user" : S.mirror; S.rot = "auto"; save(); resetAutoRot();
        if (!running) { try { await beginTracking(); } catch (e) { $("pairStatus").textContent = e.message; } }
        else { pill("warn", "尋找人物中…"); toast("手機重新連上了"); }
      },
      onData: (d) => {
        if (d?.type !== "info") return;
        const facingChanged = d.facing !== remoteInfo?.facing;
        if (remoteInfo && d.portrait !== remoteInfo.portrait) S.rot = "auto";   // 手機轉向了：手動旋轉失效
        remoteInfo = d;
        if (facingChanged) { S.mirror = d.facing === "user"; save(); }   // 前鏡頭＝鏡像
        resetAutoRot(); syncUI();
      },
    });
  } catch (e) {
    $("pairHost").classList.add("hidden"); $("start").classList.remove("hidden");
    throw e;
  }
  const url = new URL(location.href); url.search = ""; url.hash = ""; url.searchParams.set("pair", host.code);
  $("pairCode").textContent = host.code;
  $("pairUrl").textContent = url.toString().replace(/\?pair=\d+$/, "");
  const qr = qrcode(0, "M"); qr.addData(url.toString()); qr.make();
  $("qr").innerHTML = qr.createImgTag(6, 0);
  $("pairStatus").textContent = "等待手機連線…（手機和電腦最好連同一個 Wi-Fi）";
  // 等待時先載入 AI 模型，連上就能馬上開始
  tracker.init({ tier: S.tier, useFace: S.useFace, useHands: S.useHands }).catch(() => {});
}
$("btnPairCancel").onclick = () => { host?.close(); host = null; $("pairHost").classList.add("hidden"); $("start").classList.remove("hidden"); };

/* ---------------- 手機端：鏡頭模式（網址帶 ?pair=，或開始畫面按「這支手機要當鏡頭」） ---------------- */
const pairParam = new URLSearchParams(location.search).get("pair");
let camLink = null, camFacing = "environment", camStream = null, camSetup = false, barTimer = null;
function camSay(msg) { $("camStatus").textContent = msg; }
function showCamCard(on) {            // 大卡片（輸入配對碼）只在還沒連線時出現
  $("camUi").classList.toggle("hidden", !on);
  if (on) { $("camBar").classList.add("hidden"); $("camChip").classList.add("hidden"); clearTimeout(barTimer); }
}
function showCamBar() {               // 傳送中：頂端細列，3 秒後收成角落小圓點
  $("camChip").classList.add("hidden"); $("camBar").classList.remove("hidden");
  clearTimeout(barTimer); barTimer = setTimeout(hideCamBar, 3000);
}
function hideCamBar() { $("camBar").classList.add("hidden"); $("camChip").classList.remove("hidden"); }
function camInfo() {
  const st = camStream?.getVideoTracks()[0]?.getSettings?.() || {};
  return { type: "info", portrait: innerHeight > innerWidth, facing: camFacing, w: st.width || 0, h: st.height || 0 };
}
function sendCamInfo() {
  camLink?.send(camInfo());
  const i = camInfo();
  $("camBarTxt").textContent = `傳送中・${i.portrait ? "直放" : "橫放"}・${camFacing === "user" ? "前" : "後"}鏡頭`;
}
async function camFlip(to) {
  camFacing = to || (camFacing === "user" ? "environment" : "user");
  $$("#camFacing button").forEach((b) => b.classList.toggle("on", b.dataset.facing === camFacing));
  $("camSend").classList.toggle("mirror", camFacing === "user");
  if (!camStream) return;
  try {
    const ns = await getCam(camFacing);
    await camLink?.replaceTrack(ns.getVideoTracks()[0]);
    camStream.getTracks().forEach((t) => t.stop()); camStream = ns; $("camSend").srcObject = ns;
    sendCamInfo();
  } catch (err) { camSay(camError(err)); showCamCard(true); }
}
function camStop(msg = "已停止") {
  camLink?.close(); camLink = null;
  camStream?.getTracks().forEach((t) => t.stop()); camStream = null; $("camSend").srcObject = null;
  $("btnCamGo").textContent = "開始傳送"; camSay(msg); showCamCard(true); releaseWake();
}
function setupCamMode() {
  $("start").classList.add("hidden"); $("camMode").classList.remove("hidden");
  $("dock").classList.add("hidden"); document.querySelector(".topbar").classList.add("hidden");
  $("pip").classList.add("hidden");
  if (pairParam) $("camCode").value = pairParam.replace(/\D/g, "").slice(0, 6);
  showCamCard(true);
  if (camSetup) return; camSetup = true;
  camFlip(camFacing);
  $("camFacing").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) camFlip(b.dataset.facing); });
  $("camCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnCamGo").click(); });
  $("camBarFlip").onclick = () => { camFlip(); showCamBar(); };
  $("camBarStop").onclick = () => camStop();
  $("camBarHide").onclick = hideCamBar;
  $("camChip").onclick = showCamBar;
  $("btnCamBack").onclick = () => {
    camStop("");
    if (pairParam !== null) { location.href = location.pathname; return; }   // 從 QR 進來的 → 回到一般首頁
    $("camMode").classList.add("hidden"); $("start").classList.remove("hidden");
    $("dock").classList.remove("hidden"); document.querySelector(".topbar").classList.remove("hidden");
  };
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (camLink) sendCamInfo(); }, 300); });
  $("btnCamGo").onclick = async () => {
    if (camLink) { camStop(); return; }
    const code = $("camCode").value.replace(/\D/g, "");
    if (code.length !== 6) { camSay("請輸入電腦畫面上的 6 位數配對碼"); $("camCode").focus(); return; }
    $("btnCamGo").disabled = true;
    try {
      camSay("開啟鏡頭中…");
      camStream = await getCam(camFacing);
      $("camSend").srcObject = camStream; await $("camSend").play().catch(() => {});
      camSay("連線到電腦中…");
      camLink = await joinRoom(code, camStream, {
        onOpen: sendCamInfo,
        onData: (d) => { if (d?.type === "flip") { camFlip(); showCamBar(); } },
        onState: (s) => {
          if (s === "connected") { showCamCard(false); showCamBar(); sendCamInfo(); }
          else if (s === "calling") camSay("連線到電腦中…");
          else camStop({ closed: "連線中斷，請再按一次開始傳送", notfound: "找不到這個配對碼，請確認電腦上的號碼", error: "連線發生錯誤，請再試一次" }[s] || s);
        },
      });
      $("btnCamGo").textContent = "停止傳送";
      requestWake();
    } catch (e) { camStop(camError(e)); }
    finally { $("btnCamGo").disabled = false; }
  };
}
$("btnJoinCam").onclick = () => setupCamMode();

/* ---------------- 螢幕常亮 ---------------- */
let wake = null;
async function requestWake() { try { wake = await navigator.wakeLock?.request("screen"); } catch (e) {} }
function releaseWake() { try { wake?.release(); } catch (e) {} wake = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden && (running || camLink)) requestWake(); });

/* ---------------- 骨架線 ---------------- */
const ov = $("overlay"), octx = ov.getContext("2d");
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]];
const HB = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
function clearOverlay() { octx.clearRect(0, 0, ov.width, ov.height); }
function drawOverlay(f, src) {
  const w = ov.clientWidth, h = ov.clientHeight, dpr = Math.min(devicePixelRatio, 2);
  if (ov.width !== Math.round(w * dpr)) { ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr); }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.clearRect(0, 0, w, h);
  if (!S.showSkel || !f) return;
  const vw = src?.w || 4, vh = src?.h || 3, s = Math.min(w / vw, h / vh), ox = (w - vw * s) / 2, oy = (h - vh * s) / 2;   // object-fit: contain
  const P = (p) => [ox + p.x * vw * s, oy + p.y * vh * s];
  const line = (pts, pairs, color, width) => {
    octx.strokeStyle = color; octx.lineWidth = width; octx.beginPath();
    for (const [a, b] of pairs) { const A = P(pts[a]), B = P(pts[b]); octx.moveTo(...A); octx.lineTo(...B); }
    octx.stroke();
  };
  if (f.pose) line(f.pose.lm, BONES.filter(([a, b]) => (f.pose.lm[a].visibility ?? 1) > 0.4 && (f.pose.lm[b].visibility ?? 1) > 0.4), "#5fe0c2", 2.5);
  for (const k of ["L", "R"]) if (f.hands?.[k]) line(f.hands[k].lm, HB, "#f2b84b", 1.5);
}

/* ---------------- 主迴圈 ---------------- */
function loop() {
  requestAnimationFrame(loop);
  if (window.__mocapPause) return;   // 測試用：暫停主迴圈
  let frame = null;
  if (running && !video.paused) {
    try { updateAutoRot(); } catch (e) { console.warn(e); }
    const src = sourceFrame();
    if (src) layoutPip(src.w, src.h, src.rot);
    try { if (src) frame = tracker.detect(src.el, src.w, src.h); } catch (e) { console.warn(e); }
    if (frame) {
      lastFrame = frame; fpsN++;
      if (frame.pose) { if (noPersonSince) pill("ok", "追蹤中"); noPersonSince = 0; }
      else {
        if (!noPersonSince) noPersonSince = performance.now();
        if (performance.now() - noPersonSince > 1500) pill("warn", "沒看到人");
        if (performance.now() - noPersonSince > 6000) { noPersonSince = performance.now() - 1500;
          toast(S.mode === "upper" ? "沒有偵測到人：請讓頭和肩膀入鏡，並增加正面照明" : "沒有偵測到人：請退後讓全身入鏡", { ms: 4000 }); }
      }
    }
    if (S.showPip || S.split) drawOverlay(frame || lastFrame, src);
  }
  const now = performance.now();
  if (now - fpsT > 1000) { $("fps").textContent = running ? `${Math.round(fpsN * 1000 / (now - fpsT))} fps` : "—"; fpsN = 0; fpsT = now; }
  stage.update(running ? frame || lastFrame : null, {
    mirror: S.mirror, fullBody: S.mode === "full", useHands: S.useHands, useFace: S.useFace,
    responsiveness: 14 + (100 - S.smooth) * 0.3,   // 去抖動主要交給 One Euro，骨頭這層只做輕微平滑
  });
}

/* ---------------- 新版檢查（timeout + 重試一次） ---------------- */
async function fetchJSON(url, ms = 6000) {
  for (let i = 0; i < 2; i++) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
    try { const r = await fetch(url, { cache: "no-store", signal: ac.signal }); clearTimeout(t);
      if (r.ok) return await r.json(); if (r.status !== 429 && r.status < 500) return null; }
    catch (e) { clearTimeout(t); }
  }
  return null;
}
function goLatest(v) { const u = new URL(location.href); u.searchParams.set("v", v); location.replace(u.toString()); }
async function checkVersion() {
  if (IS_DEV) return;
  const d = await fetchJSON("version.json?t=" + Date.now());
  if (!d?.version || d.version === VERSION) return;
  const alreadyTried = new URL(location.href).searchParams.get("v") === d.version;
  if (!running && !camLink && !alreadyTried) { goLatest(d.version); return; }
  toast("有新版本", { ms: 0, action: { label: "更新", fn: () => goLatest(d.version) } });
}
checkVersion();
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
setInterval(checkVersion, 5 * 60 * 1000);

/* ---------------- 啟動 ---------------- */
applyBg(); syncUI(); tracker.setSmooth(S.smooth);
if (pairParam !== null) setupCamMode();
else loadModel(S.model, { silent: true });
requestAnimationFrame(loop);

// 供測試使用
window.__mocap = { S, stage, tracker, loadModel, setMode, syncUI, get running() { return running; }, set running(v) { running = v; },
  get autoRot() { return autoRot; }, curRot, setRemoteInfo(d) { remoteInfo = d; resetAutoRot(); },
  async testStream(s, info) { stopStream(); S.src = "phone"; remoteInfo = info || null; resetAutoRot(); stream = s; video.srcObject = s; await video.play(); await beginTracking(); } };
