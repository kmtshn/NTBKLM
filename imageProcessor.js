/**
 * imageProcessor.js - Image Processing Module
 * 
 * Handles:
 * - Image loading from File objects
 * - Canvas-based image manipulation utilities
 * - Simple fallback background generation (local Canvas masking)
 *   Used only when AI background generation fails or is unavailable
 * - Image resizing for API payloads
 */

/**
 * Create a simple fallback background by masking text regions with edge-sampled colors.
 * This is a LOCAL-ONLY fallback used when AI image generation is unavailable.
 * The AI-generated background (via generateCleanBackground) is always preferred.
 * 
 * @param {HTMLCanvasElement} sourceCanvas - The original rendered page canvas
 * @param {Array} maskRects - Array of {x, y, width, height} rectangles to mask
 * @returns {string} Data URL of the background image with text masked
 */
export function createMaskedBackground(sourceCanvas, maskRects) {
  if (maskRects.length === 0) {
    return sourceCanvas.toDataURL('image/png');
  }

  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext('2d');

  // Draw original image
  ctx.drawImage(sourceCanvas, 0, 0);

  // Merge overlapping rects for cleaner processing
  const merged = mergeOverlappingRects(maskRects);

  // Fill each text region with surrounding color
  for (const rect of merged) {
    fillWithSurroundingColor(ctx, rect, canvas.width, canvas.height);
  }

  // Apply edge-blending using blur for each region
  try {
    const blurCanvas = document.createElement('canvas');
    blurCanvas.width = canvas.width;
    blurCanvas.height = canvas.height;
    const blurCtx = blurCanvas.getContext('2d');

    blurCtx.filter = 'blur(2px)';
    blurCtx.drawImage(canvas, 0, 0);
    blurCtx.filter = 'none';

    for (const rect of merged) {
      const x = Math.max(0, Math.round(rect.x) - 2);
      const y = Math.max(0, Math.round(rect.y) - 2);
      const w = Math.min(Math.round(rect.width) + 4, canvas.width - x);
      const h = Math.min(Math.round(rect.height) + 4, canvas.height - y);

      if (w > 0 && h > 0) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.drawImage(blurCanvas, x, y, w, h, x, y, w, h);
        ctx.restore();
      }
    }
  } catch (e) {
    // filter API not supported - skip blur pass
  }

  return canvas.toDataURL('image/png');
}

/**
 * Merge overlapping or very close rectangles to reduce artifacts.
 */
