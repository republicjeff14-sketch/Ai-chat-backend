(() => {
  const scriptEl = document.currentScript || [...document.scripts].slice(-1)[0];
  const clientId = scriptEl?.getAttribute("data-client-id") || "demo";
  const dataIcon = scriptEl?.getAttribute("data-icon") || null;
  const dataStyle = scriptEl?.getAttribute("data-style") || null;

  const scriptSrc = scriptEl?.src || "";
  const API_BASE = scriptSrc ? new URL(scriptSrc).origin : "http://127.0.0.1:3001";
  const CHAT_URL = `${API_BASE}/chat`;
  const CONFIG_URL = `${API_BASE}/client-config?clientId=${encodeURIComponent(clientId)}`;

  const STORAGE_KEY = `aiw_session_${clientId}`;
  const HIDDEN_KEY = `aiw_hidden_${clientId}`;

  // Icon options — business sets via data-icon attribute or ui.icon from DB
  const ICONS = {
    chat:     "💬",
    support:  "🎧",
    robot:    "🤖",
    sparkle:  "✨",
    wave:     "👋",
    phone:    "📞",
  };

  function getSessionId() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const maxAgeMs = 1000 * 60 * 60 * 12;
        const isFresh = parsed?.id && parsed?.createdAt && (Date.now() - parsed.createdAt < maxAgeMs);
        if (isFresh) return parsed.id;
      } catch {}
    }
    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, createdAt: Date.now() }));
    return id;
  }

  // Hidden state — persists until midnight
  function isHidden() {
    try {
      const raw = localStorage.getItem(HIDDEN_KEY);
      if (!raw) return false;
      const { until } = JSON.parse(raw);
      if (Date.now() < until) return true;
      localStorage.removeItem(HIDDEN_KEY);
      return false;
    } catch { return false; }
  }

  function setHidden() {
    // Hide until midnight tonight
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ until: midnight }));
  }

  const sessionId = getSessionId();

  let ui = {
    title: "Chat",
    subtitle: "Automated assistant",
    greeting: "Hi! How can I help?",
    accent: "#111111",
    accentText: "#ffffff",
    icon: dataIcon || "chat",
    bubbleStyle: dataStyle || "round"
  };

  const style = document.createElement("style");
  style.textContent = `
#aiw-root, #aiw-root * {
  box-sizing: border-box !important;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif !important;
  line-height: 1.25 !important;
}
#aiw-btn-wrap {
  position: fixed; right: 18px; bottom: 18px;
  display: flex; flex-direction: column; align-items: center;
  gap: 6px; z-index: 999999;
}
#aiw-btn {
  width: 56px; height: 56px; border-radius: 50%;
  border: none; cursor: pointer; font-size: 22px;
  box-shadow: 0 10px 24px rgba(0,0,0,.22);
  background: var(--aiw-accent); color: var(--aiw-accentText);
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.15s;
}
#aiw-btn:hover { transform: scale(1.08); }
/* Bubble style variants */
#aiw-btn.style-round { border-radius: 50%; }
#aiw-btn.style-rounded-square { border-radius: 16px; }
#aiw-btn.style-flat {
  border-radius: 50%;
  box-shadow: none;
  border: 2px solid var(--aiw-accent);
  background: transparent;
  color: var(--aiw-accent);
  font-size: 20px;
}
#aiw-btn.style-flat:hover { background: var(--aiw-accent); color: var(--aiw-accentText); transform: none; }
#aiw-btn.style-pill {
  width: auto; border-radius: 999px;
  padding: 0 18px; height: 44px;
  font-size: 14px; font-weight: 700;
  gap: 6px; letter-spacing: 0.01em;
  box-shadow: 0 4px 14px rgba(0,0,0,.18);
}
#aiw-btn.style-pill .aiw-btn-label { display: inline; }
#aiw-btn:not(.style-pill) .aiw-btn-label { display: none; }
#aiw-dismiss {
  background: rgba(0,0,0,0.55); color: #fff;
  border: none; cursor: pointer;
  border-radius: 20px; padding: 3px 10px;
  font-size: 11px; font-weight: 600;
  opacity: 0.85; white-space: nowrap;
  transition: opacity 0.15s;
}
#aiw-dismiss:hover { opacity: 1; }
#aiw-panel {
  position: fixed; right: 18px; bottom: 90px;
  width: 340px; max-width: calc(100vw - 24px);
  height: 480px; max-height: calc(100vh - 120px);
  background: #fff; border-radius: 16px;
  box-shadow: 0 18px 50px rgba(0,0,0,.25);
  overflow: hidden; display: none; z-index: 999999;
  border: 1px solid rgba(0,0,0,.08);
}
#aiw-wrap { display: flex; flex-direction: column; height: 100%; }
#aiw-head {
  flex: 0 0 auto; min-height: 52px; padding: 12px;
  background: linear-gradient(135deg, var(--aiw-accent) 0%, #2a2a2a 100%);
  color: var(--aiw-accentText);
  display: flex; align-items: center; justify-content: space-between;
}
#aiw-title { font-weight: 700; font-size: 14px; }
#aiw-sub { font-size: 12px; opacity: .85; margin-top: 2px; }
#aiw-head-left { display: flex; flex-direction: column; }
#aiw-close {
  border: none; background: rgba(255,255,255,.12);
  color: var(--aiw-accentText);
  width: 32px; height: 32px;
  border-radius: 10px; cursor: pointer; font-size: 18px;
  display: flex; align-items: center; justify-content: center;
}
#aiw-body { flex: 1 1 auto; padding: 12px; overflow: auto; background: #fafafa; }
.aiw-row { display: flex; margin: 10px 0; }
.aiw-row.me { justify-content: flex-end; }
.aiw-row.bot { justify-content: flex-start; }
.aiw-bubble {
  max-width: 82%; padding: 10px 12px; border-radius: 14px; font-size: 14px;
  box-shadow: 0 6px 16px rgba(0,0,0,.06);
  word-wrap: break-word; white-space: pre-wrap;
}
.aiw-row.me .aiw-bubble {
  background: var(--aiw-accent); color: var(--aiw-accentText);
  border-bottom-right-radius: 6px;
}
.aiw-row.bot .aiw-bubble {
  background: #fff; color: #111;
  border: 1px solid rgba(0,0,0,.08);
  border-bottom-left-radius: 6px;
}
#aiw-note {
  flex: 0 0 auto; padding: 8px 12px; font-size: 12px; color: #666;
  background: #fff; border-top: 1px solid rgba(0,0,0,.06);
}
#aiw-form {
  flex: 0 0 auto; display: flex; gap: 8px;
  padding: 10px 12px; background: #fff; border-top: 1px solid rgba(0,0,0,.06);
}
#aiw-input {
  flex: 1; padding: 10px 12px;
  border: 1px solid rgba(0,0,0,.14); border-radius: 12px;
  font-size: 16px; outline: none; background: #fff;
}
#aiw-send {
  padding: 10px 14px; border: none; border-radius: 12px;
  cursor: pointer; font-weight: 700;
  background: var(--aiw-accent); color: var(--aiw-accentText);
}

@media (max-width: 640px) {
  #aiw-btn-wrap { right: 14px; bottom: 14px; }
  #aiw-panel {
    right: 12px; left: 12px; bottom: 90px;
    width: auto; max-width: none;
    height: 70vh; max-height: 70vh;
    border-radius: 14px;
  }
  #aiw-body { padding: 10px; }
  .aiw-bubble { max-width: 88%; font-size: 14px; }
  #aiw-form { padding: 10px; }
}
`;
  document.head.appendChild(style);

  // Button wrap (holds bubble + dismiss link)
  const btnWrap = document.createElement("div");
  btnWrap.id = "aiw-btn-wrap";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "aiw-btn";
  btn.classList.add("style-" + (dataStyle || "round"));
  btn.textContent = ICONS[ui.icon] || ICONS.chat;

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.id = "aiw-dismiss";
  dismiss.textContent = "✕ Hide";

  btnWrap.appendChild(btn);
  btnWrap.appendChild(dismiss);

  const panel = document.createElement("div");
  panel.id = "aiw-panel";
  panel.innerHTML = `
    <div id="aiw-wrap">
      <div id="aiw-head">
        <div id="aiw-head-left">
          <div id="aiw-title">Chat</div>
          <div id="aiw-sub">Automated assistant</div>
        </div>
        <button id="aiw-close" type="button">×</button>
      </div>
      <div id="aiw-body"></div>
      <div id="aiw-note">Ask about services, pricing, appointments, or contact.</div>
      <form id="aiw-form">
        <input id="aiw-input" placeholder="Type a message..." autocomplete="off" />
        <button id="aiw-send" type="submit">Send</button>
      </form>
    </div>
  `;

  const root = document.createElement("div");
  root.id = "aiw-root";
  root.style.setProperty("--aiw-accent", ui.accent);
  root.style.setProperty("--aiw-accentText", ui.accentText);

  root.appendChild(btnWrap);
  root.appendChild(panel);
  document.body.appendChild(root);

  // Hide if dismissed earlier today
  if (isHidden()) {
    btnWrap.style.display = "none";
    panel.style.display = "none";
  }

  const body = panel.querySelector("#aiw-body");
  const input = panel.querySelector("#aiw-input");
  const titleEl = panel.querySelector("#aiw-title");
  const subEl = panel.querySelector("#aiw-sub");

  const addMsg = (role, text) => {
    const row = document.createElement("div");
    row.className = `aiw-row ${role === "me" ? "me" : "bot"}`;
    const bubble = document.createElement("div");
    bubble.className = "aiw-bubble";
    bubble.textContent = text;
    row.appendChild(bubble);
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
    return bubble;
  };

  async function loadConfig() {
    try {
      const res = await fetch(CONFIG_URL, { method: "GET" });
      const data = await res.json();
      if (!res.ok) return;

      ui = { ...ui, ...(data.ui || {}) };

      // data-icon attribute takes priority over DB setting
      const iconKey = dataIcon || ui.icon || "chat";
      const styleKey = dataStyle || ui.bubbleStyle || "round";

      // Apply bubble style class
      btn.className = "";
      btn.classList.add("style-" + styleKey);

      // Pill style shows text label
      if (styleKey === "pill") {
        btn.innerHTML = `<span>${ICONS[iconKey] || ICONS.chat}</span><span class="aiw-btn-label">Chat with us</span>`;
      } else {
        btn.textContent = ICONS[iconKey] || ICONS.chat;
      }

      titleEl.textContent = ui.title || "Chat";
      subEl.textContent = ui.subtitle || "Automated assistant";

      root.style.setProperty("--aiw-accent", ui.accent || "#111111");
      root.style.setProperty("--aiw-accentText", ui.accentText || "#ffffff");
    } catch {}
  }

  loadConfig();

  // Open/close panel
  btn.addEventListener("click", () => {
    const isOpen = panel.style.display === "block";
    panel.style.display = isOpen ? "none" : "block";

    if (!isOpen && body.childElementCount === 0) {
      addMsg("bot", ui.greeting || "Hi! How can I help?");
    }

    if (!isOpen) input.focus();
  });

  // Close X inside panel
  panel.querySelector("#aiw-close").addEventListener("click", () => {
    panel.style.display = "none";
  });

  // Dismiss button — hides until midnight
  dismiss.addEventListener("click", () => {
    panel.style.display = "none";
    btnWrap.style.display = "none";
    setHidden();
  });

  // Send message
  panel.querySelector("#aiw-form").addEventListener("submit", async (e) => {
    e.preventDefault();

    const msg = input.value.trim();
    if (!msg) return;

    addMsg("me", msg);
    input.value = "";

    const typingBubble = addMsg("bot", "Typing…");

    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          sessionId,
          message: msg,
          pageUrl: location.href
        })
      });

      const data = await res.json();

      if (!res.ok) {
        typingBubble.textContent = data?.error || "Request blocked.";
        return;
      }

      typingBubble.textContent = data.reply || "Sorry — no reply.";
    } catch {
      typingBubble.textContent = "Error connecting to server.";
    }
  });
})();
