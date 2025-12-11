// server.js (ESM) ----------------------------------------------------------
import express from "express";
import axios from "axios";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const DATA_FILE = path.resolve("./data.json");
const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

if (!OPENAI_KEY) {
  console.error("ERROR: OPENAI_API_KEY fehlt in .env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "200kb" }));

// simple rate limiter (per IP)
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 60, // 60 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Utility: load/save data.json (users, sessions, quotas)
async function readData() {
  try {
    const txt = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(txt);
  } catch (e) {
    return { users: {}, sessions: {} }; // default shape
  }
}
async function writeData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// Default quotas per tier (requests/day). You can change to token-based later.
const TIERS = {
  free: { requestsPerDay: 5 },
  basic: { requestsPerDay: 100 },
  pro: { requestsPerDay: 500 },
  premium: { requestsPerDay: Infinity }, // unlimited
};

// Helper: ensure user exist
async function ensureUser(userId) {
  const data = await readData();
  if (!data.users[userId]) {
    data.users[userId] = {
      id: userId,
      tier: "free", // default; WP integration should set this
      extraRequests: 0, // paid add-on tokens/requests
      usage: { date: new Date().toISOString().slice(0, 10), count: 0 },
    };
    await writeData(data);
  } else {
    // reset daily usage if date changed
    const today = new Date().toISOString().slice(0, 10);
    if (data.users[userId].usage?.date !== today) {
      data.users[userId].usage = { date: today, count: 0 };
      await writeData(data);
    }
  }
  return;
}

// Check & consume quota (returns {ok, remaining, allowed})
async function consumeQuota(userId) {
  const data = await readData();
  const user = data.users[userId];
  if (!user) return { ok: false, reason: "user_not_found" };

  const tier = user.tier || "free";
  const allowed = TIERS[tier]?.requestsPerDay ?? 0;
  const extra = user.extraRequests || 0;
  const used = user.usage?.count || 0;

  if (allowed === Infinity) return { ok: true, remaining: Infinity };

  if (used < allowed) {
    user.usage.count = used + 1;
    await writeData(data);
    return { ok: true, remaining: allowed - user.usage.count };
  }

  if (extra > 0) {
    user.extraRequests = extra - 1;
    await writeData(data);
    return { ok: true, remaining: 0 };
  }

  return { ok: false, reason: "quota_exhausted", remaining: 0 };
}

// Save message to session (keep last N messages)
const MAX_SESSION_MSGS = 12;
async function pushSession(userId, role, content) {
  const data = await readData();
  data.sessions = data.sessions || {};
  data.sessions[userId] = data.sessions[userId] || [];
  data.sessions[userId].push({ role, content, ts: Date.now() });
  // keep last MAX_SESSION_MSGS
  if (data.sessions[userId].length > MAX_SESSION_MSGS) {
    data.sessions[userId] = data.sessions[userId].slice(-MAX_SESSION_MSGS);
  }
  await writeData(data);
}

// GET history for user
app.get("/api/history", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId fehlend" });
  const data = await readData();
  const sessions = data.sessions?.[userId] || [];
  return res.json({ history: sessions });
});

// Admin: reset usage (secure this in production)
app.post("/api/admin/resetUsage", async (req, res) => {
  // Simple protection: require ADMIN_KEY in .env
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "forbidden" });
  }
  const data = await readData();
  Object.keys(data.users || {}).forEach((id) => {
    data.users[id].usage = { date: new Date().toISOString().slice(0, 10), count: 0 };
  });
  await writeData(data);
  return res.json({ ok: true });
});

// MAIN: chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { userId = "guest", message, system, temperature = 0.7, max_tokens = 300 } = req.body;
    if (!message || typeof message !== "string") return res.status(400).json({ error: "message fehlt" });

    // ensure user
    await ensureUser(userId);

    // consume quota
    const q = await consumeQuota(userId);
    if (!q.ok) return res.status(429).json({ error: "Quota exhausted", details: q });

    // assemble messages (session memory + system)
    const data = await readData();
    const session = data.sessions?.[userId] || [];
    const messages = [];

    // optional system prompt from UI or default
    messages.push({
      role: "system",
      content:
        system ||
        "Du bist ein moderner, freundlicher Business-Assistent. Antworte knapp, klar und gib bei Bedarf Emojis, Beispiele und Copy zum Kopieren."
    });

    // include session memory
    session.forEach((m) => {
      messages.push({ role: m.role, content: m.content });
    });

    // push current user message
    messages.push({ role: "user", content: message });

    // call OpenAI
    const payload = {
      model: process.env.OPENAI_MODEL || OPENAI_MODEL,
      messages,
      temperature: parseFloat(temperature),
      max_tokens: parseInt(max_tokens, 10),
    };

    const openaiRes = await axios.post("https://api.openai.com/v1/chat/completions", payload, {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 120000,
    });

    const reply = openaiRes.data?.choices?.[0]?.message?.content ?? "(keine Antwort)";

    // save to session memory (user + ai)
    await pushSession(userId, "user", message);
    await pushSession(userId, "assistant", reply);

    // respond structured (copy-friendly), keep emojis intact
    return res.json({
      ok: true,
      reply,
      meta: {
        userId,
        remainingRequests: q.remaining ?? null,
      },
    });
  } catch (err) {
    console.error("ERROR /api/chat:", err.response?.data || err.message);
    return res.status(500).json({ error: "server_error", details: err.response?.data || err.message });
  }
});

// endpoint to create/update user tier (called from WP backend when membership changes)
app.post("/api/user/updateTier", async (req, res) => {
  const { userId, tier, extraRequests } = req.body;
  if (!userId) return res.status(400).json({ error: "userId fehlt" });
  const data = await readData();
  data.users = data.users || {};
  data.users[userId] = data.users[userId] || { id: userId, usage: { date: new Date().toISOString().slice(0, 10), count: 0 } };
  data.users[userId].tier = tier || data.users[userId].tier || "free";
  if (typeof extraRequests === "number") data.users[userId].extraRequests = extraRequests;
  await writeData(data);
  return res.json({ ok: true, user: data.users[userId] });
});

// quick health
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`🚀 Cashly AI Server läuft auf http://localhost:${PORT}`));
