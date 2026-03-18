/**
 * pptxParser.js - PPTX Input Parser Module
 * 
 * Parses PPTX files in the browser using JSZip.
 * Extracts:
 *   - Slide images from ppt/media/
 *   - Slide ordering from ppt/presentation.xml
 *   - Slide→image mapping from ppt/slides/_rels/slideN.xml.rels
 *   - Text content from ppt/slides/slideN.xml (if any)
 *   - Slide dimensions from ppt/presentation.xml
 */

/**
 * Parse a PPTX file and extract all slide data.
 * 
 * @param {File} file - The PPTX file
 * @param {function} onLog - Logging callback
 * @param {function} onProgress - Progress callback (current, total)
 * @returns {Promise<{slides: Array, slideDimensions: {width: number, height: number}}>}
 */
export async function parsePptx(file, onLog = () => {}, onProgress = null) {
  onLog('PPTXファイルを解析中...');

  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // 1. Get slide dimensions from presentation.xml
  const slideDimensions = await extractSlideDimensions(zip, onLog);
  onLog(`スライドサイズ: ${slideDimensions.widthIn.toFixed(2)}" × ${slideDimensions.heightIn.toFixed(2)}"`);

  // 2. Get slide order from presentation.xml
  const slideOrder = await extractSlideOrder(zip, onLog);
  onLog(`スライド数: ${slideOrder.length}`);

  // 3. For each slide, extract image and text
  const slides = [];
  for (let i = 0; i < slideOrder.length; i++) {
    const slideId = slideOrder[i];
    if (onProgress) onProgress(i + 1, slideOrder.length);
    onLog(`  スライド ${i + 1}/${slideOrder.length} を処理中...`);

    const slideData = await extractSlideData(zip, slideId, i, slideDimensions, onLog);
    slides.push(slideData);
  }

  // Clean up extracted temporary images
  return { slides, slideDimensions };
}

/**
 * Extract slide dimensions from presentation.xml.
 * Dimensions are in EMU (English Metric Units). 1 inch = 914400 EMU.
 */
