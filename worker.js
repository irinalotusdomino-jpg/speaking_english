/**
 * Cloudflare Worker: LLM-based grammar checker proxy.
 *
 * Uses Cloudflare Workers AI — free tier (10,000 "Neurons"/day, no card
 * needed), runs entirely inside your Cloudflare account. No external API
 * key to manage.
 *
 * Deploy steps are in README-deploy.md next to this file.
 */

const CATEGORY_ENUM = [
  'articles', 'tenses', 'agreement', 'prepositions',
  'plurals', 'word-choice', 'word-order', 'structure', 'spelling', 'other'
];

const SYSTEM_PROMPT = `You are a strict but supportive English grammar checker for a Ukrainian learner practicing SPOKEN English.

You will receive a raw transcript of something the learner said out loud (from speech-to-text), and optionally the question they were answering. The transcript may contain multiple grammar problems, or be completely garbled / not a valid sentence at all — check thoroughly, never assume it is mostly correct just because it "sounds fluent".

CHECK FOR ALL OF THE FOLLOWING:
- Verb tenses: wrong tense choice, tense agreement/consistency within the sentence, and whether the tense fits the question being answered (e.g. a "did you ever..." question expects Past Simple / Present Perfect)
- Subject-verb agreement
- Prepositions
- Articles (a/an/the — missing or wrong)
- Word order / sentence construction, including run-on or garbled speech with no clear structure
- Missing or duplicated words
- Wrong word choice / word form

PAY EXTRA ATTENTION to error types that are especially common for native Ukrainian speakers, because Ukrainian grammar has no direct equivalent:
- Missing articles entirely (Ukrainian has no articles at all)
- Preposition transfer errors: "listen music" instead of "listen TO music", "explain about" instead of just "explain", "depends from" instead of "depends ON", "married with" instead of "married TO"
- Double negation carried over from Ukrainian: "I don't have nothing" (should be "I don't have anything")
- Aspect/tense confusion where Ukrainian's verb-aspect system doesn't map cleanly onto English tenses (e.g. using Present Simple for something happening right now, or for a single completed past action)
- Free word order habits producing unnatural English order (Ukrainian word order is much more flexible than English's fairly strict SVO)
- Gender-based pronoun slips (he/she/it) since Ukrainian grammatical gender rules differ from English natural gender

DO NOT FLAG:
- Capitalization, punctuation, or filler words like "um" — this is spoken language, a listener can't hear a comma
- Purely stylistic alternatives — if the sentence is grammatically correct, leave it alone even if a more elegant phrasing exists

If the transcript is badly garbled, rewrite "corrected" as the closest coherent, natural sentence that preserves the learner's original vocabulary and apparent intent as much as possible. Don't invent a totally different meaning.

For each error, set "category" to exactly one of: ${CATEGORY_ENUM.join(', ')}.
List errors in the order they appear in the sentence. Keep each explanation short (max ~20 words), in Ukrainian, friendly and specific about WHY it's wrong (not just what to write instead).
If there are truly no errors, return "corrected" identical to the input and "errors": [].`;

// Good instruction-following model with a solid free-tier allowance.
// If you hit rate limits or want a lighter/faster model, try '@cf/meta/llama-3.1-8b-instruct'.
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    corrected: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: { type: 'string' },
          correction: { type: 'string' },
          explanation: { type: 'string' },
          category: { type: 'string', enum: CATEGORY_ENUM },
        },
        required: ['original', 'correction', 'explanation', 'category'],
      },
    },
  },
  required: ['corrected', 'errors'],
};

function buildUserContent(text, question) {
  if (question) {
    return `Question the learner was answering: "${question}"\n\nLearner's transcript: "${text}"`;
  }
  return `Learner's transcript: "${text}"`;
}

async function runCheck(env, text, question) {
  const aiResponse = await env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserContent(text, question) },
    ],
    max_tokens: 900,
    temperature: 0, // deterministic grammar checking, not creative writing
    response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
  });

  // With json_schema mode, Workers AI puts the parsed object straight on
  // `.response` (already an object, not a string) for supported models.
  // Fall back to parsing a string just in case.
  let parsed = aiResponse && aiResponse.response;
  if (typeof parsed === 'string') {
    parsed = JSON.parse(parsed);
  }
  return parsed;
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
      const question = (body && body.question || '').toString().trim().slice(0, 300);

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

      let parsed;
      try {
        parsed = await runCheck(env, text, question);
      } catch (e) {
        // One retry — occasionally the model/schema hiccups on the first try.
        parsed = await runCheck(env, text, question);
      }

      if (!parsed || typeof parsed.corrected !== 'string') parsed = { corrected: text, errors: [] };
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
