// Connexion aux fournisseurs d'IA, directement depuis le navigateur.
// Chaque utilisateur colle SA propre clé d'API : elle reste sur son appareil
// (localStorage) et n'est envoyée qu'au fournisseur choisi.

export const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    note: "Offre gratuite disponible (clé sur aistudio.google.com).",
    keyUrl: "https://aistudio.google.com/apikey",
    // Le modèle « lite » a en général un quota gratuit plus généreux.
    defaultModel: "gemini-flash-lite-latest",
  },
  anthropic: {
    label: "Anthropic Claude",
    note: "Payant à l'usage (clé sur platform.claude.com).",
    keyUrl: "https://platform.claude.com/settings/keys",
    defaultModel: "claude-opus-5-5",
  },
  openai: {
    label: "OpenAI",
    note: "Payant à l'usage (clé sur platform.openai.com).",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-4.1-mini",
  },
};

// Modèles Claude qui acceptent le repli automatique côté serveur en cas de refus.
const CLAUDE_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const ANTHROPIC_VERSION = "2026-10-21";

/**
 * Erreur d'IA avec un code stable, traduit ensuite par l'interface
 * (no_key, bad_key, forbidden, no_model, bad_request, rate_limit,
 *  overloaded, server, blocked, refusal, bad_json, network, unknown).
 */
export class AIError extends Error {
  constructor(code, { status = 0, detail = "", retryAfter = 0 } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.retryAfter = retryAfter; // secondes à attendre, si le fournisseur l'indique
  }
}

// 429 (quota) est traité à part : chaque nouvel essai consomme du quota.
const RETRYABLE = new Set([500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [1500, 4000, 8000];
const MAX_QUOTA_WAIT_MS = 30000;

/** Délai demandé par le fournisseur (en ms) : en-tête Retry-After, RetryInfo de Google, ou texte « retry in 17.8s ». */
async function retryDelayMs(res) {
  const header = Number(res.headers.get("retry-after"));
  if (header > 0) return header * 1000;
  try {
    const text = await res.clone().text();
    const info = text.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
    if (info) return Math.ceil(Number(info[1]) * 1000);
    const msg = text.match(/retry in ([\d.]+)\s*s/i);
    if (msg) return Math.ceil(Number(msg[1]) * 1000);
  } catch {
    /* corps illisible */
  }
  return null;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

/**
 * fetch qui réessaie tout seul :
 * - serveur surchargé (503…) : jusqu'à 3 essais espacés ;
 * - quota par minute dépassé (429) : attend le délai indiqué par le fournisseur
 *   (30 s max) puis fait UN seul nouvel essai, pour ne pas gaspiller le quota.
 * onRetry(numéroEssai, secondesAttente) permet d'informer l'utilisateur.
 */
async function fetchRetry(url, opts, onRetry) {
  let quotaRetried = false;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (attempt >= RETRY_DELAYS_MS.length) throw new AIError("network", { detail: e.message });
      onRetry?.(attempt + 1, Math.round(RETRY_DELAYS_MS[attempt] / 1000));
      await sleep(RETRY_DELAYS_MS[attempt], opts.signal);
      continue;
    }
    if (res.ok) return res;
    if (res.status === 429) {
      if (quotaRetried) return res;
      const wait = await retryDelayMs(res);
      if (wait == null || wait > MAX_QUOTA_WAIT_MS) return res;
      quotaRetried = true;
      onRetry?.(1, Math.ceil(wait / 1000));
      await sleep(wait + 500, opts.signal);
      continue;
    }
    if (!RETRYABLE.has(res.status) || attempt >= RETRY_DELAYS_MS.length) return res;
    const header = Number(res.headers.get("retry-after")) * 1000;
    const wait = header > 0 && header <= 20000 ? header : RETRY_DELAYS_MS[attempt];
    onRetry?.(attempt + 1, Math.round(wait / 1000));
    await sleep(wait, opts.signal);
  }
}

/** Lit un flux SSE et appelle onData(objetJSON) pour chaque événement "data:". */
async function readSSE(response, onData) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
      const data = chunk
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        onData(JSON.parse(data));
      } catch (e) {
        if (e instanceof AIError) throw e;
        // fragment non JSON : ignoré
      }
    }
  }
}

