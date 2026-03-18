/**
 * main.js - Application Orchestrator
 * 
 * Connects all modules and manages the conversion pipeline:
 * 
 * PDF Input:
 *   STEP1: PDF解析 (Parse PDF → Canvas + Text Items)
 *   STEP2: 座標正規化 (Normalize coordinates to 0-1)
 *   STEP3: テキスト領域抽出 (Generate mask rectangles)
 *   STEP4: 背景生成 (Create background with text removed)
 *   STEP5: (skip - text already from PDF.js)
 *   STEP6: テキスト構造化 (Group text into lines/paragraphs)
 *   STEP7: 座標変換 (Scale to PPTX coordinates)
 *   STEP8: PPTX生成 (Generate 2-layer PPTX)
 * 
 * Image Input:
 *   STEP1: 画像読込 (Load image to Canvas)
 *   STEP2: (coordinates from OCR are already normalized)
 *   STEP3: テキスト領域抽出 (From OCR results)
 *   STEP4: 背景生成 (Create background with text removed)
 *   STEP5: OCR実行 (Extract text via API)
 *   STEP6: テキスト構造化 (Group text into lines/paragraphs)
 *   STEP7: 座標変換 (Scale to PPTX coordinates)
 *   STEP8: PPTX生成 (Generate 2-layer PPTX)
 */

import { UIController } from './ui.js';
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
  createMaskImage,
  resizeImage,
  dataUrlToBase64,
} from './imageProcessor.js';
import {
  refineTextRegions,
  performOcr,
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
    downloadPptx(generatedBlob, `${baseName}.pptx`);
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
  if (!apiKey) {
    ui.showToast('OpenAI APIキーを入力してください', 'warning');
    return;
  }

  sourceFileName = file.name;
  generatedBlob = null;
  ui.setProcessing(true);
  ui.resetStatus();
  ui.setProgress(0);

  const dpiScale = ui.getDpiScale();
  const slideSize = ui.getSlideSize();
  const useInpainting = ui.getUseInpainting();

  const log = (msg, level) => ui.log(msg, level);

  try {
    let pages;

    if (ui.isPdf()) {
      pages = await processPdf(file, dpiScale, useInpainting, apiKey, log);
    } else if (ui.isImage()) {
      pages = await processImage(file, useInpainting, apiKey, log);
    } else {
      throw new Error('サポートされていないファイル形式です');
    }

    // Show previews
    ui.showPreviews(pages);

    // STEP 7: Coordinate conversion (already done as relative → will be converted in PPTX gen)
    ui.setStepStatus('convert', 'active');
    log('座標変換を実行中...');
    // The conversion happens in the PPTX generator using relative coords + slide dimensions
    ui.setStepStatus('convert', 'completed');
    ui.setProgress(85);

    // STEP 8: PPTX Generation
    ui.setStepStatus('generate', 'active');
    log('PPTX生成を開始...');

    generatedBlob = await generatePptx(pages, {
      slideSize,
      onProgress: (current, total) => {
        const progress = 85 + (current / total) * 15;
        ui.setProgress(progress);
      },
      onLog: log,
    });

    ui.setStepStatus('generate', 'completed');
    ui.setProgress(100);

    // Show download button
    ui.showDownloadButton();
    ui.showToast('変換が完了しました！ダウンロードボタンをクリックしてPPTXを取得できます。', 'success', 6000);
    log('=== 変換完了 ===', 'success');

  } catch (err) {
    log(`エラー: ${err.message}`, 'error');
    ui.showToast(`変換に失敗しました: ${err.message}`, 'error', 8000);
    console.error(err);
  } finally {
    ui.setProcessing(false);
  }
}

/**
 * Process a PDF file through the full pipeline.
 */
