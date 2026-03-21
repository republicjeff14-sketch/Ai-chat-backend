import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { Resend } from "resend";
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
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// -------------------- client config --------------------
const CLIENTS_PATH = path.join(__dirname, "clients.json");

function loadClients() {
  const raw = fs.readFileSync(CLIENTS_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  const map = new Map();

  for (const client of parsed.clients || []) {
    map.set(client.clientId, client);
  }

  return map;
}

let CLIENTS = loadClients();

fs.watchFile(CLIENTS_PATH, { interval: 500 }, () => {
  try {
    CLIENTS = loadClients();
    console.log("Reloaded clients.json");
  } catch (err) {
    console.error("Failed to reload clients.json:", err);
  }
});

// -------------------- middleware --------------------
app.use(
  cors({
    origin: (origin, cb) => cb(null, true)
  })
);

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

// -------------------- rate limit --------------------
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

// -------------------- helpers --------------------
function normalizeText(text) {
  return String(text || "").trim();
}

function detectLeadIntent(text) {
  return /\b(quote|estimate|pricing|price|cost|how much|book|booking|appointment|schedule|contact|call me|reach out|get in touch|consultation|can someone call|can someone contact)\b/i.test(
    text
  );
}

function detectBusinessTopic(text) {
  const t = normalizeText(text).toLowerCase();

  const businessPatterns = [
    /\bservice\b/,
    /\bservices\b/,
    /\bquote\b/,
    /\bestimate\b/,
    /\bpricing\b/,
    /\bprice\b/,
    /\bcost\b/,
    /\bhow much\b/,
    /\bbook\b/,
    /\bbooking\b/,
    /\bappointment\b/,
    /\bschedule\b/,
    /\bavailability\b/,
    /\bavailable\b/,
    /\bhours\b/,
    /\bopen\b/,
    /\bclosed\b/,
    /\blocation\b/,
    /\baddress\b/,
    /\bwhere are you\b/,
    /\bwhere.*located\b/,
    /\bcontact\b/,
    /\bphone\b/,
    /\bemail\b/,
    /\bcall\b/,
    /\breach\b/,
    /\bcome by\b/,
    /\bvisit\b/,
    /\btomorrow\b/,
    /\btoday\b/,
    /\bthis week\b/,
    /\bserve\b/,
    /\bservice area\b/,
    /\barea\b/,
    /\bareas\b/,
    /\bnear me\b/,
    /\binterior\b/,
    /\bexterior\b/,
    /\bcleaning\b/,
    /\bdetail\b/,
    /\bdetailing\b/,
    /\bwash\b/,
    /\brepair\b/,
    /\breplacement\b/,
    /\binstall\b/,
    /\binstallation\b/,
    /\bleak\b/,
    /\broof\b/,
    /\bconsultation\b/,
    /\bcan you do\b/,
    /\bdo you do\b/,
    /\bdo you guys do\b/,
    /\byall do\b/,
    /\by'all do\b/
  ];

  return businessPatterns.some((pattern) => pattern.test(t));
}

function extractEmail(text) {
  const m = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return m ? m[0].trim().toLowerCase() : null;
}

function extractPhone(text) {
  const m = text.match(/\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/);
  if (!m) return null;
  return m[0].replace(/\D/g, "");
}

function extractName(text) {
  const patterns = [
    /(?:my name is|i am|i'm|im|this is|name[:\s]+)\s+([A-Za-z]+)/i
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return m[1].trim();
  }

  return null;
}

function extractServiceInterest(text) {
  const cleaned = normalizeText(text);
  if (!cleaned) return null;
  if (cleaned.length <= 120) return cleaned;
  return cleaned.slice(0, 120);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function classifyLead(openaiClient, message) {
  const prompt = `
You are a lead-capture classifier for a business website chat widget.

Return ONLY valid JSON.

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
- isLead should be true if the user wants pricing, a quote, booking, contact, or service follow-up.
- Keep followupQuestion short and natural.
`;

  const result = await openaiClient.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: prompt },
      { role: "user", content: message }
    ]
  });

  return safeJsonParse(result.output_text);
}

