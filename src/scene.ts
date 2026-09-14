import * as THREE from 'three';

export type FitMode = 'contain' | 'cover';

export interface ParallaxSceneConfig {
  originalImg: HTMLImageElement;
  depthMap: Float32Array;
  depthWidth: number;
  depthHeight: number;
  initialFitMode?: FitMode;
}

export interface SceneController {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  setFitMode: (mode: FitMode) => void;
  setIntensity: (intensity: number) => void;
  updateOffset: (x: number, y: number) => void;
  dispose: () => void;
  config: ParallaxSceneConfig;
}

export async function buildParallaxScene(
  canvas: HTMLCanvasElement,
  config: ParallaxSceneConfig
): Promise<SceneController> {
  const { originalImg, depthMap, depthWidth, depthHeight, initialFitMode = 'contain' } = config;

  const imgW = originalImg.naturalWidth;
  const imgH = originalImg.naturalHeight;
  const imgAspect = imgW / imgH;

  // ── 1. High-DPI Renderer Setup ────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true, // Needed for MediaRecorder capture
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.5));
  const canvasW = canvas.clientWidth || canvas.width;
  const canvasH = canvas.clientHeight || canvas.height;
  renderer.setSize(canvasW, canvasH, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping removed to ensure 1:1 original color reproduction without contrast enhancement

  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ── 2. Camera Setup ───────────────────────────────────────────────────────
  const CAMERA_FOV = 40;
  const CAMERA_Z = 1.6;
  let aspect = canvasW / canvasH;
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, 0.01, 10);
  camera.position.set(0, 0, CAMERA_Z);
  camera.lookAt(0, 0, 0);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06060c);

  // ── 3. Texture Preparation (100% Native Resolution) ───────────────────────
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = imgW;
  bgCanvas.height = imgH;
  const bgCtx = bgCanvas.getContext('2d')!;
  bgCtx.drawImage(originalImg, 0, 0);

  const bgTexture = new THREE.CanvasTexture(bgCanvas);
  bgTexture.colorSpace = THREE.SRGBColorSpace;
  bgTexture.generateMipmaps = true;
  bgTexture.minFilter = THREE.LinearMipmapLinearFilter;
  bgTexture.magFilter = THREE.LinearFilter;
  bgTexture.anisotropy = maxAniso;
  bgTexture.wrapS = THREE.ClampToEdgeWrapping;
  bgTexture.wrapT = THREE.ClampToEdgeWrapping;

  const depthCanvas = createDepthCanvas(depthMap, depthWidth, depthHeight);
  const depthTexture = new THREE.CanvasTexture(depthCanvas);
  depthTexture.minFilter = THREE.LinearFilter;
  depthTexture.magFilter = THREE.LinearFilter;
  depthTexture.wrapS = THREE.ClampToEdgeWrapping;
  depthTexture.wrapT = THREE.ClampToEdgeWrapping;

  // ── 4. Plane Geometry Calculation ─────────────────────────────────────────
  let currentFitMode: FitMode = initialFitMode;

  function getPlaneDims(fit: FitMode) {
    return calculatePlaneDimensions(
      camera.aspect,
      imgAspect,
      CAMERA_FOV,
      CAMERA_Z,
      fit,
      1.04
    );
  }

  let planeDims = getPlaneDims(currentFitMode);
  let planeGeo = new THREE.PlaneGeometry(planeDims.width, planeDims.height);

  // ── 5. (Removed Ambient Blurred Backdrop) ─────────────────────────────────
  const fovRad = (CAMERA_FOV * Math.PI) / 180;
  const frustumH = 2 * Math.tan(fovRad / 2) * CAMERA_Z;
  const frustumW = frustumH * aspect;

  // ── 6. Continuous 4D Depth Displacement Shader ────────────────────────────
  const shaderUniforms = {
    uImage: { value: bgTexture },
    uDepth: { value: depthTexture },
    uOffset: { value: new THREE.Vector2(0, 0) },
    uScale: { value: 0.85 },
  };

  const shaderMat = new THREE.ShaderMaterial({
    uniforms: shaderUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uImage;
      uniform sampler2D uDepth;
      uniform vec2 uOffset;
      uniform float uScale;
      varying vec2 vUv;

      // Premium Depth Smoothing (Gaussian-like 9-tap)
      // This turns harsh cliffs (which cause tearing and streaks) into smooth, rubber-sheet ramps
      float getSmoothDepth(vec2 uv) {
          float d = 0.0;
          vec2 off = vec2(0.015); // Wide radius for seamless edge blending
          
          d += texture2D(uDepth, uv).r * 0.2500;
          d += texture2D(uDepth, uv + vec2(off.x, 0.0)).r * 0.1250;
          d += texture2D(uDepth, uv - vec2(off.x, 0.0)).r * 0.1250;
          d += texture2D(uDepth, uv + vec2(0.0, off.y)).r * 0.1250;
          d += texture2D(uDepth, uv - vec2(0.0, off.y)).r * 0.1250;
          
          d += texture2D(uDepth, uv + off).r * 0.0625;
          d += texture2D(uDepth, uv - off).r * 0.0625;
          d += texture2D(uDepth, uv + vec2(off.x, -off.y)).r * 0.0625;
          d += texture2D(uDepth, uv + vec2(-off.x, off.y)).r * 0.0625;
          
          return d;
      }

      void main() {
        // Frame scaling to hide edges
        vec2 centeredUv = (vUv - 0.5) * 0.90 + 0.5;
        vec2 offset = uOffset * uScale;

        // 1. Fetch flawlessly smoothed depth
        float smoothDepth = getSmoothDepth(centeredUv);
        
        // 2. Perform continuous premium displacement
        // No loops, no raymarching, no tearing, no dark auras.
        vec2 uv = centeredUv + offset * (smoothDepth - 0.5);
        
        // 3. Clean boundary clamp
        uv = clamp(uv, vec2(0.001), vec2(0.999));
        
        gl_FragColor = texture2D(uImage, uv);
      }
    `,
    depthWrite: false,
    side: THREE.FrontSide,
  });

  const shaderMesh = new THREE.Mesh(planeGeo, shaderMat);
  scene.add(shaderMesh);

  // ── 7. Controls & State ───────────────────────────────────────────────────
  function setFitMode(mode: FitMode) {
    currentFitMode = mode;
    updateGeometries();
  }

  function setIntensity(intensity: number) {
    // Highly visible depth pop, perfectly balanced to avoid overwhelming the smooth displacement
    shaderUniforms.uScale.value = 0.85 * intensity;
  }

  function updateOffset(x: number, y: number) {
    shaderUniforms.uOffset.value.set(x, y);
  }

  function updateGeometries() {
    planeDims = getPlaneDims(currentFitMode);
    planeGeo.dispose();
    planeGeo = new THREE.PlaneGeometry(planeDims.width, planeDims.height);
    shaderMesh.geometry = planeGeo;
  }

  // ── 8. Resize Handler ─────────────────────────────────────────────────────
  function onResize() {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (w === 0 || h === 0) return; // Ignore if unmounted
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    updateGeometries();
  }
  window.addEventListener('resize', onResize);

  // ── 9. Render Loop ───────────────────────────────────────────────────────
  let animId: number;
  function loop() {
    animId = requestAnimationFrame(loop);
    renderer.render(scene, camera);
  }
  loop();

  function dispose() {
    cancelAnimationFrame(animId);
    window.removeEventListener('resize', onResize);
    bgTexture.dispose();
    depthTexture.dispose();
    shaderMat.dispose();
    planeGeo.dispose();
    renderer.dispose();
  }

  return {
    renderer,
    camera,
    scene,
    setFitMode,
    setIntensity,
    updateOffset,
    dispose,
    config,
  };
}

/**
 * Calculates plane dimensions so the image is never cut in half.
 */
function calculatePlaneDimensions(
  screenAspect: number,
  imgAspect: number,
  fov: number,
  cameraZ: number,
  fitMode: FitMode,
  overshoot: number
): { width: number; height: number } {
  const fovRad = (fov * Math.PI) / 180;
  const frustumH = 2 * Math.tan(fovRad / 2) * cameraZ;
  const frustumW = frustumH * screenAspect;

  let width: number;
  let height: number;

  if (fitMode === 'contain') {
    if (screenAspect > imgAspect) {
      height = frustumH * 0.90 * overshoot;
      width = height * imgAspect;
    } else {
      width = frustumW * 0.90 * overshoot;
      height = width / imgAspect;
    }
  } else {
    if (screenAspect > imgAspect) {
      width = frustumW * overshoot;
      height = width / imgAspect;
    } else {
      height = frustumH * overshoot;
      width = height * imgAspect;
    }
  }

  return { width, height };
}

/**
 * Converts float32 depth map [0, 1] to a grayscale canvas.
 */
function createDepthCanvas(
  depthMap: Float32Array,
  width: number,
  height: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;

  for (let i = 0; i < depthMap.length; i++) {
    const val = Math.round(Math.min(Math.max(depthMap[i], 0), 1) * 255);
    const p = i * 4;
    data[p + 0] = val;
    data[p + 1] = val;
    data[p + 2] = val;
    data[p + 3] = 255;
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}
