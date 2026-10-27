// The two things that ask Claude: SOAP notes from a visit, and the
// patient-facing chatbot.
//
// The key is read from the settings table or the environment, never from the
// page — the browser must not hold it, which was already true and stays true.
const { setting } = require("../auth");

const API = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.KB_CLAUDE_MODEL || "claude-sonnet-5-5";

const actions = {};

async function ask(systemPrompt, userText, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY || (await setting("anthropic_api_key"));
  if (!key) return { success: false, error: "No Claude API key is set" };

  let res;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": String(key),
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens || 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userText }]
      })
    });
  } catch (e) {
    // The clinic PC's internet is down, or the surgery's wifi dropped. Say
    // that, rather than letting the screen hang.
    return { success: false, error: `Could not reach Claude: ${e.message}` };
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.content || !body.content[0]) {
    return { success: false, error: (body && body.error && body.error.message) || `Claude returned ${res.status}` };
  }
  return { success: true, text: body.content[0].text };
}

actions.generateSOAPNotes = async (p) => {
  const out = await ask(
    "You write SOAP notes for a dental clinic. Four headed sections — " +
    "Subjective, Objective, Assessment, Plan — in plain clinical English. " +
    "Do not invent findings that were not given to you.",
    String(p.notes || p.text || ""),
    1024
  );
  return out.success ? { success: true, soap: out.text } : out;
};

actions.chatbotReply = async (p) => {
  const out = await ask(
    "You answer patients' questions for K.B. Dental Clinic: timings, " +
    "directions, what to expect from a treatment, and how to book. You do " +
    "not give a diagnosis and you do not give medical advice — for anything " +
    "clinical, say the clinic will advise at the appointment.",
    String(p.message || p.text || ""),
    512
  );
  return out.success ? { success: true, reply: out.text } : out;
};

module.exports = { actions };
