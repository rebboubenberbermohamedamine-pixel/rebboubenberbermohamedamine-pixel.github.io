import { PROVIDERS, streamChat, completeJSON, listModels, transcribeAudio } from "./ai.js";
import { t, setUiLang, uiLang, nativeLanguageName, guessNativeLang, NATIVE_LANGS } from "./i18n.js";

/* =====================================================================
   État et stockage
   ===================================================================== */

const STORE_KEY = "parlio:v1";

const DEFAULT_STATE = {
  target: "en", // langue apprise : "en" ou "fr"
  ui: "fr", // langue maternelle : "ar", "en" ou "fr" (interface + explications)
  onboarded: false,
  level: "A2",
  theme: "auto",
  voiceRate: 1,
  provider: "gemini",
  keys: { gemini: "", anthropic: "", openai: "" },
  models: {},
  character: { en: "tutor", fr: "tutor" },
  chats: { en: {}, fr: {} },
  progress: { xpByDay: {}, lessons: 0, messages: 0, oralScores: [], words: { en: [], fr: [] } },
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return freshState();
    const saved = JSON.parse(raw);
    return deepMerge(structuredClone(DEFAULT_STATE), saved);
  } catch {
    return freshState();
  }
}

function freshState() {
  const s = structuredClone(DEFAULT_STATE);
  s.ui = guessNativeLang();
  s.target = s.ui === "en" ? "fr" : "en";
  return s;
}

function deepMerge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

let state = loadState();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* stockage plein ou bloqué : l'app continue sans sauvegarder */
  }
}

function aiConfig() {
  const p = state.provider;
  return { provider: p, key: (state.keys[p] || "").trim(), model: state.models[p] || PROVIDERS[p].defaultModel };
}

const hasKey = () => Boolean(aiConfig().key);

/* =====================================================================
   Contenu pédagogique
   ===================================================================== */

const LANG = {
  en: { name: "English", speech: "en-US" },
  fr: { name: "French", speech: "fr-FR" },
};
const LEVELS = ["A1", "A2", "B1", "B2", "C1"];

const CHARACTERS = {
  tutor: {
    emoji: "🧑‍🏫",
    name: { en: "Emma", fr: "Léa" },
    role: { fr: "Tutrice bienveillante", en: "Friendly tutor", ar: "معلّمة لطيفة" },
    persona:
      "a warm, patient language tutor. Chat about everyday topics the learner likes, ask one follow-up question at a time and recycle useful vocabulary.",
  },
  cafe: {
    emoji: "☕",
    name: { en: "Jake", fr: "Hugo" },
    role: { fr: "Serveur de café", en: "Café waiter", ar: "نادل في مقهى" },
    persona:
      "a waiter in a busy café. Role-play taking the learner's order, suggesting items, answering questions about the menu and handling the bill. Stay in character.",
  },
  interview: {
    emoji: "💼",
    name: { en: "Ms. Carter", fr: "Mme Martin" },
    role: { fr: "Entretien d'embauche", en: "Job interview", ar: "مقابلة عمل" },
    persona:
      "a friendly but professional recruiter running a job interview. Ask classic interview questions one at a time and react to the answers. Stay in character.",
  },
  travel: {
    emoji: "✈️",
    name: { en: "Noah", fr: "Inès" },
    role: { fr: "Voyage et tourisme", en: "Travel & tourism", ar: "السفر والسياحة" },
    persona:
      "a local guide helping a tourist: directions, hotel check-in, transport, sightseeing and small problems while travelling. Stay in character.",
  },
};

const TOPICS = {
  grammar: {
    en: ["Present simple vs continuous", "Past simple", "Present perfect", "Future: will / going to", "Comparatives", "Modal verbs", "Conditionals", "Prepositions of time"],
    fr: ["Le présent", "Le passé composé", "L'imparfait", "Le futur proche", "Les articles", "Les pronoms COD / COI", "Le subjonctif", "Les négations"],
  },
  vocab: {
    en: ["Food & restaurants", "Travel", "Work & office", "Health", "Shopping", "Feelings", "Phrasal verbs", "Small talk"],
    fr: ["La nourriture", "Le voyage", "Le travail", "La santé", "Les courses", "Les émotions", "Expressions courantes", "Le logement"],
  },
  reading: {
    en: ["A day in London", "Healthy habits", "Technology today", "A short story"],
    fr: ["Une journée à Paris", "Les vacances", "La vie en ville", "Une petite histoire"],
  },
};

// Phrases intégrées : l'oral fonctionne même sans clé ni connexion.
const BUILTIN_PHRASES = {
  en: [
    { text: "Could I have a glass of water, please?", translation: { fr: "Je pourrais avoir un verre d'eau, s'il vous plaît ?", ar: "هل يمكنني الحصول على كوب من الماء، من فضلك؟" } },
    { text: "I have been learning English for two years.", translation: { fr: "J'apprends l'anglais depuis deux ans.", ar: "أتعلّم الإنجليزية منذ سنتين." } },
    { text: "What time does the next train leave?", translation: { fr: "À quelle heure part le prochain train ?", ar: "في أي ساعة يغادر القطار التالي؟" } },
    { text: "I'm looking forward to seeing you again.", translation: { fr: "J'ai hâte de te revoir.", ar: "أتطلّع إلى رؤيتك مرة أخرى." } },
    { text: "Would you mind opening the window?", translation: { fr: "Ça vous dérangerait d'ouvrir la fenêtre ?", ar: "هل تمانع أن تفتح النافذة؟" } },
  ],
  fr: [
    { text: "Je voudrais un café, s'il vous plaît.", translation: { en: "I would like a coffee, please.", ar: "أريد قهوة، من فضلك." } },
    { text: "Excusez-moi, où se trouve la gare ?", translation: { en: "Excuse me, where is the train station?", ar: "عذرًا، أين تقع محطة القطار؟" } },
    { text: "J'apprends le français depuis six mois.", translation: { en: "I have been learning French for six months.", ar: "أتعلّم الفرنسية منذ ستة أشهر." } },
    { text: "Il fait très beau aujourd'hui.", translation: { en: "The weather is very nice today.", ar: "الطقس جميل جدًا اليوم." } },
    { text: "Pourriez-vous parler plus lentement ?", translation: { en: "Could you speak more slowly?", ar: "هل يمكنك التحدّث ببطء أكثر؟" } },
  ],
};

