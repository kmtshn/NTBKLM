/**
 * main.js - Application Orchestrator
 * 
 * Unified conversion pipeline for 3 input types:
 * 
 *   PPTX Input (image-only slides):
 *     1. Parse PPTX (JSZip) -> extract slide images
 *     2. For each slide image:
 *        a. OCR via GPT-4o Vision -> text items with coordinates
 *        b. Generate clean background via GPT Image API (text removed)
 *        c. Generate 2-layer PPTX slide
 * 
 *   PDF Input:
 *     1. Parse PDF (PDF.js) -> render to Canvas + extract text
 *     2. For each page:
 *        a. If PDF has text -> use PDF.js text data
 *        b. If PDF has no text (scanned) -> OCR via GPT-4o Vision
 *        c. Generate clean background via GPT Image API
 *        d. Generate 2-layer PPTX slide
 * 
 *   Image Input:
 *     1. Load image -> Canvas
 *     2. OCR via GPT-4o Vision -> text items
 *     3. Generate clean background via GPT Image API
 *     4. Generate 2-layer PPTX slide
 * 
 * Background Strategy:
 *   - PRIMARY: AI background generation (gpt-image-1) - creates a new image
 *     that looks like the original slide but with all text removed
 *   - FALLBACK: Local Canvas masking (edge-color fill) - used only when
 *     AI generation fails or API key is unavailable
 */

import { UIController } from './ui.js';
import { parsePptx } from './pptxParser.js';
import {
  parsePdf,
  normalizeCoordinates,
  generateMaskRects,
  groupTextIntoLines,
  groupLinesIntoParagraphs,
} from './pdfProcessor.js';
import {
  loadImageAsPage,
  createMaskedBackground,
  resizeImage,
  dataUrlToBase64,
  dataUrlToMimeType,
} from './imageProcessor.js';
import {
  performOcr,
  generateCleanBackground,
} from './openaiClient.js';
import {
  generatePptx,
  downloadPptx,
} from './pptGenerator.js';

// Initialize UI
const ui = new UIController();
let generatedBlob = null;
let sourceFileName = '';

// Wire up callbacks
ui.onConvert = () => startConversion();
ui.onDownload = () => {
  if (generatedBlob) {
    const baseName = sourceFileName.replace(/\.[^/.]+$/, '') || 'converted';
    downloadPptx(generatedBlob, `${baseName}_editable.pptx`);
    ui.showToast('PPTXファイルをダウンロードしました', 'success');
  }
};

/**
 * Main conversion pipeline.
 */
async function startConversion() {
  const file = ui.getFile();
  const apiKey = ui.getApiKey();

  if (!file) {
    ui.showToast('ファイルを選択してください', 'warning');
    return;
  }

  // Determine file type
  const isPptx = file.name.toLowerCase().endsWith('.pptx') ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const isPdf = file.type === 'application/pdf';
  const isImage = file.type.startsWith('image/');

  // PPTX and Image inputs always require OCR -> API key required
  if ((isPptx || isImage) && !apiKey) {
    ui.showToast('PPTX・画像ファイルの変換にはOpenAI APIキーが必要です（OCR処理のため）。APIキーを保存してから再度お試しください。', 'error', 8000);
    return;
  }

  // PDF without API key: local-only mode
  if (isPdf && !apiKey) {
    ui.showToast('APIキー未設定のためローカルモードで変換します。スキャンPDFの場合はAPIキーが必要です。', 'warning', 6000);
  }

  sourceFileName = file.name;
  generatedBlob = null;
  ui.setProcessing(true);
  ui.resetStatus();
  ui.setProgress(0);

  const slideSize = ui.getSlideSize();
  const dpiScale = ui.getDpiScale();

  const log = (msg, level) => ui.log(msg, level);

  try {
    let pages;

    if (isPptx) {
      pages = await processPptx(file, apiKey, log);
    } else if (isPdf) {
      pages = await processPdf(file, dpiScale, apiKey, log);
    } else if (isImage) {
      pages = await processImage(file, apiKey, log);
    } else {
      throw new Error('サポートされていないファイル形式です');
    }

    // Show previews
    ui.showPreviews(pages);

    // Coordinate conversion step
    ui.setStepStatus('convert', 'active');
    log('座標変換を実行中...');
    ui.setStepStatus('convert', 'completed');
    ui.setProgress(85);

    // PPTX Generation
    ui.setStepStatus('generate', 'active');
    log('PPTX生成を開始...');

    generatedBlob = await generatePptx(pages, {
      slideSize,
      onProgress: (current, total) => {
        ui.setProgress(85 + (current / total) * 15);
      },
      onLog: log,
    });

    ui.setStepStatus('generate', 'completed');
    ui.setProgress(100);

    ui.showDownloadButton();
    ui.showToast('変換が完了しました！PPTXをダウンロードできます。', 'success', 6000);
    log('=== 変換完了 ===', 'success');

  } catch (err) {
    log(`エラー: ${err.message}`, 'error');
    ui.showToast(`変換に失敗しました: ${err.message}`, 'error', 8000);
    console.error(err);
  } finally {
    ui.setProcessing(false);
  }
}

