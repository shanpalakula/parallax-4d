import { loadImageSafe, downscaleImageForAI } from './imageLoader';
import { buildParallaxScene, type SceneController, type FitMode } from './scene';
import { setupMotionSensors } from './motionSensor';
import { recordParallaxVideo, downloadBlob } from './exporter';
import type { AIWorkerOutput } from './workers/aiProcessor.worker';

// ── DOM References ─────────────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone') as HTMLDivElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const canvasEl = document.getElementById('parallax-canvas') as HTMLCanvasElement;
const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
const progressFill = document.getElementById('progress-fill') as HTMLDivElement;
const progressLabel = document.getElementById('progress-label') as HTMLSpanElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const gyroBtn = document.getElementById('gyro-btn') as HTMLButtonElement;
const retryBtn = document.getElementById('retry-btn') as HTMLButtonElement;
const appShell = document.getElementById('app-shell') as HTMLDivElement;

// Mode & Settings Controls
const fitToggleBtn = document.getElementById('fit-toggle-btn') as HTMLButtonElement;
const intensitySlider = document.getElementById('intensity-slider') as HTMLInputElement;

let currentScene: SceneController | null = null;
let cleanupSensors: (() => void) | null = null;
let currentFitMode: FitMode = 'contain';
let currentFilename: string = 'live-wallpaper';

// ── File Selection & Drag-and-Drop ─────────────────────────────────────────
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) processFile(fileInput.files[0]);
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer?.files[0]) processFile(e.dataTransfer.files[0]);
});
dropZone.addEventListener('click', () => fileInput.click());

retryBtn.addEventListener('click', () => {
  currentScene?.dispose();
  cleanupSensors?.();
  currentScene = null;
  appShell.dataset.state = 'upload';
  fileInput.value = '';
});

// ── Controls ───────────────────────────────────────────────────────────────
fitToggleBtn.addEventListener('click', () => {
  if (!currentScene) return;
  currentFitMode = currentFitMode === 'contain' ? 'cover' : 'contain';
  currentScene.setFitMode(currentFitMode);
  fitToggleBtn.textContent = currentFitMode === 'contain' ? '📐 Fit: Full' : '⛶ Fit: Fill';
  fitToggleBtn.classList.toggle('active', currentFitMode === 'contain');
});

intensitySlider.addEventListener('input', () => {
  if (!currentScene) return;
  const val = parseFloat(intensitySlider.value);
  currentScene.setIntensity(val);
});

// ── Export Video ───────────────────────────────────────────────────────────
exportBtn.addEventListener('click', async () => {
  if (!currentScene) return;
  exportBtn.disabled = true;
  exportBtn.textContent = 'Recording…';
  
  const durationMs = 4000;
  let exportScene: SceneController | null = null;
  
  try {
    const config = currentScene.config;
    const aspect = config.originalImg.naturalWidth / config.originalImg.naturalHeight;
    
    let targetW = config.originalImg.naturalWidth;
    let targetH = config.originalImg.naturalHeight;
    
    // Cap resolution at 1920 to avoid MediaRecorder/WebGL crashes on huge images
    if (targetW > 1920 || targetH > 1920) {
      if (targetW > targetH) {
        targetW = 1920;
        targetH = Math.round(targetW / aspect);
      } else {
        targetH = 1920;
        targetW = Math.round(targetH * aspect);
      }
    }

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = targetW;
    exportCanvas.height = targetH;
    
    // Build headless export scene (force 'cover' to fill the canvas bounds)
    exportScene = await buildParallaxScene(exportCanvas, {
      ...config,
      initialFitMode: 'cover'
    });
    
    // Ensure we capture with the intensity currently set by the user
    exportScene.setIntensity(parseFloat(intensitySlider.value));

    const videoBlob = await recordParallaxVideo(exportCanvas, durationMs, (pct) => {
      exportBtn.textContent = `Recording… ${Math.round(pct * 100)}%`;
      const angle = pct * Math.PI * 2;
      const radius = 0.05; 
      exportScene!.updateOffset(Math.cos(angle) * radius, Math.sin(angle) * radius);
    });
    
    downloadBlob(videoBlob, `${currentFilename}-parallax-4d.webm`);
  } catch (err) {
    console.error('Export failed:', err);
    alert('Failed to export video. Your browser might not support MediaRecorder or WebGL max texture size was exceeded.');
  } finally {
    exportScene?.dispose();
    exportBtn.disabled = false;
    exportBtn.textContent = '⬇ Download Live Wallpaper';
  }
});

