const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

export async function callModel(
  modelId: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ output: any; cost: number }> {

  if (!OPENROUTER_API_KEY) {
    // Generic error - don't reveal env var names
    console.error('[CONFIG] Model API key not configured');
    throw new Error('Model service not configured');
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://observable-lab.vercel.app',
      'X-Title': 'Observable Multi-Agent Lab',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    // Log full error server-side only, return generic message to client
    const errorBody = await response.text();
    console.error(`[API] Model call failed: ${response.status}`, errorBody);
    throw new Error(`Model service error (${response.status})`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;

  // Parse JSON - handle markdown code blocks
  let parsed;
  try {
    const jsonMatch = content.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[1] : content);
  } catch (e) {
    // Log content server-side for debugging, generic error to client
    console.error('[PARSE] Failed to parse model output:', content);
    throw new Error('Model returned invalid response');
  }

  // Calculate cost (rough estimate from token usage)
  const tokens = data.usage?.total_tokens || 0;
  const cost = tokens * 0.000003; // Adjust based on model pricing

  return { output: parsed, cost };
}
