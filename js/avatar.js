/* =====================================================================
   avatar.js — three.js 場景、VRM 角色載入、每幀更新
   ===================================================================== */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils } from "../vendor/three-vrm.module.min.js";
import { Rig, faceExpressions } from "./retarget.js?v=__BUILD_VERSION__";

export class AvatarStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.4; this.controls.maxDistance = 8;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 1.2);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6); dir.position.set(1, 2, 2);
    this.scene.add(hemi, dir);
    // 地面陰影圈
    const g = new THREE.CircleGeometry(0.45, 48);
    const m = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false });
    this.shadow = new THREE.Mesh(g, m); this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = 0.002;
    this.scene.add(this.shadow);

    this.vrm = null; this.rig = null;
    this.expr = {};
    this.framing = "upper";
    this.clock = new THREE.Clock();
    this.t = 0;
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.frame(this.framing, true);
  }

  async load(urlOrBuffer, onProgress) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = typeof urlOrBuffer === "string"
      ? await loader.loadAsync(urlOrBuffer, (e) => onProgress?.(e.total ? e.loaded / e.total : 0))
      : await loader.parseAsync(urlOrBuffer, "");
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error("這個檔案不是 VRM 角色");
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons?.(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    if (this.vrm) { this.scene.remove(this.vrm.scene); VRMUtils.deepDispose(this.vrm.scene); }
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    this.rig = new Rig(vrm);
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
    this.headY = this.rig.pos.head ? this.rig.pos.head.y + vrm.scene.position.y : 1.4;
    this.frame(this.framing, true);
    return vrm;
  }

  /** 鏡頭構圖：upper＝上半身特寫、full＝全身 */
  frame(mode, instant = false) {
    this.framing = mode;
    const hy = this.headY || 1.4;
    const tall = this.camera.aspect < 0.8;          // 手機直立
    let target, dist;
    if (mode === "full") { target = new THREE.Vector3(0, hy * 0.55, 0); dist = (tall ? 5.2 : 3.6) * (hy / 1.4); }
    else { target = new THREE.Vector3(0, hy - 0.26, 0); dist = (tall ? 2.5 : 2.0) * (hy / 1.4); }
    this._camGoal = { target, pos: target.clone().add(new THREE.Vector3(0, 0.05, dist)) };
    if (instant) { this.controls.target.copy(target); this.camera.position.copy(this._camGoal.pos); this._camGoal = null; }
    this.controls.update();
  }

  /** 每幀：frame = 追蹤結果，opts = 設定 */
  update(frame, opts) {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.t += dt;
    if (this._camGoal) {
      const a = 1 - Math.exp(-dt * 6);
      this.controls.target.lerp(this._camGoal.target, a);
      this.camera.position.lerp(this._camGoal.pos, a);
      if (this.camera.position.distanceTo(this._camGoal.pos) < 0.005) this._camGoal = null;
    }
    if (this.vrm && this.rig) {
      this.rig.solve(frame || {}, { ...opts, idleT: this.t });
      this.rig.apply(dt, opts.responsiveness);
      this.rig.ground(opts.fullBody && !!frame?.pose);
      // 表情
      const em = this.vrm.expressionManager;
      if (em) {
        const target = frame?.face?.blend && opts.useFace ? faceExpressions(frame.face.blend, opts.mirror) : null;
        const auto = this._autoBlink(dt);
        for (const k of ["blinkLeft", "blinkRight", "aa", "ih", "ou", "ee", "oh", "happy", "surprised"]) {
          let v = target ? target[k] ?? 0 : 0;
          if (!target && (k === "blinkLeft" || k === "blinkRight")) v = auto;
          const cur = this.expr[k] ?? 0;
          const speed = k.startsWith("blink") ? 30 : 16;
          const nv = cur + (v - cur) * (1 - Math.exp(-dt * speed));
          this.expr[k] = nv;
          try { em.setValue(k, nv); } catch (e) { /* 角色沒有這個表情 */ }
        }
      }
      this.vrm.update(dt);
      const hips = this.rig.node("hips");
      this.shadow.position.x = hips.getWorldPosition(new THREE.Vector3()).x;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _autoBlink(dt) {
    this._bt = (this._bt ?? 2) - dt;
    if (this._bt < 0) { this._bt = 2.5 + Math.random() * 3; this._bs = 0.16; }
    if (this._bs > 0) { this._bs -= dt; return 1; }
    return 0;
  }
}