async function extractSlideDimensions(zip, onLog) {
  try {
    const presXml = await zip.file('ppt/presentation.xml')?.async('string');
    if (!presXml) throw new Error('presentation.xml not found');

    // Parse slide size: <p:sldSz cx="12192000" cy="6858000"/>
    const sldSzMatch = presXml.match(/sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    if (sldSzMatch) {
      const cxEmu = parseInt(sldSzMatch[1], 10);
      const cyEmu = parseInt(sldSzMatch[2], 10);
      return {
        widthEmu: cxEmu,
        heightEmu: cyEmu,
        widthIn: cxEmu / 914400,
        heightIn: cyEmu / 914400,
      };
    }
  } catch (e) {
    onLog(`スライドサイズの取得に失敗、デフォルト使用: ${e.message}`, 'warn');
  }

  // Default: 16:9
  return {
    widthEmu: 12192000,
    heightEmu: 6858000,
    widthIn: 13.333,
    heightIn: 7.5,
  };
}

/**
 * Extract slide order from presentation.xml.
 * Returns array of slide numbers (1-indexed).
 */
async function extractSlideOrder(zip, onLog) {
  try {
    const presXml = await zip.file('ppt/presentation.xml')?.async('string');
    if (!presXml) throw new Error('presentation.xml not found');

    // Find all slide references: <p:sldId id="..." r:id="rId..."/>
    // Then map rId to actual slide file via presentation.xml.rels
    const relsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
    if (!relsXml) throw new Error('presentation.xml.rels not found');

    // Extract rId -> slide file mappings
    const relMap = {};
    const relRegex = /Relationship[^>]*Id="(rId\d+)"[^>]*Target="([^"]*slide[^"]*)"/gi;
    let match;
    while ((match = relRegex.exec(relsXml)) !== null) {
      const rId = match[1];
      const target = match[2];
      // Extract slide number from target like "slides/slide1.xml"
      const slideNumMatch = target.match(/slide(\d+)\.xml/);
      if (slideNumMatch) {
        relMap[rId] = parseInt(slideNumMatch[1], 10);
      }
    }

    // Extract slide order from presentation.xml (sldIdLst)
    const sldIdRegex = /sldId[^>]*r:id="(rId\d+)"/gi;
    const orderedSlideNums = [];
    while ((match = sldIdRegex.exec(presXml)) !== null) {
      const rId = match[1];
      if (relMap[rId] !== undefined) {
        orderedSlideNums.push(relMap[rId]);
      }
    }

    if (orderedSlideNums.length > 0) {
      return orderedSlideNums;
    }
  } catch (e) {
    onLog(`スライド順序の取得に失敗: ${e.message}`, 'warn');
  }

  // Fallback: detect slides by listing files
  const slideFiles = Object.keys(zip.files).filter(
    name => /^ppt\/slides\/slide\d+\.xml$/.test(name)
  );
  const nums = slideFiles
    .map(f => parseInt(f.match(/slide(\d+)\.xml/)[1], 10))
    .sort((a, b) => a - b);

  return nums;
}

/**
 * Extract data for a single slide.
 */
async function extractSlideData(zip, slideNum, slideIndex, slideDimensions, onLog) {
  // 1. Find image(s) associated with this slide via _rels
  const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
  const relsFile = zip.file(relsPath);
  
  let imageDataUrl = null;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let canvas = null;

  if (relsFile) {
    const relsXml = await relsFile.async('string');
    
    // Find image references: Target="../media/image-N-N.png"
    const imgRegex = /Target="([^"]*media\/[^"]*)"/gi;
    const imageRefs = [];
    let m;
    while ((m = imgRegex.exec(relsXml)) !== null) {
      // Resolve relative path
      let imgPath = m[1].replace('../', 'ppt/');
      imageRefs.push(imgPath);
    }

    // Load the primary (largest) image
    if (imageRefs.length > 0) {
      // If multiple images, pick the largest one (likely the full-slide background)
      let bestImage = null;
      let bestSize = 0;

      for (const imgPath of imageRefs) {
        const imgFile = zip.file(imgPath);
        if (imgFile) {
          const blob = await imgFile.async('blob');
          if (blob.size > bestSize) {
            bestSize = blob.size;
            bestImage = { path: imgPath, blob };
          }
        }
      }

      if (bestImage) {
        // Determine MIME type from extension
        const ext = bestImage.path.split('.').pop().toLowerCase();
        const mimeMap = {
          'png': 'image/png',
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'gif': 'image/gif',
          'bmp': 'image/bmp',
          'webp': 'image/webp',
          'emf': 'image/emf',
          'wmf': 'image/wmf',
        };
        const mime = mimeMap[ext] || 'image/png';
        
        // Convert blob to data URL
        const typedBlob = new Blob([bestImage.blob], { type: mime });
        imageDataUrl = await blobToDataUrl(typedBlob);

        // Get actual image dimensions by loading into an Image
        try {
          const img = await loadImage(imageDataUrl);
          canvasWidth = img.width;
          canvasHeight = img.height;

          // Create canvas from image
          canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
        } catch (imgErr) {
          onLog(`  画像読み込みエラー: ${imgErr.message}`, 'warn');
        }
      }
    }
  }

  // 2. Extract any text content from slide XML
  const slideXmlPath = `ppt/slides/slide${slideNum}.xml`;
  const slideXmlFile = zip.file(slideXmlPath);
  let textItems = [];

  if (slideXmlFile) {
    const slideXml = await slideXmlFile.async('string');
    textItems = extractTextFromSlideXml(slideXml, slideDimensions);
  }

  return {
    slideNum,
    slideIndex,
    imageDataUrl,
    canvas,
    canvasWidth,
    canvasHeight,
    pdfWidth: slideDimensions.widthIn * 72,   // Convert to points for compatibility
    pdfHeight: slideDimensions.heightIn * 72,
    dpiScale: 1,
    rawTextItems: textItems,
    source: 'pptx',
    hasEmbeddedText: textItems.length > 0,
  };
}

/**
 * Extract text items from a slide XML string.
 * Looks for <a:t> text elements within <p:sp> shape elements.
 */
function extractTextFromSlideXml(xml, slideDimensions) {
  const items = [];

  // Simple XML text extraction using regex
  // This handles the common case of <p:sp> shapes with text
  
  // Find all shape groups with position and text
  const spRegex = /<p:sp\b[\s\S]*?<\/p:sp>/gi;
  let spMatch;

  while ((spMatch = spRegex.exec(xml)) !== null) {
    const spXml = spMatch[0];

    // Extract position: <a:off x="..." y="..."/> and <a:ext cx="..." cy="..."/>
    const offMatch = spXml.match(/<a:off\s+x="(\d+)"\s+y="(\d+)"/);
    const extMatch = spXml.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);

    if (!offMatch || !extMatch) continue;

    const xEmu = parseInt(offMatch[1], 10);
    const yEmu = parseInt(offMatch[2], 10);
    const wEmu = parseInt(extMatch[1], 10);
    const hEmu = parseInt(extMatch[2], 10);

    // Extract all text runs: <a:t>text</a:t>
    const textRegex = /<a:t>([\s\S]*?)<\/a:t>/gi;
    let textMatch;
    let fullText = '';

    while ((textMatch = textRegex.exec(spXml)) !== null) {
      fullText += textMatch[1];
    }

    fullText = fullText.trim();
    if (!fullText) continue;

    // Check for bold
    const isBold = /<a:rPr[^>]*\bb="1"/.test(spXml);

    // Font size in hundredths of a point
    const szMatch = spXml.match(/<a:rPr[^>]*\bsz="(\d+)"/);
    const fontSizePt = szMatch ? parseInt(szMatch[1], 10) / 100 : 12;

    // Convert EMU to relative coordinates (0-1)
    const relX = xEmu / slideDimensions.widthEmu;
    const relY = yEmu / slideDimensions.heightEmu;
    const relWidth = wEmu / slideDimensions.widthEmu;
    const relHeight = hEmu / slideDimensions.heightEmu;

    items.push({
      text: fullText,
      x: relX * slideDimensions.widthIn * 72,
      y: relY * slideDimensions.heightIn * 72,
      width: relWidth * slideDimensions.widthIn * 72,
      height: relHeight * slideDimensions.heightIn * 72,
      fontSize: fontSizePt,
      bold: isBold,
      relX,
      relY,
      relWidth,
      relHeight,
      relFontSize: (fontSizePt / 72) / slideDimensions.heightIn,
    });
  }

  return items;
}

/**
 * Convert a Blob to a data URL.
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Load an image from a URL/data URL.
 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
