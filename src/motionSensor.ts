import * as THREE from 'three';

/**
 * 1D Kalman filter for smoothing noisy sensor data (gyroscope / accelerometer).
 */
class KalmanFilter {
  private R = 1;    // Measurement noise covariance
  private Q = 0.05; // Process noise covariance
  private P = 1;    // Estimation error covariance
  private x = 0;   // State estimate
  private K = 0;   // Kalman gain

  filter(measurement: number): number {
    this.P += this.Q;
    this.K = this.P / (this.P + this.R);
    this.x += this.K * (measurement - this.x);
    this.P *= 1 - this.K;
    return this.x;
  }

  reset() {
    this.P = 1;
    this.x = 0;
  }
}

const kfX = new KalmanFilter();
const kfY = new KalmanFilter();

/** Subtle, realistic Apple-like tilt range */
const MAX_OFFSET = 0.045;
/** Silky inertia lerp speed (faster for 120fps hyper-responsive feel) */
const LERP_SPEED = 0.15;

let targetX = 0;
let targetY = 0;
let currentX = 0;
let currentY = 0;
let gyroGranted = false;

/**
 * Sets up motion sensors (gyroscope on mobile, mouse on desktop).
 * Drives camera position and optional offset callback each frame.
 */
export function setupMotionSensors(
  camera: THREE.PerspectiveCamera,
  onOffsetUpdate?: (x: number, y: number) => void
): () => void {
  // ── Mobile: gyroscope ──────────────────────────────────────────────────────
  const onOrientation = (e: DeviceOrientationEvent) => {
    if (e.gamma === null || e.beta === null) return;

    // gamma: left/right tilt [-90, +90]
    // beta: front/back tilt [0, 180] (45° = natural phone holding angle)
    // We map +/- 45 degrees to the [-1, 1] range to match mouse sensitivity
    const rawX = Math.max(-1, Math.min(1, e.gamma / 45));
    const rawY = Math.max(-1, Math.min(1, (e.beta - 45) / 45));

    targetX = kfX.filter(rawX) * MAX_OFFSET * 2;
    targetY = kfY.filter(-rawY) * MAX_OFFSET * 2;
  };

  // ── Desktop: mouse ────────────────────────────────────────────────────────
  const onMouseMove = (e: MouseEvent) => {
    targetX = ((e.clientX / window.innerWidth) - 0.5) * MAX_OFFSET * 2;
    targetY = -((e.clientY / window.innerHeight) - 0.5) * MAX_OFFSET * 2;
  };

  // ── Touch: drag gesture ───────────────────────────────────────────────────
  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0];
    targetX = ((t.clientX / window.innerWidth) - 0.5) * MAX_OFFSET * 2;
    targetY = -((t.clientY / window.innerHeight) - 0.5) * MAX_OFFSET * 2;
  };

  window.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true });

  // iOS 13+ permission request
  if (
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof (DeviceOrientationEvent as any).requestPermission === 'function'
  ) {
    (window as any).__requestGyro = async () => {
      try {
        const permission = await (DeviceOrientationEvent as any).requestPermission();
        if (permission === 'granted') {
          window.addEventListener('deviceorientation', onOrientation, { passive: true });
          gyroGranted = true;
        }
      } catch (e) {
        console.warn('Gyroscope permission denied:', e);
      }
    };
  } else {
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
  }

  // ── Animation tick ─────────────────────────────────────────────────────────
  let rafId: number;
  function tick() {
    rafId = requestAnimationFrame(tick);
    currentX += (targetX - currentX) * LERP_SPEED;
    currentY += (targetY - currentY) * LERP_SPEED;

    camera.position.x = currentX * 0.2;
    camera.position.y = currentY * 0.2;
    // Always look at origin — produces natural rotational perspective
    camera.lookAt(0, 0, 0);

    onOffsetUpdate?.(currentX, currentY);
  }
  tick();

  return () => {
    cancelAnimationFrame(rafId);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('deviceorientation', onOrientation);
    kfX.reset();
    kfY.reset();
  };
}

export function isGyroGranted(): boolean {
  return gyroGranted;
}