async function processPdf(file, dpiScale, useInpainting, apiKey, log) {
  // STEP 1: Parse PDF
  ui.setStepStatus('parse', 'active');
  log('PDF解析を開始...');

  const rawPages = await parsePdf(file, dpiScale, (current, total) => {
    log(`  ページ ${current}/${total} を描画中...`);
    ui.setProgress((current / total) * 15);
  });

  log(`PDF解析完了: ${rawPages.length}ページ`, 'success');
  ui.setStepStatus('parse', 'completed');

  // Process each page
  const processedPages = [];

  for (let i = 0; i < rawPages.length; i++) {
    const page = rawPages[i];
    const pageNum = i + 1;
    const baseProgress = 15 + (i / rawPages.length) * 70;

    log(`--- ページ ${pageNum}/${rawPages.length} の処理 ---`);

    // STEP 2: Normalize coordinates
    if (i === 0) ui.setStepStatus('normalize', 'active');
    log(`  座標正規化中...`);

    const normalizedItems = normalizeCoordinates(
      page.rawTextItems,
      page.pdfWidth,
      page.pdfHeight
    );

    log(`  テキスト要素: ${normalizedItems.length}個`);
    if (i === 0) ui.setStepStatus('normalize', 'completed');
    ui.setProgress(baseProgress + 5);

    // STEP 3: Text region extraction
    if (i === 0) ui.setStepStatus('mask', 'active');
    log(`  テキスト領域マスク生成中...`);

    const maskRects = generateMaskRects(page.rawTextItems, page.dpiScale, 3);
    log(`  マスク矩形: ${maskRects.length}個`);
    if (i === 0) ui.setStepStatus('mask', 'completed');
    ui.setProgress(baseProgress + 10);

    // STEP 4: Background generation
    if (i === 0) ui.setStepStatus('background', 'active');
    log(`  背景画像を生成中...`);

    let backgroundImageDataUrl;

    if (useInpainting && apiKey) {
      try {
        // Resize image for API
        const resized = await resizeImage(page.imageDataUrl, 2048, 2048);
        const imageBase64 = dataUrlToBase64(resized);

        // Ask API to refine text regions
        const refinedRegions = await refineTextRegions(apiKey, imageBase64, null, log);

        if (refinedRegions && refinedRegions.length > 0) {
          // Use API-refined regions for better masking
          const refinedMaskRects = refinedRegions.map(r => ({
            x: r.x * page.canvasWidth,
            y: r.y * page.canvasHeight,
            width: r.width * page.canvasWidth,
            height: r.height * page.canvasHeight,
          }));

          // Merge original + refined rects for comprehensive coverage
          const allRects = [...maskRects, ...refinedMaskRects];
          backgroundImageDataUrl = createMaskedBackground(page.canvas, allRects);
          log(`  AI支援によるテキスト除去完了`, 'success');
        } else {
          // Fallback to local masking
          backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
          log(`  ローカルマスキングで背景生成`);
        }
      } catch (err) {
        log(`  API背景生成失敗、ローカルフォールバック: ${err.message}`, 'warn');
        backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
      }
    } else {
      backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
      log(`  ローカルマスキングで背景生成`);
    }

    if (i === 0) ui.setStepStatus('background', 'completed');
    ui.setProgress(baseProgress + 30);

    // STEP 5: (Skip for PDF - text already extracted from PDF.js)
    // STEP 6: Text structuring
    if (i === 0) ui.setStepStatus('structure', 'active');
    log(`  テキストを構造化中...`);

    const lines = groupTextIntoLines(normalizedItems);
    const paragraphs = groupLinesIntoParagraphs(lines);

    log(`  行数: ${lines.length}, 段落数: ${paragraphs.length}`);

    // Build text blocks for PPTX
    const textBlocks = paragraphs.map(para => ({
      text: para.text,
      relX: para.relX,
      relY: para.relY,
      relWidth: para.relWidth,
      relHeight: para.relHeight,
      relFontSize: para.relFontSize,
      bold: para.bold,
      originalPageHeight: page.pdfHeight,
      fontSize: para.relFontSize * page.pdfHeight, // Convert back to approximate points
    }));

    if (i === 0) ui.setStepStatus('structure', 'completed');
    ui.setProgress(baseProgress + 40);

    processedPages.push({
      ...page,
      backgroundImageDataUrl,
      textBlocks,
    });
  }

  return processedPages;
}

/**
 * Process an image file through the full pipeline.
 */
async function processImage(file, useInpainting, apiKey, log) {
  // STEP 1: Load image
  ui.setStepStatus('parse', 'active');
  log('画像を読み込み中...');

  const page = await loadImageAsPage(file);
  log(`画像サイズ: ${page.pdfWidth}×${page.pdfHeight}px`, 'success');
  ui.setStepStatus('parse', 'completed');
  ui.setProgress(10);

  // STEP 5: OCR (must come first for images since we have no text data)
  ui.setStepStatus('normalize', 'active');
  ui.setStepStatus('mask', 'active');
  log('OCRでテキスト抽出中...');

  const resized = await resizeImage(page.imageDataUrl, 2048, 2048);
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

  // STEP 3: Generate mask from OCR results
  log('テキスト領域マスクを生成中...');

  const maskRects = ocrItems.map(item => ({
    x: item.relX * page.canvasWidth,
    y: item.relY * page.canvasHeight,
    width: item.relWidth * page.canvasWidth,
    height: item.relHeight * page.canvasHeight,
  }));

  ui.setStepStatus('mask', 'completed');
  ui.setProgress(40);

  // STEP 4: Background generation
  ui.setStepStatus('background', 'active');
  log('背景画像を生成中...');

  let backgroundImageDataUrl;

  if (useInpainting && apiKey) {
    try {
      const refinedRegions = await refineTextRegions(apiKey, imageBase64, null, log);

      if (refinedRegions && refinedRegions.length > 0) {
        const refinedMaskRects = refinedRegions.map(r => ({
          x: r.x * page.canvasWidth,
          y: r.y * page.canvasHeight,
          width: r.width * page.canvasWidth,
          height: r.height * page.canvasHeight,
        }));

        const allRects = [...maskRects, ...refinedMaskRects];
        backgroundImageDataUrl = createMaskedBackground(page.canvas, allRects);
        log('AI支援によるテキスト除去完了', 'success');
      } else {
        backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
        log('ローカルマスキングで背景生成');
      }
    } catch (err) {
      log(`API背景生成失敗、ローカルフォールバック: ${err.message}`, 'warn');
      backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
    }
  } else {
    backgroundImageDataUrl = createMaskedBackground(page.canvas, maskRects);
    log('ローカルマスキングで背景生成');
  }

  ui.setStepStatus('background', 'completed');
  ui.setProgress(60);

  // STEP 6: Text structuring
  ui.setStepStatus('structure', 'active');
  log('テキストを構造化中...');

  const lines = groupTextIntoLines(ocrItems);
  const paragraphs = groupLinesIntoParagraphs(lines);

  log(`行数: ${lines.length}, 段落数: ${paragraphs.length}`);

  const textBlocks = paragraphs.map(para => ({
    text: para.text,
    relX: para.relX,
    relY: para.relY,
    relWidth: para.relWidth,
    relHeight: para.relHeight,
    relFontSize: para.relFontSize,
    bold: para.bold,
    originalPageHeight: page.pdfHeight,
    fontSize: para.relFontSize * page.pdfHeight,
  }));

  ui.setStepStatus('structure', 'completed');
  ui.setProgress(75);

  return [{
    ...page,
    backgroundImageDataUrl,
    textBlocks,
  }];
}
