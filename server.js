import crypto from "node:crypto";
import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import helmet from "helmet";
import OpenAI, { toFile } from "openai";
import { z } from "zod";

const VERSION = "2.1.0";
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SHARED_SECRET = process.env.CASHLY_SHARED_SECRET || "";
const STANDARD_MODEL = process.env.OPENAI_MODEL_STANDARD || process.env.OPENAI_MODEL_FAST || "gpt-6-luna";
const PLUS_MODEL = process.env.OPENAI_MODEL_PLUS || process.env.OPENAI_MODEL_DEFAULT || "gpt-6.1-sol";
const DEEP_MODEL = process.env.OPENAI_MODEL_DEEP || "gpt-6.1-sol";
const SIGNATURE_TOLERANCE_SECONDS = 300;

if (!OPENAI_API_KEY || !SHARED_SECRET) {
  console.error("OPENAI_API_KEY und CASHLY_SHARED_SECRET muessen gesetzt sein.");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  timeout: 90_000,
  maxRetries: 2,
});

const modeSchema = z.enum(["general", "market", "reseller"]);
const planSchema = z.enum(["standard", "plus"]);
const analysisModeSchema = z.enum(["standard", "deep"]);
const historyMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(20_000),
}).strict();

const chatSchema = z.object({
  requestId: z.string().trim().min(12).max(120),
  userId: z.string().trim().min(1).max(120),
  chatId: z.string().trim().min(1).max(160),
  mode: modeSchema,
  plan: planSchema.default("standard"),
  analysisMode: analysisModeSchema.default("standard"),
  message: z.string().trim().min(1).max(4_000),
  history: z.array(historyMessageSchema).max(30).default([]),
  knowledgeContext: z.string().max(24_000).default(""),
  vectorStoreId: z.string().regex(/^vs_[A-Za-z0-9_-]+$/).optional().or(z.literal("")),
}).strict();

const knowledgeDocumentSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240),
  url: z.string().url().max(2_000).optional().or(z.literal("")),
  content: z.string().trim().min(20).max(120_000),
  hash: z.string().trim().max(128).optional(),
}).strict();

const knowledgeSyncSchema = z.object({
  requestId: z.string().trim().min(12).max(120),
  previousVectorStoreId: z.string().regex(/^vs_[A-Za-z0-9_-]+$/).optional().or(z.literal("")),
  documents: z.array(knowledgeDocumentSchema).min(1).max(40),
}).strict();

const MODE_PROMPTS = {
  general: `
MODUS: ALLGEMEIN
Hilf bei Orientierung, Planung, Lernen und der sinnvollen Nutzung von Cashly Network.
Erklaere Zusammenhaenge einfach, ohne sie unnoetig zu vereinfachen.
Wenn eine Anfrage klar zum Cashly Market oder Cashly Reseller gehoert, beantworte sie trotzdem hilfreich und weise knapp auf den passenderen Modus hin.
`,
  market: `
MODUS: CASHLY MARKET
Du bist auf die Vermarktung physischer Produkte aus dem Cashly Market spezialisiert.
Unterstuetze bei Produktauswahl, Zielgruppen, Positionierung, Content-Ideen, Hooks, Kurzvideo-Skripten, Facebook-Inhalten, organischem Marketing, Kampagnen und Auswertung.
Die Market-Provision betraegt laut aktuellem Cashly-Grundwissen 20 Prozent direkt und enthaelt keine passive Provision. Nenne diese Werte nur, wenn sie durch den bereitgestellten Wissenskontext bestaetigt werden.
Erfinde keine Produkteigenschaften, Lieferzeiten, Preise, Gesundheitswirkungen oder Garantien. Frage nach fehlenden Produktdaten.
Formuliere Werbung ehrlich, konkret und passend zur Zielgruppe. Vermeide Spam, Druck, falsche Knappheit und unrealistische Versprechen.
`,
  reseller: `
MODUS: CASHLY RESELLER
Du bist auf die serioese Empfehlung von Cashly Network spezialisiert.
Unterstuetze bei Zielgruppen, Akquise, persoenlichen Nachrichten, Content, Gespraechsleitfaeden, Bedarfsermittlung, Einwandbehandlung, Follow-ups und Abschlussvorbereitung.
Nutze ausschliesslich aktuelle Provisions-, Mitgliedschafts- und Leistungsdaten aus dem bereitgestellten Cashly-Wissen. Erfinde keine Leistungen oder Verguetungen.
Fuehre Verkauf beratend: Situation verstehen, Bedarf klaeren, Nutzen passend erklaeren, offene Fragen beantworten und einen ehrlichen naechsten Schritt anbieten.
Mache niemals Einkommensgarantien und stelle Cashly nicht als risikofreien oder automatischen Verdienst dar.
`,
};

