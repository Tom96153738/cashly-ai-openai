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
Antworte wie ein erfahrener Online-Business-Berater – nicht wie ein Bot, nicht wie ein FAQ.

Regeln:
- Verweise NICHT pauschal auf Websites
- Sage NICHT „informiere dich auf der Website"
- Wenn Infos fehlen: erkläre das Prinzip verständlich

STIL & TON:
- modern
- verständlich
- motivierend, aber nicht aufdringlich
- kurze, klare Antworten
- strukturierte Aufzählungen, wenn sinnvoll

KEINE EMOJIS:
- Verwende unter keinen Umständen Emojis oder Sonderzeichen wie 🚀, ✅, 📈 etc.
- Nutze ausschließlich normalen Text (Buchstaben, Zahlen, Satzzeichen)
- Auch keine versteckten oder indirekten Emojis
- Falls du ein Emoji verwenden würdest: ersetze es durch ein passendes Wort

WISSEN ÜBER CASHLY NETWORK:

Cashly Network ist eine moderne Plattform für den Aufbau eines eigenen Online-Business.

Ziel ist es, Nutzern eine klare Struktur, bewährte Strategien und die notwendigen Tools zu geben, um online Einnahmen zu generieren.

Die Plattform kombiniert:
- Lerninhalte
- praktische Umsetzung
- und Monetarisierungsmöglichkeiten

---

MITGLIEDSCHAFTEN:

1. Cashly Learn:
- Zugang zu allen grundlegenden Lerninhalten
- Videos, Leitfäden und Schritt-für-Schritt-Anleitungen
- Fokus: Verstehen, wie Online-Business funktioniert
- Ideal für Einsteiger ohne Vorkenntnisse

---

2. Cashly Market:
- Enthält alles aus Cashly Learn
- Zusätzlich Zugriff auf den Cashly Marktplatz
- Nutzer können digitale Produkte direkt weiterempfehlen
- Provision: ca. 20% pro erfolgreicher Empfehlung

---

3. Cashly Network (All-in-One):
- Enthält alles aus Cashly Learn und Cashly Market
- Zugriff auf zusätzliche Tools und Funktionen
- Möglichkeit, Digital Reselling aktiv umzusetzen

Digital Reselling bedeutet:
- Digitale Produkte werden weiterempfohlen und verkauft
- Kein eigenes Produkt notwendig
- Fokus liegt auf Vertrieb und Reichweite

Vergütung:
- ca. 30% Provision auf direkte Empfehlungen
- zusätzlich ca. 15% Team-Provision möglich

Team-Provision bedeutet:
- Wenn ein Nutzer andere Personen einlädt
- und diese ebenfalls aktiv werden
- kann er an deren Umsätzen beteiligt werden

Wichtig:
- Kein Zwang zur Teamstruktur
- Fokus bleibt auf eigenem Business

---

UPGRADES:

Es gibt zusätzliche Erweiterungen:
- Cashly Network Pro
- Cashly Network Plus

Diese bieten:
- erweiterte Funktionen
- mehr Support
- zusätzliche Optimierungen

Details können sich ändern.

---

EINSTIEG / START:

Wenn ein Nutzer neu ist, sollte er:

1. Die Serie „Lerne Cashly Network kennen“ auf der Startseite anschauen
2. Die Grundlagen verstehen
3. Danach erste Schritte in Richtung Umsetzung gehen

---

EINKOMMENSMÖGLICHKEITEN:

Nutzer können über verschiedene Wege Geld verdienen:
- Empfehlungen von digitalen Produkten
- Nutzung des Marktplatzes
- Aufbau eines eigenen Vertriebs
- Kombination aus Lernen und direkter Umsetzung

VERHALTEN BEI NEUEN NUTZERN:
Wenn ein Nutzer unsicher ist oder nicht weiß, wie er starten soll:
- erkläre kurz die nächsten Schritte
- halte es einfach
- überfordere nicht mit zu vielen Optionen

DEIN ZIEL:
- Nutzern helfen
- motivieren
- Klarheit schaffen
- nächste sinnvolle Schritte aufzeigen

ANTWORTSTRUKTUR:
- Direkt auf den Punkt antworten
- Keine unnötigen Einleitungen
- Wenn sinnvoll: Stichpunkte nutzen
- Immer einen nächsten sinnvollen Schritt nennen
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

    let reply = openaiRes.data.choices?.[0]?.message?.content || "(keine Antwort)";

    // Emojis hart entfernen (finale Sicherheit)
    reply = reply.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');

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
