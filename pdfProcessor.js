/**
 * pdfProcessor.js - PDF Parsing & Text Extraction Module
 * 
 * Handles:
 * - PDF.js page rendering to Canvas
 * - Text content extraction with transform/coordinate info
 * - Coordinate normalization to relative (0-1) space
 * - Text grouping into logical lines
 */

/**
 * Parse a PDF file and extract all page data.
 * @param {File} file - The PDF file
 * @param {number} dpiScale - Rendering scale factor (1, 2, or 3)
 * @param {function} onProgress - Progress callback (pageIndex, totalPages)
 * @returns {Promise<Array<PageData>>} Array of page data objects
 */
export async function parsePdf(file, dpiScale = 2, onProgress = null) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;
  const pages = [];

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const pageData = await extractPageData(page, dpiScale);
    pages.push(pageData);

    if (onProgress) onProgress(i, totalPages);
  }

  return pages;
}

/**
 * Extract rendering and text data from a single PDF page.
 */
async function extractPageData(page, dpiScale) {
  const viewport = page.getViewport({ scale: dpiScale });
  const pdfWidth = viewport.width / dpiScale;
  const pdfHeight = viewport.height / dpiScale;

  // Render page to canvas
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');

  await page.render({
    canvasContext: ctx,
    viewport: viewport,
  }).promise;

  const imageDataUrl = canvas.toDataURL('image/png');

  // Extract text content
  const textContent = await page.getTextContent();
  const rawTextItems = extractTextItems(textContent, viewport, dpiScale, pdfWidth, pdfHeight);

  return {
    imageDataUrl,
    canvas,
    pdfWidth,       // Original PDF page width (in PDF points)
    pdfHeight,      // Original PDF page height (in PDF points)
    canvasWidth: viewport.width,
    canvasHeight: viewport.height,
    dpiScale,
    rawTextItems,   // Raw extracted text items with absolute PDF coordinates
    source: 'pdf',
  };
}

/**
 * Extract text items from PDF.js text content with coordinate info.
 * PDF coordinate system: origin at bottom-left, Y increases upward.
 * We convert to top-left origin for consistency.
 */
function extractTextItems(textContent, viewport, dpiScale, pdfWidth, pdfHeight) {
  const items = [];

  for (const item of textContent.items) {
    if (!item.str || item.str.trim() === '') continue;

    const tx = item.transform;
    // transform = [scaleX, skewY, skewX, scaleY, translateX, translateY]
    // tx[4] = x position, tx[5] = y position (bottom-left origin in PDF)
    // tx[0] = horizontal scale (≈ font size * horizontal scaling)
    // tx[3] = vertical scale (can be negative)

    const fontSize = Math.abs(tx[3]); // Approximate font size from transform
    const x = tx[4];
    // Convert from bottom-left to top-left coordinate system
    const y = pdfHeight - tx[5];

    // Width from PDF.js
    const textWidth = item.width;
    // Height approximation from font size
    const textHeight = fontSize;

    // Detect bold from font name heuristic
    const fontName = item.fontName || '';
    const bold = /bold|heavy|black/i.test(fontName);

    items.push({
      text: item.str,
      x,              // Left edge (PDF points, top-left origin)
      y: y - fontSize, // Top edge (adjusted for baseline→top)
      width: textWidth,
      height: textHeight,
      fontSize,
      bold,
      fontName,
      // Store raw transform for advanced processing
      _transform: tx,
    });
  }

  return items;
}

/**
 * Normalize text items to relative coordinates (0-1).
 * This removes page-size dependency and prepares for scaling to any output size.
 * 
 * @param {Array} textItems - Raw text items with absolute coordinates
 * @param {number} pageWidth - PDF page width in points
 * @param {number} pageHeight - PDF page height in points
 * @returns {Array} Normalized text items with relative coordinates
 */
export function normalizeCoordinates(textItems, pageWidth, pageHeight) {
  return textItems.map(item => ({
    ...item,
    relX: item.x / pageWidth,
    relY: item.y / pageHeight,
    relWidth: item.width / pageWidth,
    relHeight: item.height / pageHeight,
    relFontSize: item.fontSize / pageHeight,
  }));
}

/**
 * Generate bounding boxes for text masking.
 * Returns rectangles in canvas pixel coordinates (for Canvas API drawing).
 * 
 * @param {Array} textItems - Raw text items with absolute coordinates
 * @param {number} dpiScale - The DPI scale used for rendering
 * @param {number} paddingPx - Extra padding around each text box (in canvas px)
 * @returns {Array} Array of {x, y, width, height} in canvas pixel coordinates
 */
