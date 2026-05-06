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
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// -------------------- client config --------------------
async function getClientById(clientId) {
  if (!clientId) return null;

  const result = await pool.query(
    `select * from clients where client_id = $1 limit 1`,
    [clientId]
  );

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
    leadSettings: row.lead_settings || {}
  };
}

async function getClientOrThrow(clientId) {
  if (!clientId) return { error: "clientId required", status: 400 };
  const client = await getClientById(clientId);
  if (!client) return { error: "Unknown client", status: 404 };
  if (!client.enabled) return { error: "Client disabled", status: 403 };
  return { client };
}

// -------------------- middleware --------------------
app.use(cors({ origin: (origin, cb) => cb(null, true) }));

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

function detectLeadCancellation(text) {
  return /\b(no|not|don't|dont|just|only|question|ask|asking|curious|not interested|no quote|no thanks)\b/i.test(text);
}

// IMPROVED: catches way more casual lead intent phrases
function detectLeadIntent(text) {
  const t = normalizeText(text).toLowerCase();
  return /\b(quote|estimate|price|cost|how much|book|schedule|appointment|call me|contact me|get a quote|reach out|follow up|follow-up|get back to me|send someone|come out|come by|check it out|take a look|free estimate|free quote|need help|looking for|interested in|want to know|can you help|can u help|what do you charge|what does it cost|what.?s the price|do you guys|do yall|yall do|you do|can you do)\b/i.test(t);
}

// IMPROVED: much broader name extraction with more patterns
function extractName(text) {
  const stopWords = new Set([
    'my', 'the', 'a', 'hi', 'hey', 'i', 'yes', 'no', 'ok', 'sure',
    'car', 'roof', 'detail', 'and', 'or', 'it', 'is', 'am', 'be',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'up', 'out', 'if', 'about', 'who', 'which', 'what', 'when', 'where',
    'just', 'so', 'but', 'can', 'all', 'one', 'there', 'do', 'we',
    'he', 'she', 'they', 'you', 'it', 'this', 'that', 'these', 'those',
    'thanks', 'thank', 'please', 'yeah', 'yep', 'nope', 'hello', 'good',
    'great', 'nice', 'okay', 'alright', 'service', 'repair', 'fix', 'need',
    'want', 'looking', 'help', 'quote', 'price', 'cost', 'book', 'schedule'
  ]);

  const patterns = [
    // "my name is X" / "i am X" / "i'm X" / "im X" / "this is X" / "it's X" / "its X"
    /(?:my name is|i am|i'm|im|this is|it's|its|name[:\s]+)\s+([A-Za-z]{2,20})/i,
    // "call me X" / "call me back, X here"
    /call me\s+([A-Za-z]{2,20})/i,
    // "X here" at start of message
    /^([A-Za-z]{2,20})\s+here\b/i,
    // "X speaking"
    /^([A-Za-z]{2,20})\s+speaking\b/i,
    // "name is X"
    /name\s+is\s+([A-Za-z]{2,20})/i,
    // "I go by X"
    /i go by\s+([A-Za-z]{2,20})/i,
    // "X and my phone/number/email is..."
    /^([A-Za-z]{2,20})\s+(?:and\s+)?(?:my\s+)?(?:phone|number|cell|email|contact)/i,
    // "X, phone/number/email..."
    /^([A-Za-z]{2,20}),\s*(?:phone|number|cell|email|\d|\()/i,
    // "hey it's X" / "hey this is X"
    /(?:hey|hi|hello)[,\s]+(?:it'?s|this is|i'm|im)\s+([A-Za-z]{2,20})/i,
    // Standalone single capitalized word at start that looks like a name
    /^([A-Z][a-z]{1,19})[\s,!.]+(?:here|speaking|calling|and|my|i)/i,
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      const candidate = m[1].trim();
      if (!stopWords.has(candidate.toLowerCase()) && candidate.length >= 2) {
        return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
      }
    }
  }

  return null;
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

// IMPROVED: uses AI to extract just the service, not the whole message
async function extractServiceInterest(text, businessContext) {
  const cleaned = normalizeText(text);
  if (!cleaned) return null;

  // Quick keyword check first to avoid unnecessary AI calls
  const hasServiceKeyword = /\b(repair|fix|install|clean|replace|inspect|service|quote|estimate|help with|need|want|looking for|interested in)\b/i.test(cleaned);

  if (!hasServiceKeyword && cleaned.length < 15) return null;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You extract the specific service a customer is asking about from a message.
Business context: ${businessContext || "general service business"}

Rules:
- Return ONLY the service name/description, nothing else
- Keep it short (2-8 words max)
- If no specific service is mentioned, return null
- Do NOT return contact info, names, or unrelated text
- Examples: "roof repair", "full detailing", "AC installation", "lawn mowing", "emergency leak repair"

Reply with just the service string or the word null.`
        },
        { role: "user", content: cleaned }
      ],
      max_tokens: 20,
      temperature: 0
    });

    const result = response.choices[0].message.content.trim();
    if (!result || result.toLowerCase() === "null" || result.length < 2) return null;
    return result;
  } catch {
    // Fallback: return first 80 chars if AI fails
    return cleaned.length <= 80 ? cleaned : cleaned.slice(0, 80);
  }
}

// IMPROVED: AI-powered name extraction fallback
async function extractNameWithAI(text) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Extract a person's first name from this message if one is present.
Rules:
- Return ONLY the name with proper capitalization, nothing else
- Only return actual human names, not business names or service words
- If no name is present, return null
- Examples of names: "John", "Sarah", "Mike", "Jennifer"
- Examples of NOT names: "roof", "repair", "yes", "hello", "quote"

Reply with just the name or the word null.`
        },
        { role: "user", content: text }
      ],
      max_tokens: 10,
      temperature: 0
    });

    const result = response.choices[0].message.content.trim();
    if (!result || result.toLowerCase() === "null" || result.length < 2) return null;
    // Make sure it looks like a name (only letters)
    if (!/^[A-Za-z]{2,25}$/.test(result)) return null;
    return result.charAt(0).toUpperCase() + result.slice(1).toLowerCase();
  } catch {
    return null;
  }
}