// ── iOS Gyroscope Permission ───────────────────────────────────────────────
gyroBtn.addEventListener('click', async () => {
  if ((window as any).__requestGyro) {
    await (window as any).__requestGyro();
    gyroBtn.style.display = 'none';
  }
});

// ── Main Processing Pipeline ───────────────────────────────────────────────
async function processFile(file: File): Promise<void> {
  try {
    // Store original filename without extension
    const parts = file.name.split('.');
    if (parts.length > 1) parts.pop();
    currentFilename = parts.join('.') || 'live-wallpaper';

    appShell.dataset.state = 'processing';
    setProgress('Loading image…', 2);

    // 1. Load full-res image (HEIC-safe, correctly oriented)
    const originalImg = await loadImageSafe(file);
    setProgress('Preparing AI input…', 8);

    // 2. Downscale for AI inference
    const aiInputDataUrl = downscaleImageForAI(originalImg, 512);
    setProgress('Loading AI depth model…', 12);

    // 3. Run depth estimation in Web Worker
    const aiResult = await runAIWorker(
      aiInputDataUrl,
      originalImg.naturalWidth,
      originalImg.naturalHeight
    );
    setProgress('Synthesizing 4D parallax scene…', 90);

    // 4. Dispose previous scene if any
    currentScene?.dispose();
    cleanupSensors?.();

    // 5. Transition to viewer before mounting Three.js so canvas has viewport dimensions
    appShell.dataset.state = 'viewer';
    await new Promise((r) => requestAnimationFrame(r));

    // 6. Build the 4D Parallax Scene
    currentScene = await buildParallaxScene(canvasEl, {
      originalImg,
      depthMap: aiResult.depthMap,
      depthWidth: aiResult.depthWidth,
      depthHeight: aiResult.depthHeight,
      initialFitMode: currentFitMode,
    });

    // 7. Attach motion sensors (drives camera and shader offset)
    cleanupSensors = setupMotionSensors(currentScene.camera, (x, y) => {
      currentScene?.updateOffset(x, y);
    });

    // Reset controls state
    fitToggleBtn.textContent = currentFitMode === 'contain' ? '📐 Fit: Full' : '⛶ Fit: Fill';
    fitToggleBtn.classList.toggle('active', currentFitMode === 'contain');
    intensitySlider.value = '1.0';

    // Show gyro button on iOS
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof (DeviceOrientationEvent as any).requestPermission === 'function'
    ) {
      gyroBtn.style.display = 'flex';
    }

    setProgress('Ready!', 100);

  } catch (err) {
    console.error('Processing failed:', err);
    showError(String(err));
  }
}

// ── Web Worker Bridge ──────────────────────────────────────────────────────
function runAIWorker(
  imageDataUrl: string,
  originalWidth: number,
  originalHeight: number
): Promise<AIWorkerOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./workers/aiProcessor.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setProgress(msg.step, 10 + (msg.pct / 100) * 78);
      } else if (msg.type === 'result') {
        worker.terminate();
        resolve(msg.data as AIWorkerOutput);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };

    worker.postMessage({ imageDataUrl, originalWidth, originalHeight });
  });
}

// ── UI Helpers ─────────────────────────────────────────────────────────────
function setProgress(label: string, pct: number) {
  progressLabel.textContent = label;
  progressFill.style.width = `${Math.round(pct)}%`;
  progressBar.setAttribute('aria-valuenow', String(Math.round(pct)));
}

function showError(msg: string) {
  appShell.dataset.state = 'upload';
  const errEl = document.getElementById('error-msg') as HTMLParagraphElement;
  errEl.textContent = `Error: ${msg}`;
  errEl.style.display = 'block';
}
