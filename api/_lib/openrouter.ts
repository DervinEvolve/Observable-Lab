const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// A real web page the model consulted (from OpenRouter's web plugin), surfaced
// so the lab can stream what a model actually browsed into its terminal.
export interface WebCitation {
  url: string
  title: string
}

// Pull url_citation annotations off an OpenRouter message (present when the
// web plugin ran). Best-effort — shape varies slightly across models.
function extractCitations(message: any): WebCitation[] {
  const annotations = message?.annotations
  if (!Array.isArray(annotations)) return []
  const out: WebCitation[] = []
  for (const a of annotations) {
    const c = a?.url_citation ?? a
    if (c?.url) out.push({ url: String(c.url), title: String(c.title || c.url) })
  }
  return out
}

function extractJson(content: string): unknown {
  let trimmed = content.trim();
  if (!trimmed) {
    throw new Error('Empty model response');
  }

  // Clean up common issues
  // Remove BOM and other invisible characters
  trimmed = trimmed.replace(/^\uFEFF/, '');
  // Remove any leading/trailing backticks without code block
  trimmed = trimmed.replace(/^`+|`+$/g, '');

  // First try: extract from markdown code block
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      // Continue to other methods
    }
  }

  // Second try: find JSON object/array anywhere in the content
  const jsonObjectMatch = trimmed.match(/\{[\s\S]*\}/);
  const jsonArrayMatch = trimmed.match(/\[[\s\S]*\]/);
  const match = jsonObjectMatch || jsonArrayMatch;
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      // Try to fix common JSON issues
      let fixed = match[0]
        .replace(/,\s*}/g, '}')  // Remove trailing commas in objects
        .replace(/,\s*]/g, ']')  // Remove trailing commas in arrays
        .replace(/'/g, '"')       // Replace single quotes with double
        .replace(/(\w+):/g, '"$1":'); // Quote unquoted keys
      try {
        return JSON.parse(fixed);
      } catch (e2) {
        // Continue to last try
      }
    }
  }

  // Last try: parse entire content as JSON
  return JSON.parse(trimmed);
}