/** Traduction dans la langue maternelle (texte simple venant de l'IA, ou objet par langue). */
function translationFor(tr) {
  if (!tr) return "";
  if (typeof tr === "string") return tr;
  return tr[state.ui] || "";
}

/** Flèches « précédent / suivant » qui suivent le sens d'écriture. */
const arrowBack = () => (NATIVE_LANGS[state.ui]?.dir === "rtl" ? "→" : "←");
const arrowNext = () => (NATIVE_LANGS[state.ui]?.dir === "rtl" ? "←" : "→");

/* =====================================================================
   Outils d'interface
   ===================================================================== */

/** Crée un élément sans jamais interpréter de HTML venant de l'IA. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "html") throw new Error("html interdit");
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Mot + traduction, chacun isolé pour mélanger correctement arabe et latin. */
function wordChip(word, translation) {
  return el("span", { title: translation || "" }, el("bdi", { dir: "ltr" }, word || ""), " — ", el("bdi", { dir: "auto" }, translation || ""));
}

/** Ajoute des éléments à un conteneur en ignorant les valeurs vides. */
function mount(parent, ...children) {
  parent.append(...children.flat().filter((c) => c != null && c !== false));
}

/** Affiche du texte avec **gras** et retours à la ligne, sans HTML. */
function richText(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text).split(/(\*\*[^*]+\*\*|\*[^*\s][^*\n]*?\*)/g);
  for (const p of parts) {
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) frag.append(el("strong", {}, p.slice(2, -2)));
    else if (p.startsWith("*") && p.endsWith("*") && p.length > 2) frag.append(el("em", {}, p.slice(1, -1)));
    else frag.append(document.createTextNode(p));
  }
  return frag;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const box = document.getElementById("toast");
  box.textContent = msg;
  box.setAttribute("dir", "auto");
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("show"), ms);
}

/** Message d'erreur dans la langue maternelle (le détail technique reste en console). */
function errText(e) {
  if (e?.code) {
    if (e.detail) console.warn("Parlio:", e.code, e.status || "", e.detail);
    if (e.code === "rate_limit" && e.retryAfter > 0) return t("err_rate_limit_wait", { s: e.retryAfter });
    const key = `err_${e.code}`;
    const msg = t(key);
    return `${msg === key ? t("err_unknown") : msg}${e.status ? ` (${e.status})` : ""}`;
  }
  return e?.message || t("err_unknown");
}

const showError = (e) => toast(`${t("error")} : ${errText(e)}`, 6000);
const onRetry = (n, s = 0) =>
  s >= 5 ? toast(t("retry_wait", { s }), s * 1000 + 1000) : toast(t("retrying", { n }), 4000);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function addXP(n) {
  if (n <= 0) return;
  const d = today();
  state.progress.xpByDay[d] = (state.progress.xpByDay[d] || 0) + n;
  save();
  toast(t("xp_gain", { n }));
}

const targetName = () => t(`lang_${state.target}`);

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", state.theme);
}

/* ---------- Voix ---------- */

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const clean = text.replace(/✏️[\s\S]*$/, "").replace(/\*/g, "");
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = LANG[state.target].speech;
  u.rate = Number(state.voiceRate) || 1;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace("_", "-").startsWith(state.target));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/** Problème de micro : kind = blocked | no_device | service | unsupported. */
class MicError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

let micGranted = false;

/**
 * Demande l'autorisation du micro de façon explicite (getUserMedia).
 * C'est ce qui fait apparaître la fenêtre « Autoriser ? » d'Android/Chrome,
 * y compris dans l'APK : l'utilisateur n'a rien à régler à la main.
 */
async function ensureMic() {
  if (micGranted) return;
  if (!navigator.mediaDevices?.getUserMedia) return; // navigateur ancien : la reconnaissance gérera
  try {
    const status = await navigator.permissions?.query({ name: "microphone" });
    if (status?.state === "granted") {
      micGranted = true;
      return;
    }
  } catch {
    /* API Permissions indisponible : on demande directement */
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((tr) => tr.stop());
    micGranted = true;
  } catch (e) {
    if (e.name === "NotFoundError" || e.name === "OverconstrainedError") throw new MicError("no_device");
    throw new MicError("blocked");
  }
}

/** Reconnaissance vocale de Chrome (gratuite, rapide). */
function recognize(button) {
  return new Promise((resolve, reject) => {
    const rec = new Recognition();
    rec.lang = LANG[state.target].speech;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let result = "";
    let failed = false;
    button?.classList.add("recording");
    rec.onresult = (e) => {
      result = Array.from(e.results).map((r) => r[0].transcript).join(" ");
    };
    rec.onerror = (e) => {
      failed = true;
      button?.classList.remove("recording");
      if (e.error === "no-speech" || e.error === "aborted") resolve("");
      else if (e.error === "not-allowed" && !micGranted) reject(new MicError("blocked"));
      else reject(new MicError("service")); // service vocal indisponible sur cet appareil
    };
    rec.onend = () => {
      button?.classList.remove("recording");
      if (!failed) resolve(result);
    };
    try {
      rec.start();
    } catch {
      button?.classList.remove("recording");
      reject(new MicError("service"));
    }
  });
}

let activeRecorder = null;

/** Secours : enregistre la voix puis la fait transcrire par Gemini. */
async function recordAndTranscribe(button) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [];
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  activeRecorder = recorder;
  button?.classList.add("recording");
  toast(t("mic_listening"), 9000);
  const done = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();
  const timer = setTimeout(() => recorder.state === "recording" && recorder.stop(), 8000);
  await done;
  clearTimeout(timer);
  activeRecorder = null;
  stream.getTracks().forEach((tr) => tr.stop());
  button?.classList.remove("recording");
  const blob = new Blob(chunks, { type: (recorder.mimeType || "audio/webm").split(";")[0] });
  if (blob.size < 1500) return "";
  toast(t("mic_transcribing"), 6000);
  return transcribeAudio(aiConfig(), { blob, language: LANG[state.target].name, onRetry });
}

