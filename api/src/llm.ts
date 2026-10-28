// The one place the server talks to the language model: the consent
// narrative and the chatbot both come through here. The key lives in the
// server's environment and never reaches a page.

export class LlmError extends Error {}

export interface ChatMessage { role: "user" | "assistant"; content: string }

export async function complete(opts: { model: string; system?: string; messages: ChatMessage[]; maxTokens: number }): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new LlmError("ANTHROPIC_API_KEY is not set on the server");
  let data: { content?: { text?: string }[]; error?: { message?: string } };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: opts.model, max_tokens: opts.maxTokens, messages: opts.messages, ...(opts.system ? { system: opts.system } : {})
      }),
      signal: AbortSignal.timeout(30_000)
    });
    data = (await res.json()) as typeof data;
  } catch {
    throw new LlmError("The writer could not be reached. Try again.");
  }
  const text = data.content?.[0]?.text;
  if (!text) throw new LlmError(data.error?.message ?? "No content in API response");
  return text;
}

/** At most `max` calls per person in any `windowMs`; the model is paid for by the call. */
export function callLimiter(max: number, windowMs: number) {
  const calls = new Map<string, number[]>();
  return (who: string): boolean => {
    const now = Date.now();
    const recent = (calls.get(who) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { calls.set(who, recent); return false; }
    calls.set(who, [...recent, now]);
    return true;
  };
}