function getMissingLeadFields({ name, email, phone, serviceInterest }, client, conversation) {
  const missing = [];
  const requiresName = Boolean(client?.leadSettings?.requireName);
  const requiresLocation = Boolean(client?.leadSettings?.requireLocation);

  if (!email && !phone) missing.push("contact");

  const hasService = serviceInterest || conversation?.service_interest;
  if (!hasService) missing.push("service");

  if (requiresName && !name) missing.push("name");
  if (requiresLocation) missing.push("location");

  return missing;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

// IMPROVED: better lead classifier prompt
async function classifyLead(openaiClient, message) {
  const prompt = `You are a lead-capture classifier for a business website chat widget.

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
- isLead = true if the user wants pricing, a quote, booking, contact, follow-up, or shows buying intent
- Also mark isLead = true for casual phrasing like "how much does X cost", "can yall do X", "I need X done"
- Extract name if present — look for introductions, signatures, or self-references
- Keep followupQuestion short and natural
- notes should be the service they want, not their full message`;

  const result = await openaiClient.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: prompt },
      { role: "user", content: message }
    ]
  });

  return safeJsonParse(result.output_text);
}

// IMPROVED: better message classifier
async function classifyMessage(openaiClient, client, message) {
  const prompt = `You are a classifier for a business website assistant.

Business context:
${client.promptClient || ""}

Return ONLY valid JSON:
{
  "isBusinessRelevant": boolean,
  "isLead": boolean,
  "intent": "quote" | "booking" | "pricing" | "service_question" | "contact" | "off_topic" | "other",
  "confidence": number,
  "suggestedFollowup": string | null
}

Rules:
- isBusinessRelevant = true if the message relates to this business's services, pricing, quotes, scheduling, hours, location, or availability
- Treat typos, slang, abbreviations, and casual wording as valid ("yall", "u", "ur", "gonna", etc)
- isLead = true for: quote requests, pricing questions, booking intent, contact requests, or anyone who seems ready to hire
- service_question = just asking if they offer something, NOT ready to hire yet
- confidence is 0 to 1
- Return JSON only`;

  const result = await openaiClient.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: prompt },
      { role: "user", content: message }
    ]
  });

  return safeJsonParse(result.output_text);
}

