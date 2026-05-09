import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { Resend } from "resend";
import path from "path";
import { fileURLToPath } from "url";
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
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT CONFIG
// ─────────────────────────────────────────────────────────────────────────────

async function getClientById(clientId) {
  if (!clientId) return null;
  const result = await pool.query(`select * from clients where client_id = $1 limit 1`, [clientId]);
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    clientId: row.client_id,
    enabled: row.enabled,
    allowedOrigins: row.allowed_origins || [],
    ui: row.ui || {},
    promptClient: row.prompt_client || "",
    model: row.model || "gpt-4.1-mini",
    limits: { rpm: row.rpm_limit ?? 30 },
    notificationEmail: row.notification_email || null,
    leadSettings: row.lead_settings || {},
    plan: row.plan || "starter",
    leadsThisMonth: row.leads_this_month || 0,
    leadsResetAt: row.leads_reset_at || null
  };
}

async function getClientOrThrow(clientId) {
  if (!clientId) return { error: "clientId required", status: 400 };
  const client = await getClientById(clientId);
  if (!client) return { error: "Unknown client", status: 404 };
  if (!client.enabled) return { error: "Client disabled", status: 403 };
  return { client };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAN LIMITS
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_LIMITS = {
  starter: { leadsPerMonth: 75, name: "Starter" },
  pro:     { leadsPerMonth: Infinity, name: "Pro" },
  agency:  { leadsPerMonth: Infinity, name: "Agency" }
};

async function checkAndIncrementLeads(clientId, plan, leadsThisMonth, leadsResetAt) {
  const limit = PLAN_LIMITS[plan]?.leadsPerMonth ?? 75;

  // Reset counter if it's been over 30 days
  const resetDate = leadsResetAt ? new Date(leadsResetAt) : new Date(0);
  const daysSinceReset = (Date.now() - resetDate.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceReset >= 30) {
    await pool.query(
      `UPDATE clients SET leads_this_month = 1, leads_reset_at = now() WHERE client_id = $1`,
      [clientId]
    );
    return { allowed: true, leadsThisMonth: 1, limit };
  }

  if (leadsThisMonth >= limit) {
    return { allowed: false, leadsThisMonth, limit };
  }

  await pool.query(
    `UPDATE clients SET leads_this_month = leads_this_month + 1 WHERE client_id = $1`,
    [clientId]
  );

  return { allowed: true, leadsThisMonth: leadsThisMonth + 1, limit };
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

app.use(cors({ origin: (origin, cb) => cb(null, true) }));

function enforceOrigin(req, client) {
  const origin = req.headers.origin;
  if (!origin) return { ok: false, reason: "Missing Origin" };
  const allowed = (client.allowedOrigins || []).includes(origin);
  if (!allowed) return { ok: false, reason: `Origin not allowed: ${origin}` };
  return { ok: true };
}

const buckets = new Map();
function rateLimit(key, rpm) {
  const now = Date.now();
  const windowMs = 60_000;
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartMs >= windowMs) {
    bucket = { windowStartMs: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= rpm;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getOrCreateConversation(clientId, sessionId, pageUrl) {
  const existing = await pool.query(
    `select * from conversations where client_id = $1 and session_id = $2 limit 1`,
    [clientId, sessionId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await pool.query(
    `insert into conversations (client_id, session_id, last_page_url) values ($1, $2, $3) returning *`,
    [clientId, sessionId, pageUrl || null]
  );
  return inserted.rows[0];
}

async function updateConversation(conversationId, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = $${i}`);
    values.push(value);
    i += 1;
  }
  fields.push(`updated_at = now()`);
  values.push(conversationId);
  const result = await pool.query(
    `update conversations set ${fields.join(", ")} where id = $${i} returning *`,
    values
  );
  return result.rows[0];
}

async function getRecentMessages(conversationId, limit = 12) {
  if (!conversationId) return [];
  try {
    const result = await pool.query(
      `select role, content from messages where conversation_id = $1 order by created_at desc limit $2`,
      [conversationId, limit]
    );
    return result.rows.reverse();
  } catch {
    return [];
  }
}

async function logMessage(conversationId, role, content) {
  if (!conversationId || !role || !content) return;
  try {
    await pool.query(
      `insert into messages (conversation_id, role, content) values ($1, $2, $3)`,
      [conversationId, role, content]
    );
  } catch (err) {
    console.error("Failed to log message:", err.message);
  }
}

async function findRecentLead(clientId, email, phone) {
  if (!email && !phone) return null;
  const result = await pool.query(
    `select * from leads
     where client_id = $1
       and (($2::text is not null and email = $2) or ($3::text is not null and phone = $3))
       and created_at >= now() - interval '24 hours'
     order by created_at desc limit 1`,
    [clientId, email || null, phone || null]
  );
  return result.rows[0] || null;
}

async function insertOrUpdateLead({ clientId, conversationId, name, email, phone, serviceInterest, message, pageUrl }) {
  const existing = await findRecentLead(clientId, email, phone);
  if (existing) {
    const result = await pool.query(
      `update leads set
        name = coalesce($1, name),
        email = coalesce($2, email),
        phone = coalesce($3, phone),
        service_interest = coalesce($4, service_interest),
        message = coalesce($5, message),
        page_url = coalesce($6, page_url),
        conversation_id = coalesce($7, conversation_id)
       where id = $8 returning *`,
      [name||null, email||null, phone||null, serviceInterest||null, message||null, pageUrl||null, conversationId||null, existing.id]
    );
    return result.rows[0];
  }

  const inserted = await pool.query(
    `insert into leads (client_id, conversation_id, name, email, phone, service_interest, message, page_url, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'new') returning *`,
    [clientId, conversationId, name||null, email||null, phone||null, serviceInterest||null, message||null, pageUrl||null]
  );
  return inserted.rows[0];
}

async function sendLeadNotification(client, lead) {
  if (!client.notificationEmail || !resend) return;
  const fromEmail = process.env.NOTIFY_FROM_EMAIL;
  if (!fromEmail) return;

  const subject = `New lead for ${client.clientId}`;
  const body = `New website lead\n\nClient: ${client.clientId}\nName: ${lead.name || "N/A"}\nEmail: ${lead.email || "N/A"}\nPhone: ${lead.phone || "N/A"}\nService: ${lead.service_interest || lead.message || "N/A"}\nPage URL: ${lead.page_url || "N/A"}\nStatus: ${lead.status || "new"}\nCreated: ${lead.created_at || new Date().toISOString()}`;

  try {
    await resend.emails.send({ from: fromEmail, to: client.notificationEmail, subject, text: body });
  } catch (err) {
    console.error("Failed to send lead notification:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI BRAIN — single AI call that decides everything
// ─────────────────────────────────────────────────────────────────────────────

function buildBrainPrompt(client, conversationState) {
  return `You are an AI assistant on a business's website. Your job is to help website visitors with information about the business AND capture leads naturally when there's interest.

═══════════════════════════════════════════════════
BUSINESS CONTEXT
═══════════════════════════════════════════════════
${client.promptClient || "No business info provided. Tell visitors the team will follow up for any specifics."}

═══════════════════════════════════════════════════
CURRENT CONVERSATION STATE
═══════════════════════════════════════════════════
- Visitor name: ${conversationState.visitor_name || "unknown"}
- Visitor email: ${conversationState.visitor_email || "unknown"}
- Visitor phone: ${conversationState.visitor_phone || "unknown"}
- Service interest: ${conversationState.service_interest || "unknown"}
- Lead already captured this session: ${conversationState.status === "lead_complete" ? "yes" : "no"}

═══════════════════════════════════════════════════
HOW TO BEHAVE
═══════════════════════════════════════════════════

ANSWER FIRST, CAPTURE LATER:
- Always answer the visitor's question directly using the business context above
- Don't immediately ask for contact info — that's pushy
- Only ask for contact info when the visitor shows real buying intent (wants a quote, wants to book, wants someone to follow up, says they're interested in working with you)
- After answering general questions, you CAN offer "I can have someone reach out with more details if you'd like — what's the best way to contact you?"

WHEN TO CAPTURE A LEAD:
- Visitor asks for a quote, estimate, or pricing for THEIR specific situation
- Visitor wants to book or schedule
- Visitor explicitly asks for someone to call/email them
- Visitor expresses clear intent to hire/buy
- Visitor offers their contact info unprompted

WHEN NOT TO CAPTURE:
- Visitor is just browsing or asking general info
- Visitor asks pricing questions answerable from the context (just give the info)
- Visitor is comparing options
- Visitor already gave their info this session

INFO TO COLLECT (when capturing a lead):
- Service they need
- Either phone OR email (don't ask for both)
- Their name is nice to have but not required
- Don't ask for location unless explicitly required by the business
- Ask one thing at a time, conversationally

PERSONALITY:
- Talk like a helpful real person, not a robot
- Keep replies short — 1-3 sentences usually
- Use the visitor's name naturally if you know it
- Match the tone of the business context
- Never invent info not in the business context — say "I'm not sure but the team can follow up" instead

OFF-TOPIC HANDLING:
- If completely unrelated (jokes, general AI questions, math problems), politely redirect: "I can help with this business's services, pricing, or scheduling — what would you like to know?"
- Greetings like "hi", "hello" should get a warm response asking how you can help

═══════════════════════════════════════════════════
RESPONSE FORMAT
═══════════════════════════════════════════════════

Return ONLY valid JSON in this exact shape — no other text, no markdown:

{
  "reply": "Your conversational message to the visitor",
  "extracted": {
    "name": "first name only, or null",
    "email": "email or null",
    "phone": "digits only no formatting, or null",
    "service_interest": "what service they want, short phrase, or null"
  },
  "lead_complete": true if you have enough info (service + contact) AND the visitor wants follow-up; false otherwise,
  "intent": "answering_question" | "capturing_lead" | "lead_complete" | "off_topic" | "greeting" | "closing"
}

CRITICAL: Extract info from the visitor's message AND use what's already in the conversation state. If they previously said "car detailing" and now give their phone, mark service_interest as "car detailing" — don't lose context.

If lead_complete is true, your reply should thank them and confirm someone will follow up.`;
}

async function callBrain(client, conversation, recentMessages, currentMessage) {
  const systemPrompt = buildBrainPrompt(client, conversation);

  const inputMessages = [
    { role: "system", content: systemPrompt },
    ...recentMessages.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content
    })),
    { role: "user", content: currentMessage }
  ];

  const response = await openai.chat.completions.create({
    model: client.model || "gpt-4.1-mini",
    messages: inputMessages,
    response_format: { type: "json_object" },
    temperature: 0.6
  });

  const raw = response.choices[0].message.content;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("Brain JSON parse failed:", raw);
    return {
      reply: "Sorry — could you rephrase that?",
      extracted: { name: null, email: null, phone: null, service_interest: null },
      lead_complete: false,
      intent: "answering_question"
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/client-config", async (req, res) => {
  const clientId = req.query.clientId;
  const { client, error, status } = await getClientOrThrow(clientId);
  if (error) return res.status(status).json({ error });
  const originCheck = enforceOrigin(req, client);
  if (!originCheck.ok) return res.status(403).json({ error: originCheck.reason });
  res.json({ ui: client.ui || {} });
});

app.post("/chat", async (req, res) => {
  try {
    const { clientId, sessionId, message, pageUrl } = req.body;

    const { client, error, status } = await getClientOrThrow(clientId);
    if (error) return res.status(status).json({ error });

    const originCheck = enforceOrigin(req, client);
    if (!originCheck.ok) return res.status(403).json({ error: originCheck.reason });

    if (!sessionId || typeof sessionId !== "string")
      return res.status(400).json({ error: "sessionId required" });
    if (!message || typeof message !== "string")
      return res.status(400).json({ error: "message required" });

    const rpm = client.limits?.rpm ?? 30;
    if (!rateLimit(`${clientId}:${sessionId}`, rpm))
      return res.status(429).json({ error: "Rate limit exceeded. Please try again soon." });

    const cleanMessage = message.trim();
    if (!cleanMessage) return res.status(400).json({ error: "Empty message" });

    let conversation = await getOrCreateConversation(clientId, sessionId, pageUrl);

    // Reset stale completed leads after 12 hours
    if (
      conversation.status === "lead_complete" &&
      conversation.updated_at &&
      Date.now() - new Date(conversation.updated_at).getTime() > 1000 * 60 * 60 * 12
    ) {
      conversation = await updateConversation(conversation.id, {
        status: "open",
        visitor_name: null,
        visitor_email: null,
        visitor_phone: null,
        service_interest: null
      });
    }

    await logMessage(conversation.id, "user", cleanMessage);

    // Get recent context
    const recentMessages = await getRecentMessages(conversation.id, 12);

    // ONE AI CALL — decides everything
    const brain = await callBrain(client, conversation, recentMessages, cleanMessage);

    // Check lead limit BEFORE saving a lead (only counts when lead_complete)

    // Merge extracted info with existing conversation state
    const merged = {
      name: brain.extracted?.name || conversation.visitor_name || null,
      email: brain.extracted?.email || conversation.visitor_email || null,
      phone: brain.extracted?.phone || conversation.visitor_phone || null,
      service_interest: brain.extracted?.service_interest || conversation.service_interest || null
    };

    // Persist updated conversation state
    const newStatus = brain.lead_complete ? "lead_complete" : conversation.status;
    await updateConversation(conversation.id, {
      visitor_name: merged.name,
      visitor_email: merged.email,
      visitor_phone: merged.phone,
      service_interest: merged.service_interest,
      last_page_url: pageUrl || conversation.last_page_url,
      last_user_message: cleanMessage,
      status: newStatus,
      lead_intent: brain.intent === "capturing_lead" || brain.intent === "lead_complete"
    });

    // If lead is complete, check plan limit then save
    if (brain.lead_complete && (merged.email || merged.phone)) {
      const limitCheck = await checkAndIncrementLeads(
        clientId, client.plan, client.leadsThisMonth, client.leadsResetAt
      );

      if (!limitCheck.allowed) {
        await logMessage(conversation.id, "assistant", brain.reply);
        return res.json({
          reply: brain.reply,
          state: { mode: brain.intent, leadComplete: false, limitReached: true }
        });
      }

      const lead = await insertOrUpdateLead({
        clientId,
        conversationId: conversation.id,
        name: merged.name,
        email: merged.email,
        phone: merged.phone,
        serviceInterest: merged.service_interest,
        message: merged.service_interest || cleanMessage,
        pageUrl
      });
      await sendLeadNotification(client, lead);
    }

    await logMessage(conversation.id, "assistant", brain.reply);

    return res.json({
      reply: brain.reply,
      state: { mode: brain.intent, leadComplete: brain.lead_complete }
    });

  } catch (err) {
    console.error("Chat route failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Server listening on port ${port}`));