async function classifyMessage(openaiClient, client, message) {
  const prompt = `
You are a classifier for a business website assistant.

Business context:
${client.promptClient || ""}

Return ONLY valid JSON in this exact shape:
{
  "isBusinessRelevant": boolean,
  "isLead": boolean,
  "intent": "quote" | "booking" | "pricing" | "service_question" | "contact" | "off_topic" | "other",
  "confidence": number,
  "suggestedFollowup": string | null
}

Rules:
- isBusinessRelevant should be true if the message is about the business, its services, pricing, quotes, scheduling, hours, location, contact, or availability.
- Treat typos, slang, and casual wording as valid if the likely meaning is about the business.
- isLead should ONLY be true if the visitor is asking for a quote, estimate, pricing, booking, scheduling, contact, callback, or direct follow-up.
- Questions asking whether the business offers a service should usually be "service_question", not a lead.
- Examples of service_question and NOT a lead:
  - "do yall do detailing"
  - "do you clean interiors"
  - "yall fix roof leaks"
- Examples of lead:
  - "i want a quote"
  - "how much does detailing cost"
  - "can someone call me"
  - "i want to book"
- If unrelated to the business, mark isBusinessRelevant false and intent off_topic.
- confidence should be a number from 0 to 1.
- Return JSON only.
`;

  const result = await openaiClient.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: prompt },
      { role: "user", content: message }
    ]
  });

  return safeJsonParse(result.output_text);
}

function buildSystemPrompt(client, conversation) {
  return `
You are a website lead capture assistant for a business.

Your job is to help visitors with:
- services
- pricing
- quotes
- appointments
- business hours
- locations
- contact requests

Rules:
- Do NOT act like a general AI chatbot.
- Do NOT answer unrelated questions.
- Do NOT provide jokes, trivia, motivational quotes, or entertainment.
- Do NOT warn users not to share contact information when they are requesting service.
- Keep replies short, clear, and businesslike.
- If the visitor asks for pricing, a quote, booking, or contact, help collect the missing details needed for follow-up.
- If the visitor is off-topic, politely redirect them to services, pricing, appointments, or contact help only.
- Do not invent pricing, policies, or services.

Business context:
${client.promptClient || ""}

Conversation state:
- lead_intent: ${conversation?.lead_intent ? "yes" : "no"}
- visitor_name: ${conversation?.visitor_name || "unknown"}
- visitor_email: ${conversation?.visitor_email || "unknown"}
- visitor_phone: ${conversation?.visitor_phone || "unknown"}
- service_interest: ${conversation?.service_interest || "unknown"}
`;
}

function buildOffTopicReply() {
  return "I can help with this business’s services, pricing, appointments, and contact requests. What would you like help with?";
}

// -------------------- db helpers --------------------
async function getOrCreateConversation(clientId, sessionId, pageUrl) {
  const existing = await pool.query(
    `
      select *
      from conversations
      where client_id = $1 and session_id = $2
      limit 1
    `,
    [clientId, sessionId]
  );

  if (existing.rows[0]) return existing.rows[0];

  const inserted = await pool.query(
    `
      insert into conversations (
        client_id,
        session_id,
        last_page_url
      )
      values ($1, $2, $3)
      returning *
    `,
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
    `
      update conversations
      set ${fields.join(", ")}
      where id = $${i}
      returning *
    `,
    values
  );

  return result.rows[0];
}

async function findRecentLead(clientId, email, phone) {
  if (!email && !phone) return null;

  const result = await pool.query(
    `
      select *
      from leads
      where client_id = $1
        and (
          ($2::text is not null and email = $2)
          or
          ($3::text is not null and phone = $3)
        )
        and created_at >= now() - interval '24 hours'
      order by created_at desc
      limit 1
    `,
    [clientId, email || null, phone || null]
  );

  return result.rows[0] || null;
}

async function insertOrUpdateLead({
  clientId,
  conversationId,
  name,
  email,
  phone,
  serviceInterest,
  message,
  pageUrl
}) {
  const existing = await findRecentLead(clientId, email, phone);

  if (existing) {
    const result = await pool.query(
      `
        update leads
        set
          name = coalesce($1, name),
          email = coalesce($2, email),
          phone = coalesce($3, phone),
          service_interest = coalesce($4, service_interest),
          message = coalesce($5, message),
          page_url = coalesce($6, page_url),
          conversation_id = coalesce($7, conversation_id)
        where id = $8
        returning *
      `,
      [
        name || null,
        email || null,
        phone || null,
        serviceInterest || null,
        message || null,
        pageUrl || null,
        conversationId || null,
        existing.id
      ]
    );

    return result.rows[0];
  }

  const inserted = await pool.query(
    `
      insert into leads (
        client_id,
        conversation_id,
        name,
        email,
        phone,
        service_interest,
        message,
        page_url,
        status
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'new')
      returning *
    `,
    [
      clientId,
      conversationId,
      name || null,
      email || null,
      phone || null,
      serviceInterest || null,
      message || null,
      pageUrl || null
    ]
  );

  return inserted.rows[0];
}