async function failFromResponse(res) {
  const retryAfter = res.status === 429 ? Math.ceil(((await retryDelayMs(res)) || 0) / 1000) : 0;
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.error?.status || JSON.stringify(body).slice(0, 200);
  } catch {
    detail = res.statusText;
  }
  const s = res.status;
  const code =
    { 400: "bad_request", 401: "bad_key", 403: "forbidden", 404: "no_model", 429: "rate_limit", 503: "overloaded", 529: "overloaded" }[s] ||
    (s >= 500 ? "server" : "unknown");
  // Gemini renvoie parfois 400 pour une clé invalide.
  const finalCode = code === "bad_request" && /api key/i.test(detail) ? "bad_key" : code;
  // Quota journalier épuisé (pas seulement par minute) : on le signale différemment.
  const daily = s === 429 && /per ?day|daily|PerDay/i.test(detail);
  throw new AIError(daily ? "quota_day" : finalCode, { status: s, detail, retryAfter });
}

/* ---------------- Gemini ---------------- */
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

function geminiBody(system, messages, json) {
  const body = {
    contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig = { responseMimeType: "application/json" };
  return body;
}

async function geminiStream(cfg, system, messages, onText, signal, json = false) {
  const res = await fetchRetry(`${GEMINI}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": cfg.key },
    body: JSON.stringify(geminiBody(system, messages, json)),
    signal,
  }, cfg.onRetry);
  if (!res.ok) await failFromResponse(res);
  let full = "";
  await readSSE(res, (ev) => {
    const cand = ev.candidates?.[0];
    if (ev.promptFeedback?.blockReason) throw new AIError("blocked", { detail: ev.promptFeedback.blockReason });
    if (ev.error) throw new AIError(ev.error.code === 503 ? "overloaded" : "server", { status: ev.error.code || 0, detail: ev.error.message || "" });
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    if (text) {
      full += text;
      onText(full);
    }
  });
  return full;
}

async function geminiModels(cfg) {
  const res = await fetchRetry(`${GEMINI}/models?pageSize=200`, { headers: { "x-goog-api-key": cfg.key } });
  if (!res.ok) await failFromResponse(res);
  const data = await res.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((id) => id.startsWith("gemini"))
    // On garde seulement les modèles qui savent discuter en texte.
    .filter((id) => !/(tts|image|banana|robotics|computer-use|transcribe|omni|embedding|customtools|argon)/.test(id));
}

/* ---------------- Anthropic Claude ---------------- */
const ANTHROPIC = "https://api.anthropic.com/v1";

function anthropicHeaders(cfg, withFallback) {
  const h = {
    "content-type": "application/json",
    "x-api-key": cfg.key,
    "anthropic-version": ANTHROPIC_VERSION,
    // Obligatoire pour appeler l'API depuis un navigateur avec la clé de l'utilisateur.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (withFallback) h["anthropic-beta"] = "server-side-fallback-2026-07-01";
  return h;
}

async function anthropicStream(cfg, system, messages, onText, signal, json = false) {
  const withFallback = CLAUDE_FALLBACK_MODELS.has(cfg.model);
  const body = {
    model: cfg.model,
    max_tokens: 64000,
    stream: true,
    system: json ? `${system}\n\nRéponds uniquement avec un objet JSON valide, sans texte autour ni bloc de code.` : system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    // Conversation : effort bas = réponses rapides et peu coûteuses ; leçons : effort moyen.
    output_config: { effort: json ? "medium" : "low" },
  };
  if (withFallback) body.fallbacks = "default";
  const res = await fetchRetry(`${ANTHROPIC}/messages`, {
    method: "POST",
    headers: anthropicHeaders(cfg, withFallback),
    body: JSON.stringify(body),
    signal,
  }, cfg.onRetry);
  if (!res.ok) await failFromResponse(res);
  let full = "";
  let stopReason = null;
  await readSSE(res, (ev) => {
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      full += ev.delta.text;
      onText(full);
    } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
      stopReason = ev.delta.stop_reason;
    } else if (ev.type === "error") {
      const type = ev.error?.type || "";
      throw new AIError(type === "overloaded_error" ? "overloaded" : type === "rate_limit_error" ? "rate_limit" : "server", { detail: ev.error?.message || type });
    }
  });
  if (stopReason === "refusal" && !full) throw new AIError("refusal");
  return full;
}

async function anthropicModels(cfg) {
  const res = await fetchRetry(`${ANTHROPIC}/models?limit=100`, { headers: anthropicHeaders(cfg, false) });
  if (!res.ok) await failFromResponse(res);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

/* ---------------- OpenAI ---------------- */
const OPENAI = "https://api.openai.com/v1";

async function openaiStream(cfg, system, messages, onText, signal, json = false) {
  const body = {
    model: cfg.model,
    stream: true,
    messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
  };
  if (json) body.response_format = { type: "json_object" };
  const res = await fetchRetry(`${OPENAI}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
    signal,
  }, cfg.onRetry);
  if (!res.ok) await failFromResponse(res);
  let full = "";
  await readSSE(res, (ev) => {
    const text = ev.choices?.[0]?.delta?.content;
    if (text) {
      full += text;
      onText(full);
    }
  });
  return full;
}

