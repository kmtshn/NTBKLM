/**
 * Cloudflare Workers - OpenAI Image Edit Proxy
 * 
 * Proxies image edit requests to OpenAI's /v1/images/edits endpoint.
 * The OpenAI API key is stored as a Workers secret (OPENAI_API_KEY),
 * so it never appears in frontend code.
 * 
 * Supports:
 *   - Image editing with mask (gpt-image-1.5 inpainting)
 *   - Image editing without mask
 *   - Image generation (no source image)
 * 
 * DEPLOY:
 *   1. cd workers/
 *   2. wrangler secret put OPENAI_API_KEY   (paste your sk-... key)
 *   3. wrangler deploy
 * 
 * REQUEST FORMAT (from frontend):
 *   POST / 
 *   Content-Type: application/json
 *   {
 *     "model": "gpt-image-1.5",
 *     "prompt": "Remove all text from this slide...",
 *     "image": "data:image/png;base64,iVBOR...",   // original slide image
 *     "mask": "data:image/png;base64,iVBOR...",     // optional: OCR-based mask
 *     "size": "1536x1024",
 *     "quality": "medium",
 *     "input_fidelity": "high"
 *   }
 * 
 * RESPONSE FORMAT (passed through from OpenAI):
 *   {
 *     "data": [{ "b64_json": "iVBOR..." }],
 *     "created": 1234567890,
 *     ...
 *   }
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    if (request.method !== 'POST') {
      return jsonError('Method not allowed', 405);
    }

    try {
      const body = await request.json();
      const { model, prompt, image, mask, size, quality, input_fidelity } = body;

      if (!prompt) {
        return jsonError('Missing required field: prompt', 400);
      }

      // Build the OpenAI API request body
      const openaiBody = {
        model: model || 'gpt-image-1.5',
        prompt: prompt,
        size: size || '1536x1024',
        quality: quality || 'medium',
      };

      // If an image is provided, use /v1/images/edits (edit mode)
      // Otherwise, use /v1/images/generations (generation mode)
      let endpoint;
      if (image) {
        endpoint = 'https://api.openai.com/v1/images/edits';
        // The images/edits endpoint accepts images as an array of objects
        // with image_url field for base64 data URLs
        openaiBody.images = [{ image_url: image }];
        // input_fidelity controls how closely the output matches the input
        if (input_fidelity) {
          openaiBody.input_fidelity = input_fidelity;
        }
        // Mask: tells the model which areas to inpaint
        // White areas = inpaint (remove text), Black areas = preserve
        if (mask) {
          openaiBody.mask = { image_url: mask };
        }
      } else {
        endpoint = 'https://api.openai.com/v1/images/generations';
      }

      const openaiResponse = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(openaiBody),
      });

      const responseBody = await openaiResponse.text();

      return new Response(responseBody, {
        status: openaiResponse.status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(),
        },
      });

    } catch (err) {
      return jsonError(`Server error: ${err.message}`, 500);
    }
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}
