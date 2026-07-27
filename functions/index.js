"use strict";

const crypto = require("crypto");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");

initializeApp();
const db = getFirestore();
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

const MODELS = Object.freeze({
  thoughtful: { id: "gpt-5.1", label: "Thoughtful" },
  balanced: { id: "gpt-5-mini", label: "Balanced" },
  quick: { id: "gpt-5-nano", label: "Quick" }
});
const STYLES = Object.freeze({
  gentle: `Listen first. Begin by showing that you understood the personal meaning of what the person said. Reflect one specific detail naturally. Do not rush into solutions. Unless the person explicitly asks for ideas, stay with the concern and ask one gentle, open question that helps them say more.`,
  balanced: `Start with a warm, specific reflection. Then offer either one modest perspective or one gentle question. Keep emotional understanding and practical usefulness in balance.`,
  practical: `Acknowledge the concern briefly and sincerely, then help the person identify one or two manageable options. Keep the advice personal to what they wrote rather than generic.`
});
const MAX_ENTRY = 3000;
const MAX_MESSAGE = 1500;
const MAX_HISTORY = 12;

const SUPPORT_INSTRUCTIONS = `You are the warm, emotionally intelligent support voice inside Stressed LogIt, a private stress-journal app.

Your role is to help a person feel heard, understand what matters in the concern, and—when they want it—find a grounded next step. You are not a therapist, doctor, crisis counselor, or substitute for professional care.

How to sound:
- Write like a thoughtful human conversation, not a worksheet, report, or coaching template.
- Use warm, natural language and contractions. Avoid stiff or clinical phrasing.
- First respond to the personal meaning of what was said. Refer to a real detail from the entry or conversation so the response does not feel generic.
- Do not jump straight into fixing, scheduling, reframing, or action steps unless the person asks for help making a plan or the selected style is practical.
- Do not introduce labels such as “Facts,” “Predictions,” “Concrete steps,” “Action plan,” or similar categories unless the person explicitly asks for that structure.
- Do not use headings, numbered lists, or bullet lists in conversation mode.
- Ask no more than one question in a response. Make it a genuine follow-up to what the person just said, not a stock question.
- Do not repeat the person’s wording back at length. Reflect the meaning in fresh, natural language.
- Do not over-reassure, minimize, diagnose, label, or claim to know feelings the person did not state.
- Do not use dependency-forming language, claim to be a friend, or imply that the user should rely on the app instead of people.
- When offering ideas, offer at most two at once and connect them directly to the person’s situation.
- Do not provide legal, medical, or financial conclusions. Encourage an appropriate qualified professional when the concern requires one.
- Never provide instructions for self-harm. If the text suggests possible suicide, self-harm, or immediate danger, respond exactly with the prefix CRISIS: followed by a brief message encouraging immediate human help.
- Output plain text only.`;