// IMPROVED: includes recent conversation history so AI has context
async function getRecentMessages(conversationId, limit = 6) {
  if (!conversationId) return [];
  try {
    const result = await pool.query(
      `select role, content from messages
       where conversation_id = $1
       order by created_at desc
       limit $2`,
      [conversationId, limit]
    );
    return result.rows.reverse();
  } catch {
    return [];
  }
}

function buildSystemPrompt(client, conversation) {
  return `You are a website lead capture assistant for a business.

Your job is to help visitors with:
- services, pricing, quotes, appointments, business hours, location, contact requests

Rules:
- Do NOT act like a general AI chatbot
- Do NOT answer unrelated questions
- Do NOT provide jokes, trivia, or entertainment
- Do NOT warn users not to share contact info when they are requesting service
- Keep replies short, clear, and natural — like a helpful real person, not a robot
- Use the exact business info provided — never invent pricing, policies, or services
- If asked something not in the business context, say "I don't have that info but someone from the team can help — can I get your contact details?"
- For quote/booking requests, collect: 1) what service they need, 2) their phone or email
- Do not ask for both phone AND email — either one is fine
- Do not ask for location unless the business context explicitly requires it
- Keep follow-up questions to one at a time
- If the visitor gives their name, use it naturally in responses

Business context:
${client.promptClient || "No business info provided."}

Current conversation state:
- Has lead intent: ${conversation?.lead_intent ? "yes" : "no"}
- Visitor name: ${conversation?.visitor_name || "unknown"}
- Visitor email: ${conversation?.visitor_email || "unknown"}
- Visitor phone: ${conversation?.visitor_phone || "unknown"}
- Service interest: ${conversation?.service_interest || "unknown"}`;
}

function buildOffTopicReply() {
  return "I can help with this business's services, pricing, appointments, and contact requests. What would you like help with?";
}

