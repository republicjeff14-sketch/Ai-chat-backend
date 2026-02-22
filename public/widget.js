(() => {
  const scriptEl = document.currentScript || [...document.scripts].slice(-1)[0];
  const clientId = scriptEl?.getAttribute("data-client-id") || "demo";

  const scriptSrc = scriptEl?.src || "";
  const API_BASE = scriptSrc ? new URL(scriptSrc).origin : "http://127.0.0.1:3001";
  const CHAT_URL = `${API_BASE}/chat`;
  const CONFIG_URL = `${API_BASE}/client-config?clientId=${encodeURIComponent(clientId)}`;

  // Defaults (in case config fetch fails)
  let ui = {
    title: "Chat",
    subtitle: "Automated assistant",
    greeting: "Hi! How can I help?",
    accent: "#111111",
    accentText: "#ffffff",
  };

  // --- styles ---
  const style = document.createElement("style");
  style.textContent = `
  #aiw-root, #aiw-root * {
    box-sizing: border-box !important;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif !important;
    line-height: 1.25 !important;
  }
  #aiw-btn{
    position:fixed; right:18px; bottom:18px;
    width:56px; height:56px; border-radius:50%;
    border:none; cursor:pointer; font-size:22px;
    box-shadow:0 10px 24px rgba(0,0,0,.22);
    z-index:999999; background: var(--aiw-accent); color: var(--aiw-accentText);
  }
  #aiw-panel{
    position:fixed; right:18px; bottom:84px;
    width:340px; max-width: calc(100vw - 36px);
    height:480px; max-height: calc(100vh - 120px);
    background:#fff; border-radius:16px;
    box-shadow:0 18px 50px rgba(0,0,0,.25);
    overflow:hidden; display:none; z-index:999999;
    border:1px solid rgba(0,0,0,.08);
  }
  #aiw-wrap{display:flex; flex-direction:column; height:100%;}
  #aiw-head{
    flex:0 0 auto; min-height:52px; padding:12px 12px;
    background: linear-gradient(135deg, var(--aiw-accent) 0%, #2a2a2a 100%);
    color: var(--aiw-accentText);
    display:flex; align-items:center; justify-content:space-between;
  }
  #aiw-title{font-weight:700; font-size:14px; letter-spacing:.2px;}
  #aiw-sub{font-size:12px; opacity:.85; margin-top:2px;}
  #aiw-head-left{display:flex; flex-direction:column;}
  #aiw-close{
    border:none; background:rgba(255,255,255,.12);
    color: var(--aiw-accentText);
    width:32px; height:32px;
    border-radius:10px; cursor:pointer; font-size:18px;
  }
  #aiw-body{flex:1 1 auto; padding:12px; overflow:auto; background:#fafafa;}
  .aiw-row{display:flex; margin:10px 0;}
  .aiw-row.me{justify-content:flex-end;}
  .aiw-row.bot{justify-content:flex-start;}
  .aiw-bubble{
    max-width:82%; padding:10px 12px; border-radius:14px; font-size:14px;
    box-shadow:0 6px 16px rgba(0,0,0,.06);
    word-wrap:break-word; white-space:pre-wrap;
  }
  .aiw-row.me .aiw-bubble{
    background: var(--aiw-accent); color: var(--aiw-accentText);
    border-bottom-right-radius:6px;
  }
  .aiw-row.bot .aiw-bubble{
    background:#fff; color:#111;
    border:1px solid rgba(0,0,0,.08);
    border-bottom-left-radius:6px;
  }
  #aiw-note{
    flex:0 0 auto; padding:8px 12px; font-size:12px; color:#666;
    background:#fff; border-top:1px solid rgba(0,0,0,.06);
  }
  #aiw-form{
    flex:0 0 auto; display:flex; gap:8px;
    padding:10px 12px; background:#fff; border-top:1px solid rgba(0,0,0,.06);
  }
  #aiw-input{
    flex:1; padding:10px 12px;
    border:1px solid rgba(0,0,0,.14); border-radius:12px;
    font-size:14px; outline:none; background:#fff;
  }
  #aiw-send{
    padding:10px 14px; border:none; border-radius:12px;
    cursor:pointer; font-weight:700;
    background: var(--aiw-accent); color: var(--aiw-accentText);
  }
  #aiw-send:active{transform:translateY(1px);}
`;
  document.head.appendChild(style);

  // --- UI ---
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "aiw-btn";
  btn.textContent = "💬";

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
    <div id="aiw-note">Don’t share sensitive information.</div>
    <form id="aiw-form">
      <input id="aiw-input" placeholder="Type a message..." autocomplete="off" />
      <button id="aiw-send" type="submit">Send</button>
    </form>
  </div>
  `;

  const root = document.createElement("div");
  root.id = "aiw-root";
  // Theme vars live on root
  root.style.setProperty("--aiw-accent", ui.accent);
  root.style.setProperty("--aiw-accentText", ui.accentText);

  root.appendChild(btn);
  root.appendChild(panel);
  document.body.appendChild(root);

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

      titleEl.textContent = ui.title || "Chat";
      subEl.textContent = ui.subtitle || "Automated assistant";

      root.style.setProperty("--aiw-accent", ui.accent || "#111111");
      root.style.setProperty("--aiw-accentText", ui.accentText || "#ffffff");
    } catch {}
  }
  loadConfig();

  btn.addEventListener("click", () => {
    panel.style.display =
      panel.style.display === "none" || !panel.style.display ? "block" : "none";

    if (panel.style.display === "block" && body.childElementCount === 0) {
      addMsg("bot", ui.greeting || "Hi! How can I help?");
    }
    input.focus();
  });

  panel.querySelector("#aiw-close").addEventListener("click", () => {
    panel.style.display = "none";
  });

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
        body: JSON.stringify({ clientId, message: msg }),
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