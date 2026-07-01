// score-qualitative
//
// Scores a brand's weekly Branding / Target Audience / Communication notes
// using Google's Gemini API (free tier — no credit card required, get a key
// at aistudio.google.com), then writes the scores straight into the
// weekly_qualitative table. Called from the app whenever a manager submits
// qualitative notes without also typing a manual 0-100 score.
//
// Deploy: supabase functions deploy score-qualitative --no-verify-jwt
// Secret: supabase secrets set GEMINI_API_KEY=...
//   (get a free key at https://aistudio.google.com/apikey — no billing setup)
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by
// Supabase into every Edge Function — no need to set those as secrets.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const GEMINI_MODEL = 'gemini-2.5-flash'; // free-tier eligible; swap here if Google renames/retires it
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    if (!GEMINI_API_KEY) {
      return json({ error: 'GEMINI_API_KEY secret is not set on this project.' }, 500);
    }

    const { brand, weekLabel, weekEnding, brandNotes, audienceNotes, commNotes } = await req.json();
    if (!brand || !weekLabel) {
      return json({ error: 'brand and weekLabel are required' }, 400);
    }
    if (!brandNotes && !audienceNotes && !commNotes) {
      return json({ error: 'Provide at least one of brandNotes, audienceNotes, commNotes to score.' }, 400);
    }

    const prompt = `You are scoring a social media manager's self-reported weekly notes for a small business brand called "${brand}".

Score each category from 0-100 based ONLY on what's described in the notes (be a fair, moderately strict grader — vague or empty notes should score in the 40-60 range, not high):

1. AI Branding Score — brand consistency, visual identity, tone of voice, content quality.
Notes: "${(brandNotes || 'No notes provided.').replace(/"/g, "'")}"

2. Target Audience Quality — relevance of the audience reached, demographic fit, conversion readiness.
Notes: "${(audienceNotes || 'No notes provided.').replace(/"/g, "'")}"

3. Communication Score — response time, comment replies, DM management, professionalism.
Notes: "${(commNotes || 'No notes provided.').replace(/"/g, "'")}"

Respond with ONLY a JSON object in this exact shape, no other text:
{"brandingScore": <0-100 integer>, "audienceScore": <0-100 integer>, "commScore": <0-100 integer>, "reasoning": "<one sentence summary>"}`;

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // thinkingBudget: 0 turns off Gemini 2.5 Flash's internal "thinking" pass —
          // otherwise it silently burns the token budget on reasoning before it ever
          // writes the visible JSON answer, and the response comes back truncated.
          generationConfig: { maxOutputTokens: 1024, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return json({ error: `AI API error: ${errText}` }, 502);
    }

    const aiData = await aiRes.json();
    const rawText = aiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      return json({ error: 'AI response was not valid JSON', raw: rawText }, 502);
    }
    const scores = JSON.parse(match[0]);

    const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: existing } = await supabase
      .from('weekly_qualitative')
      .select('id')
      .eq('brand', brand)
      .eq('week_label', weekLabel)
      .maybeSingle();

    const fields = {
      branding_score: clamp(scores.brandingScore),
      audience_score: clamp(scores.audienceScore),
      comm_score: clamp(scores.commScore),
      ai_scored_at: new Date().toISOString(),
    };

    if (existing) {
      await supabase.from('weekly_qualitative').update(fields).eq('id', existing.id);
    } else {
      await supabase.from('weekly_qualitative').insert({
        brand,
        week_label: weekLabel,
        week_ending: weekEnding || null,
        comm_notes: commNotes || '',
        brand_notes: brandNotes || '',
        audience_notes: audienceNotes || '',
        ...fields,
      });
    }

    return json({ ok: true, ...fields, reasoning: scores.reasoning });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