// -------------------- db helpers --------------------
async function getOrCreateConversation(clientId, sessionId, pageUrl) {
  const existing = await pool.query(
    `select * from conversations where client_id = $1 and session_id = $2 limit 1`,
    [clientId, sessionId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await pool.query(
    `insert into conversations (client_id, session_id, last_page_url)
     values ($1, $2, $3) returning *`,
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

// -------------------- routes --------------------
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

    const cleanMessage = normalizeText(message);
    const conversation = await getOrCreateConversation(clientId, sessionId, pageUrl);

    // Reset lead intent if visitor is cancelling
    if (detectLeadCancellation(cleanMessage) && conversation.lead_intent) {
      await updateConversation(conversation.id, { lead_intent: false, status: "open" });
    }

    let activeBaseConversation = conversation;

    // Reset stale completed lead after 12 hours
    const completedLeadIsStale =
      conversation.status === "lead_complete" &&
      conversation.updated_at &&
      Date.now() - new Date(conversation.updated_at).getTime() > 1000 * 60 * 60 * 12;

    if (completedLeadIsStale) {
      activeBaseConversation = await updateConversation(conversation.id, {
        status: "open", lead_intent: false,
        visitor_name: null, visitor_email: null, visitor_phone: null, service_interest: null
      });
    }

    await logMessage(activeBaseConversation.id, "user", cleanMessage);

    // ── Extract info from current message ──────────────────────
    const ruleEmail = extractEmail(cleanMessage);
    const rulePhone = extractPhone(cleanMessage);

    // Try regex name first, fall back to AI
    let ruleName = extractName(cleanMessage);
    if (!ruleName && cleanMessage.length > 2) {
      ruleName = await extractNameWithAI(cleanMessage);
    }

    const obviousLeadIntent = detectLeadIntent(cleanMessage);
    const obviousContactInfo = Boolean(ruleEmail || rulePhone || ruleName);
    const currentMessageHasName = Boolean(ruleName);

    // Extract service using AI — skip if message is purely contact info
    // e.g. "my name is Ben, email is x@x.com" should not overwrite existing service_interest
    const wordCount = cleanMessage.replace(/[^a-zA-Z ]/g, " ").trim().split(/\s+/).length;
    const isJustContactInfo = Boolean(ruleEmail || rulePhone) && wordCount < 8 && !obviousLeadIntent;

    const shouldExtractService =
      !isJustContactInfo &&
      (obviousLeadIntent || activeBaseConversation.lead_intent || Boolean(ruleName));

    const ruleService = shouldExtractService
      ? await extractServiceInterest(cleanMessage, client.promptClient)
      : null;

      (obviousLeadIntent || activeBaseConversation.lead_intent || Boolean(ruleName));

    const ruleService = shouldExtractService
      ? await extractServiceInterest(cleanMessage, client.promptClient)
      : null;

    // ── AI classification ───────────────────────────────────────
    let classifierData = null;
    if (obviousLeadIntent || activeBaseConversation.lead_intent) {
      try {
        classifierData = await classifyLead(openai, cleanMessage);
      } catch (err) {
        console.error("Lead classifier failed:", err.message);
      }
    }

    // Only run message classifier if not already detected as lead/contact
    let messageClass = null;
    const keywordBusinessMatch = await detectBusinessTopic(cleanMessage, client.promptClient);

    if (!keywordBusinessMatch && !obviousLeadIntent && !obviousContactInfo) {
      try {
        messageClass = await classifyMessage(openai, client, cleanMessage);
      } catch (err) {
        console.error("Message classifier failed:", err.message);
      }
    }

    // After lead is complete, don't re-trigger lead flow from contact info alone
    // Only use obviousContactInfo as a lead signal when we're actively collecting
    const isLeadComplete = activeBaseConversation.status === "lead_complete";
    const currentMessageLeadIntent =
      obviousLeadIntent ||
      (!isLeadComplete && obviousContactInfo) ||
      (Boolean(classifierData?.isLead) && detectLeadIntent(cleanMessage)) ||
      (Boolean(messageClass?.isLead) && ["quote", "booking", "pricing", "contact"].includes(messageClass?.intent));

    // ── Merge all data sources ──────────────────────────────────
    const mergedName = ruleName || classifierData?.name || activeBaseConversation.visitor_name || null;
    const mergedEmail = ruleEmail || classifierData?.email || activeBaseConversation.visitor_email || null;
    const mergedPhone = rulePhone || classifierData?.phone || activeBaseConversation.visitor_phone || null;
    const mergedService =
      (ruleService && ruleService.length > 2 ? ruleService : null) ||
      classifierData?.notes ||
      activeBaseConversation.service_interest ||
      null;

    const alreadyCompletedLead = activeBaseConversation.status === "lead_complete";
    const conversationStillCollecting =
      !alreadyCompletedLead &&
      activeBaseConversation.lead_intent &&
      !(mergedEmail || mergedPhone);

    const leadIntent =
      !alreadyCompletedLead &&
      (currentMessageLeadIntent || conversationStillCollecting);

    const updatedConversation = await updateConversation(activeBaseConversation.id, {
      lead_intent: leadIntent,
      visitor_name: mergedName,
      visitor_email: mergedEmail,
      visitor_phone: mergedPhone,
      service_interest: mergedService,
      last_page_url: pageUrl || activeBaseConversation.last_page_url,
      last_user_message: cleanMessage
    });

    // ── Lead completion logic ───────────────────────────────────
    if (leadIntent) {
      const missingFields = getMissingLeadFields(
        { name: mergedName, email: mergedEmail, phone: mergedPhone, serviceInterest: mergedService },
        client,
        updatedConversation
      );

      const isActivelyCollecting = conversationStillCollecting || currentMessageLeadIntent;

      if (isActivelyCollecting && !missingFields.length) {
        const lead = await insertOrUpdateLead({
          clientId, conversationId: updatedConversation.id,
          name: mergedName, email: mergedEmail, phone: mergedPhone,
          serviceInterest: mergedService, message: mergedService || cleanMessage, pageUrl
        });

        await sendLeadNotification(client, lead);
        await updateConversation(updatedConversation.id, { status: "lead_complete", lead_intent: false });

        const reply = mergedName
          ? `Thanks ${mergedName} — someone from our team will be in touch shortly!`
          : "Thanks — someone from our team will be in touch shortly!";

        await logMessage(updatedConversation.id, "assistant", reply);
        return res.json({ reply, state: { mode: "lead_complete", leadId: lead.id } });
      }

      if (missingFields.includes("contact")) {
        const reply = currentMessageHasName
          ? `Thanks ${mergedName} — what's the best phone number or email to reach you?`
          : "Sure — what's the best phone number or email to reach you?";
        await logMessage(updatedConversation.id, "assistant", reply);
        return res.json({ reply, state: { mode: "collecting_lead", missingFields } });
      }

      if (missingFields.includes("service")) {
        const reply = "What service are you looking for?";
        await logMessage(updatedConversation.id, "assistant", reply);
        return res.json({ reply, state: { mode: "collecting_lead", missingFields } });
      }
    }

    // ── General business response with conversation history ─────
    const topicLooksBusinessRelated =
      keywordBusinessMatch ||
      obviousLeadIntent ||
      obviousContactInfo ||
      currentMessageHasName ||
      Boolean(messageClass?.isBusinessRelevant);

    let activeConversation = updatedConversation;

    if (activeConversation.status === "lead_complete" && !currentMessageLeadIntent && topicLooksBusinessRelated) {
      activeConversation = await updateConversation(activeConversation.id, { lead_intent: false, status: "open" });
    }

    // Greetings should get a natural AI response, not the off-topic block
    const isGreeting = /^(hi|hello|hey|howdy|sup|what's up|whats up|yo|good morning|good afternoon|good evening|hiya|helo|helo there)[\s!?.]*$/i.test(cleanMessage.trim());

    if (!topicLooksBusinessRelated && !isGreeting) {
      const reply = buildOffTopicReply();
      await logMessage(activeConversation.id, "assistant", reply);
      return res.json({ reply, state: { mode: "off_topic" } });
    }

    const systemPrompt = buildSystemPrompt(client, activeConversation);

    // Get recent messages for context
    const recentMessages = await getRecentMessages(activeConversation.id, 8);
    const inputMessages = [
      { role: "system", content: systemPrompt },
      ...recentMessages.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
      { role: "user", content: cleanMessage }
    ];

    const response = await openai.responses.create({
      model: client.model || "gpt-4.1-mini",
      input: inputMessages
    });

    const reply = response.output_text || "Sorry — I couldn't generate a response.";
    await logMessage(activeConversation.id, "assistant", reply);

    return res.json({ reply, state: { mode: "business_info" } });

  } catch (err) {
    console.error("Chat route failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// IMPROVED: better business topic detection using business context
async function detectBusinessTopic(message, businessContext) {
  const text = message.toLowerCase();

  const keywords = [
    "service", "repair", "clean", "detail", "install", "fix",
    "i want", "i need", "looking", "price", "cost", "quote",
    "how much", "book", "appointment", "schedule", "do you", "do yall",
    "can you", "can u", "yall do", "you do", "hours", "open", "available",
    "help", "interested", "estimate", "hire", "call", "contact"
  ];

  if (keywords.some(k => text.includes(k))) return true;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Business context: ${businessContext || "general service business"}\n\nDoes this message relate to this business's services, pricing, availability, or contact? Reply ONLY 'yes' or 'no'.`
        },
        { role: "user", content: message }
      ],
      max_tokens: 5,
      temperature: 0
    });
    return response.choices[0].message.content.toLowerCase().includes("yes");
  } catch {
    return false;
  }
}

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Server listening on port ${port}`));
