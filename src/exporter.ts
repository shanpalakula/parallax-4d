export async function recordParallaxVideo(
  canvas: HTMLCanvasElement,
  durationMs: number = 4000,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // 60 fps capture
    const stream = canvas.captureStream(60);
    
    // Try to get highest quality codec
    const mimeTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    
    let selectedMimeType = '';
    for (const mime of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mime)) {
        selectedMimeType = mime;
        break;
      }
    }

    if (!selectedMimeType) {
      return reject(new Error('No supported video mime type found for MediaRecorder'));
    }

    const recorder = new MediaRecorder(stream, {
      mimeType: selectedMimeType,
      videoBitsPerSecond: 12_000_000 // 12 Mbps for high quality
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: selectedMimeType });
      resolve(blob);
    };

    recorder.start(100); // Collect data every 100ms

    const startTime = performance.now();
    
    function checkProgress() {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / durationMs, 1.0);
      if (onProgress) {
        onProgress(progress);
      }
      
      if (progress < 1.0) {
        requestAnimationFrame(checkProgress);
      }
    }
    
    if (onProgress) requestAnimationFrame(checkProgress);

    setTimeout(() => {
      recorder.stop();
    }, durationMs);
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