/**
 * Écoute une phrase. Retourne le texte reconnu, "" si rien n'a été entendu,
 * ou null si l'utilisateur a juste arrêté un enregistrement en cours.
 */
async function listenOnce(button) {
  if (activeRecorder) {
    activeRecorder.stop(); // second appui : fin de l'enregistrement
    return null;
  }
  await ensureMic();
  if (Recognition) {
    try {
      return await recognize(button);
    } catch (e) {
      if (!(e instanceof MicError) || e.kind !== "service") throw e;
    }
  }
  if (state.provider === "gemini" && hasKey() && window.MediaRecorder) return recordAndTranscribe(button);
  throw new MicError(Recognition ? "service" : "unsupported");
}

/** Affiche le bon message, ou l'aide pas à pas si le micro est bloqué. */
function handleMicError(e) {
  if (e instanceof MicError && e.kind === "blocked") return showMicHelp();
  if (e instanceof MicError) return toast(t(`mic_${e.kind}`), 6000);
  showError(e);
}

/** Fenêtre d'aide affichée seulement quand le micro a été refusé définitivement. */
function showMicHelp() {
  document.querySelector(".modal-backdrop")?.remove();
  const close = () => backdrop.remove();
  const retry = el("button", { class: "btn", type: "button" }, t("mic_help_retry"));
  retry.addEventListener("click", async () => {
    micGranted = false;
    try {
      await ensureMic();
      close();
      toast(t("mic_ready"));
    } catch {
      retry.textContent = t("mic_help_still");
      setTimeout(() => (retry.textContent = t("mic_help_retry")), 2500);
    }
  });
  const backdrop = el(
    "div",
    { class: "modal-backdrop", role: "dialog", "aria-modal": "true", "aria-labelledby": "mic-help-title", onclick: (ev) => ev.target === backdrop && close() },
    el(
      "div",
      { class: "modal" },
      el("h2", { id: "mic-help-title" }, `🎙️ ${t("mic_help_title")}`),
      el("p", {}, t("mic_help_intro")),
      el("ol", {}, el("li", {}, t("mic_help_step1")), el("li", {}, t("mic_help_step2")), el("li", {}, t("mic_help_step3"))),
      el("div", { class: "row", style: "justify-content:flex-end;margin-top:12px" }, el("button", { class: "btn secondary", type: "button", onclick: close }, t("mic_help_close")), retry)
    )
  );
  document.body.append(backdrop);
  retry.focus();
}

/* =====================================================================
   Navigation
   ===================================================================== */

const VIEWS = { chat: renderChat, oral: renderOral, lessons: renderLessons, progress: renderProgress, settings: renderSettings };
let currentTab = "chat";
let chatAbort = null;

function go(tab) {
  if (chatAbort) {
    chatAbort.abort();
    chatAbort = null;
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  currentTab = tab;
  try {
    sessionStorage.setItem("parlio:tab", tab);
  } catch {
    /* ignoré */
  }
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const view = document.getElementById("view");
  view.replaceChildren();
  VIEWS[tab](view);
  window.scrollTo(0, 0);
}

function refreshChrome() {
  setUiLang(state.ui);
  document.querySelectorAll("[data-i18n]").forEach((n) => (n.textContent = t(n.dataset.i18n)));
  document.querySelectorAll(".lang-switch button").forEach((b) => b.classList.toggle("active", b.dataset.target === state.target));
  applyTheme();
}

function keyNotice() {
  return el(
    "div",
    { class: "notice" },
    t("need_key"),
    " ",
    el("button", { class: "btn ghost small", type: "button", onclick: () => go("settings") }, t("go_settings"))
  );
}

/* =====================================================================
   1. Chat avec le tuteur
   ===================================================================== */

function chatSystemPrompt(charId) {
  const c = CHARACTERS[charId];
  const lang = LANG[state.target].name;
  const explainIn = nativeLanguageName(state.ui);
  return [
    `You are ${c.name[state.target]}, ${c.persona}`,
    `The learner is practising ${lang} at CEFR level ${state.level}.`,
    `Always reply in ${lang}, using vocabulary and grammar suited to level ${state.level}.`,
    "Keep each reply short (2 to 4 sentences) and end with a question that keeps the conversation going.",
    `If the learner's last message contains mistakes in ${lang}, add at the end a line that starts with "✏️" and gives the corrected sentence, then on the next line a very short explanation in ${explainIn}. If there are no mistakes, do not add that line.`,
    `The learner's native language is ${explainIn}. If they write in ${explainIn} or another language, help them say it in ${lang}.`,
    "Never use markdown headings or lists. Plain sentences only; **bold** is allowed for key words.",
  ].join("\n");
}

function getChat(charId) {
  const byLang = state.chats[state.target];
  if (!byLang[charId]) byLang[charId] = [];
  return byLang[charId];
}

function renderMessage(m, onSpeak) {
  const isAI = m.role === "assistant";
  const box = el("div", { class: `msg ${isAI ? "ai" : "me"}` });
  fillMessage(box, m.content, isAI, onSpeak);
  return box;
}

function fillMessage(box, text, isAI, onSpeak, typing = false) {
  box.replaceChildren();
  const idx = isAI ? text.indexOf("✏️") : -1;
  const main = idx >= 0 ? text.slice(0, idx).trim() : text;
  const correction = idx >= 0 ? text.slice(idx).trim() : "";
  box.setAttribute("dir", "auto");
  const body = el("span", { class: typing ? "typing" : "", dir: "auto" }, richText(main));
  box.append(body);
  if (correction) {
    // Phrase corrigée (langue apprise) et explication (langue maternelle) sur deux lignes,
    // chacune dans son propre sens d'écriture.
    const m = correction.match(/^([\s\S]*?)(?:\s+[—–-]\s+|\n+)([\s\S]+)$/);
    const fixed = m ? m[1] : correction;
    const why = m ? m[2] : "";
    box.append(
      el(
        "span",
        { class: "correction" },
        el("span", { dir: "ltr", style: "display:block" }, richText(fixed)),
        why ? el("span", { dir: "auto", style: "display:block;margin-top:4px;opacity:.9" }, richText(why)) : null
      )
    );
  }
  if (isAI && !typing && text) {
    box.append(
      el(
        "div",
        { class: "tools" },
        el("button", { type: "button", title: t("listen"), "aria-label": t("listen"), onclick: () => onSpeak(text) }, "🔊"),
        el(
          "button",
          {
            type: "button",
            title: t("copy"),
            "aria-label": t("copy"),
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(main);
                toast(t("copied"));
              } catch {
                /* presse-papiers indisponible */
              }
            },
          },
          "📋"
        )
      )
    );
  }
}

