/**
 * Cloudflare Worker: LLM-based grammar checker proxy.
 *
 * Uses Cloudflare Workers AI — free tier (10,000 "Neurons"/day, no card
 * needed), runs entirely inside your Cloudflare account. No external API
 * key to manage.
 *
 * Why this exists: your index.html is a static page on GitHub Pages, so it
 * can't safely hold an API key. This worker receives the transcript from
 * the page, asks the model to check it, and returns clean JSON back.
 *
 * Deploy steps are in README-deploy.md next to this file.
 */

const SYSTEM_PROMPT = `You are a strict but supportive English grammar checker for a Ukrainian learner practicing SPOKEN English.

You will receive a raw transcript of something the learner said out loud (from speech-to-text). It may contain multiple grammar problems, or be completely garbled / not a valid sentence at all — check thoroughly, do not assume it is mostly correct.

Check for ALL of the following:
- Verb tenses: wrong tense choice, and tense agreement/consistency within the sentence (e.g. mixing past and present when describing one continuous event)
- Subject-verb agreement
- Prepositions (in/on/at, listen to, arrive at/in, etc.)
- Articles (a/an/the, missing or wrong)
- Word order / sentence construction (including run-on or garbled speech with no clear structure)
- Missing or duplicated words
- Wrong word choice / word form (e.g. wrong part of speech)

Do NOT flag: capitalization, punctuation, or filler words like "um" — this is spoken language, a listener can't hear a comma.

If the transcript is badly garbled, rewrite it as the closest coherent, natural sentence that preserves the learner's original vocabulary and apparent intent as much as possible. Don't invent a totally different meaning.

Respond with ONLY a JSON object. No markdown code fences, no commentary before or after, nothing but the JSON object itself, in exactly this shape:

{"corrected": "the full corrected sentence", "errors": [{"original": "exact original phrase with the error", "correction": "the corrected phrase", "explanation": "short explanation IN UKRAINIAN, one sentence, friendly and specific"}]}

If there are truly no errors, return "corrected" identical to the input and "errors": [].
List errors in the order they appear in the sentence. Keep explanations short (max ~20 words), in Ukrainian.`;

// Good instruction-following model with a solid free-tier allowance.
// If you hit rate limits or want a lighter model, try '@cf/meta/llama-3.1-8b-instruct'.
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function extractJson(raw) {
  let s = (raw || '').trim();
  // strip markdown code fences if the model added them anyway
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // if there's leading/trailing chatter, grab the outermost { ... }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    s = s.slice(start, end + 1);
  }
  return s;
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      // For better security, replace '*' with your exact GitHub Pages origin,
      // e.g. 'https://yourusername.github.io'
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = await request.json();
      const text = (body && body.text || '').toString().trim();

      if (!text) {
        return new Response(JSON.stringify({ error: 'Missing "text"' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (text.length > 2000) {
        return new Response(JSON.stringify({ error: 'Text too long' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const aiResponse = await env.AI.run(MODEL, {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        max_tokens: 800,
        temperature: 0.2,
      });

      const raw = aiResponse && aiResponse.response ? aiResponse.response : '';
      const jsonStr = extractJson(raw);

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        // Model didn't return valid JSON — fail safe rather than crash the page.
        return new Response(JSON.stringify({
          error: 'Model returned invalid JSON',
          raw,
        }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (typeof parsed.corrected !== 'string') parsed.corrected = text;
      if (!Array.isArray(parsed.errors)) parsed.errors = [];

      return new Response(JSON.stringify(parsed), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