function mergeOverlappingRects(rects) {
  if (rects.length === 0) return [];

  const sorted = rects.map(r => ({
    x: r.x, y: r.y, width: r.width, height: r.height,
  })).sort((a, b) => a.y - b.y || a.x - b.x);

  const merged = [sorted[0]];
  const MARGIN = 4;

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const last = merged[merged.length - 1];

    if (
      curr.x <= last.x + last.width + MARGIN &&
      curr.y <= last.y + last.height + MARGIN &&
      curr.x + curr.width >= last.x - MARGIN &&
      curr.y + curr.height >= last.y - MARGIN
    ) {
      const newX = Math.min(last.x, curr.x);
      const newY = Math.min(last.y, curr.y);
      const newRight = Math.max(last.x + last.width, curr.x + curr.width);
      const newBottom = Math.max(last.y + last.height, curr.y + curr.height);
      last.x = newX;
      last.y = newY;
      last.width = newRight - newX;
      last.height = newBottom - newY;
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

/**
 * Fill a rectangle with colors sampled from its surrounding border pixels.
 */
function fillWithSurroundingColor(ctx, rect, canvasWidth, canvasHeight) {
  const x = Math.round(Math.max(0, rect.x));
  const y = Math.round(Math.max(0, rect.y));
  const w = Math.round(Math.min(rect.width, canvasWidth - x));
  const h = Math.round(Math.min(rect.height, canvasHeight - y));

  if (w <= 0 || h <= 0) return;

  const sampleDepth = 4;

  const topColor = sampleEdge(ctx, x, Math.max(0, y - sampleDepth), w, sampleDepth, canvasWidth, canvasHeight);
  const botColor = sampleEdge(ctx, x, Math.min(canvasHeight - sampleDepth, y + h), w, sampleDepth, canvasWidth, canvasHeight);
  const leftColor = sampleEdge(ctx, Math.max(0, x - sampleDepth), y, sampleDepth, h, canvasWidth, canvasHeight);
  const rightColor = sampleEdge(ctx, Math.min(canvasWidth - sampleDepth, x + w), y, sampleDepth, h, canvasWidth, canvasHeight);

  try {
    const gradient = ctx.createLinearGradient(x, y, x, y + h);
    gradient.addColorStop(0, `rgb(${topColor[0]}, ${topColor[1]}, ${topColor[2]})`);
    gradient.addColorStop(1, `rgb(${botColor[0]}, ${botColor[1]}, ${botColor[2]})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, w, h);

    const hGradient = ctx.createLinearGradient(x, y, x + w, y);
    hGradient.addColorStop(0, `rgba(${leftColor[0]}, ${leftColor[1]}, ${leftColor[2]}, 0.3)`);
    hGradient.addColorStop(1, `rgba(${rightColor[0]}, ${rightColor[1]}, ${rightColor[2]}, 0.3)`);
    ctx.fillStyle = hGradient;
    ctx.fillRect(x, y, w, h);
  } catch (e) {
    const avgColor = [
      Math.round((topColor[0] + botColor[0] + leftColor[0] + rightColor[0]) / 4),
      Math.round((topColor[1] + botColor[1] + leftColor[1] + rightColor[1]) / 4),
      Math.round((topColor[2] + botColor[2] + leftColor[2] + rightColor[2]) / 4),
    ];
    ctx.fillStyle = `rgb(${avgColor[0]}, ${avgColor[1]}, ${avgColor[2]})`;
    ctx.fillRect(x, y, w, h);
  }
}

/**
 * Sample average color from a rectangular edge region.
 */
function sampleEdge(ctx, x, y, w, h, canvasWidth, canvasHeight) {
  const sx = Math.max(0, Math.round(x));
  const sy = Math.max(0, Math.round(y));
  const sw = Math.max(1, Math.min(Math.round(w), canvasWidth - sx));
  const sh = Math.max(1, Math.min(Math.round(h), canvasHeight - sy));

  try {
    const data = ctx.getImageData(sx, sy, sw, sh).data;
    let r = 0, g = 0, b = 0, count = 0;

    const step = Math.max(1, Math.floor(data.length / (4 * 50)));
    for (let i = 0; i < data.length; i += 4 * step) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }

    if (count === 0) return [255, 255, 255];
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
  } catch (e) {
    return [255, 255, 255];
  }
}

/**
 * Load an image file into a Canvas and return page-like data.
 * 
 * @param {File} file - Image file (PNG, JPG, WEBP)
 * @returns {Promise<Object>} Page data object similar to PDF page data
 */
export async function loadImageAsPage(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  return {
    imageDataUrl: dataUrl,
    canvas,
    pdfWidth: img.width,
    pdfHeight: img.height,
    canvasWidth: img.width,
    canvasHeight: img.height,
    dpiScale: 1,
    rawTextItems: [],
    source: 'image',
  };
}

/**
 * Read a File as a data URL.
 */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Load an image from a URL/data URL.
 */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Resize a data URL image to fit within max dimensions.
 * Used to reduce API payload size.
 * 
 * @param {string} dataUrl - Source image data URL
 * @param {number} maxWidth - Maximum width
 * @param {number} maxHeight - Maximum height
 * @param {string} format - Output format ('image/png' or 'image/jpeg')
 * @param {number} quality - JPEG quality (0-1)
 * @returns {Promise<string>} Resized image data URL
 */
export async function resizeImage(dataUrl, maxWidth = 2048, maxHeight = 2048, format = 'image/jpeg', quality = 0.85) {
  const img = await loadImage(dataUrl);

  let { width, height } = img;
  if (width > maxWidth || height > maxHeight) {
    const ratio = Math.min(maxWidth / width, maxHeight / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  return canvas.toDataURL(format, quality);
}

/**
 * Extract the base64 data from a data URL string.
 * @param {string} dataUrl 
 * @returns {string} base64 string
 */
export function dataUrlToBase64(dataUrl) {
  return dataUrl.split(',')[1];
}

/**
 * Detect the MIME type from a data URL.
 * @param {string} dataUrl
 * @returns {string} MIME type (e.g. 'image/png')
 */
export function dataUrlToMimeType(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);/);
  return match ? match[1] : 'image/png';
}

/**
 * Convert a data URL to a Blob.
 * @param {string} dataUrl 
 * @returns {Blob}
 */
export function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime = parts[0].match(/:(.*?);/)[1];
  const bstr = atob(parts[1]);
  const u8arr = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) {
    u8arr[i] = bstr.charCodeAt(i);
  }
  return new Blob([u8arr], { type: mime });
}
