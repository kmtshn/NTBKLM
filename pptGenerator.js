/**
 * pptGenerator.js - PPTX Generation Module
 * 
 * Core Design: 2-Layer Structure per slide
 *   Layer 1: Background image (original slide with text removed, or original as-is)
 *   Layer 2: Editable text boxes (positioned with OCR-detected coordinates)
 * 
 * This ensures the output PPTX is:
 *   - Visually close to the source
 *   - Fully editable (text can be selected, modified, copied)
 *   - Properly structured (not just an image paste)
 */

// PptxGenJS is loaded globally via CDN

const SLIDE_SIZES = {
  '16:9': { width: 13.333, height: 7.5 },
  '4:3':  { width: 10, height: 7.5 },
};

/**
 * Generate a PPTX file from processed page data.
 * 
 * @param {Array<Object>} pages - Array of processed page data
 * @param {Object} options - Generation options
 * @returns {Promise<Blob>} PPTX file as Blob
 */
export async function generatePptx(pages, options = {}) {
  const { slideSize = 'auto', onProgress, onLog = () => {} } = options;

  onLog('PPTX生成を開始...');

  // Determine slide dimensions
  const dimensions = calculateSlideDimensions(pages, slideSize);
  onLog(`スライドサイズ: ${dimensions.width.toFixed(2)}" × ${dimensions.height.toFixed(2)}" (${dimensions.label})`);

  // Create presentation
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: 'CUSTOM',
    width: dimensions.width,
    height: dimensions.height,
  });
  pptx.layout = 'CUSTOM';

  // Process each page
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    onLog(`スライド ${i + 1}/${pages.length} を生成中...`);

    const slide = pptx.addSlide();

    // === LAYER 1: Background Image ===
    addBackgroundLayer(slide, page, dimensions);

    // === LAYER 2: Text Boxes ===
    const placedCount = addTextLayer(slide, page, dimensions, onLog);
    onLog(`  テキストボックス: ${placedCount}個配置`);

    if (onProgress) onProgress(i + 1, pages.length);
  }

  onLog('PPTXファイルを書き出し中...');

  // Generate file
  const blob = await pptx.write({ outputType: 'blob' });

  const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
  onLog(`PPTX生成完了 (${sizeMB} MB, ${pages.length}スライド)`);
  return blob;
}

/**
 * Calculate optimal slide dimensions.
 */
function calculateSlideDimensions(pages, slideSize) {
  if (slideSize !== 'auto' && SLIDE_SIZES[slideSize]) {
    return { ...SLIDE_SIZES[slideSize], label: slideSize };
  }

  // Auto-detect from first page aspect ratio
  if (pages.length > 0) {
    const page = pages[0];
    let aspectRatio;

    if (page.canvasWidth && page.canvasHeight) {
      aspectRatio = page.canvasWidth / page.canvasHeight;
    } else if (page.pdfWidth && page.pdfHeight) {
      aspectRatio = page.pdfWidth / page.pdfHeight;
    } else {
      aspectRatio = 16 / 9;
    }

    if (aspectRatio > 1.6) {
      return { ...SLIDE_SIZES['16:9'], label: '16:9 (自動検出)' };
    } else if (aspectRatio > 1.2) {
      return { ...SLIDE_SIZES['4:3'], label: '4:3 (自動検出)' };
    } else if (aspectRatio < 0.8) {
      // Portrait
      const height = 10;
      const width = height * aspectRatio;
      return { width, height, label: `縦向き (自動)` };
    } else {
      return { width: 10, height: 10 / aspectRatio, label: 'カスタム (自動)' };
    }
  }

  return { ...SLIDE_SIZES['16:9'], label: '16:9 (デフォルト)' };
}

/**
 * LAYER 1: Add background image to slide.
 */