const BASE_PROMPT = `
Du bist Cashly AI, der digitale Business-Assistent von Cashly Network.

ARBEITSWEISE
- Antworte auf Deutsch, direkt, hochwertig und handlungsorientiert.
- Nutze keine Emojis, keine ASCII-Art und keine dekorativen Trennlinien.
- Gib zuerst die konkrete Antwort. Erklaere danach nur, was fuer die Umsetzung wichtig ist.
- Verwende klare Abschnitte und kurze Listen, wenn sie das Lesen verbessern.
- Stelle hoechstens eine notwendige Rueckfrage. Mache ansonsten sinnvolle, klar benannte Annahmen.
- Wenn der Nutzer einen Text, Plan oder ein Skript verlangt, liefere eine direkt verwendbare Fassung.
- Trenne Fakten, Empfehlungen und Annahmen sauber voneinander.

VERBINDLICHKEIT
- Der bereitgestellte Cashly-Wissenskontext und abgerufene Cashly-Quellen haben Vorrang vor deinem allgemeinen Wissen.
- Wenn Cashly-Informationen fehlen oder widerspruechlich sind, sage das offen. Erfinde nichts.
- Verweise nur auf Links und Bereiche, die im Wissenskontext vorkommen.
- Mache keine unbelegten Einkommens-, Erfolgs-, Gesundheits- oder Produktversprechen.
- Bei rechtlichen, steuerlichen, medizinischen oder finanziellen Fragen gib allgemeine Orientierung und empfehle bei konkreten Entscheidungen fachkundige Beratung.

VERKAUF
- Arbeite bedarfsorientiert, ehrlich und konkret.
- Hilf dabei, Zielgruppe, Problem, gewuenschten Zustand, Nutzen, Beleg und naechsten Schritt zu verbinden.
- Passe Kanal, Ton und Handlungsaufforderung an die Situation an.
- Vermeide manipulative Aussagen, Massennachrichten und kuenstlichen Druck.
`;

function normalizeHistory(history) {
  return history.slice(-24).map((item) => ({ role: item.role, content: item.content }));
}

function pickModel(message, mode, plan, analysisMode) {
  const normalized = message.toLowerCase();
  const simpleSignals = ["kuerzer", "umschreiben", "titel", "drei hooks", "korrigiere", "zusammenfassen"];

  if (analysisMode === "deep") {
    return { model: DEEP_MODEL, reasoning: "high", route: "deep", maxOutputTokens: 3_200 };
  }
  if (plan === "plus") {
    return { model: PLUS_MODEL, reasoning: mode === "general" ? "medium" : "high", route: "plus", maxOutputTokens: 2_200 };
  }
  if (mode === "general" && message.length < 260 && simpleSignals.some((term) => normalized.includes(term))) {
    return { model: STANDARD_MODEL, reasoning: "low", route: "fast", maxOutputTokens: 1_400 };
  }
  return { model: STANDARD_MODEL, reasoning: mode === "general" ? "low" : "medium", route: "standard", maxOutputTokens: 1_800 };
}

