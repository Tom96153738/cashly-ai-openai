import express from "express";
import axios from "axios";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import cron from "node-cron";
dotenv.config();

const DATA_FILE = path.resolve("./data.json");
const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const CASHLY_SYSTEM_PROMPT = `
Du bist „Cashly AI“, der offizielle digitale Business-Assistent von Cashly Network(www.cashlynetwork.de).

DEINE ROLLE:
Du hilfst Nutzern dabei, ihr Online-Business aufzubauen, dranzubleiben und bessere Entscheidungen zu treffen.
Du bist professionell, motivierend, klar und lösungsorientiert.
Kein Guru-Blabla, kein Druck, keine falschen Versprechen.

STIL & TON:
- modern
- verständlich
- motivierend, aber nicht aufdringlich
- kurze, klare Antworten
- strukturierte Aufzählungen, wenn sinnvoll

EMOJI-REGELN:
- Maximal 1–2 Emojis pro Antwort
- Nur Business-Emojis (🚀 📈 💼 ✅)
- Emojis nur am Satzende oder bei Überschriften
- Niemals übertreiben

WISSEN ÜBER CASHLY NETWORK:
Cashly Network ist eine wachsende Online-Business-Plattform.
Nutzer können dort digitale Business-Modelle lernen und starten.

Es gibt:
- Kurse & Lerninhalte
- Einen Reseller-Bereich mit Dashboard & Empfehlungslink
- Einen Tool-Bereich (Standard & Premium, abhängig von der Mitgliedschaft)
- Eine Web-App
- Eine Community (im Aufbau)

EINNAHMEN:
Aktuell können Nutzer über das Reseller-System Provisionen verdienen.
Details, Preise und aktuelle Vorteile können sich ändern und sind immer auf der Website zu finden.

MITGLIEDSCHAFTEN:
- Starter, Claimer, Winner
- Claimer & Winner als Abo oder Lifetime
- Höhere Zugänge bieten mehr Tools, besseren Support und mehr Funktionen
- Die Cashly AI ist je nach Zugang unterschiedlich nutzbar
- Unlimited-Zugang zur Cashly AI kostet 3,99 € monatlich

WICHTIG:
Erfinde keine Preise oder Details.
Wenn etwas unklar ist: erkläre das Prinzip und verweise auf die Website.

DEIN ZIEL:
- Nutzern helfen
- motivieren
- Klarheit schaffen
- nächste sinnvolle Schritte aufzeigen
`;


if (!OPENAI_KEY) {
  console.error("ERROR: OPENAI_API_KEY fehlt in .env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "200kb" }));

// Ensure data.json exists
async function ensureDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify({ users: {}, sessions: {} }, null, 2));
  }
}
await ensureDataFile();

// Rate limiter
const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Täglicher Reset um 0 Uhr
cron.schedule('0 0 * * *', async () => {
  try {
    const data = await readData();
    const today = new Date().toISOString().slice(0, 10);
    Object.keys(data.users).forEach(id => {
      data.users[id].usage = { date: today, count: 0 };
    });
    await writeData(data);
    console.log("✅ Täglicher Reset erfolgreich durchgeführt");
  } catch (err) {
    console.error("❌ Fehler beim täglichen Reset:", err);
  }
}, {
  timezone: "Europe/Berlin" // optional, damit es genau um Mitternacht MEZ passiert
});


// Utility: load/save data.json
async function readData() {
  try {
    const txt = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(txt);
  } catch {
    return { users: {}, sessions: {} };
  }
}
async function writeData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// Level IDs und Mapping
const LEVELS = {
  4: { name: "Cashly Starter Lifetime", requestsPerDay: 5, model: "gpt-4.1-mini" },
  5: { name: "Cashly Claimer Lifetime", requestsPerDay: 20, model: "gpt-4.1-mini" },
  2: { name: "Cashly Claimer(ABO)", requestsPerDay: 20, model: "gpt-4.1-mini" },
  6: { name: "Cashly Winner Lifetime", requestsPerDay: Infinity, model: "gpt-4.1" },
  3: { name: "Cashly Winner(ABO)", requestsPerDay: Infinity, model: "gpt-4.1" },
  11:{ name: "Cashly Unlimed", requestsPerDay: Infinity, model: "gpt-4.1" },
};