async function requestCompletion(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  jsonOnly: boolean,
  webSearch = false,
  maxTokens = 8000
): Promise<{ data: any; content: string; citations: WebCitation[] }> {
  const enforcedSystemPrompt = jsonOnly
    ? `${systemPrompt}\n\nReturn valid JSON only. Do not include markdown or commentary.`
    : systemPrompt;

  // Build request body
  const requestBody: Record<string, unknown> = {
    model: modelId,
    messages: [
      { role: 'system', content: enforcedSystemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    // Bumped from 4000: a truncated response is unparseable JSON, which threw
    // away whole contributions. Code generation needs far more room (a real
    // file wrapped in JSON with escaped newlines easily exceeds 4k tokens).
    max_tokens: maxTokens,
  };

  // Real web access via OpenRouter's web plugin — the model can search and its
  // cited sources come back as message.annotations.
  if (webSearch) {
    requestBody.plugins = [{ id: 'web', max_results: 4 }];
  }

  // Force JSON response format for models that support it (OpenAI, some others).
  // Skip it when web-searching — the web plugin and strict json_object mode
  // don't reliably compose, and we parse JSON out of the text anyway.
  if (!webSearch && (jsonOnly || modelId.includes('openai') || modelId.includes('gpt'))) {
    requestBody.response_format = { type: 'json_object' };
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://observable-lab.vercel.app',
      'X-Title': 'Observable Multi-Agent Lab',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    // Log full error server-side only, return generic message to client
    const errorBody = await response.text();
    console.error(`[API] Model call failed: ${response.status}`, errorBody);
    throw new Error(`Model service error (${response.status})`);
  }

  const data = await response.json();
  const choice = data.choices?.[0] ?? {};
  const message = choice.message ?? {};
  // Some models (e.g. reasoning models) return the answer in content, but if
  // content is empty and reasoning holds the text, fall back to it so we don't
  // discard a usable response. finish_reason is logged to diagnose emptiness.
  let content = message.content || '';
  if (!content && typeof message.reasoning === 'string') content = message.reasoning;
  if (!content) console.warn(`[MODEL] ${modelId} returned empty content (finish_reason=${choice.finish_reason})`);

  return { data, content, citations: extractCitations(message) };
}

// Which model actually produced an output. Attached to object outputs as
// `served_by` so it is stored with the role output and shown in the log.
export interface ServedBy {
  model: string      // the model ID that answered (the assigned one, or the fallback)
  assigned: string   // the model the role was assigned to
  fallback: boolean  // true when the assigned model failed and a substitute answered
  reported?: string  // the model name OpenRouter reported for the answering call
}

/** The model that answered a stored output: the fallback model if one stepped in, else `assigned`. */
export function answeredModel(output: unknown, assigned: string): string {
  const servedBy = output && typeof output === 'object'
    ? (output as { served_by?: Partial<ServedBy> }).served_by
    : undefined
  return servedBy?.fallback && typeof servedBy.model === 'string' && servedBy.model ? servedBy.model : assigned
}

export async function callModel(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  opts: { webSearch?: boolean; maxTokens?: number; noFallback?: boolean } = {}
): Promise<{ output: any; cost: number; citations: WebCitation[]; servedBy: ServedBy }> {

  if (!OPENROUTER_API_KEY) {
    // Generic error - don't reveal env var names
    console.error('[CONFIG] Model API key not configured');
    throw new Error('Model service not configured');
  }

  console.log(`[MODEL] Calling ${modelId}${opts.webSearch ? ' (web search)' : ''}...`);

  let data: any;
  let content = '';
  let parsed: unknown;
  let citations: WebCitation[] = [];
  let lastError: Error | null = null;
  let answeredBy = modelId;

  // Try up to 3 times with increasing JSON enforcement. Web search and strict
  // json_object mode don't reliably compose, so after the first attempt we
  // DROP web search and turn strict JSON back on — grounding is best-effort,
  // but a parseable response is not (a flubbed one throws away the epoch).
  for (let attempt = 0; attempt < 3; attempt++) {
    const jsonOnly = attempt > 0;
    const useWeb = opts.webSearch && attempt === 0;
    try {
      const result = await requestCompletion(modelId, systemPrompt, userPrompt, jsonOnly, useWeb, opts.maxTokens);
      data = result.data;
      content = result.content || '';
      if (result.citations.length) citations = result.citations; // keep first-attempt sources
      parsed = extractJson(content);
      break;
    } catch (e) {
      lastError = e as Error;
      if (attempt < 2) {
        console.warn(`[PARSE] Attempt ${attempt + 1} failed for ${modelId}, retrying...`);
        // Brief delay before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      console.error(`[PARSE] All attempts failed for ${modelId}. Last content:`, content.substring(0, 500));
    }
  }

  // RESILIENCE: if the assigned model never produced a usable response (empty
  // content or unparseable JSON, e.g. a flaky provider), fall back to a
  // reliable substitute so ONE bad model call can't kill the whole epoch —
  // roles depend on each other, so a dead planner/executor is fatal otherwise.
  if (parsed === undefined && !opts.noFallback) {
    const fallbacks = ['anthropic/claude-opus-4.8', 'google/gemini-3.5-flash']
      .filter(m => m !== modelId);
    for (const fb of fallbacks) {
      try {
        console.warn(`[MODEL] ${modelId} failed — falling back to ${fb}`);
        const result = await requestCompletion(fb, systemPrompt, userPrompt, true, false, opts.maxTokens);
        parsed = extractJson(result.content || '');
        data = result.data;
        answeredBy = fb;
        console.log(`[MODEL] fallback ${fb} succeeded for ${modelId}'s call`);
        break;
      } catch (e) {
        lastError = e as Error;
      }
    }
  }

  if (parsed === undefined) {
    throw new Error('Model returned invalid response');
  }

  const fallback = answeredBy !== modelId;
  const reported = typeof data?.model === 'string' && data.model.length <= 200 ? data.model : '';
  const servedBy: ServedBy = { model: answeredBy, assigned: modelId, fallback, ...(reported ? { reported } : {}) };
  console.log(fallback
    ? `[MODEL] ${modelId} failed; ${servedBy.model} answered instead`
    : `[MODEL] ${modelId} responded successfully`)
  // Record attribution with the output itself, so every stored role output
  // says who answered and whether a fallback happened.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    (parsed as Record<string, unknown>).served_by = servedBy;
  }

  // Calculate cost (rough estimate from token usage)
  const tokens = data?.usage?.total_tokens || 0;
  const cost = tokens * 0.000003; // Adjust based on model pricing

  return { output: parsed, cost, citations, servedBy };
}