async function logMessage(conversationId, role, content) {
  if (!conversationId || !role || !content) return;

  try {
    await pool.query(
      `
        insert into messages (conversation_id, role, content)
        values ($1, $2, $3)
      `,
      [conversationId, role, content]
    );
  } catch (err) {
    console.error("Failed to log message:", err.message);
  }
}

async function sendLeadNotification(client, lead) {
  console.log("sendLeadNotification called", {
    clientId: client?.clientId,
    notificationEmail: client?.notificationEmail,
    hasResend: Boolean(resend),
    fromEmail: process.env.NOTIFY_FROM_EMAIL
  });

  if (!client.notificationEmail) {
    console.log("Skipping email: missing client.notificationEmail");
    return;
  }

  if (!resend) {
    console.log("Skipping email: resend not configured");
    return;
  }

  const fromEmail = process.env.NOTIFY_FROM_EMAIL;
  if (!fromEmail) {
    console.error("Missing NOTIFY_FROM_EMAIL");
    return;
  }

  const subject = `New website lead for ${client.clientId}`;

  const body = `
New website lead

Client: ${client.clientId}
Name: ${lead.name || "N/A"}
Email: ${lead.email || "N/A"}
Phone: ${lead.phone || "N/A"}
Service: ${lead.service_interest || lead.message || "N/A"}
Page URL: ${lead.page_url || "N/A"}
Status: ${lead.status || "new"}
Created At: ${lead.created_at || new Date().toISOString()}
`;

  try {
    const result = await resend.emails.send({
      from: fromEmail,
      to: client.notificationEmail,
      subject,
      text: body
    });

    console.log("Lead notification sent", result);
  } catch (err) {
    console.error("Failed to send lead notification:", err);
  }
}

// -------------------- routes --------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/client-config", (req, res) => {
  const clientId = req.query.clientId;
  const { client, error, status } = getClientOrThrow(clientId);
  if (error) return res.status(status).json({ error });

  const originCheck = enforceOrigin(req, client);
  if (!originCheck.ok) return res.status(403).json({ error: originCheck.reason });

  res.json({
    ui: client.ui || {}
  });
});