function renderChat(view) {
  const charId = state.character[state.target] || "tutor";

  const chars = el(
    "div",
    { class: "chars", role: "tablist" },
    Object.entries(CHARACTERS).map(([id, c]) =>
      el(
        "button",
        {
          type: "button",
          class: `char ${id === charId ? "active" : ""}`,
          role: "tab",
          "aria-selected": String(id === charId),
          onclick: () => {
            state.character[state.target] = id;
            save();
            go("chat");
          },
        },
        el("b", {}, `${c.emoji} ${c.name[state.target]}`),
        c.role[state.ui]
      )
    )
  );

  const messagesBox = el("div", { class: "messages", "aria-live": "polite" });
  const history = getChat(charId);

  const greet = () => {
    const c = CHARACTERS[charId];
    const hello =
      state.target === "en"
        ? { tutor: "Hi! I'm Emma. What would you like to talk about today?", cafe: "Good morning! Welcome to the café. What can I get you?", interview: "Hello, thanks for coming in today. Could you start by introducing yourself?", travel: "Hi there! Welcome to the city. How can I help you today?" }
        : { tutor: "Salut ! Moi, c'est Léa. De quoi as-tu envie de parler aujourd'hui ?", cafe: "Bonjour ! Bienvenue au café. Qu'est-ce que je vous sers ?", interview: "Bonjour, merci d'être venu. Pouvez-vous vous présenter ?", travel: "Bonjour et bienvenue ! Comment puis-je vous aider ?" };
    return { role: "assistant", content: hello[charId] || `${c.emoji}` };
  };
  if (history.length === 0) history.push(greet());

  const scrollDown = () => (messagesBox.scrollTop = messagesBox.scrollHeight);
  const redraw = () => {
    messagesBox.replaceChildren(...history.map((m) => renderMessage(m, speak)));
    scrollDown();
  };

  const input = el("textarea", { rows: "1", dir: "auto", placeholder: t("chat_placeholder", { lang: targetName() }), "aria-label": t("chat_placeholder", { lang: targetName() }) });
  const sendBtn = el("button", { class: "btn", type: "button" }, t("send"));
  const micBtn = el("button", { class: "icon-btn", type: "button", title: t("mic"), "aria-label": t("mic") }, "🎙️");

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  micBtn.addEventListener("click", async () => {
    try {
      const said = await listenOnce(micBtn);
      if (said === null) return;
      if (!said) return toast(t("mic_nothing"));
      input.value = (input.value ? `${input.value} ` : "") + said;
      input.dispatchEvent(new Event("input"));
      input.focus();
    } catch (e) {
      handleMicError(e);
    }
  });

  async function send() {
    if (chatAbort) {
      chatAbort.abort();
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    if (!hasKey()) {
      toast(t("need_key"));
      return;
    }
    input.value = "";
    input.dispatchEvent(new Event("input"));
    history.push({ role: "user", content: text });
    state.progress.messages += 1;
    save();
    redraw();

    const aiBox = el("div", { class: "msg ai" });
    fillMessage(aiBox, "", true, speak, true);
    messagesBox.append(aiBox);
    scrollDown();

    chatAbort = new AbortController();
    sendBtn.textContent = t("stop");
    // On n'envoie que les 30 derniers messages pour limiter le coût.
    const recent = history.slice(-30);
    const firstUser = recent.findIndex((m) => m.role === "user");
    const payload = recent.slice(Math.max(firstUser, 0));
    try {
      const reply = await streamChat(aiConfig(), {
        system: chatSystemPrompt(charId),
        messages: payload,
        signal: chatAbort.signal,
        onRetry,
        onText: (full) => {
          fillMessage(aiBox, full, true, speak, true);
          scrollDown();
        },
      });
      history.push({ role: "assistant", content: reply || "…" });
      if (history.length > 200) history.splice(1, history.length - 200);
      save();
      addXP(2);
    } catch (e) {
      if (e.name === "AbortError") {
        const partial = aiBox.textContent.trim();
        if (partial) history.push({ role: "assistant", content: partial });
      } else {
        history.pop(); // retire le message non traité pour pouvoir le renvoyer
        input.value = text;
        showError(e);
      }
      save();
    } finally {
      chatAbort = null;
      sendBtn.textContent = t("send");
      redraw();
    }
  }
  sendBtn.addEventListener("click", send);

  const newChat = el(
    "button",
    {
      class: "btn ghost small",
      type: "button",
      onclick: () => {
        state.chats[state.target][charId] = [];
        save();
        go("chat");
      },
    },
    `↺ ${t("new_chat")}`
  );

  mount(view, 
    !hasKey() ? keyNotice() : null,
    chars,
    el("div", { class: "row", style: "justify-content:flex-end;margin-bottom:4px" }, newChat),
    el("div", { class: "chat-wrap" }, messagesBox, el("div", { class: "composer" }, micBtn, el("div", { class: "grow" }, input), sendBtn))
  );
  redraw();
}

/* =====================================================================
   2. Conversation orale avec score
   ===================================================================== */

const normalize = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Compare la phrase attendue et ce qui a été dit (plus longue sous-suite commune). */
function scorePronunciation(expected, said) {
  const a = normalize(expected);
  const b = normalize(said);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const matched = new Set();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      matched.add(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const extra = Math.max(0, b.length - matched.size);
  const score = a.length ? Math.round((100 * matched.size) / (a.length + extra * 0.5)) : 0;
  return { score: Math.min(100, score), words: a.map((w, k) => ({ w, ok: matched.has(k) })) };
}

let oralSet = null; // { phrases, index, scores }

function renderOral(view) {
  if (!oralSet || oralSet.lang !== state.target) {
    oralSet = { lang: state.target, phrases: BUILTIN_PHRASES[state.target], index: 0, scores: [] };
  }
  const themeInput = el("input", { type: "text", placeholder: t("oral_theme_ph"), "aria-label": t("oral_theme") });
  const genBtn = el("button", { class: "btn", type: "button", disabled: !hasKey() }, `✨ ${t("oral_new")}`);
  const builtinBtn = el("button", { class: "btn secondary", type: "button" }, t("oral_builtin"));
  const area = el("div");

  genBtn.addEventListener("click", async () => {
    genBtn.disabled = true;
    area.replaceChildren(el("div", { class: "card" }, el("span", { class: "spinner" }), " ", t("generating")));
    try {
      const transLang = nativeLanguageName(state.ui);
      const data = await completeJSON(aiConfig(), {
        onRetry,
        system: "You create speaking practice sentences for language learners. Output JSON only.",
        prompt: `Create 5 natural, useful sentences in ${LANG[state.target].name} for a learner at CEFR level ${state.level}${themeInput.value.trim() ? ` about the theme "${themeInput.value.trim()}"` : ""}. Each sentence should take 3 to 15 words to say. Return {"phrases":[{"text":"...","translation":"... (in ${transLang})"}]}.`,
      });
      const phrases = (data.phrases || []).filter((p) => p && typeof p.text === "string").slice(0, 8);
      if (!phrases.length) throw new Error("—");
      oralSet = { lang: state.target, phrases, index: 0, scores: [] };
    } catch (e) {
      showError(e);
    } finally {
      genBtn.disabled = !hasKey();
      drawPhrase();
    }
  });
  builtinBtn.addEventListener("click", () => {
    oralSet = { lang: state.target, phrases: BUILTIN_PHRASES[state.target], index: 0, scores: [] };
    drawPhrase();
  });

  function drawPhrase() {
    const { phrases, index } = oralSet;
    if (index >= phrases.length) {
      const avg = Math.round(oralSet.scores.reduce((s, x) => s + x, 0) / Math.max(1, oralSet.scores.length));
      area.replaceChildren(
        el(
          "div",
          { class: "card" },
          el("div", { class: "score" }, `${avg} %`),
          el("p", { style: "text-align:center" }, t("oral_done", { score: avg })),
          el(
            "div",
            { class: "row", style: "justify-content:center;margin-top:8px" },
            el(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: () => {
                  oralSet.index = 0;
                  oralSet.scores = [];
                  drawPhrase();
                },
              },
              t("retry")
            )
          )
        )
      );
      return;
    }
    const p = phrases[index];
    const result = el("div");
    const mic = el("button", { class: "icon-btn", type: "button", "aria-label": t("mic"), style: "width:64px;height:64px;font-size:28px" }, "🎙️");
    mic.addEventListener("click", async () => {
      try {
        const said = await listenOnce(mic);
        if (said === null) return;
        if (!said) return toast(t("mic_nothing"));
        const { score, words } = scorePronunciation(p.text, said);
        oralSet.scores[index] = score;
        state.progress.oralScores.push(score);
        if (state.progress.oralScores.length > 500) state.progress.oralScores.shift();
        save();
        addXP(Math.max(1, Math.round(score / 20)));
        result.replaceChildren(
          el("div", { class: "score", style: `color:var(${score >= 80 ? "--good" : score >= 50 ? "--warn" : "--bad"})` }, `${score} %`),
          el("div", { class: "words", dir: "ltr" }, words.map((x) => el("span", { class: `word ${x.ok ? "ok" : "miss"}` }, x.w))),
          el("p", { class: "muted", style: "margin-top:8px" }, `${t("oral_heard")} « ${said} »`)
        );
      } catch (e) {
        handleMicError(e);
      }
    });
    area.replaceChildren(
      el(
        "div",
        { class: "card" },
        el("div", { class: "progressbar" }, el("div", { style: `width:${(100 * index) / phrases.length}%` })),
        el("p", { class: "muted" }, `${index + 1} / ${phrases.length}`),
        el("div", { class: "phrase", dir: "ltr" }, p.text),
        translationFor(p.translation) ? el("div", { class: "translation", dir: "auto" }, translationFor(p.translation)) : null,
        el(
          "div",
          { class: "row", style: "justify-content:center;gap:16px;margin:16px 0 4px" },
          el("button", { class: "icon-btn", type: "button", "aria-label": t("listen"), onclick: () => speak(p.text) }, "🔊"),
          mic
        ),
        el("p", { class: "muted", style: "text-align:center" }, t("oral_tap")),
        result,
        el(
          "div",
          { class: "row", style: "justify-content:space-between;margin-top:12px" },
          el(
            "button",
            {
              class: "btn secondary small",
              type: "button",
              disabled: index === 0,
              onclick: () => {
                oralSet.index -= 1;
                drawPhrase();
              },
            },
            `${arrowBack()} ${t("oral_prev")}`
          ),
          el(
            "button",
            {
              class: "btn small",
              type: "button",
              onclick: () => {
                oralSet.index += 1;
                drawPhrase();
              },
            },
            `${t("oral_next")} ${arrowNext()}`
          )
        )
      )
    );
  }

  mount(view, 
    el("h1", {}, `🎙️ ${t("oral_title")}`),
    el("p", { class: "muted" }, t("oral_intro")),
    !Recognition && !window.MediaRecorder ? el("div", { class: "notice" }, t("mic_unsupported")) : null,
    el(
      "div",
      { class: "card" },
      el("label", {}, t("oral_theme")),
      themeInput,
      el("div", { class: "row", style: "margin-top:10px" }, genBtn, builtinBtn)
    ),
    area
  );
  drawPhrase();
}

/* =====================================================================
   3. Leçons et quiz
   ===================================================================== */

function lessonPrompt(category, topic) {
  const lang = LANG[state.target].name;
  const explainIn = nativeLanguageName(state.ui);
  const kind = {
    grammar: "a short grammar lesson",
    vocab: "a vocabulary lesson with 8 to 10 useful words or expressions",
    reading: `a reading lesson: write an original text of 120 to 200 words in ${lang}, then quiz comprehension`,
  }[category];
  return `Create ${kind} for a learner of ${lang} at CEFR level ${state.level}. Topic: "${topic}".
Write explanations in ${explainIn}. Examples and vocabulary words must be in ${lang} with a translation in ${explainIn}.
Return exactly this JSON shape:
{
  "title": "lesson title",
  "explanation": "clear explanation in ${explainIn}, 60 to 150 words",
  "text": "${category === "reading" ? `the reading text in ${lang}` : ""}",
  "examples": [{"target": "sentence in ${lang}", "translation": "translation"}],
  "vocabulary": [{"word": "word in ${lang}", "translation": "translation"}],
  "quiz": [{"question": "question", "options": ["A", "B", "C", "D"], "answer": 0, "explanation": "why, in ${explainIn}"}]
}
Give 3 to 5 examples, 4 to 10 vocabulary items and exactly 5 quiz questions. "answer" is the index (0-3) of the correct option. Vary the position of the correct answer.`;
}

function validLesson(d) {
  return (
    d &&
    typeof d.title === "string" &&
    Array.isArray(d.quiz) &&
    d.quiz.length > 0 &&
    d.quiz.every((q) => q && Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length)
  );
}

function renderLessons(view) {
  mount(view, el("h1", {}, `📚 ${t("lessons_title")}`), el("p", { class: "muted" }, t("lessons_intro")));
  if (!hasKey()) view.append(keyNotice());

  const area = el("div");
  mount(view, area);

  function showTopics() {
    const customInput = el("input", { type: "text", placeholder: t("custom_ph"), "aria-label": t("custom_topic") });
    const customBtn = el("button", { class: "btn", type: "button", disabled: !hasKey() }, t("generate"));
    customBtn.addEventListener("click", () => {
      const topic = customInput.value.trim();
      if (topic) generate("grammar", topic);
    });
    area.replaceChildren(
      ...["grammar", "vocab", "reading"].map((cat) =>
        el(
          "section",
          {},
          el("h2", {}, t(`cat_${cat}`)),
          el(
            "div",
            { class: "grid2" },
            TOPICS[cat][state.target].map((topic) =>
              el(
                "button",
                { class: "topic", type: "button", disabled: !hasKey(), onclick: () => generate(cat, topic) },
                el("b", {}, topic),
                el("span", {}, `${state.level} · ${t(`cat_${cat}`)}`)
              )
            )
          )
        )
      ),
      el("div", { class: "card", style: "margin-top:16px" }, el("label", {}, t("custom_topic")), el("div", { class: "row" }, el("div", { class: "grow" }, customInput), customBtn))
    );
  }

  async function generate(category, topic) {
    area.replaceChildren(el("div", { class: "card" }, el("span", { class: "spinner" }), " ", t("generating")));
    try {
      const data = await completeJSON(aiConfig(), {
        onRetry,
        system: "You are an expert language teacher who writes accurate, engaging lessons. Output JSON only.",
        prompt: lessonPrompt(category, topic),
      });
      if (!validLesson(data)) throw new Error("—");
      showLesson(data);
    } catch (e) {
      showError(e);
      showTopics();
    }
  }

  function showLesson(lesson) {
    const back = el("button", { class: "btn ghost small", type: "button", onclick: showTopics }, `${arrowBack()} ${t("back_topics")}`);
    area.replaceChildren(
      back,
      el(
        "div",
        { class: "card" },
        el("h1", {}, lesson.title),
        lesson.explanation ? el("p", {}, richText(lesson.explanation)) : null,
        lesson.text
          ? el(
              "div",
              {},
              el("h2", {}, el("span", {}, t("text")), " ", el("button", { class: "btn ghost small", type: "button", onclick: () => speak(lesson.text) }, "🔊")),
              el("p", { style: "white-space:pre-wrap", dir: "ltr" }, lesson.text)
            )
          : null,
        Array.isArray(lesson.examples) && lesson.examples.length
          ? el(
              "div",
              {},
              el("h2", {}, t("examples")),
              lesson.examples.map((ex) =>
                el(
                  "div",
                  { class: "example" },
                  el("div", { class: "row" }, el("b", { class: "grow", dir: "ltr" }, ex.target || ""), el("button", { class: "btn ghost small", type: "button", "aria-label": t("listen"), onclick: () => speak(ex.target || "") }, "🔊")),
                  el("div", { class: "muted" }, ex.translation || "")
                )
              )
            )
          : null,
        Array.isArray(lesson.vocabulary) && lesson.vocabulary.length
          ? el(
              "div",
              {},
              el("h2", {}, t("vocabulary")),
              el(
                "div",
                { class: "vocab-list" },
                lesson.vocabulary.map((v) => wordChip(v.word, v.translation))
              )
            )
          : null,
        el("div", { class: "row", style: "margin-top:16px" }, el("button", { class: "btn", type: "button", onclick: () => runQuiz(lesson) }, `${t("start_quiz")} ${arrowNext()}`))
      )
    );
  }

  function runQuiz(lesson) {
    let qi = 0;
    let good = 0;
    const total = lesson.quiz.length;
    const draw = () => {
      if (qi >= total) return finish();
      const q = lesson.quiz[qi];
      let answered = false;
      const explain = el("div");
      const nextBtn = el("button", { class: "btn", type: "button", disabled: true }, qi + 1 < total ? t("next") : t("see_result"));
      nextBtn.addEventListener("click", () => {
        qi += 1;
        draw();
      });
      const options = q.options.map((opt, k) =>
        el(
          "button",
          {
            class: "option",
            type: "button",
            onclick: (e) => {
              if (answered) return;
              answered = true;
              const btns = e.currentTarget.parentElement.querySelectorAll(".option");
              btns[q.answer].classList.add("correct");
              if (k === q.answer) good += 1;
              else e.currentTarget.classList.add("wrong");
              if (q.explanation) explain.replaceChildren(el("p", { class: "muted" }, richText(q.explanation)));
              nextBtn.disabled = false;
            },
          },
          String(opt)
        )
      );
      area.replaceChildren(
        el(
          "div",
          { class: "card" },
          el("p", { class: "muted" }, t("question", { n: qi + 1, total })),
          el("div", { class: "progressbar" }, el("div", { style: `width:${(100 * qi) / total}%` })),
          el("p", { style: "font-weight:600;font-size:17px" }, richText(q.question || "")),
          el("div", {}, options),
          explain,
          el("div", { class: "row", style: "justify-content:flex-end;margin-top:8px" }, nextBtn)
        )
      );
    };
    const finish = () => {
      state.progress.lessons += 1;
      const words = state.progress.words[state.target];
      for (const v of lesson.vocabulary || []) {
        const w = String(v.word || "").trim();
        if (w && !words.some((x) => x.word.toLowerCase() === w.toLowerCase())) words.push({ word: w, translation: String(v.translation || "") });
      }
      save();
      addXP(5 + good * 2);
      area.replaceChildren(
        el(
          "div",
          { class: "card", style: "text-align:center" },
          el("div", { class: "score" }, `${good} / ${total}`),
          el("p", {}, t("quiz_result", { good, total })),
          el(
            "div",
            { class: "row", style: "justify-content:center;margin-top:8px" },
            el("button", { class: "btn secondary", type: "button", onclick: () => runQuiz(lesson) }, t("retry")),
            el("button", { class: "btn", type: "button", onclick: showTopics }, t("back_topics"))
          )
        )
      );
    };
    draw();
  }

  showTopics();
}

/* =====================================================================
   4. Progrès
   ===================================================================== */

function streakDays() {
  const days = state.progress.xpByDay;
  let n = 0;
  const d = new Date();
  // La série continue si l'utilisateur n'a pas encore pratiqué aujourd'hui.
  if (!days[today()]) d.setDate(d.getDate() - 1);
  for (;;) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!days[key]) break;
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function renderProgress(view) {
  const p = state.progress;
  const totalXP = Object.values(p.xpByDay).reduce((s, x) => s + x, 0);
  const words = p.words[state.target];
  const oralAvg = p.oralScores.length ? Math.round(p.oralScores.reduce((s, x) => s + x, 0) / p.oralScores.length) : 0;

  const week = [];
  const fmt = new Intl.DateTimeFormat(state.ui, { weekday: "short" });
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    week.push({ label: fmt.format(d), xp: p.xpByDay[key] || 0 });
  }
  const max = Math.max(10, ...week.map((w) => w.xp));

  mount(view, 
    el("h1", {}, `📈 ${t("progress_title")}`),
    el(
      "div",
      { class: "card stats" },
      el("div", { class: "stat" }, el("div", { class: "n" }, `🔥 ${streakDays()}`), el("div", { class: "l" }, t("streak"))),
      el("div", { class: "stat" }, el("div", { class: "n" }, `⭐ ${totalXP}`), el("div", { class: "l" }, t("xp"))),
      el("div", { class: "stat" }, el("div", { class: "n" }, `📖 ${words.length}`), el("div", { class: "l" }, t("words")))
    ),
    el(
      "div",
      { class: "card" },
      el("h2", { style: "margin-top:0" }, t("this_week")),
      el(
        "div",
        { class: "week", role: "img", "aria-label": week.map((w) => `${w.label} ${w.xp} XP`).join(", ") },
        week.map((w) => el("div", { class: "bar", title: `${w.xp} XP` }, el("div", { style: `height:${Math.round((80 * w.xp) / max)}px` }), el("span", {}, w.label)))
      )
    ),
    el(
      "div",
      { class: "card" },
      el("p", {}, `📚 ${t("lessons_done")} : `, el("b", {}, p.lessons)),
      el("p", {}, `🎙️ ${t("oral_avg")} : `, el("b", {}, `${oralAvg} %`)),
      el("p", {}, `💬 ${t("messages_sent")} : `, el("b", {}, p.messages))
    ),
    el(
      "div",
      { class: "card" },
      el("h2", { style: "margin-top:0" }, t("learned_words", { lang: targetName() })),
      words.length
        ? el(
            "div",
            { class: "vocab-list" },
            words
              .slice()
              .reverse()
              .map((w) => wordChip(w.word, w.translation))
          )
        : el("p", { class: "muted" }, t("no_words"))
    ),
    el(
      "button",
      {
        class: "btn secondary small",
        type: "button",
        onclick: () => {
          if (!confirm(t("reset_confirm"))) return;
          state.progress = structuredClone(DEFAULT_STATE.progress);
          save();
          go("progress");
        },
      },
      t("reset")
    )
  );
}