async function openaiModels(cfg) {
  const res = await fetchRetry(`${OPENAI}/models`, { headers: { authorization: `Bearer ${cfg.key}` } });
  if (!res.ok) await failFromResponse(res);
  const data = await res.json();
  return (data.data || [])
    .map((m) => m.id)
    .filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding)/.test(id))
    .sort();
}

/* ---------------- API commune ---------------- */
const STREAMERS = { gemini: geminiStream, anthropic: anthropicStream, openai: openaiStream };
const LISTERS = { gemini: geminiModels, anthropic: anthropicModels, openai: openaiModels };

function check(cfg) {
  if (!cfg?.key) throw new AIError("no_key");
  if (!STREAMERS[cfg.provider]) throw new AIError("unknown", { detail: "provider" });
}

/**
 * Conversation en streaming. onText reçoit le texte complet à chaque nouveau morceau ;
 * onRetry(n) est appelé quand le fournisseur est surchargé et qu'on réessaie.
 */
export async function streamChat(cfg, { system, messages, onText, signal, onRetry }) {
  check(cfg);
  return STREAMERS[cfg.provider]({ ...cfg, onRetry }, system, messages, onText || (() => {}), signal, false);
}

/** Demande un objet JSON (leçons, quiz, phrases). */
export async function completeJSON(cfg, { system, prompt, signal, onRetry }) {
  check(cfg);
  const text = await STREAMERS[cfg.provider]({ ...cfg, onRetry }, system, [{ role: "user", content: prompt }], () => {}, signal, true);
  return parseJSONLoose(text);
}

/**
 * Transcrit un enregistrement audio (secours quand la reconnaissance vocale
 * du téléphone n'est pas disponible). Gemini uniquement : il accepte l'audio en entrée.
 */
export async function transcribeAudio(cfg, { blob, language, onRetry, signal }) {
  check(cfg);
  if (cfg.provider !== "gemini") throw new AIError("unknown", { detail: "audio transcription needs Gemini" });
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: blob.type || "audio/webm", data: base64 } },
          {
            text: `Transcribe exactly what is said in this recording. The speaker is practising ${language}. Return only the transcription, with no comment. If nothing intelligible is said, return an empty string.`,
          },
        ],
      },
    ],
  };
  const res = await fetchRetry(
    `${GEMINI}/models/${encodeURIComponent(cfg.model)}:generateContent`,
    { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": cfg.key }, body: JSON.stringify(body), signal },
    onRetry
  );
  if (!res.ok) await failFromResponse(res);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  return text.replace(/^["«»“”]+|["«»“”]+$/g, "").trim();
}

export async function listModels(cfg) {
  check(cfg);
  return LISTERS[cfg.provider](cfg);
}

export function parseJSONLoose(text) {
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* continue */
      }
    }
    throw new AIError("bad_json");
  }
}