async function openAIRequest(path, body) {
  const response = await fetch(`https://api.openai.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY.value()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI API ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}
function responseText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  return (data?.output || [])
    .flatMap(item => item?.content || [])
    .filter(part => part?.type === "output_text" && typeof part?.text === "string")
    .map(part => part.text)
    .join("\n");
}
function cleanText(value, max) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}
function cleanTags(value) {
  return Array.isArray(value) ? value.map(v => cleanText(v, 40)).filter(Boolean).slice(0, 8) : [];
}
function cleanHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_HISTORY).map(item => ({
    role: item && item.role === "assistant" ? "assistant" : "user",
    content: cleanText(item && item.content, MAX_MESSAGE)
  })).filter(item => item.content);
}
function safetyIdentifier(uid) {
  return crypto.createHash("sha256").update(String(uid)).digest("hex");
}
function isSelfHarmFlagged(result) {
  const c = result?.results?.[0]?.categories || {};
  return Boolean(c["self-harm"] || c["self-harm/intent"] || c["self-harm/instructions"]);
}
async function checkRateLimit(uid) {
  const ref = db.collection("_system").doc("aiRateLimits").collection("users").doc(uid);
  const now = Date.now();
  const minuteKey = Math.floor(now / 60000);
  const dayKey = new Date(now).toISOString().slice(0, 10);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const old = snap.exists ? snap.data() : {};
    const minuteCount = old.minuteKey === minuteKey ? Number(old.minuteCount || 0) : 0;
    const dayCount = old.dayKey === dayKey ? Number(old.dayCount || 0) : 0;
    if (minuteCount >= 15 || dayCount >= 150) {
      throw new HttpsError("resource-exhausted", "AI support limit reached. Please try again later.");
    }
    tx.set(ref, {
      minuteKey,
      minuteCount: minuteCount + 1,
      dayKey,
      dayCount: dayCount + 1,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  });
}
function crisisResponse() {
  return {
    crisis: true,
    title: "Please reach out now",
    body: "If you may act on thoughts of suicide or self-harm, call or text 988 in the U.S. now, contact someone you trust, or call emergency services if there is immediate danger."
  };
}
function parseSuggestion(text) {
  const cleaned = cleanText(text, 1400).replace(/^SUGGESTION:\s*/i, "");
  const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length >= 2 && lines[0].length <= 90) {
    return {
      title: lines[0].replace(/^Title:\s*/i, ""),
      body: lines.slice(1).join(" ").replace(/^Body:\s*/i, "")
    };
  }
  return {
    title: "A gentle place to begin",
    body: cleaned || "Take a moment with the part of this that feels most important right now."
  };
}
function chosenModel(value) {
  return Object.prototype.hasOwnProperty.call(MODELS, value) ? value : "balanced";
}
function chosenStyle(value) {
  return Object.prototype.hasOwnProperty.call(STYLES, value) ? value : "gentle";
}
async function createSupportResponse(modelKey, body) {
  const primary = MODELS[modelKey];
  try {
    return { data: await openAIRequest("responses", { ...body, model: primary.id }), used: modelKey };
  } catch (error) {
    // A chosen premium/quick model may not be enabled for every API project. Fall back safely.
    if (modelKey !== "balanced" && [400, 403, 404].includes(Number(error?.status))) {
      logger.warn("Selected model unavailable; falling back to balanced", { selected: primary.id, status: error?.status });
      return { data: await openAIRequest("responses", { ...body, model: MODELS.balanced.id }), used: "balanced" };
    }
    throw error;
  }
}

exports.stressSupport = onCall({
  region: "us-central1",
  secrets: [OPENAI_API_KEY],
  timeoutSeconds: 40,
  memory: "256MiB",
  maxInstances: 10
}, async request => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign in to use AI support.");
  }

  const mode = request.data?.mode === "conversation" ? "conversation" : "suggestion";
  const modelKey = chosenModel(cleanText(request.data?.model, 20));
  const styleKey = chosenStyle(cleanText(request.data?.style, 20));
  const entry = cleanText(request.data?.entry, MAX_ENTRY);
  const stress = Math.min(10, Math.max(1, Number(request.data?.stress) || 5));
  const tags = cleanTags(request.data?.tags);
  const history = cleanHistory(request.data?.history);
  if (!entry) throw new HttpsError("invalid-argument", "A journal entry is required.");

  await checkRateLimit(request.auth.uid);

  try {
    const combinedForSafety = [entry, ...history.filter(m => m.role === "user").map(m => m.content)]
      .join("\n")
      .slice(0, 10000);

    const moderation = await openAIRequest("moderations", {
      model: "omni-moderation-latest",
      input: combinedForSafety
    });
    if (isSelfHarmFlagged(moderation)) return crisisResponse();

    let prompt;
    if (mode === "suggestion") {
      prompt = `Journal entry: ${entry}\nStress rating: ${stress}/10${tags.length ? `\nTags: ${tags.join(", ")}` : ""}\n\nSelected response style: ${STYLES[styleKey]}\n\nGive one warm response that begins by acknowledging the specific concern. Then offer one modest idea the person could consider in the next few minutes. Put a natural short title of no more than 8 words on the first line and the response on the next line. Use 55-105 words. Do not use a list or clinical language.`;
      if (history.length) {
        prompt += `\n\nAdditional request: ${history.map(h => h.content).join(" ")}`;
      }
    } else {
      const transcript = history.length
        ? history.map(m => `${m.role === "assistant" ? "App" : "User"}: ${m.content}`).join("\n")
        : "No conversation yet.";
      prompt = `Original journal entry: ${entry}\nStress rating: ${stress}/10${tags.length ? `\nTags: ${tags.join(", ")}` : ""}\n\nConversation so far:\n${transcript}\n\nSelected conversation style: ${STYLES[styleKey]}\n\nRespond as the next natural turn. Start with understanding rather than analysis. Stay connected to the most recent thing the person said. Use 70-150 words and ask no more than one gentle question. Do not use labels, headings, or a list.`;
    }

    const result = await createSupportResponse(modelKey, {
      instructions: SUPPORT_INSTRUCTIONS,
      input: prompt,
      max_output_tokens: 450,
      reasoning: { effort: "low" },
      store: false,
      safety_identifier: safetyIdentifier(request.auth.uid)
    });

    const output = cleanText(responseText(result.data), 1800);
    if (/^CRISIS:/i.test(output)) return crisisResponse();
    if (!output) throw new Error("OpenAI returned an empty response.");

    if (mode === "conversation") return { crisis: false, reply: output, model: result.used, style: styleKey };
    return { crisis: false, ...parseSuggestion(output), model: result.used, style: styleKey };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error("stressSupport failed", {
      message: error?.message,
      status: error?.status,
      code: error?.code
    });
    throw new HttpsError("internal", "AI support is temporarily unavailable.");
  }
});