/* =====================================================================
   5. Réglages
   ===================================================================== */

function renderSettings(view) {
  const field = (labelText, control, extra) => el("div", {}, el("label", {}, labelText), control, extra || null);

  const uiSel = el(
    "select",
    { "aria-label": t("ui_lang") },
    Object.entries(NATIVE_LANGS).map(([code, l]) => el("option", { value: code }, l.label))
  );
  uiSel.value = state.ui;
  uiSel.addEventListener("change", () => {
    state.ui = uiSel.value;
    save();
    refreshChrome();
    go("settings");
  });

  const levelSel = el("select", { "aria-label": t("level") }, LEVELS.map((l) => el("option", { value: l }, l)));
  levelSel.value = state.level;
  levelSel.addEventListener("change", () => {
    state.level = levelSel.value;
    save();
    toast(t("saved"));
  });

  const provSel = el(
    "select",
    { "aria-label": t("provider") },
    Object.entries(PROVIDERS).map(([id, p]) => el("option", { value: id }, p.label))
  );
  provSel.value = state.provider;

  const provNote = el("p", { class: "muted" });
  const keyLink = el("a", { target: "_blank", rel: "noopener" }, t("get_key"));
  const keyInput = el("input", { type: "password", autocomplete: "off", spellcheck: "false", "aria-label": t("api_key") });
  const showBtn = el("button", { class: "btn secondary small", type: "button" }, t("show"));
  showBtn.addEventListener("click", () => {
    const hidden = keyInput.type === "password";
    keyInput.type = hidden ? "text" : "password";
    showBtn.textContent = hidden ? t("hide") : t("show");
  });

  const modelSel = el("select", { "aria-label": t("model") });
  const loadBtn = el("button", { class: "btn secondary small", type: "button" }, t("load_models"));
  const testBtn = el("button", { class: "btn small", type: "button" }, t("test"));
  const status = el("p", { class: "muted", "aria-live": "polite" });

  function fillModels(list) {
    const current = state.models[state.provider] || PROVIDERS[state.provider].defaultModel;
    const ids = Array.from(new Set([current, ...list]));
    modelSel.replaceChildren(...ids.map((id) => el("option", { value: id }, id)));
    modelSel.value = current;
  }

  function syncProvider() {
    const p = PROVIDERS[state.provider];
    provNote.textContent = p.note;
    keyLink.href = p.keyUrl;
    keyInput.value = state.keys[state.provider] || "";
    status.textContent = "";
    fillModels([]);
  }

  provSel.addEventListener("change", () => {
    state.provider = provSel.value;
    save();
    syncProvider();
  });
  keyInput.addEventListener("change", () => {
    state.keys[state.provider] = keyInput.value.trim();
    save();
    toast(t("saved"));
  });
  modelSel.addEventListener("change", () => {
    state.models[state.provider] = modelSel.value;
    save();
    toast(t("saved"));
  });
  loadBtn.addEventListener("click", async () => {
    state.keys[state.provider] = keyInput.value.trim();
    save();
    status.replaceChildren(el("span", { class: "spinner" }));
    try {
      const list = await listModels(aiConfig());
      fillModels(list);
      status.textContent = `${list.length} ✓`;
    } catch (e) {
      status.textContent = `${t("error")} : ${errText(e)}`;
    }
  });
  testBtn.addEventListener("click", async () => {
    state.keys[state.provider] = keyInput.value.trim();
    save();
    status.replaceChildren(el("span", { class: "spinner" }));
    try {
      await streamChat(aiConfig(), { onRetry, system: "Reply with one short word.", messages: [{ role: "user", content: "Say OK." }] });
      status.textContent = t("test_ok");
    } catch (e) {
      status.textContent = `${t("error")} : ${errText(e)}`;
    }
  });

  const rate = el("input", { type: "range", min: "0.6", max: "1.3", step: "0.1", "aria-label": t("voice_rate"), style: "width:100%" });
  rate.value = String(state.voiceRate);
  rate.addEventListener("change", () => {
    state.voiceRate = Number(rate.value);
    save();
    speak(state.target === "en" ? "This is how fast I speak." : "Voici ma vitesse de parole.");
  });

  const themeSel = el(
    "select",
    { "aria-label": t("theme") },
    el("option", { value: "auto" }, t("theme_auto")),
    el("option", { value: "light" }, t("theme_light")),
    el("option", { value: "dark" }, t("theme_dark"))
  );
  themeSel.value = state.theme;
  themeSel.addEventListener("change", () => {
    state.theme = themeSel.value;
    save();
    applyTheme();
  });

  mount(view, 
    el("h1", {}, `⚙️ ${t("settings_title")}`),
    el("div", { class: "card" }, field(t("ui_lang"), uiSel, el("p", { class: "muted" }, t("ui_lang_help"))), field(t("level"), levelSel)),
    el(
      "div",
      { class: "card" },
      field(t("provider"), provSel, provNote),
      field(t("api_key"), el("div", { class: "row" }, el("div", { class: "grow" }, keyInput), showBtn), el("p", { class: "muted" }, keyLink)),
      field(t("model"), modelSel, el("div", { class: "row", style: "margin-top:8px" }, loadBtn, testBtn)),
      status,
      el("p", { class: "muted" }, `🔒 ${t("privacy")}`)
    ),
    el("div", { class: "card" }, field(t("voice_rate"), rate), field(t("theme"), themeSel)),
    el("p", { class: "muted" }, t("install_hint"))
  );
  syncProvider();
}