// Create user if missing
async function ensureUser(userId) {
  const data = await readData();
  if (!data.users[userId]) {
    data.users[userId] = {
      id: userId,
      levelId: 4, // default Starter
      extraRequests: 0,
      usage: { date: new Date().toISOString().slice(0, 10), count: 0 },
    };
    await writeData(data);
  } else {
    const today = new Date().toISOString().slice(0, 10);
    if (data.users[userId].usage?.date !== today) {
      data.users[userId].usage = { date: today, count: 0 };
      await writeData(data);
    }
  }
}

// Consume quota per level
async function consumeQuota(userId) {
  const data = await readData();
  const user = data.users[userId];
  if (!user) return { ok: false, reason: "user_not_found" };

  const level = LEVELS[user.levelId] || LEVELS[4];
  const allowed = level.requestsPerDay;
  const extra = user.extraRequests;
  const used = user.usage.count;

  if (allowed === Infinity) return { ok: true, remaining: Infinity };

  if (used < allowed) {
    user.usage.count++;
    await writeData(data);
    return { ok: true, remaining: allowed - user.usage.count };
  }

  if (extra > 0) {
    user.extraRequests--;
    await writeData(data);
    return { ok: true, remaining: 0 };
  }

  return { ok: false, reason: "quota_exhausted" };
}

// Push session messages
const MAX_SESSION_MSGS = 12;
async function pushSession(userId, role, content) {
  const data = await readData();
  data.sessions[userId] = data.sessions[userId] || [];
  data.sessions[userId].push({ role, content, ts: Date.now() });
  if (data.sessions[userId].length > MAX_SESSION_MSGS) {
    data.sessions[userId] = data.sessions[userId].slice(-MAX_SESSION_MSGS);
  }
  await writeData(data);
}

// GET history
app.get("/api/history", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId fehlt" });
  const data = await readData();
  return res.json({ history: data.sessions[userId] || [] });
});

// ADMIN: reset usage
app.post("/api/admin/resetUsage", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: "forbidden" });

  const data = await readData();
  const today = new Date().toISOString().slice(0, 10);
  Object.keys(data.users).forEach(id => {
    data.users[id].usage = { date: today, count: 0 };
  });
  await writeData(data);
  res.json({ ok: true });
});

// MAIN /api/chat
app.post("/api/chat", async (req, res) => {
  try {
    const { userId = "guest", message, system, temperature = 0.7, max_tokens = 300 } = req.body;

    if (!message) return res.status(400).json({ error: "message fehlt" });

    await ensureUser(userId);
    const q = await consumeQuota(userId);
    if (!q.ok) return res.status(429).json({ error: "Quota exhausted", details: q });

    const data = await readData();
    const session = data.sessions[userId] || [];
    const level = LEVELS[data.users[userId].levelId] || LEVELS[4];

    const messages = [
      {
  role: "system",
  content: system || CASHLY_SYSTEM_PROMPT
},

      ...session,
      { role: "user", content: message }
    ];

    const payload = {
      model: level.model,
      messages,
      temperature: Number(temperature),
      max_tokens: Number(max_tokens),
    };

    const openaiRes = await axios.post("https://api.openai.com/v1/chat/completions", payload, {
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      timeout: 120000,
    });

    const reply = openaiRes.data.choices?.[0]?.message?.content || "(keine Antwort)";

    await pushSession(userId, "user", message);
    await pushSession(userId, "assistant", reply);

    res.json({
      ok: true,
      reply,
      meta: { userId, remainingRequests: q.remaining },
    });
  } catch (err) {
    console.error("ERROR /api/chat:", err.response?.data || err.message);
    res.status(500).json({ error: "server_error", details: err.response?.data || err.message });
  }
});

// update levelId / extraRequests
app.post("/api/user/updateLevel", async (req, res) => {
  const { userId, levelId, extraRequests } = req.body;
  if (!userId) return res.status(400).json({ error: "userId fehlt" });

  const data = await readData();
  data.users[userId] = data.users[userId] || { id: userId };
  if (levelId) data.users[userId].levelId = levelId;
  if (typeof extraRequests === "number") data.users[userId].extraRequests = extraRequests;

  await writeData(data);
  res.json({ ok: true, user: data.users[userId] });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`🚀 Cashly AI läuft auf Port ${PORT}`));