// ======================================================================
// AI Background Generation (shared helper)
// ======================================================================

/**
 * Generate a clean background image using AI, with local fallback.
 * 
 * @param {string} apiKey - OpenAI API key
 * @param {string} imageDataUrl - Original image data URL
 * @param {HTMLCanvasElement|null} canvas - Canvas element for local fallback
 * @param {Array} ocrItems - OCR items for local fallback mask rects
 * @param {function} log - Logging callback
 * @returns {Promise<string>} Background image data URL
 */
async function generateBackground(apiKey, imageDataUrl, canvas, ocrItems, log) {
  if (!apiKey) {
    log('  APIキーなし：ローカルマスキングで背景生成');
    return localFallbackBackground(canvas, ocrItems, log);
  }

  try {
    // Resize image for API (gpt-image-1 accepts up to 50MB but smaller = faster)
    const resized = await resizeImage(imageDataUrl, 2048, 2048, 'image/png', 1.0);
    const base64 = dataUrlToBase64(resized);
    const mimeType = dataUrlToMimeType(resized);

    const bgDataUrl = await generateCleanBackground(apiKey, base64, mimeType, log);
    return bgDataUrl;
  } catch (err) {
    log(`  AI背景生成失敗: ${err.message}`, 'warn');
    log('  ローカルマスキングにフォールバック...', 'warn');
    return localFallbackBackground(canvas, ocrItems, log);
  }
}

/**
 * Local fallback: create background using Canvas edge-color fill.
 */
function localFallbackBackground(canvas, ocrItems, log) {
  if (!canvas || !ocrItems || ocrItems.length === 0) {
    if (canvas) return canvas.toDataURL('image/png');
    return null;
  }

  const maskRects = ocrItems.map(item => ({
    x: (item.relX || item.x || 0) * canvas.width,
    y: (item.relY || item.y || 0) * canvas.height,
    width: (item.relWidth || item.width || 0.1) * canvas.width,
    height: (item.relHeight || item.height || 0.03) * canvas.height,
  }));

  const bg = createMaskedBackground(canvas, maskRects);
  log('  ローカルマスキングで背景生成完了');
  return bg;
}

// ======================================================================
// PPTX Processing Pipeline
// ======================================================================

async function processPptx(file, apiKey, log) {
  // STEP 1: Parse PPTX
  ui.setStepStatus('parse', 'active');
  log('PPTX解析を開始...');

  const { slides, slideDimensions } = await parsePptx(file, log, (current, total) => {
    ui.setProgress((current / total) * 10);
  });

  log(`PPTX解析完了: ${slides.length}スライド`, 'success');
  ui.setStepStatus('parse', 'completed');
  ui.setProgress(10);

  const processedPages = [];

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const baseProgress = 10 + (i / slides.length) * 75;
    log(`--- スライド ${i + 1}/${slides.length} ---`);

    // Image-only slide -> OCR required (most PPTX cases with Galaxy-type files)
    if (!slide.imageDataUrl) {
      log(`  スライド ${i + 1}: 画像なし、スキップ`, 'warn');
      continue;
    }

    if (slide.hasEmbeddedText && slide.rawTextItems && slide.rawTextItems.length > 5) {
      log(`  埋め込みテキスト使用: ${slide.rawTextItems.length}要素`);
      const page = await processSlideWithText(slide, apiKey, log);
      processedPages.push(page);
    } else {
      log(`  画像ベーススライド → OCR + AI背景生成`);
      const page = await processSlideWithOcr(slide, apiKey, log);
      processedPages.push(page);
    }

    // Update status steps on first iteration
    if (i === 0) {
      ui.setStepStatus('normalize', 'completed');
      ui.setStepStatus('mask', 'completed');
      ui.setStepStatus('background', 'completed');
      ui.setStepStatus('structure', 'completed');
    }

    ui.setProgress(baseProgress + (75 / slides.length));
  }

  return processedPages;
}

/**
 * Process a PPTX slide that has embedded text.
 */
