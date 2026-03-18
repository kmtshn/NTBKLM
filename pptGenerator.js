/**
 * pptGenerator.js - PPTX Generation Module
 * 
 * Core Design: 2-Layer Structure
 *   Layer 1: Background image (text removed)
 *   Layer 2: Editable text boxes (positioned with original coordinates)
 * 
 * This ensures the output PPTX is:
 *   - Visually identical to the source
 *   - Fully editable (text can be selected, modified, copied)
 *   - Properly structured (not just an image paste)
 */

// PptxGenJS is loaded globally via CDN
// const PptxGenJS = window.PptxGenJS;

/**
 * Slide dimensions in inches for standard sizes.
 */
const SLIDE_SIZES = {
  '16:9': { width: 13.333, height: 7.5 },
  '4:3':  { width: 10, height: 7.5 },
};

/**
 * Generate a PPTX file from processed page data.
 * 
 * @param {Array<ProcessedPage>} pages - Array of processed page data
 * @param {Object} options - Generation options
 * @param {string} options.slideSize - '16:9', '4:3', or 'auto'
 * @param {function} options.onProgress - Progress callback (pageIndex, totalPages)
 * @param {function} options.onLog - Logging callback
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
    addTextLayer(slide, page, dimensions, onLog);

    if (onProgress) onProgress(i + 1, pages.length);
  }

  onLog('PPTXファイルを書き出し中...');

  // Generate file
  const blob = await pptx.write({ outputType: 'blob' });

  onLog(`PPTX生成完了 (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
  return blob;
}

/**
 * Calculate optimal slide dimensions based on content.
 */
function calculateSlideDimensions(pages, slideSize) {
  if (slideSize !== 'auto' && SLIDE_SIZES[slideSize]) {
    return { ...SLIDE_SIZES[slideSize], label: slideSize };
  }

  // Auto-detect from first page aspect ratio
  if (pages.length > 0) {
    const page = pages[0];
    const aspectRatio = page.pdfWidth / page.pdfHeight;

    if (aspectRatio > 1.5) {
      return { ...SLIDE_SIZES['16:9'], label: '16:9 (自動)' };
    } else if (aspectRatio > 1.2) {
      return { ...SLIDE_SIZES['4:3'], label: '4:3 (自動)' };
    } else if (aspectRatio < 0.8) {
      // Portrait - use custom size
      const height = 10;
      const width = height * aspectRatio;
      return { width, height, label: `カスタム (${width.toFixed(1)}:${height.toFixed(1)})` };
    } else {
      // Near square
      return { width: 10, height: 10 / aspectRatio, label: 'カスタム' };
    }
  }

  return { ...SLIDE_SIZES['16:9'], label: '16:9 (デフォルト)' };
}

/**
 * LAYER 1: Add background image to slide.
 * The background image has text regions removed/inpainted.
 */
function addBackgroundLayer(slide, page, dimensions) {
  if (!page.backgroundImageDataUrl) return;

  // Add as full-slide background image
  slide.addImage({
    data: page.backgroundImageDataUrl,
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
 * Each text element is positioned at its original coordinates.
 */
function addTextLayer(slide, page, dimensions, onLog) {
  const textBlocks = page.textBlocks || [];

  if (textBlocks.length === 0) {
    onLog('  テキストブロックなし - 背景のみ');
    return;
  }

  let placedCount = 0;

  for (const block of textBlocks) {
    try {
      addTextBox(slide, block, dimensions);
      placedCount++;
    } catch (err) {
      onLog(`  テキスト配置エラー: ${err.message}`, 'warn');
    }
  }

  onLog(`  ${placedCount}個のテキストボックスを配置`);
}

/**
 * Add a single text box to a slide with precise positioning.
 * 
 * @param {Object} slide - PptxGenJS slide object
 * @param {Object} block - Text block with relative coordinates
 * @param {Object} dimensions - Slide dimensions in inches
 */
function addTextBox(slide, block, dimensions) {
  // Convert relative coordinates to absolute inches
  const x = block.relX * dimensions.width;
  const y = block.relY * dimensions.height;
  const w = Math.max(block.relWidth * dimensions.width, 0.5); // Minimum width 0.5 inches
  const h = Math.max(block.relHeight * dimensions.height, 0.2); // Minimum height 0.2 inches

  // Calculate font size in points
  // relFontSize is relative to page height
  // Convert: relFontSize * slide height (inches) * 72 (points per inch)
  let fontSize = block.relFontSize * dimensions.height * 72;

  // Clamp font size to reasonable range
  fontSize = Math.max(6, Math.min(72, fontSize));

  // If we have an explicit fontSize from OCR (in points), prefer it
  if (block.fontSize && block.fontSize > 0) {
    // Scale the OCR fontSize relative to original vs slide dimensions
    const scaleFactor = dimensions.height / (block.originalPageHeight || 792); // 792 = letter height in points
    fontSize = block.fontSize * scaleFactor;
    fontSize = Math.max(6, Math.min(72, fontSize));
  }

  // Build text options
  const textOptions = {
    x,
    y,
    w,
    h: h + 0.1, // Add slight extra height to prevent clipping
    fontSize,
    fontFace: 'Arial',
    color: '000000',
    bold: block.bold || false,
    valign: 'top',
    align: detectAlignment(block),
    wrap: true,
    shrinkText: false,
    // Make background transparent so Layer 1 shows through
    fill: { color: 'FFFFFF', transparency: 100 },
    // No border
    line: { width: 0 },
    // Minimal margins to match positioning
    margin: [0, 0, 0, 0],
    // Paragraph spacing
    paraSpaceBefore: 0,
    paraSpaceAfter: 0,
    lineSpacingMultiple: 1.0,
  };

  // Handle multi-line text
  const text = block.text || '';

  if (text.includes('\n')) {
    // Multi-line: create text runs for each line
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
          fontFace: 'Arial',
          color: '000000',
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
 * Detect text alignment based on position.
 * Center-aligned text tends to be centered on the page.
 * Right-aligned text tends to be at the right side.
 */
function detectAlignment(block) {
  const centerX = block.relX + block.relWidth / 2;

  // If the text block is narrow and centered
  if (block.relWidth < 0.4 && Math.abs(centerX - 0.5) < 0.1) {
    return 'center';
  }

  // If text starts far right
  if (block.relX > 0.6 && block.relWidth < 0.35) {
    return 'right';
  }

  return 'left';
}

/**
 * Trigger download of the generated PPTX blob.
 * 
 * @param {Blob} blob - PPTX file blob
 * @param {string} filename - Download filename
 */
export function downloadPptx(blob, filename = 'converted.pptx') {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Revoke after a delay to ensure download starts
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
