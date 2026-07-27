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

const MODEL = "gpt-5-mini";
const MAX_ENTRY = 3000;
const MAX_MESSAGE = 1500;
const MAX_HISTORY = 10;

const SUPPORT_INSTRUCTIONS = `You are the support voice inside Stressed LogIt, a private stress-journal app.

Your role is to help a person organize a concern and identify a grounded next step. You are not a therapist, doctor, crisis counselor, or substitute for professional care.

Style and boundaries:
- Be warm, calm, plainspoken, and concise.
- Do not diagnose, label, or claim to know feelings the person did not state.
- Do not use dependency-forming language, claim to be a friend, or imply that the user should rely on the app instead of people.
- Do not dismiss or minimize the actual concern.
- Prefer reflection, separating facts from predictions, prioritizing, identifying controllable parts, and choosing small concrete next steps.
- Do not provide legal, medical, or financial conclusions. Encourage an appropriate qualified professional when the concern requires one.
- Ask no more than one question in a response.
- Never provide instructions for self-harm. If the text suggests possible suicide, self-harm, or immediate danger, respond exactly with the prefix CRISIS: followed by a brief message encouraging immediate human help.
- Output plain text only, with no markdown headings or bullet lists.`;


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
  const cleaned = cleanText(text, 1200).replace(/^SUGGESTION:\s*/i, "");
  const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length >= 2 && lines[0].length <= 90) {
    return {
      title: lines[0].replace(/^Title:\s*/i, ""),
      body: lines.slice(1).join(" ").replace(/^Body:\s*/i, "")
    };
  }
  return {
    title: "Try one small next step",
    body: cleaned || "Pause and identify one small action that would make the concern slightly clearer."
  };
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
      prompt = `Journal entry: ${entry}\nStress rating: ${stress}/10${tags.length ? `\nTags: ${tags.join(", ")}` : ""}\n\nGive exactly one useful response. Put a short title of no more than 8 words on the first line. On the next line, give a 45-90 word supportive suggestion the person can try or think through in the next few minutes. Do not use a list.`;
      if (history.length) {
        prompt += `\n\nAdditional request: ${history.map(h => h.content).join(" ")}`;
      }
    } else {
      const transcript = history.length
        ? history.map(m => `${m.role === "assistant" ? "App" : "User"}: ${m.content}`).join("\n")
        : "No conversation yet.";
      prompt = `Original journal entry: ${entry}\nStress rating: ${stress}/10${tags.length ? `\nTags: ${tags.join(", ")}` : ""}\n\nConversation so far:\n${transcript}\n\nRespond as the next turn in the conversation. Help the person untangle the concern rather than merely reassuring them. Keep the reply to 55-120 words and ask at most one focused question.`;
    }

    const response = await openAIRequest("responses", {
      model: MODEL,
      instructions: SUPPORT_INSTRUCTIONS,
      input: prompt,
      max_output_tokens: 320,
      reasoning: { effort: "low" },
      store: false,
      safety_identifier: safetyIdentifier(request.auth.uid)
    });

    const output = cleanText(responseText(response), 1500);
    if (/^CRISIS:/i.test(output)) return crisisResponse();
    if (!output) throw new Error("OpenAI returned an empty response.");

    if (mode === "conversation") return { crisis: false, reply: output };
    return { crisis: false, ...parseSuggestion(output) };
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
