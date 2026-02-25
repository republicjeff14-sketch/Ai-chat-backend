import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50kb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- clients.json loader ----------
const CLIENTS_PATH = path.join(__dirname, "clients.json");

function loadClients() {
  const raw = fs.readFileSync(CLIENTS_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  const map = new Map();
  for (const c of parsed.clients || []) map.set(c.clientId, c);
  console.log("Loaded clients:");
  for (const [id, client] of map.entries()) {
    console.log(id, client.allowedOrigins);
  }
  return map;
}

let CLIENTS = loadClients();
fs.watchFile(CLIENTS_PATH, { interval: 500 }, () => {
  try {
    CLIENTS = loadClients();
    console.log("Reloaded clients.json");
  } catch (e) {
    console.error("Failed to reload clients.json:", e);
  }
});

// ---------- CORS (allow all here; enforce origin in routes) ----------
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      return cb(null, true);
    },
  })
);

// ---------- helpers ----------
function getClientOrThrow(clientId) {
  if (!clientId) return { error: "clientId required", status: 400 };
  const client = CLIENTS.get(clientId);
  if (!client) return { error: "Unknown client", status: 404 };
  if (!client.enabled) return { error: "Client disabled", status: 403 };
  return { client };
}

function enforceOrigin(req, client) {
  const origin = req.headers.origin;
  if (!origin) return { ok: false, reason: "Missing Origin" };
  const allowed = (client.allowedOrigins || []).includes(origin);
  if (!allowed) return { ok: false, reason: `Origin not allowed: ${origin}` };
  return { ok: true };
}

// ---------- basic per-client rate limiting (in-memory) ----------
const buckets = new Map(); // clientId -> { windowStartMs, count }

function rateLimit(clientId, rpm) {
  const now = Date.now();
  const windowMs = 60_000;

  let b = buckets.get(clientId);
  if (!b || now - b.windowStartMs >= windowMs) {
    b = { windowStartMs: now, count: 0 };
    buckets.set(clientId, b);
  }

  b.count += 1;
  if (b.count > rpm) return false;
  return true;
}

// ---------- usage logging ----------
const LOG_PATH = path.join(__dirname, "usage.log");
function logUsage(lineObj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...lineObj }) + "\n";
  fs.appendFile(LOG_PATH, line, () => {});
}

// ---------- routes ----------
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Safe config for widget UI (NO secrets)
app.get("/client-config", (req, res) => {
  const clientId = req.query.clientId;
  const { client, error, status } = getClientOrThrow(clientId);
  if (error) return res.status(status).json({ error });

  // Enforce domain here too (prevents config being fetched from random sites)
  const originCheck = enforceOrigin(req, client);
  if (!originCheck.ok) return res.status(403).json({ error: originCheck.reason });

  res.json({
    ui: client.ui || {},
  });
});

app.post("/chat", async (req, res) => {
  const started = Date.now();
  try {
    const { clientId, message } = req.body;

    const { client, error, status } = getClientOrThrow(clientId);
    if (error) return res.status(status).json({ error });

    const originCheck = enforceOrigin(req, client);
    if (!originCheck.ok) return res.status(403).json({ error: originCheck.reason });

    const rpm = client.limits?.rpm ?? 30;
    if (!rateLimit(clientId, rpm)) {
      return res.status(429).json({ error: "Rate limit exceeded. Please try again soon." });
    }

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message required" });
    }

  

   const systemPrompt = `${client.promptBase}\n\n${client.promptClient}`;

const response = await openai.responses.create({
  model: client.model || "gpt-4.1-mini",
  input: [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: message
    }
  ]
});

    const reply = response.output_text || "";

    logUsage({
      clientId,
      origin: req.headers.origin || null,
      ms: Date.now() - started,
      msgChars: message.length,
      replyChars: reply.length,
    });

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));