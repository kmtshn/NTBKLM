/**
 * openaiClient.js - OpenAI API Integration Module
 * 
 * Handles:
 * - Structured OCR via GPT-4o vision (optimized for Japanese business documents)
 * - Text region detection for background masking
 * - API error handling, retries, and rate limiting
 */

const API_URL = 'https://api.openai.com/v1/chat/completions';
const VISION_MODEL = 'gpt-4o';

/**
 * Perform comprehensive OCR on a slide image.
 * Optimized for Japanese business presentations with:
 *   - Headers, body text, labels, table cells
 *   - Precise bounding box coordinates
 *   - Font size estimation
 *   - Color detection
 * 
 * @param {string} apiKey - OpenAI API key
 * @param {string} imageBase64 - Base64 encoded image (JPEG recommended)
 * @param {function} onLog - Logging callback
 * @returns {Promise<Array>} Array of text items with coordinates
 */
export async function performOcr(apiKey, imageBase64, onLog = () => {}) {
  onLog('GPT-4o VisionでOCR実行中...');

  const response = await callVisionApi(apiKey, [
    {
      role: 'system',
      content: `You are a world-class OCR engine specialized in Japanese business presentations and documents.

TASK: Extract ALL visible text from the image with precise positioning data.

OUTPUT FORMAT: Return a JSON array. Each element represents one text block:
{
  "text": "テキスト内容",
  "x": 0.05,
  "y": 0.10,
  "width": 0.40,
  "height": 0.04,
  "font_size": 18,
  "bold": true,
  "color": "#333333",
  "type": "heading"
}

FIELD DEFINITIONS:
- text: The exact text content (preserve Japanese characters exactly)
- x: Left edge position as fraction of image width (0.0 = left, 1.0 = right)
- y: Top edge position as fraction of image height (0.0 = top, 1.0 = bottom)
- width: Width of text block as fraction of image width
- height: Height of text block as fraction of image height
- font_size: Estimated font size in points (8-72 range)
- bold: true if text appears bold/heavy
- color: Hex color code of the text (e.g. "#000000" for black, "#FF0000" for red)
- type: One of "heading", "body", "label", "caption", "table_cell", "footer", "number"

CRITICAL RULES:
1. Extract EVERY piece of visible text, no matter how small
2. For tables, extract each cell as a separate text block
3. Coordinates must be PRECISE - measure carefully from the image edges
4. Group text that belongs together (same line, same logical unit)
5. Do NOT merge text blocks that are in different rows/columns of a table
6. Preserve line breaks within text blocks using \\n
7. Return ONLY the JSON array, no markdown fences, no explanations
8. If text appears partially obscured, extract what is visible`
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Extract all text from this Japanese business presentation slide. Return precise JSON with coordinates.'
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'high' }
        }
      ]
    }
  ], 4096);

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
        width: clamp(item.width || 0.1, 0.005, 1),
        height: clamp(item.height || 0.03, 0.005, 1),
        fontSize: clamp(item.font_size || 12, 6, 72),
        bold: !!item.bold,
        color: item.color || '#000000',
        type: item.type || 'body',
        // Computed relative coordinates for pptx generation
        relX: clamp(item.x, 0, 1),
        relY: clamp(item.y, 0, 1),
        relWidth: clamp(item.width || 0.1, 0.005, 1),
        relHeight: clamp(item.height || 0.03, 0.005, 1),
        relFontSize: clamp((item.height || 0.03), 0.005, 0.2),
      }));

    onLog(`OCR完了: ${cleaned.length}個のテキスト要素を検出`);
    return cleaned;
  } catch (err) {
    throw new Error(`OCR結果のパースに失敗: ${err.message}\n応答: ${text.substring(0, 200)}`);
  }
}

/**
 * Detect text regions for masking (more aggressive detection for background generation).
 * 
 * @param {string} apiKey - OpenAI API key
 * @param {string} imageBase64 - Base64 encoded image
 * @param {function} onLog - Logging callback
 * @returns {Promise<Array|null>} Array of text region bounding boxes or null
 */
export async function detectTextRegions(apiKey, imageBase64, onLog = () => {}) {
  try {
    onLog('テキスト領域を検出中...');

    const response = await callVisionApi(apiKey, [
      {
        role: 'system',
        content: `Analyze this image and identify ALL regions containing text.
Return a JSON array of bounding boxes. Each box:
{"x": <left 0-1>, "y": <top 0-1>, "width": <0-1>, "height": <0-1>}
Coordinates are relative to image dimensions (0.0 to 1.0).
Include ALL text: titles, body, labels, numbers, watermarks, small text.
Be generous with bounding box sizes - it's better to include extra padding.
Return ONLY the JSON array.`
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Identify all text regions. Return JSON array of bounding boxes.'
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'high' }
          }
        ]
      }
    ], 2048);

    const text = response.choices[0].message.content.trim();
    const jsonStr = extractJson(text);
    const regions = JSON.parse(jsonStr);

    if (Array.isArray(regions) && regions.length > 0) {
      // Validate and add padding
      const validated = regions
        .filter(r => typeof r.x === 'number' && typeof r.y === 'number')
        .map(r => ({
          x: clamp(r.x - 0.01, 0, 1),
          y: clamp(r.y - 0.01, 0, 1),
          width: clamp((r.width || 0.1) + 0.02, 0.01, 1),
          height: clamp((r.height || 0.03) + 0.02, 0.01, 1),
        }));

      onLog(`${validated.length}個のテキスト領域を検出`);
      return validated;
    }
    return null;
  } catch (err) {
    onLog(`テキスト領域検出に失敗: ${err.message}`, 'warn');
    return null;
  }
}

/**
 * Call the OpenAI Chat Completions API with vision support.
 * Includes retry logic with exponential backoff.
 */
async function callVisionApi(apiKey, messages, maxTokens = 4096, maxRetries = 3) {
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
          max_tokens: maxTokens,
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
          throw new Error(`認証エラー (${response.status}): APIキーを確認してください。正しい形式は sk-... です。`);
        }

        if (response.status === 429) {
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
  // Try markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // Try JSON array directly
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];

  // Try JSON object directly
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
