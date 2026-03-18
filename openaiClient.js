/**
 * openaiClient.js - OpenAI API Integration Module
 * 
 * Handles:
 * - Structured OCR via GPT-4o vision (optimized for Japanese business documents)
 * - AI background generation via GPT Image API (text removal from slides)
 * - API error handling, retries, and rate limiting
 */

const CHAT_API_URL = 'https://api.openai.com/v1/chat/completions';
const IMAGE_EDIT_API_URL = 'https://api.openai.com/v1/images/edits';
const VISION_MODEL = 'gpt-4o';
const IMAGE_MODEL = 'gpt-image-1';

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
 * Generate a text-free background image using OpenAI Image Edit API.
 * 
 * Sends the original slide image to gpt-image-1 with a prompt to
 * reproduce the slide's visual design but with ALL text removed.
 * The result is a brand-new image that preserves the layout, colors,
 * shapes, icons, and overall visual feel — but without any text.
 * 
 * @param {string} apiKey - OpenAI API key
 * @param {string} imageBase64 - Base64 encoded image (PNG or JPEG)
 * @param {string} mimeType - MIME type of the image ('image/png' or 'image/jpeg')
 * @param {function} onLog - Logging callback
 * @returns {Promise<string>} Data URL of the generated background image
 */
export async function generateCleanBackground(apiKey, imageBase64, mimeType = 'image/png', onLog = () => {}) {
  onLog('AI画像生成で背景を作成中（テキスト除去）...');

  const prompt = `Look at this presentation slide image carefully. 
Reproduce the EXACT same image but with ALL text completely removed.

IMPORTANT RULES:
- Keep the exact same layout, background colors, gradients, patterns
- Keep all icons, logos, images, diagrams, shapes, lines, borders
- Keep the exact same color scheme and visual style
- Remove ALL text characters (Japanese, English, numbers, symbols used as labels)
- Where text was, fill naturally with the surrounding background color/pattern
- The result should look like a clean template/background ready for new text overlay
- Do NOT add any new elements, watermarks, or text
- Maintain the same aspect ratio and overall composition
- The background areas where text was removed should blend seamlessly`;

  // Convert base64 to Blob for FormData
  const imageBlob = base64ToBlob(imageBase64, mimeType);
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';

  // Determine best output size based on aspect ratio
  // gpt-image-1 supports: 1024x1024, 1024x1536, 1536x1024, auto
  const size = 'auto';

  const formData = new FormData();
  formData.append('model', IMAGE_MODEL);
  formData.append('image', imageBlob, `slide.${ext}`);
  formData.append('prompt', prompt);
  formData.append('size', size);
  formData.append('quality', 'high');

  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      onLog(`  画像生成API呼び出し中... (試行 ${attempt}/3)`);

      const response = await fetch(IMAGE_EDIT_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: formData,
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

        if (response.status === 401 || response.status === 403) {
          throw new Error(`認証エラー (${response.status}): APIキーを確認してください。`);
        }

        if (response.status === 429) {
          const waitTime = attempt * 10000;
          onLog(`  レート制限。${waitTime / 1000}秒待機中...`, 'warn');
          await sleep(waitTime);
          lastError = new Error(`レート制限 (429): ${errorMsg}`);
          continue;
        }

        throw new Error(`Image API error (${response.status}): ${errorMsg}`);
      }

      const result = await response.json();

      if (result.data && result.data.length > 0 && result.data[0].b64_json) {
        const base64Data = result.data[0].b64_json;
        const dataUrl = `data:image/png;base64,${base64Data}`;

        // Log token usage if available
        if (result.usage) {
          onLog(`  画像生成完了 (入力: ${result.usage.input_tokens}トークン, 出力: ${result.usage.output_tokens}トークン)`);
        } else {
          onLog('  AI背景画像生成完了', 'success');
        }

        return dataUrl;
      }

      throw new Error('画像データが応答に含まれていません');

    } catch (err) {
      lastError = err;
      if (err.message.includes('認証エラー')) throw err;
      if (attempt < 3) {
        onLog(`  リトライ中... (${err.message})`, 'warn');
        await sleep(attempt * 3000);
      }
    }
  }

  throw lastError;
}

/**
 * Call the OpenAI Chat Completions API with vision support.
 * Includes retry logic with exponential backoff.
 */
async function callVisionApi(apiKey, messages, maxTokens = 4096, maxRetries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(CHAT_API_URL, {
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
 * Convert a base64 string to a Blob.
 * @param {string} base64 - Base64 encoded data
 * @param {string} mimeType - MIME type
 * @returns {Blob}
 */
function base64ToBlob(base64, mimeType = 'image/png') {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
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