async function processSlideWithText(slide, apiKey, log) {
  const normalizedItems = slide.rawTextItems;

  // Background generation: AI-based
  ui.setStepStatus('background', 'active');
  const backgroundImageDataUrl = await generateBackground(
    apiKey, slide.imageDataUrl, slide.canvas, normalizedItems, log
  );
  ui.setStepStatus('background', 'completed');

  // Build text blocks
  const textBlocks = normalizedItems.map(item => ({
    text: item.text,
    relX: item.relX,
    relY: item.relY,
    relWidth: item.relWidth,
    relHeight: item.relHeight,
    relFontSize: item.relFontSize,
    fontSize: item.fontSize,
    bold: item.bold,
    color: item.color,
    type: item.type,
  }));

  return {
    ...slide,
    backgroundImageDataUrl,
    textBlocks,
  };
}

/**
 * Process a PPTX slide that is image-only (requires OCR).
 */
async function processSlideWithOcr(slide, apiKey, log) {
  // Resize image for OCR API
  const resizedForOcr = await resizeImage(slide.imageDataUrl, 2048, 2048, 'image/jpeg', 0.90);
  const imageBase64 = dataUrlToBase64(resizedForOcr);

  // STEP: OCR
  ui.setStepStatus('normalize', 'active');
  let ocrItems;
  try {
    ocrItems = await performOcr(apiKey, imageBase64, log);
  } catch (err) {
    log(`  OCR失敗: ${err.message}`, 'error');
    return {
      ...slide,
      backgroundImageDataUrl: slide.imageDataUrl,
      textBlocks: [],
    };
  }
  ui.setStepStatus('normalize', 'completed');

  // STEP: Background generation (AI-based)
  ui.setStepStatus('background', 'active');
  log('  AI背景画像を生成中...');
  const backgroundImageDataUrl = await generateBackground(
    apiKey, slide.imageDataUrl, slide.canvas, ocrItems, log
  );
  ui.setStepStatus('background', 'completed');

  // STEP: Structure text
  ui.setStepStatus('structure', 'active');
  const textBlocks = ocrItems.map(item => ({
    text: item.text,
    relX: item.relX,
    relY: item.relY,
    relWidth: item.relWidth,
    relHeight: item.relHeight,
    relFontSize: item.relFontSize,
    fontSize: item.fontSize,
    bold: item.bold,
    color: item.color,
    type: item.type,
  }));

  log(`  テキストブロック: ${textBlocks.length}個`);
  ui.setStepStatus('structure', 'completed');

  return {
    ...slide,
    backgroundImageDataUrl,
    textBlocks,
  };
}

// ======================================================================
// PDF Processing Pipeline
// ======================================================================

