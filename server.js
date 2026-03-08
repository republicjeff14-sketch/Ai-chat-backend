import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
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

function detectLeadIntent(text) {
  return /(quote|estimate|pricing|price|book|booking|appointment|schedule|contact|call me|reach out|get in touch)/i.test(text);
}

function extractEmail(text) {
  const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

function extractPhone(text) {
  const m = text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0] : null;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function classifyLead(openai, message)  {
  const classifierPrompt = `
You are a lead-capture classifier for a business website chat widget.

Your job:
1. Decide if the user's message indicates sales/contact intent.
2. Extract any lead information already present.
3. Decide what missing information should be asked next.

Return ONLY valid JSON.
No markdown.
No explanation.

JSON shape:
{
  "isLead": boolean,
  "leadType": "quote_request" | "booking_request" | "pricing_question" | "general_contact" | "none",
  "name": string | null,
  "phone": string | null,
  "email": string | null,
  "notes": string | null,
  "shouldAskFollowup": boolean,
  "followupQuestion": string | null
}

Rules:
- isLead should be true if the user wants pricing, a quote, a booking, a consultation, to be contacted, or shows buying intent.
- Extract name if the user says things like "my name is..." or "I'm ..."
- Extract phone if present.
- Extract email if present.
- notes should briefly summarize what they want.
- If isLead is true and phone/email is missing, shouldAskFollowup should usually be true.
- followupQuestion should be short, natural, and ask only for the missing info.
- If enough contact info is already present, shouldAskFollowup should be false.
`;

  const result = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: classifierPrompt
      },
      {
        role: "user",
        content: message
      }
    ]
  });

  return safeJsonParse(result.output_text);
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
    const { clientId, message, pageUrl } = req.body;

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
let leadData = null;

try {
  leadData = await classifyLead(openai, client, message);
} catch (e) {
  console.error("Lead classifier failed:", e.message);
}

if (leadData?.isLead) {
  const fallbackPhone = extractPhone(message);
  const fallbackEmail = extractEmail(message);

  const name = leadData.name || null;
  const phone = leadData.phone || fallbackPhone || null;
  const email = leadData.email || fallbackEmail || null;
  const notes = leadData.notes || message;

  try {
    await pool.query(
      `insert into leads (client_id, name, email, phone, message, page_url)
       values ($1, $2, $3, $4, $5, $6)`,
      [clientId, name, email, phone, notes, pageUrl || null]
    );
  } catch (e) {
    console.error("Lead insert failed:", e.message);
  }

  if (leadData.shouldAskFollowup) {
    return res.json({
      reply:
        leadData.followupQuestion ||
        "Sure — could you share your name and best phone number so our team can follow up?"
    });
  }

  return res.json({
    reply: name
      ? `Thanks ${name}! Someone from our team will reach out shortly.`
      : "Thanks! Someone from our team will reach out shortly."
  });
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
app.get("/", (req, res) => {
  res.type("text").send(
    "AI Chat Backend is running ✅\n\nTry:\n/health\n/widget.js"
  );
});
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));