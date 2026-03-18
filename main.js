/**
 * main.js - Application Orchestrator
 * 
 * Unified conversion pipeline for 3 input types:
 * 
 *   PPTX Input (image-only slides):
 *     1. Parse PPTX (JSZip) → extract slide images
 *     2. For each slide image:
 *        a. OCR via GPT-4o Vision → text items with coordinates
 *        b. Generate masked background (text removed)
 *        c. Generate 2-layer PPTX slide
 * 
 *   PDF Input:
 *     1. Parse PDF (PDF.js) → render to Canvas + extract text
 *     2. For each page:
 *        a. If PDF has text → use PDF.js text data
 *        b. If PDF has no text (scanned) → OCR via GPT-4o Vision
 *        c. Generate masked background
 *        d. Generate 2-layer PPTX slide
 * 
 *   Image Input:
 *     1. Load image → Canvas
 *     2. OCR via GPT-4o Vision → text items
 *     3. Generate masked background
 *     4. Generate 2-layer PPTX slide
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
} from './imageProcessor.js';
import {
  performOcr,
  detectTextRegions,
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

  // PPTX and Image inputs always require OCR → API key required
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
  const useInpainting = ui.getUseInpainting() && !!apiKey;

  const log = (msg, level) => ui.log(msg, level);

  try {
    let pages;

    if (isPptx) {
      pages = await processPptx(file, apiKey, useInpainting, log);
    } else if (isPdf) {
      pages = await processPdf(file, dpiScale, apiKey, useInpainting, log);
    } else if (isImage) {
      pages = await processImage(file, apiKey, useInpainting, log);
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
// PPTX Processing Pipeline
// ======================================================================

async function processPptx(file, apiKey, useInpainting, log) {
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

    // If slide already has embedded text, use it
    if (slide.hasEmbeddedText && slide.rawTextItems.length > 5) {
      log(`  埋め込みテキスト使用: ${slide.rawTextItems.length}要素`);
      const page = await processSlideWithText(slide, useInpainting, apiKey, log);
      processedPages.push(page);
    } else {
      // Image-only slide → OCR required
      if (!slide.imageDataUrl) {
        log(`  スライド ${i + 1}: 画像なし、スキップ`, 'warn');
        continue;
      }

      log(`  画像ベーススライド → OCR実行`);
      const page = await processSlideWithOcr(slide, apiKey, useInpainting, log);
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
async function processSlideWithText(slide, useInpainting, apiKey, log) {
  const normalizedItems = slide.rawTextItems; // Already normalized in pptxParser

  // Generate mask rects from text items
  const maskRects = normalizedItems.map(item => ({
    x: item.relX * slide.canvasWidth,
    y: item.relY * slide.canvasHeight,
    width: item.relWidth * slide.canvasWidth,
    height: item.relHeight * slide.canvasHeight,
  }));

  // Background generation
  let backgroundImageDataUrl = slide.imageDataUrl;
  if (slide.canvas && maskRects.length > 0) {
    backgroundImageDataUrl = createMaskedBackground(slide.canvas, maskRects);
    log(`  ローカルマスキングで背景生成`);
  }

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
async function processSlideWithOcr(slide, apiKey, useInpainting, log) {
  // Resize image for API (max 2048px, JPEG for smaller payload)
  const resized = await resizeImage(slide.imageDataUrl, 2048, 2048, 'image/jpeg', 0.90);
  const imageBase64 = dataUrlToBase64(resized);

  // STEP: OCR
  ui.setStepStatus('normalize', 'active');
  let ocrItems;
  try {
    ocrItems = await performOcr(apiKey, imageBase64, log);
  } catch (err) {
    log(`  OCR失敗: ${err.message}`, 'error');
    // Return page with just the background image (no text layer)
    return {
      ...slide,
      backgroundImageDataUrl: slide.imageDataUrl,
      textBlocks: [],
    };
  }
  ui.setStepStatus('normalize', 'completed');

  // STEP: Generate mask from OCR results
  ui.setStepStatus('mask', 'active');
  const maskRects = ocrItems.map(item => ({
    x: item.relX * slide.canvasWidth,
    y: item.relY * slide.canvasHeight,
    width: item.relWidth * slide.canvasWidth,
    height: item.relHeight * slide.canvasHeight,
  }));
  ui.setStepStatus('mask', 'completed');

  // STEP: Background generation
  ui.setStepStatus('background', 'active');
  let backgroundImageDataUrl;

  if (useInpainting && apiKey) {
    try {
      const textRegions = await detectTextRegions(apiKey, imageBase64, log);
      if (textRegions && textRegions.length > 0) {
        const refinedMaskRects = textRegions.map(r => ({
          x: r.x * slide.canvasWidth,
          y: r.y * slide.canvasHeight,
          width: r.width * slide.canvasWidth,
          height: r.height * slide.canvasHeight,
        }));
        const allRects = [...maskRects, ...refinedMaskRects];
        backgroundImageDataUrl = createMaskedBackground(slide.canvas, allRects);
        log(`  AI支援テキスト除去完了`, 'success');
      } else {
        backgroundImageDataUrl = createMaskedBackground(slide.canvas, maskRects);
        log(`  ローカルマスキングで背景生成`);
      }
    } catch (err) {
      log(`  AI背景生成失敗、フォールバック: ${err.message}`, 'warn');
      backgroundImageDataUrl = createMaskedBackground(slide.canvas, maskRects);
    }
  } else {
    backgroundImageDataUrl = createMaskedBackground(slide.canvas, maskRects);
    log(`  ローカルマスキングで背景生成`);
  }
  ui.setStepStatus('background', 'completed');

  // STEP: Structure text
  ui.setStepStatus('structure', 'active');
  // OCR items are already structured, use directly as text blocks
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

async function processPdf(file, dpiScale, apiKey, useInpainting, log) {
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
      const maskRects = generateMaskRects(page.rawTextItems, page.dpiScale, 3);
      if (i === 0) ui.setStepStatus('mask', 'completed');
      ui.setProgress(baseProgress + 10);

      // Background
      if (i === 0) ui.setStepStatus('background', 'active');
      let backgroundImageDataUrl;

      if (useInpainting && apiKey) {
        try {
          const resized = await resizeImage(page.imageDataUrl, 2048, 2048, 'image/jpeg', 0.90);
          const imageBase64 = dataUrlToBase64(resized);
          const textRegions = await detectTextRegions(apiKey, imageBase64, log);

          if (textRegions && textRegions.length > 0) {
            const refinedMaskRects = textRegions.map(r => ({
              x: r.x * page.canvasWidth,
              y: r.y * page.canvasHeight,
              width: r.width * page.canvasWidth,
              height: r.height * page.canvasHeight,
            }));
            backgroundImageDataUrl = createMaskedBackground(page.canvas, [...maskRects, ...refinedMaskRects]);
            log(`  AI支援テキスト除去完了`, 'success');
          } else {
            backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
          }
        } catch (err) {
          log(`  フォールバック: ${err.message}`, 'warn');
          backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
        }
      } else {
        backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
      }

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
      // Scanned PDF (no text) → need OCR
      if (!apiKey) {
        log(`  テキストなし＋APIキーなし: 背景画像のみ`, 'warn');
        processedPages.push({ ...page, backgroundImageDataUrl: page.imageDataUrl, textBlocks: [] });
        continue;
      }

      log(`  テキストなし → OCR実行`);

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

      // Mask
      if (i === 0) ui.setStepStatus('mask', 'active');
      const maskRects = ocrItems.map(item => ({
        x: item.relX * page.canvasWidth,
        y: item.relY * page.canvasHeight,
        width: item.relWidth * page.canvasWidth,
        height: item.relHeight * page.canvasHeight,
      }));
      if (i === 0) ui.setStepStatus('mask', 'completed');

      // Background
      if (i === 0) ui.setStepStatus('background', 'active');
      const backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
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

async function processImage(file, apiKey, useInpainting, log) {
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

  // Mask
  ui.setStepStatus('mask', 'active');
  const maskRects = ocrItems.map(item => ({
    x: item.relX * page.canvasWidth,
    y: item.relY * page.canvasHeight,
    width: item.relWidth * page.canvasWidth,
    height: item.relHeight * page.canvasHeight,
  }));
  ui.setStepStatus('mask', 'completed');
  ui.setProgress(40);

  // Background
  ui.setStepStatus('background', 'active');
  let backgroundImageDataUrl;

  if (useInpainting && apiKey) {
    try {
      const textRegions = await detectTextRegions(apiKey, imageBase64, log);
      if (textRegions && textRegions.length > 0) {
        const refinedMaskRects = textRegions.map(r => ({
          x: r.x * page.canvasWidth,
          y: r.y * page.canvasHeight,
          width: r.width * page.canvasWidth,
          height: r.height * page.canvasHeight,
        }));
        backgroundImageDataUrl = createMaskedBackground(page.canvas, [...maskRects, ...refinedMaskRects]);
        log('AI支援テキスト除去完了', 'success');
      } else {
        backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
      }
    } catch (err) {
      log(`フォールバック: ${err.message}`, 'warn');
      backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
    }
  } else {
    backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
  }

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