export function generateMaskRects(textItems, dpiScale, paddingPx = 2) {
  return textItems.map(item => {
    const x = Math.max(0, item.x * dpiScale - paddingPx);
    const y = Math.max(0, item.y * dpiScale - paddingPx);
    const w = item.width * dpiScale + paddingPx * 2;
    const h = item.height * dpiScale + paddingPx * 2;
    return { x, y, width: w, height: h };
  });
}

/**
 * Group nearby text items into logical lines.
 * Items on the same line share similar Y coordinates.
 * Then merge items within each line left-to-right.
 * 
 * @param {Array} normalizedItems - Items with relX, relY, etc.
 * @param {number} lineThreshold - Relative Y distance to consider same line (0-1)
 * @returns {Array} Grouped line objects
 */
export function groupTextIntoLines(normalizedItems, lineThreshold = 0.005) {
  if (normalizedItems.length === 0) return [];

  // Sort by Y then X
  const sorted = [...normalizedItems].sort((a, b) => {
    const dy = a.relY - b.relY;
    if (Math.abs(dy) > lineThreshold) return dy;
    return a.relX - b.relX;
  });

  const lines = [];
  let currentLine = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentLine[currentLine.length - 1];
    const curr = sorted[i];

    // Same line if Y coordinates are close enough
    if (Math.abs(curr.relY - prev.relY) <= lineThreshold) {
      currentLine.push(curr);
    } else {
      lines.push(buildLineObject(currentLine));
      currentLine = [curr];
    }
  }

  if (currentLine.length > 0) {
    lines.push(buildLineObject(currentLine));
  }

  return lines;
}

/**
 * Build a merged line object from an array of text items on the same line.
 */
function buildLineObject(items) {
  // Sort left-to-right
  items.sort((a, b) => a.relX - b.relX);

  // Merge text with space detection
  let mergedText = '';
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      const prevEnd = items[i - 1].relX + items[i - 1].relWidth;
      const currStart = items[i].relX;
      const gap = currStart - prevEnd;
      // If gap is significant, add space
      if (gap > 0.005) {
        mergedText += ' ';
      }
    }
    mergedText += items[i].text;
  }

  // Bounding box of the entire line
  const minX = Math.min(...items.map(it => it.relX));
  const minY = Math.min(...items.map(it => it.relY));
  const maxX = Math.max(...items.map(it => it.relX + it.relWidth));
  const maxY = Math.max(...items.map(it => it.relY + it.relHeight));

  // Dominant font size (most common or largest)
  const fontSize = Math.max(...items.map(it => it.relFontSize));
  const bold = items.some(it => it.bold);

  return {
    text: mergedText,
    relX: minX,
    relY: minY,
    relWidth: maxX - minX,
    relHeight: maxY - minY,
    relFontSize: fontSize,
    bold,
    itemCount: items.length,
    items, // Keep original items for reference
  };
}

/**
 * Group lines into paragraphs (lines that are vertically adjacent with small gaps).
 * 
 * @param {Array} lines - Grouped line objects
 * @param {number} paragraphThreshold - Relative Y gap threshold for paragraph break
 * @returns {Array} Paragraph objects with combined text and bounding boxes
 */
export function groupLinesIntoParagraphs(lines, paragraphThreshold = 0.02) {
  if (lines.length === 0) return [];

  // Sort by Y position
  const sorted = [...lines].sort((a, b) => a.relY - b.relY);

  const paragraphs = [];
  let currentPara = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prevLine = currentPara[currentPara.length - 1];
    const currLine = sorted[i];

    const gap = currLine.relY - (prevLine.relY + prevLine.relHeight);
    const xOverlap =
      currLine.relX < prevLine.relX + prevLine.relWidth &&
      currLine.relX + currLine.relWidth > prevLine.relX;

    // Same paragraph if gap is small and there's horizontal overlap
    if (gap < paragraphThreshold && gap >= -0.005 && xOverlap) {
      currentPara.push(currLine);
    } else {
      paragraphs.push(buildParagraph(currentPara));
      currentPara = [currLine];
    }
  }

  if (currentPara.length > 0) {
    paragraphs.push(buildParagraph(currentPara));
  }

  return paragraphs;
}

/**
 * Build a paragraph from an array of line objects.
 */
function buildParagraph(lines) {
  const text = lines.map(l => l.text).join('\n');

  const minX = Math.min(...lines.map(l => l.relX));
  const minY = Math.min(...lines.map(l => l.relY));
  const maxX = Math.max(...lines.map(l => l.relX + l.relWidth));
  const maxY = Math.max(...lines.map(l => l.relY + l.relHeight));

  const fontSize = Math.max(...lines.map(l => l.relFontSize));
  const bold = lines.some(l => l.bold);

  return {
    text,
    relX: minX,
    relY: minY,
    relWidth: maxX - minX,
    relHeight: maxY - minY,
    relFontSize: fontSize,
    bold,
    lineCount: lines.length,
    lines,
  };
}