/* =====================================================================
   Écran d'accueil : langue maternelle et langue apprise
   ===================================================================== */

function renderWelcome() {
  document.body.classList.add("onboarding");
  const view = document.getElementById("view");
  const choice = (selected, onPick) => (value, label) =>
    el(
      "button",
      { type: "button", class: `choice ${selected === value ? "active" : ""}`, "aria-pressed": String(selected === value), onclick: () => onPick(value) },
      label
    );

  const nativeChoice = choice(state.ui, (v) => {
    state.ui = v;
    if (state.target === v) state.target = v === "en" ? "fr" : "en";
    refreshChrome();
    renderWelcome();
  });
  const targetChoice = choice(state.target, (v) => {
    state.target = v;
    refreshChrome();
    renderWelcome();
  });

  view.replaceChildren();
  mount(
    view,
    el(
      "div",
      { class: "welcome" },
      el("img", { src: "icons/icon-192.png", alt: "", width: "72", height: "72" }),
      el("h1", {}, t("welcome_title")),
      el("h2", {}, t("welcome_native")),
      el("div", { class: "choices" }, Object.entries(NATIVE_LANGS).map(([code, l]) => nativeChoice(code, l.label))),
      el("h2", {}, t("welcome_target")),
      el(
        "div",
        { class: "choices" },
        targetChoice("en", `🇬🇧 ${t("lang_en")}`),
        targetChoice("fr", `🇫🇷 ${t("lang_fr")}`)
      ),
      el(
        "button",
        {
          class: "btn",
          type: "button",
          style: "width:100%;margin-top:20px;padding:14px",
          onclick: () => {
            state.onboarded = true;
            save();
            document.body.classList.remove("onboarding");
            go(hasKey() ? "chat" : "settings");
          },
        },
        `${t("welcome_start")} ${arrowNext()}`
      )
    )
  );
}

/* =====================================================================
   Démarrage
   ===================================================================== */

document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
document.querySelectorAll(".lang-switch button").forEach((b) =>
  b.addEventListener("click", () => {
    state.target = b.dataset.target;
    oralSet = null;
    save();
    refreshChrome();
    go(currentTab);
  })
);

// Les voix de synthèse se chargent parfois en retard.
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};

refreshChrome();
let startTab = hasKey() ? "chat" : "settings";
try {
  const saved = sessionStorage.getItem("parlio:tab");
  if (saved && VIEWS[saved]) startTab = saved;
} catch {
  /* ignoré */
}
if (state.onboarded) go(startTab);
else renderWelcome();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// Exposé pour le débogage dans la console.
window.__parlio = { get state() { return state; }, uiLang };
