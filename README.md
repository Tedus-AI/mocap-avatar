# Mocap Avatar · 動態捕捉虛擬人物

用鏡頭讓 3D 虛擬角色跟著你動：臉部表情、身體、手指。
純網頁、免安裝，iPhone／iPad（Safari）與 Windows 電腦（Chrome／Edge）都能用。

**網址：** https://tedus-ai.github.io/mocap-avatar/

## 功能

- **三種影像來源**
  - 這台裝置的鏡頭（前／後鏡頭可切換）
  - **手機當鏡頭**：電腦顯示角色，手機掃 QR code 配對後無線傳送畫面（WebRTC）
  - 影片檔
- **動捕範圍**：上半身（坐在鏡頭前）／全身（退到 2～3 公尺）
- **追蹤**：身體（MediaPipe Pose）、手指（Hand）、臉部表情與頭部轉動（Face blendshapes）
- **效能分級**：省電／平衡／高品質，手機預設省電（臉、手隔幀更新）
- **8 個內建角色**可直接切換，也可以載入自己的 `.vrm`（VRoid Studio 匯出），記在本機不上傳
- 鏡像動作、動作平滑、背景（綠幕／藍幕／自訂圖片）、自由拖曳視角

## 使用方式

1. 開啟網址 → 選影像來源、動捕範圍 → 按「開始」→ 允許相機
2. 上半身：坐在鏡頭前約 1 公尺，讓頭、肩膀和雙手入鏡
3. 全身：鏡頭放低到腰的高度，人退到全身入鏡
4. 手機當鏡頭：電腦選「手機當鏡頭」→ 手機掃畫面上的 QR code → 按「開始傳送」，手機橫放立好（兩台最好連同一個 Wi-Fi）

## 架構

純前端，部署在 GitHub Pages，沒有建置步驟。

| 檔案 | 內容 |
|---|---|
| `index.html`, `css/app.css` | 介面（手機直／橫、平板、桌機響應式） |
| `js/main.js` | 狀態、介面事件、主迴圈 |
| `js/tracker.js` | MediaPipe Tasks Vision（GPU 失敗自動改 CPU） |
| `js/retarget.js` | 追蹤座標 → VRM 正規化骨架旋轉（適用 VRM0／VRM1） |
| `js/avatar.js` | three.js 場景與 VRM 載入 |
| `js/pairing.js` | 手機當鏡頭（PeerJS / WebRTC） |
| `vendor/` | three.js 0.187、three-vrm 3.6、PeerJS 1.5、qrcode-generator |

版本號由 CI 自動蓋上（`__BUILD_VERSION__`），網頁會定期比對 `version.json` 提示更新。

## 授權與致謝

- 本專案的動作捕捉概念參考 **[XR Animator](https://github.com/ButzYung/SystemAnimatorOnline)**（© ButzYung，CC BY-NC-SA 4.0）。
  依其授權，本專案程式碼同樣以 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)** 釋出：可修改、分享，需標示來源，**不可商業使用**。
- 追蹤：[Google MediaPipe](https://github.com/google-ai-edge/mediapipe)（Apache 2.0）
- 角色渲染：[three.js](https://threejs.org/)（MIT）、[three-vrm](https://github.com/pixiv/three-vrm)（MIT, pixiv）
- 配對：[PeerJS](https://peerjs.com/)（MIT）、[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT）

### 內建角色

| 角色 | 作者 | 授權 |
|---|---|---|
| 千駄ヶ谷 篠、Vita、Vivi、Victoria Rubin、千駄ヶ谷 渋 | VRoid Project（pixiv） | CC0（VRoid Studio 早期版本範例角色） |
| VRM1 範例（VRM1_Constraint_Twist_Sample） | pixiv Inc. | VRM Public License 1.0，允許再散布 |
| Seed-san | VirtualCast, Inc. | VRM Public License 1.0，允許再散布 |
| Orion | Polygonal Mind | CC0 |

各角色的完整授權資訊也記錄在 `.vrm` 檔內的 meta 欄位。
