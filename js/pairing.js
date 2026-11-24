/* =====================================================================
   pairing.js — 手機當鏡頭：用 WebRTC（PeerJS 公共伺服器做配對）
   電腦＝接收端（顯示角色、跑追蹤），手機＝鏡頭端（只拍、傳畫面）
   ===================================================================== */
const PREFIX = "tedus-mocap-v1-";
const Peer = () => window.Peer;

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); })]).finally(() => clearTimeout(t));
}
export const randomCode = () => String(Math.floor(100000 + Math.random() * 900000));

/** 電腦端：開一個房間等手機連線。onStream(stream) 收到畫面 */
export async function hostRoom({ onStream, onState, onData }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode();
    const peer = new (Peer())(PREFIX + code, { debug: 1 });
    try {
      await withTimeout(new Promise((res, rej) => {
        peer.on("open", res);
        peer.on("error", rej);
      }), 12000, "連不上配對伺服器（請確認網路）");
    } catch (e) {
      peer.destroy();
      if (String(e?.type) === "unavailable-id") continue;   // 號碼撞到，換一個
      throw e;
    }
    const room = { code, peer, conn: null, connected: false,
      send(msg) { try { if (room.conn?.open) room.conn.send(msg); } catch (e) {} },
      close: () => peer.destroy() };
    peer.on("call", (call) => {
      onState?.("connecting");
      call.answer();
      call.on("stream", (s) => { room.connected = true; onState?.("connected"); onStream(s); });
      call.on("close", () => { room.connected = false; onState?.("closed"); });
      call.on("error", () => { room.connected = false; onState?.("closed"); });
    });
    // 資料通道：手機回報方向／鏡頭，電腦可要求手機換鏡頭
    peer.on("connection", (conn) => {
      room.conn = conn;
      conn.on("data", (d) => onData?.(d));
    });
    peer.on("disconnected", () => { try { peer.reconnect(); } catch (e) {} });
    return room;
  }
  throw new Error("配對號碼建立失敗，請重試");
}

/** 手機端：連到電腦的房間並送出鏡頭畫面 */
export async function joinRoom(code, stream, { onState, onData, onOpen, fps: fpsWanted = 60 }) {
  const peer = new (Peer())({ debug: 1 });
  await withTimeout(new Promise((res, rej) => { peer.on("open", res); peer.on("error", rej); }), 12000, "連不上配對伺服器（請確認網路）");
  onState?.("calling");
  const call = peer.call(PREFIX + code, stream);
  if (!call) throw new Error("找不到這個配對碼，請確認電腦畫面上的號碼");
  peer.on("error", (e) => onState?.(e?.type === "peer-unavailable" ? "notfound" : "error", e));
  call.on("close", () => onState?.("closed"));
  // 連線成功判斷：ICE 狀態
  const pc = call.peerConnection;
  /** 要求 WebRTC 優先維持畫面數（網路不夠時降畫質、不降 fps） */
  const tuneSender = async (fps = 60) => {
    try {
      const sender = call.peerConnection?.getSenders().find((s) => s.track?.kind === "video");
      if (!sender) return;
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxFramerate = fps;
      p.encodings[0].maxBitrate = 6_000_000;
      p.degradationPreference = "maintain-framerate";
      await sender.setParameters(p);
    } catch (e) { console.warn("無法設定傳送參數", e); }
  };
  pc?.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") { onState?.("connected"); tuneSender(fpsWanted); }
    if (["failed", "disconnected"].includes(pc.connectionState)) onState?.("closed");
  });
  const conn = peer.connect(PREFIX + code, { reliable: true });
  conn.on("open", () => onOpen?.());
  conn.on("data", (d) => onData?.(d));
  return {
    peer, call, conn, tuneSender,
    send(msg) { try { if (conn.open) conn.send(msg); } catch (e) {} },
    /** 換鏡頭時直接替換影像軌，不用重新配對 */
    replaceTrack(track) {
      const sender = call.peerConnection?.getSenders().find((s) => s.track?.kind === "video");
      return sender?.replaceTrack(track);
    },
    close: () => { call.close(); peer.destroy(); },
  };
}