function safeEqualHex(first, second) {
  if (!/^[a-f0-9]{64}$/i.test(first || "") || !/^[a-f0-9]{64}$/i.test(second || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(first, "hex"), Buffer.from(second, "hex"));
}

const replayCache = new Map();

function purgeReplayCache(now = Date.now()) {
  for (const [requestId, expiresAt] of replayCache.entries()) {
    if (expiresAt <= now) replayCache.delete(requestId);
  }
}

function requireSignature(req, res, next) {
  const timestamp = req.get("x-cashly-timestamp") || "";
  const signature = req.get("x-cashly-signature") || "";
  const timestampNumber = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (!Number.isInteger(timestampNumber) || Math.abs(nowSeconds - timestampNumber) > SIGNATURE_TOLERANCE_SECONDS) {
    return res.status(401).json({ ok: false, error: "invalid_signature" });
  }

  const expected = crypto.createHmac("sha256", SHARED_SECRET)
    .update(`${timestamp}.${req.rawBody || ""}`)
    .digest("hex");

  if (!safeEqualHex(signature, expected)) {
    return res.status(401).json({ ok: false, error: "invalid_signature" });
  }

  const requestId = req.body?.requestId;
  purgeReplayCache();
  if (requestId && replayCache.has(requestId)) {
    return res.status(409).json({ ok: false, error: "duplicate_request" });
  }
  if (requestId) replayCache.set(requestId, Date.now() + SIGNATURE_TOLERANCE_SECONDS * 1_000);
  return next();
}

function buildInstructions(mode, knowledgeContext, plan, analysisMode) {
  const knowledge = knowledgeContext.trim()
    ? `\nVERBINDLICHES CASHLY-WISSEN\n${knowledgeContext.trim()}\n`
    : "\nEs wurde kein zusaetzlicher Cashly-Wissenskontext bereitgestellt. Behaupte keine konkreten Cashly-Leistungen, Preise oder Verguetungen.\n";
  const quality = plan === "plus"
    ? "\nQUALITAET: CASHLY AI PLUS\nArbeite besonders praezise. Pruefe Zusammenhaenge, passe Empfehlungen an den Kontext an und liefere belastbare naechste Schritte statt allgemeiner Floskeln.\n"
    : "\nQUALITAET: STANDARD\nAntworte klar, nuetzlich und kompakt.\n";
  const depth = analysisMode === "deep"
    ? "\nTIEFENANALYSE\nAnalysiere Ziel, Ausgangslage, Annahmen, Optionen, Risiken und Prioritaeten. Begruende die Empfehlung und schliesse mit einem konkreten Umsetzungsplan. Bleibe trotz der Tiefe fokussiert.\n"
    : "";
  return `${BASE_PROMPT}\n${MODE_PROMPTS[mode]}\n${quality}${depth}${knowledge}`;
}

function logEvent(event, details = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

async function syncKnowledge(documents) {
  const vectorStore = await openai.vectorStores.create({
    name: `Cashly Knowledge ${new Date().toISOString()}`,
  });

  try {
    for (const document of documents) {
      const safeName = `${document.id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
      const file = await openai.files.create({
        file: await toFile(
          Buffer.from(`Titel: ${document.title}\nQuelle: ${document.url || "Cashly Admin"}\n\n${document.content}`, "utf8"),
          safeName,
          { type: "text/plain" },
        ),
        purpose: "assistants",
      });

      await openai.vectorStores.files.createAndPoll(vectorStore.id, {
        file_id: file.id,
        attributes: {
          source_id: document.id.slice(0, 120),
          source_url: (document.url || "").slice(0, 500),
          source_hash: (document.hash || "").slice(0, 120),
        },
      });
    }
    return vectorStore.id;
  } catch (error) {
    await deleteVectorStoreWithFiles(vectorStore.id);
    throw error;
  }
}

async function deleteVectorStoreWithFiles(vectorStoreId) {
  if (!vectorStoreId) return;
  const fileIds = [];

  try {
    for await (const item of openai.vectorStores.files.list(vectorStoreId, { limit: 100 })) {
      if (item.id) fileIds.push(item.id);
    }
  } catch (error) {
    logEvent("knowledge.cleanup_list_failed", { vectorStoreId, error: error?.name || "Error" });
  }

  await openai.vectorStores.delete(vectorStoreId).catch(() => {});
  await Promise.all(fileIds.map((fileId) => openai.files.delete(fileId).catch(() => {})));
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
}));
app.use(express.json({
  limit: "6mb",
  verify(req, _res, buffer) {
    req.rawBody = buffer.toString("utf8");
  },
}));

const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.userId || ipKeyGenerator(req.ip),
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "cashly-ai", version: VERSION });
});

app.post("/api/v2/chat", requireSignature, chatLimiter, async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request" });

  const startedAt = Date.now();
  const input = parsed.data;
  const route = pickModel(input.message, input.mode, input.plan, input.analysisMode);
  const tools = input.vectorStoreId
    ? [{ type: "file_search", vector_store_ids: [input.vectorStoreId], max_num_results: 6 }]
    : undefined;

  try {
    const response = await openai.responses.create({
      model: route.model,
      instructions: buildInstructions(input.mode, input.knowledgeContext, input.plan, input.analysisMode),
      input: [...normalizeHistory(input.history), { role: "user", content: input.message }],
      reasoning: { effort: route.reasoning },
      text: { verbosity: "medium" },
      tools,
      include: tools ? ["file_search_call.results"] : undefined,
      max_output_tokens: route.maxOutputTokens,
      store: false,
      metadata: {
        cashly_request_id: input.requestId.slice(0, 64),
        cashly_mode: input.mode,
        cashly_plan: input.plan,
        cashly_analysis: input.analysisMode,
      },
    });

    const reply = response.output_text?.trim();
    if (!reply) throw new Error("empty_model_response");

    logEvent("chat.completed", {
      requestId: input.requestId,
      userId: crypto.createHash("sha256").update(input.userId).digest("hex").slice(0, 12),
      mode: input.mode,
      plan: input.plan,
      analysisMode: input.analysisMode,
      model: route.model,
      route: route.route,
      durationMs: Date.now() - startedAt,
      inputTokens: response.usage?.input_tokens || null,
      outputTokens: response.usage?.output_tokens || null,
    });

    return res.json({
      ok: true,
      reply,
      meta: { model: route.model, route: route.route, analysisMode: input.analysisMode, usage: response.usage || null },
    });
  } catch (error) {
    logEvent("chat.failed", {
      requestId: input.requestId,
      mode: input.mode,
      plan: input.plan,
      analysisMode: input.analysisMode,
      durationMs: Date.now() - startedAt,
      error: error?.name || "Error",
      status: error?.status || null,
    });
    return res.status(502).json({ ok: false, error: "generation_failed" });
  }
});

app.post("/api/v2/knowledge/sync", requireSignature, async (req, res) => {
  const parsed = knowledgeSyncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_request" });

  const startedAt = Date.now();
  try {
    const vectorStoreId = await syncKnowledge(parsed.data.documents);
    if (parsed.data.previousVectorStoreId && parsed.data.previousVectorStoreId !== vectorStoreId) {
      await deleteVectorStoreWithFiles(parsed.data.previousVectorStoreId);
    }

    logEvent("knowledge.synced", {
      requestId: parsed.data.requestId,
      documents: parsed.data.documents.length,
      durationMs: Date.now() - startedAt,
    });
    return res.json({ ok: true, vectorStoreId, documents: parsed.data.documents.length });
  } catch (error) {
    logEvent("knowledge.failed", {
      requestId: parsed.data.requestId,
      durationMs: Date.now() - startedAt,
      error: error?.name || "Error",
      status: error?.status || null,
    });
    return res.status(502).json({ ok: false, error: "knowledge_sync_failed" });
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: "payload_too_large" });
  }
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }
  logEvent("server.error", { error: error?.name || "Error" });
  return res.status(500).json({ ok: false, error: "server_error" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  logEvent("server.started", { version: VERSION, port: PORT });
});

function shutdown(signal) {
  logEvent("server.stopping", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
