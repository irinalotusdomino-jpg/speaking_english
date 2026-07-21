/**
 * Cloudflare Worker: LLM-based grammar checker proxy.
 *
 * Why this exists: your index.html is a static page on GitHub Pages, so it
 * can't safely hold an API key. This worker holds the key as a secret,
 * receives the transcript from the page, asks an LLM to check it, and
 * returns clean JSON back to the page.
 *
 * Deploy steps are in README.md next to this file.
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

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:

{
  "corrected": "the full corrected sentence",
  "errors": [
    {
      "original": "exact original phrase with the error",
      "correction": "the corrected phrase",
      "explanation": "short explanation IN UKRAINIAN, one sentence, friendly and specific"
    }
  ]
}

If there are truly no errors, return "corrected" identical to the input and "errors": [].
List errors in the order they appear in the sentence. Keep explanations short (max ~20 words), in Ukrainian.`;

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

      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        return new Response(JSON.stringify({ error: 'Upstream LLM error', detail: errText }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const data = await upstream.json();
      const content = data.choices?.[0]?.message?.content || '{"corrected":"","errors":[]}';

      // content is already a JSON string (thanks to response_format), pass it straight through
      return new Response(content, {
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