async function processPdf(file, dpiScale, apiKey, log) {
  // STEP 1: Parse PDF
  ui.setStepStatus('parse', 'active');
  log('PDF解析を開始...');

  const rawPages = await parsePdf(file, dpiScale, (current, total) => {
    log(`  ページ ${current}/${total} を描画中...`);
    ui.setProgress((current / total) * 15);
  });

  log(`PDF解析完了: ${rawPages.length}ページ`, 'success');
  ui.setStepStatus('parse', 'completed');

  const processedPages = [];

  for (let i = 0; i < rawPages.length; i++) {
    const page = rawPages[i];
    const baseProgress = 15 + (i / rawPages.length) * 70;
    log(`--- ページ ${i + 1}/${rawPages.length} ---`);

    // Check if PDF has text content
    const hasText = page.rawTextItems.length > 3;

    if (hasText) {
      // PDF with text: use PDF.js extracted text
      log(`  PDF.jsテキスト使用: ${page.rawTextItems.length}要素`);

      if (i === 0) ui.setStepStatus('normalize', 'active');
      const normalizedItems = normalizeCoordinates(page.rawTextItems, page.pdfWidth, page.pdfHeight);
      if (i === 0) ui.setStepStatus('normalize', 'completed');
      ui.setProgress(baseProgress + 5);

      if (i === 0) ui.setStepStatus('mask', 'active');
      if (i === 0) ui.setStepStatus('mask', 'completed');
      ui.setProgress(baseProgress + 10);

      // Background - AI generation
      if (i === 0) ui.setStepStatus('background', 'active');
      const backgroundImageDataUrl = await generateBackground(
        apiKey, page.imageDataUrl, page.canvas, normalizedItems, log
      );
      if (i === 0) ui.setStepStatus('background', 'completed');
      ui.setProgress(baseProgress + 30);

      // Structure text
      if (i === 0) ui.setStepStatus('structure', 'active');
      const lines = groupTextIntoLines(normalizedItems);
      const paragraphs = groupLinesIntoParagraphs(lines);

      const textBlocks = paragraphs.map(para => ({
        text: para.text,
        relX: para.relX,
        relY: para.relY,
        relWidth: para.relWidth,
        relHeight: para.relHeight,
        relFontSize: para.relFontSize,
        fontSize: para.relFontSize * page.pdfHeight,
        bold: para.bold,
      }));

      if (i === 0) ui.setStepStatus('structure', 'completed');
      ui.setProgress(baseProgress + 40);

      processedPages.push({ ...page, backgroundImageDataUrl, textBlocks });

    } else {
      // Scanned PDF (no text) -> need OCR
      if (!apiKey) {
        log(`  テキストなし＋APIキーなし: 背景画像のみ`, 'warn');
        processedPages.push({ ...page, backgroundImageDataUrl: page.imageDataUrl, textBlocks: [] });
        continue;
      }

      log(`  テキストなし → OCR + AI背景生成`);

      if (i === 0) ui.setStepStatus('normalize', 'active');
      const resized = await resizeImage(page.imageDataUrl, 2048, 2048, 'image/jpeg', 0.90);
      const imageBase64 = dataUrlToBase64(resized);

      let ocrItems;
      try {
        ocrItems = await performOcr(apiKey, imageBase64, log);
      } catch (err) {
        log(`  OCR失敗: ${err.message}`, 'error');
        processedPages.push({ ...page, backgroundImageDataUrl: page.imageDataUrl, textBlocks: [] });
        continue;
      }
      if (i === 0) ui.setStepStatus('normalize', 'completed');

      // Background - AI generation
      if (i === 0) ui.setStepStatus('background', 'active');
      const backgroundImageDataUrl = await generateBackground(
        apiKey, page.imageDataUrl, page.canvas, ocrItems, log
      );
      if (i === 0) ui.setStepStatus('background', 'completed');

      // Text blocks
      if (i === 0) ui.setStepStatus('structure', 'active');
      const textBlocks = ocrItems.map(item => ({
        text: item.text,
        relX: item.relX,
        relY: item.relY,
        relWidth: item.relWidth,
        relHeight: item.relHeight,
        relFontSize: item.relFontSize,
        fontSize: item.fontSize,
        bold: item.bold,
        color: item.color,
        type: item.type,
      }));
      if (i === 0) ui.setStepStatus('structure', 'completed');
      ui.setProgress(baseProgress + 40);

      processedPages.push({ ...page, backgroundImageDataUrl, textBlocks });
    }
  }

  return processedPages;
}

// ======================================================================
// Image Processing Pipeline
// ======================================================================

async function processImage(file, apiKey, log) {
  // STEP 1: Load image
  ui.setStepStatus('parse', 'active');
  log('画像を読み込み中...');

  const page = await loadImageAsPage(file);
  log(`画像サイズ: ${page.pdfWidth}x${page.pdfHeight}px`, 'success');
  ui.setStepStatus('parse', 'completed');
  ui.setProgress(10);

  // OCR
  ui.setStepStatus('normalize', 'active');
  const resized = await resizeImage(page.imageDataUrl, 2048, 2048, 'image/jpeg', 0.90);
  const imageBase64 = dataUrlToBase64(resized);

  let ocrItems;
  try {
    ocrItems = await performOcr(apiKey, imageBase64, log);
  } catch (err) {
    log(`OCR失敗: ${err.message}`, 'error');
    throw new Error(`OCRに失敗しました: ${err.message}`);
  }
  ui.setStepStatus('normalize', 'completed');
  ui.setProgress(30);

  // Background - AI generation
  ui.setStepStatus('mask', 'active');
  ui.setStepStatus('mask', 'completed');
  ui.setProgress(35);

  ui.setStepStatus('background', 'active');
  log('AI背景画像を生成中...');
  const backgroundImageDataUrl = await generateBackground(
    apiKey, page.imageDataUrl, page.canvas, ocrItems, log
  );
  ui.setStepStatus('background', 'completed');
  ui.setProgress(60);

  // Text blocks
  ui.setStepStatus('structure', 'active');
  const textBlocks = ocrItems.map(item => ({
    text: item.text,
    relX: item.relX,
    relY: item.relY,
    relWidth: item.relWidth,
    relHeight: item.relHeight,
    relFontSize: item.relFontSize,
    fontSize: item.fontSize,
    bold: item.bold,
    color: item.color,
    type: item.type,
  }));
  ui.setStepStatus('structure', 'completed');
  ui.setProgress(75);

  return [{
    ...page,
    backgroundImageDataUrl,
    textBlocks,
  }];
}
