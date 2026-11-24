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
};
const S = { ...DEFAULTS };
function load() { try { Object.assign(S, JSON.parse(localStorage.getItem(STORE_KEY) || "{}")); } catch (e) {} if (!TIERS[S.tier]) S.tier = autoTier(); }
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

function resize() { stage.resize(window.innerWidth, window.innerHeight); }
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
  $("tierHint").textContent = `${TIERS[S.tier].label}：` + ({ low: "手機建議，臉和手隔幀更新", mid: "平板/一般電腦建議", high: "身體用高精度模型，需要較強的電腦" })[S.tier];
  $("pip").classList.toggle("hidden", !(running && S.showPip));
  $("pip").classList.toggle("mirror", S.mirror);
  $("btnFlip").disabled = !(running && S.src === "local");
  $("verTxt").textContent = IS_DEV ? "開發版" : VERSION;
}
function setMode(m) { S.mode = m; save(); stage.frame(m); syncUI(); }
$$(".dock .seg button, #startMode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$$("#srcChoices .choice").forEach((b) => b.addEventListener("click", () => { S.src = b.dataset.src; save(); syncUI(); }));
$$("#startFacing button").forEach((b) => b.addEventListener("click", () => { S.facing = b.dataset.facing; S.mirror = S.facing === "user"; save(); syncUI(); }));
$("optMirror").onchange = (e) => { S.mirror = e.target.checked; save(); syncUI(); };
$("optPip").onchange = (e) => { S.showPip = e.target.checked; save(); syncUI(); };
$("optSkel").onchange = (e) => { S.showSkel = e.target.checked; save(); clearOverlay(); };
$("optSmooth").oninput = (e) => { S.smooth = +e.target.value; save(); };
$("optFace").onchange = (e) => { S.useFace = e.target.checked; save(); applyTracking(); };
$("optHands").onchange = (e) => { S.useHands = e.target.checked; save(); applyTracking(); };
$("segTier").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.tier = b.dataset.tier; save(); syncUI(); applyTracking(); });
async function applyTracking() {
  tracker.setOptions({ tier: S.tier, useFace: S.useFace, useHands: S.useHands });
  if (!running) return;
  try { pill("busy", "更新追蹤設定…"); await tracker.init({ tier: S.tier, useFace: S.useFace, useHands: S.useHands }, (t) => pill("busy", t)); }
  catch (e) { toast("載入模型失敗：" + e.message, { err: true }); }
}
$("pipToggle").onclick = () => $("pip").classList.toggle("small");
$("btnView").onclick = () => stage.frame(S.mode);
$("btnFlip").onclick = async () => {
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
  return navigator.mediaDevices.getUserMedia({ audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } });
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
        S.mirror = true; save();
        if (!running) { try { await beginTracking(); } catch (e) { $("pairStatus").textContent = e.message; } }
        else { pill("warn", "尋找人物中…"); toast("手機重新連上了"); }
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

/* ---------------- 手機端：鏡頭模式（網址帶 ?pair=） ---------------- */
const pairParam = new URLSearchParams(location.search).get("pair");
let camLink = null, camFacing = "environment", camStream = null;
function setupCamMode() {
  $("start").classList.add("hidden"); $("camMode").classList.remove("hidden");
  $("dock").classList.add("hidden"); document.querySelector(".topbar").classList.add("hidden");
  if (pairParam) $("camCode").value = pairParam.replace(/\D/g, "").slice(0, 6);
  const sv = $("camSend");
  const setFacingUI = () => { $$("#camFacing button").forEach((b) => b.classList.toggle("on", b.dataset.facing === camFacing)); sv.classList.toggle("mirror", camFacing === "user"); };
  setFacingUI();
  $("camFacing").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    camFacing = b.dataset.facing; setFacingUI();
    if (camStream) {
      try {
        const ns = await getCam(camFacing);
        camLink?.replaceTrack(ns.getVideoTracks()[0]);
        camStream.getTracks().forEach((t) => t.stop()); camStream = ns; sv.srcObject = ns;
      } catch (err) { $("camStatus").textContent = camError(err); }
    }
  });
  $("btnCamGo").onclick = async () => {
    const code = $("camCode").value.replace(/\D/g, "");
    if (camLink) { camLink.close(); camLink = null; camStream?.getTracks().forEach((t) => t.stop()); camStream = null;
      $("btnCamGo").textContent = "開始傳送"; document.querySelector(".cam-ui").classList.remove("live"); $("camStatus").textContent = "已停止"; releaseWake(); return; }
    if (code.length !== 6) { $("camStatus").textContent = "請輸入電腦畫面上的 6 位數配對碼"; return; }
    $("btnCamGo").disabled = true;
    try {
      $("camStatus").textContent = "開啟鏡頭中…";
      camStream = await getCam(camFacing);
      sv.srcObject = camStream; await sv.play().catch(() => {});
      $("camStatus").textContent = "連線到電腦中…";
      camLink = await joinRoom(code, camStream, { onState: (s) => {
        $("camStatus").textContent = { calling: "連線到電腦中…", connected: "● 傳送中 — 請把手機橫放立好", closed: "連線中斷，請再按一次開始", notfound: "找不到這個配對碼，請確認電腦上的號碼", error: "連線發生錯誤" }[s] || s;
      } });
      $("btnCamGo").textContent = "停止傳送";
      document.querySelector(".cam-ui").classList.add("live");
      requestWake();
    } catch (e) { $("camStatus").textContent = camError(e); camStream?.getTracks().forEach((t) => t.stop()); camStream = null; }
    finally { $("btnCamGo").disabled = false; }
  };
}

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
function drawOverlay(f) {
  const w = ov.clientWidth, h = ov.clientHeight, dpr = Math.min(devicePixelRatio, 2);
  if (ov.width !== Math.round(w * dpr)) { ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr); }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.clearRect(0, 0, w, h);
  if (!S.showSkel || !f) return;
  const vw = video.videoWidth || 4, vh = video.videoHeight || 3, s = Math.max(w / vw, h / vh), ox = (w - vw * s) / 2, oy = (h - vh * s) / 2;
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
    try { frame = tracker.detect(video); } catch (e) { console.warn(e); }
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
    if (S.showPip) drawOverlay(frame || lastFrame);
  }
  const now = performance.now();
  if (now - fpsT > 1000) { $("fps").textContent = running ? `${Math.round(fpsN * 1000 / (now - fpsT))} fps` : "—"; fpsN = 0; fpsT = now; }
  stage.update(running ? frame || lastFrame : null, {
    mirror: S.mirror, fullBody: S.mode === "full", useHands: S.useHands, useFace: S.useFace,
    responsiveness: 4 + (100 - S.smooth) * 0.36,
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
applyBg(); syncUI();
if (pairParam !== null) setupCamMode();
else loadModel(S.model, { silent: true });
requestAnimationFrame(loop);

// 供測試使用
window.__mocap = { S, stage, tracker, loadModel, setMode, syncUI, get running() { return running; }, set running(v) { running = v; } };
