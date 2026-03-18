/**
 * openaiClient.js - OpenAI API Integration Module
 * 
 * Handles:
 * - Text removal / background inpainting via vision model
 * - OCR via vision model (structured JSON output)
 * - API error handling and retries
 */

const API_URL = 'https://api.openai.com/v1/chat/completions';
const VISION_MODEL = 'gpt-4o';

/**
 * Request background inpainting: remove text from an image while preserving shapes/lines.
 * 
 * NOTE: GPT-4o vision can analyze images but cannot generate/edit images directly.
 * Instead, we use it to identify text regions more precisely, then handle removal locally.
 * For actual inpainting, we rely on the local fallback (Canvas-based masking).
 * 
 * This function is a "smart mask refinement" step: it sends the image to the API
 * to get precise text bounding boxes, which we then use for better local masking.
 * 
 * @param {string} apiKey - OpenAI API key
 * @param {string} imageBase64 - Base64 encoded image
 * @param {string} maskBase64 - Base64 encoded mask image (text regions in white)
 * @param {function} onLog - Logging callback
 * @returns {Promise<Array|null>} Refined text regions or null on failure
 */
export async function refineTextRegions(apiKey, imageBase64, maskBase64, onLog = () => {}) {
  try {
    onLog('APIにテキスト領域の精密検出を依頼中...');

    const response = await callVisionApi(apiKey, [
      {
        role: 'system',
        content: `You are a precise document layout analyzer. Analyze the provided image and identify ALL text regions.
Return a JSON array of text bounding boxes. Each box should be:
{"x": <left 0-1>, "y": <top 0-1>, "width": <0-1>, "height": <0-1>}
Coordinates are relative (0-1) to image dimensions.
Include ALL text: titles, body text, labels, numbers, captions.
Return ONLY the JSON array, no markdown, no explanation.`
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Identify all text regions in this document image. Return a JSON array of bounding boxes with relative coordinates (0-1).'
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${imageBase64}`, detail: 'high' }
          }
        ]
      }
    ]);

    const text = response.choices[0].message.content.trim();
    const jsonStr = extractJson(text);
    const regions = JSON.parse(jsonStr);

    if (Array.isArray(regions) && regions.length > 0) {
      onLog(`API: ${regions.length}個のテキスト領域を検出`);
      return regions;
    }

    return null;
  } catch (err) {
    onLog(`APIテキスト検出に失敗: ${err.message}`, 'warn');
    return null;
  }
}

/**
 * Perform OCR on an image using the vision model.
 * Returns structured text data with positions.
 * 
 * @param {string} apiKey - OpenAI API key
 * @param {string} imageBase64 - Base64 encoded image
 * @param {function} onLog - Logging callback
 * @returns {Promise<Array>} Array of text items with coordinates
 */
export async function performOcr(apiKey, imageBase64, onLog = () => {}) {
  onLog('APIでOCR実行中...');

  const response = await callVisionApi(apiKey, [
    {
      role: 'system',
      content: `You are an expert OCR system. Analyze the provided image and extract ALL text with precise positioning.

Return a JSON array. Each element must have:
{
  "text": "the text content",
  "x": <left edge, relative 0-1>,
  "y": <top edge, relative 0-1>,
  "width": <text width, relative 0-1>,
  "height": <text height, relative 0-1>,
  "font_size": <approximate font size in points>,
  "bold": <true/false>
}

IMPORTANT RULES:
1. Coordinates are RELATIVE to image dimensions (0.0 to 1.0)
2. x=0 is left edge, y=0 is top edge
3. Include ALL visible text: titles, body, labels, numbers, headers, footers
4. Group text into natural reading units (words/phrases on the same line together)
5. Estimate font_size based on visual size (typical body=10-12pt, headers=16-24pt)
6. Set bold=true for visually bold/heavy text
7. Return ONLY the JSON array, no markdown fences, no explanation`
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Extract all text from this image with precise positions. Return a JSON array with text, x, y, width, height, font_size, bold for each text element.'
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${imageBase64}`, detail: 'high' }
        }
      ]
    }
  ]);

  const text = response.choices[0].message.content.trim();
  const jsonStr = extractJson(text);

  try {
    const items = JSON.parse(jsonStr);
    if (!Array.isArray(items)) throw new Error('Response is not an array');

    // Validate and clean items
    const cleaned = items
      .filter(item => item.text && typeof item.x === 'number' && typeof item.y === 'number')
      .map(item => ({
        text: String(item.text),
        x: clamp(item.x, 0, 1),
        y: clamp(item.y, 0, 1),
        width: clamp(item.width || 0.1, 0.001, 1),
        height: clamp(item.height || 0.02, 0.001, 1),
        fontSize: item.font_size || 12,
        bold: !!item.bold,
        // These are already relative coordinates
        relX: clamp(item.x, 0, 1),
        relY: clamp(item.y, 0, 1),
        relWidth: clamp(item.width || 0.1, 0.001, 1),
        relHeight: clamp(item.height || 0.02, 0.001, 1),
        relFontSize: clamp((item.height || 0.02), 0.001, 0.2),
      }));

    onLog(`OCR完了: ${cleaned.length}個のテキスト要素を検出`);
    return cleaned;
  } catch (err) {
    throw new Error(`OCR結果のパースに失敗: ${err.message}`);
  }
}

/**
 * Call the OpenAI Chat Completions API with vision support.
 * Includes retry logic with exponential backoff.
 */
async function callVisionApi(apiKey, messages, maxRetries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: VISION_MODEL,
          messages,
          max_tokens: 4096,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMsg;
        try {
          const errorJson = JSON.parse(errorBody);
          errorMsg = errorJson.error?.message || errorBody;
        } catch {
          errorMsg = errorBody;
        }

        // Don't retry on auth errors
        if (response.status === 401 || response.status === 403) {
          throw new Error(`認証エラー (${response.status}): APIキーを確認してください`);
        }

        if (response.status === 429) {
          // Rate limited - wait longer
          const waitTime = attempt * 5000;
          await sleep(waitTime);
          lastError = new Error(`レート制限 (429): ${errorMsg}`);
          continue;
        }

        throw new Error(`API error (${response.status}): ${errorMsg}`);
      }

      return await response.json();
    } catch (err) {
      lastError = err;

      if (err.message.includes('認証エラー')) throw err;

      if (attempt < maxRetries) {
        await sleep(attempt * 2000);
      }
    }
  }

  throw lastError;
}

/**
 * Extract JSON from a string that might contain markdown code fences or other text.
 */
function extractJson(text) {
  // Try to extract from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // Try to find JSON array directly
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];

  // Try to find JSON object directly
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];

  return text;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