app.post("/chat", async (req, res) => {
  try {
    const { clientId, sessionId, message, pageUrl } = req.body;

    const { client, error, status } = getClientOrThrow(clientId);
    if (error) return res.status(status).json({ error });

    const originCheck = enforceOrigin(req, client);
    if (!originCheck.ok) return res.status(403).json({ error: originCheck.reason });

    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ error: "sessionId required" });
    }

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message required" });
    }

    const rpm = client.limits?.rpm ?? 30;
    const rateKey = `${clientId}:${sessionId}`;
    if (!rateLimit(rateKey, rpm)) {
      return res.status(429).json({ error: "Rate limit exceeded. Please try again soon." });
    }

    const cleanMessage = normalizeText(message);
    const conversation = await getOrCreateConversation(clientId, sessionId, pageUrl);

    let activeBaseConversation = conversation;

    const completedLeadIsStale =
      conversation.status === "lead_complete" &&
      conversation.updated_at &&
      Date.now() - new Date(conversation.updated_at).getTime() > 1000 * 60 * 60 * 12;

    if (completedLeadIsStale) {
      activeBaseConversation = await updateConversation(conversation.id, {
        status: "open",
        lead_intent: false,
        visitor_name: null,
        visitor_email: null,
        visitor_phone: null,
        service_interest: null
      });
    }

    await logMessage(activeBaseConversation.id, "user", cleanMessage);

    const ruleName = extractName(cleanMessage);
    const ruleEmail = extractEmail(cleanMessage);
    const rulePhone = extractPhone(cleanMessage);

    const currentMessageHasContact = Boolean(ruleEmail || rulePhone);
    const currentMessageHasName = Boolean(ruleName);

    const obviousLeadIntent = detectLeadIntent(cleanMessage);

    const ruleService =
      obviousLeadIntent || activeBaseConversation.lead_intent
        ? extractServiceInterest(cleanMessage)
        : null;

    let classifierData = null;
    const shouldClassify = obviousLeadIntent || activeBaseConversation.lead_intent;

    if (shouldClassify) {
      try {
        classifierData = await classifyLead(openai, cleanMessage);
      } catch (err) {
        console.error("Lead classifier failed:", err.message);
      }
    }

    let messageClass = null;

    const keywordBusinessMatch = detectBusinessTopic(cleanMessage);
    const obviousContactInfo = Boolean(ruleEmail || rulePhone);

    if (!keywordBusinessMatch && !obviousLeadIntent && !obviousContactInfo) {
      try {
        messageClass = await classifyMessage(openai, client, cleanMessage);
      } catch (err) {
        console.error("Message classifier failed:", err.message);
      }
    }

    const mergedName =
      ruleName || classifierData?.name || activeBaseConversation.visitor_name || null;
    const mergedEmail =
      ruleEmail || classifierData?.email || activeBaseConversation.visitor_email || null;
    const mergedPhone =
      rulePhone || classifierData?.phone || activeBaseConversation.visitor_phone || null;
    const mergedService =
      (ruleService && ruleService.length > 2 ? ruleService : null) ||
      classifierData?.notes ||
      activeBaseConversation.service_interest ||
      null;

    const currentMessageLeadIntent =
      obviousLeadIntent ||
      Boolean(classifierData?.isLead) ||
      (
        Boolean(messageClass?.isLead) &&
        ["quote", "booking", "pricing", "contact"].includes(messageClass?.intent)
      );

    const alreadyCompletedLead = activeBaseConversation.status === "lead_complete";

    const conversationStillCollecting =
      !alreadyCompletedLead &&
      activeBaseConversation.lead_intent &&
      !(activeBaseConversation.visitor_email || activeBaseConversation.visitor_phone);

    const leadIntent = Boolean(currentMessageLeadIntent || conversationStillCollecting);

    const updatedConversation = await updateConversation(activeBaseConversation.id, {
      lead_intent: leadIntent,
      visitor_name: mergedName,
      visitor_email: mergedEmail,
      visitor_phone: mergedPhone,
      service_interest: mergedService,
      last_page_url: pageUrl || activeBaseConversation.last_page_url,
      last_user_message: cleanMessage
    });

    if (leadIntent) {
      const hasAnyContact = Boolean(mergedEmail || mergedPhone);

      const isActivelyCollectingLead =
        conversationStillCollecting || currentMessageLeadIntent;

      if (!hasAnyContact) {
        const reply =
          classifierData?.followupQuestion ||
          messageClass?.suggestedFollowup ||
          "Sure — what’s the best phone number or email for follow-up?";

        await logMessage(updatedConversation.id, "assistant", reply);

        return res.json({
          reply,
          state: {
            mode: "collecting_lead",
            missingFields: ["contact"]
          }
        });
      }

      const shouldCompleteLead =
        isActivelyCollectingLead &&
        (currentMessageHasContact || conversationStillCollecting);

      if (shouldCompleteLead) {
        const lead = await insertOrUpdateLead({
          clientId,
          conversationId: updatedConversation.id,
          name: mergedName,
          email: mergedEmail,
          phone: mergedPhone,
          serviceInterest: mergedService,
          message: mergedService || cleanMessage,
          pageUrl
        });

        await sendLeadNotification(client, lead);

        await updateConversation(updatedConversation.id, {
          status: "lead_complete",
          lead_intent: false
        });

        const reply = mergedName
          ? `Thanks ${mergedName} — someone from our team will contact you shortly.`
          : "Thanks — someone from our team will contact you shortly.";

        await logMessage(updatedConversation.id, "assistant", reply);

        return res.json({
          reply,
          state: {
            mode: "lead_complete",
            leadId: lead.id
          }
        });
      }

      if (isActivelyCollectingLead && !currentMessageHasContact) {
        const reply = currentMessageHasName
          ? `Thanks ${mergedName} — what’s the best phone number or email for follow-up?`
          : "Sure — what’s the best phone number or email for follow-up?";

        await logMessage(updatedConversation.id, "assistant", reply);

        return res.json({
          reply,
          state: {
            mode: "collecting_lead",
            missingFields: ["contact"]
          }
        });
      }
    }

    const topicLooksBusinessRelated =
      keywordBusinessMatch ||
      obviousLeadIntent ||
      obviousContactInfo ||
      currentMessageHasName ||
      Boolean(messageClass?.isBusinessRelevant);

    let activeConversation = updatedConversation;

    if (
      activeConversation.status === "lead_complete" &&
      !currentMessageLeadIntent &&
      topicLooksBusinessRelated
    ) {
      activeConversation = await updateConversation(activeConversation.id, {
        lead_intent: false,
        status: "open"
      });
    }

    if (!topicLooksBusinessRelated) {
      const reply = buildOffTopicReply();
      await logMessage(activeConversation.id, "assistant", reply);

      return res.json({
        reply,
        state: {
          mode: "off_topic"
        }
      });
    }

    const systemPrompt = buildSystemPrompt(client, activeConversation);

    const response = await openai.responses.create({
      model: client.model || "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: cleanMessage }
      ]
    });

    const reply = response.output_text || "Sorry — I couldn’t generate a response.";
    await logMessage(activeConversation.id, "assistant", reply);

    return res.json({
      reply,
      state: {
        mode: "business_info"
      }
    });
  } catch (err) {
    console.error("Chat route failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});