function addBackgroundLayer(slide, page, dimensions) {
  const imgSrc = page.backgroundImageDataUrl || page.imageDataUrl;
  if (!imgSrc) return;

  slide.addImage({
    data: imgSrc,
    x: 0,
    y: 0,
    w: dimensions.width,
    h: dimensions.height,
    sizing: {
      type: 'cover',
      w: dimensions.width,
      h: dimensions.height,
    },
  });
}

/**
 * LAYER 2: Add editable text boxes to slide.
 * Returns count of placed text boxes.
 */
function addTextLayer(slide, page, dimensions, onLog) {
  const textBlocks = page.textBlocks || [];
  if (textBlocks.length === 0) return 0;

  let placedCount = 0;

  for (const block of textBlocks) {
    try {
      addTextBox(slide, block, dimensions);
      placedCount++;
    } catch (err) {
      // Skip individual text box errors silently
    }
  }

  return placedCount;
}

/**
 * Add a single text box to a slide with precise positioning.
 */
function addTextBox(slide, block, dimensions) {
  // Convert relative coordinates (0-1) to absolute inches
  const x = clamp(block.relX * dimensions.width, 0, dimensions.width);
  const y = clamp(block.relY * dimensions.height, 0, dimensions.height);
  const w = clamp(block.relWidth * dimensions.width, 0.3, dimensions.width - x);
  const h = clamp(block.relHeight * dimensions.height, 0.15, dimensions.height - y);

  // Font size calculation
  let fontSize;
  if (block.fontSize && block.fontSize > 0) {
    fontSize = block.fontSize;
  } else {
    // Estimate from relative height
    fontSize = block.relFontSize * dimensions.height * 72;
  }
  fontSize = clamp(fontSize, 6, 72);

  // Parse color
  let textColor = '000000';
  if (block.color) {
    textColor = block.color.replace('#', '');
    if (textColor.length !== 6) textColor = '000000';
  }

  // Build text content
  const text = block.text || '';
  if (!text.trim()) return;

  // Detect alignment
  const align = detectAlignment(block, dimensions);

  // Choose font face based on content
  const fontFace = containsJapanese(text) ? 'Meiryo' : 'Arial';

  // Build text options
  const textOptions = {
    x,
    y,
    w,
    h: h + 0.05,
    fontSize,
    fontFace,
    color: textColor,
    bold: block.bold || false,
    valign: 'top',
    align,
    wrap: true,
    shrinkText: false,
    fill: { color: 'FFFFFF', transparency: 100 },
    line: { width: 0 },
    margin: [0, 2, 0, 2],
    paraSpaceBefore: 0,
    paraSpaceAfter: 0,
    lineSpacingMultiple: 1.1,
  };

  // Handle text content (may contain newlines)
  if (text.includes('\n')) {
    const lines = text.split('\n');
    const textRuns = [];

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        textRuns.push({ text: '\n', options: { fontSize, breakType: 'break' } });
      }
      textRuns.push({
        text: lines[i],
        options: {
          fontSize,
          fontFace,
          color: textColor,
          bold: block.bold || false,
        }
      });
    }
    slide.addText(textRuns, textOptions);
  } else {
    slide.addText(text, textOptions);
  }
}

/**
 * Detect text alignment based on position and type.
 */
function detectAlignment(block, dimensions) {
  // If block has explicit type info
  if (block.type === 'heading') {
    const centerX = block.relX + block.relWidth / 2;
    if (Math.abs(centerX - 0.5) < 0.15) return 'center';
  }

  // If centered horizontally on the slide
  const centerX = block.relX + block.relWidth / 2;
  if (block.relWidth < 0.5 && Math.abs(centerX - 0.5) < 0.08) {
    return 'center';
  }

  // If text starts far right
  if (block.relX > 0.65 && block.relWidth < 0.3) {
    return 'right';
  }

  return 'left';
}

/**
 * Check if text contains Japanese characters.
 */
function containsJapanese(text) {
  return /[\u3000-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]/.test(text);
}

/**
 * Clamp a value between min and max.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Trigger download of the generated PPTX blob.
 */
export function downloadPptx(blob, filename = 'converted.pptx') {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
