(function () {
  const config = window.siterep || window.citerep || {};
  const scriptTag = document.currentScript;
  const scriptData = (scriptTag && scriptTag.dataset) || {};
  const botId = config.botId || scriptData.botId || "starter-demo";
  const publicKey = config.publicKey || scriptData.publicKey || "";
  const apiBase =
    config.apiBase ||
    scriptData.apiBase ||
    (["127.0.0.1", "localhost"].includes(window.location.hostname) ? "http://127.0.0.1:8787" : "https://siterep.net");
  const previewMode = config.previewMode === true || config.previewMode === "true" || config.previewMode === "1";
  const widgetMode = String(config.mode || scriptData.mode || "site").toLowerCase() === "docs" ? "docs" : "site";
  const docsMode = widgetMode === "docs";
  const configuredHotkey = config.hotkey || scriptData.hotkey || (docsMode ? "mod+k" : "");
  const configuredTheme = config.theme || scriptData.theme || "";
  const theme = /^#[0-9a-f]{6}$/i.test(configuredTheme) ? configuredTheme : "#1f8f5f";
  const sessionId = config.sessionId || persistedSessionId();
  let answering = false;
  let widgetSettings = {
    title: docsMode ? "Docs assistant" : "Site Rep Assistant",
    welcomeMessage: docsMode
      ? "Ask about these docs. Answers cite the exact source pages, or the team can follow up."
      : "Ask a question about this site. If the approved pages do not cover it, leave your details and the team can follow up.",
    theme,
    mode: widgetMode,
    hotkey: configuredHotkey,
    suggestedQuestions: docsMode
      ? ["How do I get started?", "How do I install it?", "Which sources were used?"]
      : ["What does it cost?", "How do I install it?", "Can it answer with sources?"],
  };
  let brandingRequired = true;
  let lastQuestion = "";
  let leadBookingUrl = "";
  let sourceDrawerId = 0;
  let lastFocusedElement = null;
  let abuseProtection = { enabled: false, provider: "turnstile", siteKey: "", actions: [] };
  let abuseToken = "";
  let abuseTokenAction = "";
  let turnstileWidgetId = null;
  let turnstileAction = "";
  let turnstileScriptLoading = false;
	  const cleanup = [];

	  if (window.SiteRep && typeof window.SiteRep.uninstall === "function") {
	    window.SiteRep.uninstall();
	  } else if (window.CiteRep && typeof window.CiteRep.uninstall === "function") {
	    window.CiteRep.uninstall();
	  }
	  document.querySelectorAll("[data-citerep-owned]").forEach((node) => node.remove());

  const css = `
    .cr-typing{opacity:.65;letter-spacing:3px;animation:cr-pulse 1.2s ease-in-out infinite}
    .cr-launcher{position:fixed;right:22px;bottom:22px;width:58px;height:58px;border:0;border-radius:16px;background:var(--cr-theme,${theme});color:#fff;box-shadow:0 18px 44px rgba(0,0,0,.22);font:700 22px system-ui;z-index:2147483647;cursor:pointer;animation:cr-launch-in .42s cubic-bezier(.2,.8,.2,1) both}
    .cr-launcher.cr-docs{width:auto;min-width:88px;height:40px;padding:0 13px;border-radius:999px;font:800 13px system-ui;letter-spacing:0;box-shadow:0 10px 28px rgba(17,22,20,.18)}
    .cr-panel{position:fixed;right:22px;bottom:92px;width:min(390px,calc(100vw - 28px));height:min(560px,calc(100dvh - 116px));background:#fff;border:1px solid #dfe5da;border-radius:16px;box-shadow:0 24px 70px rgba(24,37,31,.22);z-index:2147483647;overflow:hidden;display:none;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111614}
    .cr-panel.cr-docs{right:18px;bottom:72px;width:min(430px,calc(100vw - 28px));height:min(520px,calc(100dvh - 96px));border-radius:12px}
    .cr-panel.cr-open{display:flex;flex-direction:column}
    .cr-head{display:flex;gap:10px;align-items:center;padding:16px;border-bottom:1px solid #dfe5da}
    .cr-docs .cr-head{padding:12px 14px}
    .cr-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#111614;color:#fff}
    .cr-title{min-width:0;flex:1}.cr-title strong,.cr-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cr-head strong{display:block;font-size:15px}.cr-head span{display:block;color:#5c665f;font-size:12px;font-weight:650}
    .cr-ai-note{background:#f7f8f4;border-bottom:1px solid #dfe5da;color:#5c665f;font-size:11px;font-weight:750;line-height:1.4;margin:0;padding:8px 14px}
    .cr-close{width:44px;height:44px;border:0;border-radius:10px;background:#f0f3f4;color:#111614;font:800 18px system-ui;cursor:pointer}
    .cr-body{flex:1;overflow:auto;padding:14px;background:#f7f8f4;display:flex;flex-direction:column;gap:10px}
    .cr-docs .cr-body{padding:10px;background:#fbfcfa;gap:8px}
    .cr-msg{max-width:86%;padding:11px 12px;border-radius:15px;line-height:1.42;font-size:14px;overflow-wrap:anywhere;animation:cr-msg-in .26s ease both}
    .cr-docs .cr-msg{max-width:92%;border-radius:10px;font-size:13px}
    .cr-bot{background:#fff;border:1px solid #e3e8de}.cr-user{align-self:flex-end;background:#111614;color:#fff}
    .cr-sources{margin-top:10px}.cr-source-toggle{align-items:center;background:#f7f8f4;border:1px solid #dfe5da;border-radius:999px;color:#126342;cursor:pointer;display:inline-flex;font:inherit;font-size:12px;font-weight:850;gap:6px;min-height:36px;padding:7px 10px}.cr-source-toggle:after{content:"▾";font-size:10px}.cr-source-toggle[aria-expanded="true"]:after{content:"▴"}.cr-source-drawer[hidden]{display:none}.cr-source-drawer{background:#fff;border:1px solid #dfe5da;border-radius:12px;display:grid;gap:8px;margin-top:8px;max-height:min(260px,45dvh);overflow:auto;padding:8px}.cr-source-item{border-bottom:1px solid #edf0eb;display:grid;gap:3px;padding:0 0 8px}.cr-source-item:last-child{border-bottom:0;padding-bottom:0}.cr-source-item a,.cr-source-item span{color:#126342;font-size:12px;font-weight:850;line-height:1.35;text-decoration:none;word-break:break-word}.cr-source-url{color:#73806f;font-size:11px;line-height:1.35;word-break:break-all}.cr-source-excerpt{color:#44514b;font-size:12px;line-height:1.4;margin:0}.cr-source-toggle:focus-visible,.cr-source-item a:focus-visible,.cr-launcher:focus-visible,.cr-close:focus-visible,.cr-send:focus-visible,.cr-suggestions button:focus-visible,.cr-feedback button:focus-visible{outline:3px solid color-mix(in srgb,var(--cr-theme,${theme}) 36%,transparent);outline-offset:2px}
    .cr-lead{margin-top:10px;border:1px solid #dfe5da;border-radius:12px;padding:9px;background:#f7f8f4}
    .cr-abuse{background:#fff;border-top:1px solid #dfe5da;padding:10px 12px}.cr-abuse[hidden]{display:none}.cr-abuse-note{color:#5c665f;font-size:12px;font-weight:750;margin:0 0 8px}
    .cr-lead input,.cr-lead textarea{width:100%;margin:4px 0;border:1px solid #cfd8c8;border-radius:9px;padding:0 9px;font:inherit;font-size:16px}
    .cr-lead input{min-height:44px}.cr-lead textarea{min-height:76px;padding-top:8px;resize:vertical}
    .cr-hp{position:absolute!important;left:-9999px!important;opacity:0!important;pointer-events:none!important}
    .cr-lead button,.cr-send{border:0;background:var(--cr-theme,${theme});color:#fff;border-radius:10px;font-weight:800;cursor:pointer}
    .cr-lead button{min-height:44px;padding:0 10px;width:100%;margin-top:4px}
    .cr-lead-error{color:#a44718;font-size:12px;font-weight:750;margin-top:6px}
    .cr-lead-consent{color:#73806f;font-size:11px;margin:6px 2px 0;line-height:1.4}
    .cr-suggestions{display:flex;flex-wrap:wrap;gap:7px}.cr-suggestions button{background:#fff;border:1px solid #dfe5da;border-radius:999px;color:#126342;cursor:pointer;font:inherit;font-size:12px;font-weight:800;min-height:44px;padding:8px 12px}
    .cr-status{background:#edf8f0;border:1px solid #cdebd6;border-radius:999px;color:#126342;display:inline-flex;font-size:11px;font-weight:850;margin:0 0 2px;padding:6px 9px;width:max-content}
    .cr-status.cr-warn{background:#fff4df;border-color:#f0d38a;color:#7b5314}
    .cr-answer-state{color:#5c665f;font-size:11px;font-weight:800;margin-top:8px}
    .cr-feedback{display:flex;gap:6px;margin-top:9px}.cr-feedback button{background:#f7f8f4;border:1px solid #dfe5da;border-radius:999px;color:#44514b;cursor:pointer;font:inherit;font-size:11px;font-weight:800;padding:6px 8px}.cr-feedback strong{color:#126342;font-size:12px}
    .cr-feedback-note{display:grid;gap:6px;margin-top:9px;width:100%}.cr-feedback-note textarea{border:1px solid #cfd8c8;border-radius:10px;font:inherit;font-size:12px;min-height:58px;padding:8px;resize:vertical}.cr-feedback-note button{background:var(--cr-theme,${theme});border-color:var(--cr-theme,${theme});color:#fff;width:max-content}
    .cr-input{display:flex;gap:8px;padding:12px;border-top:1px solid #dfe5da;background:#fff}.cr-docs .cr-input{padding:10px}.cr-input input{flex:1;height:44px;border:1px solid #cfd8c8;border-radius:11px;padding:0 12px;font:inherit;font-size:16px;min-width:0}.cr-send{width:44px;min-height:44px;flex:0 0 44px}
    .cr-powered{text-align:center;padding:8px;border-top:1px solid #dfe5da;font-size:12px;color:#5c665f;font-weight:750}
    @keyframes cr-launch-in{from{opacity:0}to{opacity:1}}
    @keyframes cr-msg-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    @keyframes cr-pulse{0%,100%{opacity:.35}50%{opacity:.8}}
    @media(max-width:480px){.cr-launcher{right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px))}.cr-panel,.cr-panel.cr-docs{right:10px;bottom:calc(70px + env(safe-area-inset-bottom,0px));width:calc(100vw - 20px);height:min(620px,calc(100dvh - 88px - env(safe-area-inset-bottom,0px)))}.cr-source-drawer{max-height:38dvh}.cr-msg{max-width:94%}}
    @media(prefers-reduced-motion:reduce){.cr-launcher,.cr-msg,.cr-panel,.cr-typing{animation:none!important;transition:none!important}}
  `;

	  const style = document.createElement("style");
	  style.id = "citerep-style";
	  style.dataset.citerepOwned = "style";
	  style.textContent = css;
	  document.head.appendChild(style);

		  const panel = document.createElement("section");
		  panel.id = "citerep-panel";
		  panel.className = `cr-panel${docsMode ? " cr-docs" : ""}`;
		  panel.dataset.citerepOwned = "panel";
      panel.setAttribute("role", "dialog");
		  panel.setAttribute("aria-labelledby", "citerep-title");
  panel.style.setProperty("--cr-theme", widgetSettings.theme);
  panel.innerHTML = `
    <div class="cr-head">
      <span class="cr-mark">↗</span>
      <div class="cr-title"><strong id="citerep-title" data-cr-title>Site Rep Assistant</strong><span data-cr-subtitle></span></div>
      <button class="cr-close" type="button" aria-label="Close Site Rep assistant">×</button>
    </div>
    <p class="cr-ai-note" data-cr-ai-note>You are chatting with an AI assistant, not a person. It answers from this site's approved pages.</p>
    <div class="cr-body" data-cr-body>
      <div class="cr-hp" data-cr-announcer role="status" aria-live="polite" aria-atomic="true"></div>
      <div class="cr-status" data-cr-status hidden></div>
      <div class="cr-msg cr-bot" data-cr-welcome>Ask a question about this site. If the approved pages do not cover it, leave your details and the team can follow up.</div>
      <div class="cr-suggestions" data-cr-suggestions></div>
    </div>
    <div class="cr-abuse" data-cr-abuse hidden><p class="cr-abuse-note">Complete this quick visitor check to send.</p><div data-cr-abuse-widget></div></div>
    <form class="cr-input" data-cr-form>
      <input data-cr-input aria-label="Ask a question" placeholder="Ask a question..." />
      <button class="cr-send" aria-label="Send">→</button>
    </form>
    <div class="cr-powered">Powered by Site Rep</div>
  `;

	  const launcher = document.createElement("button");
	  launcher.id = "citerep-launcher";
	  launcher.className = `cr-launcher${docsMode ? " cr-docs" : ""}`;
	  launcher.dataset.citerepOwned = "launcher";
	  launcher.style.setProperty("--cr-theme", widgetSettings.theme);
  launcher.type = "button";
  launcher.setAttribute("aria-label", docsMode ? "Ask AI — open docs assistant" : "Open Site Rep AI assistant");
  launcher.setAttribute("aria-controls", "citerep-panel");
  launcher.setAttribute("aria-expanded", "false");
  launcher.textContent = docsMode ? "Ask AI" : "↗";

  const body = panel.querySelector("[data-cr-body]");
  const form = panel.querySelector("[data-cr-form]");
  const input = panel.querySelector("[data-cr-input]");
  const sendButton = panel.querySelector(".cr-send");
  const close = panel.querySelector(".cr-close");
  const title = panel.querySelector("[data-cr-title]");
  const subtitle = panel.querySelector("[data-cr-subtitle]");
  const welcome = panel.querySelector("[data-cr-welcome]");
  const suggestions = panel.querySelector("[data-cr-suggestions]");
  const status = panel.querySelector("[data-cr-status]");
  const abuseBox = panel.querySelector("[data-cr-abuse]");
  const abuseWidget = panel.querySelector("[data-cr-abuse-widget]");
  const announcer = panel.querySelector("[data-cr-announcer]");
  subtitle.textContent = `${window.location.hostname || "this site"} · AI answers with sources`;
  const powered = panel.querySelector(".cr-powered");

  function mountWidget() {
    document.body.append(panel, launcher);
  }
  const remountTimer = setInterval(() => {
    if (document.body && !launcher.isConnected) document.body.append(panel, launcher);
  }, 2000);
  cleanup.push(() => clearInterval(remountTimer));
  if (document.body) {
    mountWidget();
  } else {
    document.addEventListener("DOMContentLoaded", mountWidget, { once: true });
  }

	  listen(launcher, "click", () => {
	    if (panel.classList.contains("cr-open")) {
	      closeWidget();
	    } else {
	      openWidget();
	    }
	  });

		  listen(close, "click", () => {
        closeWidget();
        restoreFocus();
      });
		  listen(form, "submit", submitQuestion);
      listen(document, "keydown", (event) => {
        if (event.key === "Escape" && panel.classList.contains("cr-open")) {
          closeWidget();
          restoreFocus();
          return;
        }
        if (hotkeyMatches(event, widgetSettings.hotkey) && !typingTarget(event.target)) {
          event.preventDefault();
          openWidget();
        }
      });

	  listen(input, "keydown", (event) => {
	    if (event.key === "Enter") {
	      event.preventDefault();
	      submitQuestion(event);
	    }
	  });
	  window.CiteRep = {
	    version: "0.1.0",
	    open: openWidget,
	    close: closeWidget,
	    uninstall,
	  };
  window.SiteRep = window.CiteRep;
	  renderSuggestions();
	  verifyInstall();
	  loadConfig();

	  function listen(target, eventName, handler, options) {
	    target.addEventListener(eventName, handler, options);
	    cleanup.push(() => target.removeEventListener(eventName, handler, options));
	  }

		  function openWidget() {
        lastFocusedElement = document.activeElement;
		    panel.classList.add("cr-open");
		    launcher.setAttribute("aria-expanded", "true");
        launcher.hidden = true;
        window.setTimeout(() => input.focus(), 0);
		  }

	  function closeWidget() {
	    panel.classList.remove("cr-open");
	    launcher.setAttribute("aria-expanded", "false");
      launcher.hidden = false;
	  }

  function restoreFocus() {
    const target = lastFocusedElement && typeof lastFocusedElement.focus === "function" && document.contains(lastFocusedElement)
      ? lastFocusedElement
      : launcher;
    target.focus();
  }

	  function uninstall() {
	    for (const remove of cleanup.splice(0)) remove();
	    panel.remove();
	    launcher.remove();
	    style.remove();
	    if (window.CiteRep && window.CiteRep.uninstall === uninstall) {
	      delete window.CiteRep;
	    }
    if (window.SiteRep && window.SiteRep.uninstall === uninstall) {
      delete window.SiteRep;
    }
	  }

  async function submitQuestion(event) {
    event.preventDefault();
    if (answering) return;
    const question = input.value.trim();
    if (!question) return;
    await askQuestion(question);
  }

  async function askQuestion(question) {
    input.value = "";
    lastQuestion = question;
    append("user", question);
    setBusy(true);
    const typing = document.createElement("div");
    typing.className = "cr-msg cr-bot cr-typing";
    typing.textContent = "…";
    body.appendChild(typing);
    body.scrollTop = body.scrollHeight;
    try {
      const answer = await findAnswer(question);
      setStatus(answer.mode || "", answer.warning ? "warn" : "ok");
      append("bot", answer.text, answer.sources, answer.lead, answer.conversationId, answer.mode);
      announcer.textContent = answer.text;
    } finally {
      typing.remove();
      setBusy(false);
    }
  }

	  async function findAnswer(question) {
	    try {
      const abuseProtectionToken = await ensureAbuseToken("chat");
      if (abuseProtection.enabled && abuseProtection.actions.includes("chat") && !abuseProtectionToken) {
        input.value = question;
        return {
          text: "Complete the visitor check, then send your question again.",
          sources: [],
          lead: false,
          conversationId: null,
          mode: "Visitor check needed",
          warning: true,
        };
      }
	      const { response, data } = await fetchJson(`${apiBase}/api/public/chat`, {
	        method: "POST",
	        headers: { "content-type": "application/json" },
		        body: JSON.stringify({ botId, publicKey, question, sessionId, abuseProtectionToken, abuseProtectionAction: "chat" }),
	      });
      resetAbuseChallenge("chat");
	      if (response.status === 429) {
	        return {
          text: data.error || "The widget is getting a lot of questions right now. Leave your email and the team can follow up.",
          sources: [],
          lead: true,
          conversationId: null,
	          mode: data.retryAfterSeconds ? `Busy: try again in ${data.retryAfterSeconds}s` : "Busy",
          warning: true,
        };
      }
      if (!response.ok) {
        return {
	          text: data.error || "The assistant is not available for this domain yet. Leave your email and the team can follow up.",
          sources: [],
          lead: true,
          conversationId: null,
	          mode: "Unavailable",
          warning: true,
        };
      }
      return {
        text: data.answer,
        sources: data.sources || [],
        lead: Boolean(data.leadPrompt),
        conversationId: data.conversation?.id,
        mode: data.unknown ? "No answer yet — leave your details below" : "Answered from this site's pages",
        warning: Boolean(data.unknown),
	      };
	    } catch {
	      return {
	        text:
	          "I cannot reach the indexed sources right now, so I will not guess. Leave your email and the team can follow up.",
	        sources: [],
	        lead: true,
	        conversationId: null,
	        mode: "Connection issue — try again shortly",
	        warning: true,
	      };
	    }
	  }

	  async function loadConfig() {
	    if (!publicKey) return;
	    try {
	      const { response, data } = await fetchJson(
	        `${apiBase}/api/public/config?botId=${encodeURIComponent(botId)}&publicKey=${encodeURIComponent(publicKey)}`,
	      );
	      if (!response.ok) throw new Error(data.error || "Config failed");
      const inlineOverrides = {};
      if (config.theme || scriptData.theme) inlineOverrides.theme = theme;
      if (config.mode || scriptData.mode) inlineOverrides.mode = widgetMode;
      if (config.hotkey || scriptData.hotkey) inlineOverrides.hotkey = configuredHotkey;
      widgetSettings = {
        ...widgetSettings,
        ...(data.widgetSettings || {}),
        ...inlineOverrides,
      };
      brandingRequired = data.brandingRequired !== false;
      const rawBookingUrl = String(data.leadRules?.bookingUrl || "");
      leadBookingUrl = /^https?:\/\//i.test(rawBookingUrl) ? rawBookingUrl : "";
      abuseProtection = {
        enabled: Boolean(data.abuseProtection?.enabled),
        provider: data.abuseProtection?.provider || "turnstile",
        siteKey: data.abuseProtection?.siteKey || "",
        actions: Array.isArray(data.abuseProtection?.actions) ? data.abuseProtection.actions : [],
      };
      renderAbuseProtection();
      applySettings();
      if (data.lifecycleStatus && data.lifecycleStatus !== "live") {
	        setStatus("Preview only: widget not live yet", "warn");
      }
    } catch {
      setStatus("", "ok");
    }
  }

	  async function verifyInstall() {
	    if (!publicKey) return;
	    if (previewMode) {
		      setStatus("Preview only: install proof skipped", "warn");
	      return;
	    }
	    try {
	      const { response } = await fetchJson(`${apiBase}/api/public/install`, {
	        method: "POST",
	        headers: { "content-type": "application/json" },
	        body: JSON.stringify({ botId, publicKey, href: window.location.href, title: document.title }),
	      }, 6000);
	      if (!response.ok) setStatus("", "ok");
    } catch {
      setStatus("", "ok");
    }
  }

  function applySettings() {
    panel.style.setProperty("--cr-theme", widgetSettings.theme);
    launcher.style.setProperty("--cr-theme", widgetSettings.theme);
    panel.classList.toggle("cr-docs", widgetSettings.mode === "docs");
    launcher.classList.toggle("cr-docs", widgetSettings.mode === "docs");
    title.textContent = widgetSettings.title || "Site Rep Assistant";
    welcome.textContent = widgetSettings.welcomeMessage || "Ask about pricing, setup, or security.";
    launcher.textContent = widgetSettings.mode === "docs" ? "Ask AI" : "↗";
    launcher.setAttribute("aria-label", widgetSettings.mode === "docs" ? "Ask AI — open docs assistant" : "Open Site Rep AI assistant");
    if (powered) powered.hidden = !brandingRequired;
    renderSuggestions();
  }

  function setBusy(next) {
    answering = next;
    form.classList.toggle("cr-busy", next);
    input.disabled = next;
    sendButton.disabled = next;
    sendButton.textContent = next ? "…" : "→";
  }

  function setStatus(text, tone) {
    if (!status) return;
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle("cr-warn", tone === "warn");
  }

	  function renderSuggestions() {
	    suggestions.innerHTML = "";
	    for (const question of widgetSettings.suggestedQuestions || []) {
	      if (!question) continue;
	      const button = document.createElement("button");
	      button.type = "button";
	      button.textContent = question;
	      listen(button, "click", () => askQuestion(question));
	      suggestions.appendChild(button);
	    }
    const leadButton = document.createElement("button");
    leadButton.type = "button";
    leadButton.textContent = "Leave details";
    listen(leadButton, "click", () => append("bot", "Share your details and the team will follow up.", [], true, null, ""));
    suggestions.appendChild(leadButton);
	  }

  function append(role, text, sources, lead, conversationId, mode) {
    const message = document.createElement("div");
    message.className = `cr-msg cr-${role}`;
    message.textContent = text;
    if (sources && sources.length) {
      const sourceList = document.createElement("div");
      sourceList.className = "cr-sources";
      renderSourceDrawer(sourceList, sources);
      message.appendChild(sourceList);
    }
    if (role === "bot" && mode) {
      const state = document.createElement("div");
      state.className = "cr-answer-state";
      state.textContent = mode;
      message.appendChild(state);
    }
    if (lead) {
      const box = document.createElement("form");
      box.className = "cr-lead";
      box.innerHTML = `
        <input name="name" placeholder="Name" aria-label="Name" />
        <input name="email" type="email" placeholder="Email" required aria-label="Email" />
        <input class="cr-hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" />
        <textarea name="need" placeholder="What should the team follow up on?" aria-label="What should the team follow up on?"></textarea>
        <button>Send</button>
        <p class="cr-lead-consent">We'll only use your details to follow up on your question.</p>
      `;
      box.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submitButton = box.querySelector("button");
        if (submitButton.disabled) return;
        const email = box.querySelector('input[name="email"]').value;
        const name = box.querySelector('input[name="name"]').value;
        const website = box.querySelector('input[name="website"]').value;
        const need = box.querySelector('textarea[name="need"]').value || lastQuestion || "";
        // The server 403s an untokened lead; block until the visitor check
        // completes, mirroring the chat gate.
        const abuseProtectionToken = await ensureAbuseToken("lead");
        if (abuseProtection.enabled && abuseProtection.actions.includes("lead") && !abuseProtectionToken) {
          showLeadError(box, "Complete the visitor check above, then send your details again.");
          return;
        }
        submitButton.disabled = true;
        submitButton.textContent = "Sending…";
        try {
	          const { response, data } = await fetchJson(`${apiBase}/api/public/leads`, {
	            method: "POST",
	            headers: { "content-type": "application/json" },
		            body: JSON.stringify({
                  botId,
                  publicKey,
                  name,
                  email,
                  need,
                  website,
                  source: "Widget",
                  conversationId,
                  sessionId,
                  abuseProtectionToken,
                  abuseProtectionAction: "lead",
                }),
	          });
          resetAbuseChallenge("lead");
	          if (!response.ok) {
	            throw new Error(data.error || "Lead capture failed.");
	          }
          box.innerHTML = "<strong>Thanks — your details are with the team and they will get back to you soon.</strong>";
          if (leadBookingUrl) {
            const booking = document.createElement("a");
            booking.href = leadBookingUrl;
            booking.target = "_blank";
            booking.rel = "noopener noreferrer";
            booking.textContent = "Want to pick a time right now? Book here.";
            box.appendChild(booking);
          }
        } catch (failure) {
          submitButton.disabled = false;
          submitButton.textContent = "Send";
          showLeadError(
            box,
            (failure && failure.message && failure.message !== "Lead capture failed." ? failure.message : "") ||
              "Could not send that yet. Please try again in a minute.",
          );
        }
      });
      message.appendChild(box);
    }
    if (role === "bot" && conversationId) {
      const feedback = document.createElement("div");
      feedback.className = "cr-feedback";
      feedback.innerHTML = `
        <button type="button" data-rating="up">Helpful</button>
        <button type="button" data-rating="down">Not helpful</button>
      `;
      feedback.addEventListener("click", async (event) => {
        const target = event.target.closest("button[data-rating]");
        if (!target) return;
        const rating = target.getAttribute("data-rating");
        if (rating === "down") {
          renderFeedbackNote(conversationId, feedback);
          return;
        }
        await sendFeedback(conversationId, rating, feedback);
      });
      message.appendChild(feedback);
    }
    body.appendChild(message);
    body.scrollTop = body.scrollHeight;
  }

  function renderSourceDrawer(container, sources) {
    container.textContent = "";
    const count = sources.length;
    const id = `citerep-sources-${++sourceDrawerId}`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "cr-source-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", id);
    toggle.setAttribute("aria-label", `Used ${count} source${count === 1 ? "" : "s"} for this answer`);
    toggle.textContent = `Used ${count} source${count === 1 ? "" : "s"}`;
    const drawer = document.createElement("div");
    drawer.id = id;
    drawer.className = "cr-source-drawer";
    drawer.hidden = true;
    drawer.setAttribute("role", "list");
    for (const source of sources) {
      const label = sourceTitle(source);
      const href = sourceHref(source);
      const item = document.createElement("div");
      item.className = "cr-source-item";
      item.setAttribute("role", "listitem");
      const titleNode = href ? document.createElement("a") : document.createElement("span");
      titleNode.textContent = label;
      if (href) {
        titleNode.href = href;
        titleNode.target = "_blank";
        titleNode.rel = "noopener noreferrer";
      }
      const url = document.createElement("div");
      url.className = "cr-source-url";
      url.textContent = sourceDisplayUrl(source);
      const excerpt = document.createElement("p");
      excerpt.className = "cr-source-excerpt";
      excerpt.textContent = sourceExcerpt(source);
      item.append(titleNode, url, excerpt);
      drawer.appendChild(item);
    }
    listen(toggle, "click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      drawer.hidden = expanded;
    });
    container.append(toggle, drawer);
  }

  function sourceDisplayUrl(source) {
    if (typeof source === "string") return "Source details";
    return source?.url || source?.sourceType || "Uploaded or manual source";
  }

  function sourceExcerpt(source) {
    const excerpt = typeof source === "string" ? "" : String(source?.excerpt || "").trim();
    if (excerpt) return excerpt.length > 260 ? `${excerpt.slice(0, 257)}...` : excerpt;
    return "No excerpt is available for this source.";
  }

  function hotkeyMatches(event, hotkey) {
    const raw = String(hotkey || "").trim().toLowerCase();
    if (!raw) return false;
    const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
    const key = parts.pop();
    if (!key) return false;
    const wantsMod = parts.includes("mod");
    const wantsCtrl = parts.includes("ctrl") || parts.includes("control");
    const wantsMeta = parts.includes("cmd") || parts.includes("meta");
    const wantsAlt = parts.includes("alt") || parts.includes("option");
    const wantsShift = parts.includes("shift");
    if (wantsMod && !(event.metaKey || event.ctrlKey)) return false;
    if (!wantsMod && wantsCtrl !== event.ctrlKey) return false;
    if (!wantsMod && wantsMeta !== event.metaKey) return false;
    if (wantsAlt !== event.altKey) return false;
    if (wantsShift !== event.shiftKey) return false;
    return String(event.key || "").toLowerCase() === key;
  }

  function typingTarget(target) {
    const tag = String(target?.tagName || "").toLowerCase();
    return Boolean(target?.isContentEditable || ["input", "textarea", "select"].includes(tag));
  }

  function renderAbuseProtection() {
    if (!abuseBox) return;
    const enabled = abuseProtection.enabled && abuseProtection.provider === "turnstile" && abuseProtection.siteKey;
    abuseBox.hidden = !enabled;
    if (enabled) loadTurnstileScript();
  }

  function showLeadError(box, msg) {
    const el = box.querySelector(".cr-lead-error") || document.createElement("div");
    el.className = "cr-lead-error";
    el.textContent = msg;
    box.appendChild(el);
  }

  async function ensureAbuseToken(action) {
    if (!abuseProtection.enabled || !abuseProtection.actions.includes(action)) return "";
    if (abuseToken && abuseTokenAction === action) return abuseToken;
    if (abuseToken && abuseTokenAction !== action) resetAbuseChallenge(action);
    renderAbuseProtection();
    if (window.turnstile && typeof window.turnstile.render === "function") renderTurnstile(action);
    return "";
  }

  function loadTurnstileScript() {
    if (window.turnstile && typeof window.turnstile.render === "function") {
      renderTurnstile(abuseProtection.actions[0] || "lead");
      return;
    }
    if (turnstileScriptLoading || document.querySelector("script[data-siterep-turnstile]")) return;
    turnstileScriptLoading = true;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.siterepTurnstile = "true";
    script.onload = () => renderTurnstile(abuseProtection.actions[0] || "lead");
    script.onerror = () => setStatus("Visitor check unavailable", "warn");
    document.head.appendChild(script);
    cleanup.push(() => script.remove());
  }

  function renderTurnstile(action = "lead") {
    if (!abuseWidget || !window.turnstile) return;
    if (turnstileWidgetId !== null && turnstileAction === action) return;
    if (turnstileWidgetId !== null && typeof window.turnstile.remove === "function") window.turnstile.remove(turnstileWidgetId);
    abuseWidget.textContent = "";
    abuseToken = "";
    turnstileAction = action;
    turnstileWidgetId = window.turnstile.render(abuseWidget, {
      sitekey: abuseProtection.siteKey,
      action,
      callback(token) {
        abuseToken = token || "";
        abuseTokenAction = token ? action : "";
        setStatus("", "ok");
      },
      "expired-callback"() {
        abuseToken = "";
        abuseTokenAction = "";
      },
      "error-callback"() {
        abuseToken = "";
        abuseTokenAction = "";
        setStatus("Visitor check failed. Try again.", "warn");
      },
    });
  }

  function resetAbuseChallenge(action = turnstileAction || "lead") {
    abuseToken = "";
    abuseTokenAction = "";
    if (!abuseProtection.enabled || !window.turnstile || turnstileWidgetId === null) return;
    if (typeof window.turnstile.reset === "function") {
      window.turnstile.reset(turnstileWidgetId);
      return;
    }
    if (typeof window.turnstile.remove === "function") {
      window.turnstile.remove(turnstileWidgetId);
      turnstileWidgetId = null;
      turnstileAction = "";
      abuseWidget.textContent = "";
      renderTurnstile(action);
    }
  }

  function sourceTitle(source) {
    if (typeof source === "string") return source;
    return source?.title || source?.url || "Source";
  }

	  function sourceHref(source) {
    if (typeof source !== "object" || !source?.url) return "";
    const value = String(source.url);
    if (/^https?:\/\//i.test(value) || value.startsWith("/")) return value;
    return "";
  }

  function renderFeedbackNote(conversationId, feedback) {
    feedback.innerHTML = "";
    const box = document.createElement("div");
    box.className = "cr-feedback-note";
    const note = document.createElement("textarea");
    note.placeholder = "What should we improve?";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Send review";
	    listen(button, "click", () => sendFeedback(conversationId, "down", feedback, note.value));
	    box.append(note, button);
    feedback.appendChild(box);
    note.focus();
  }

  async function sendFeedback(conversationId, rating, feedback, note = "") {
	    feedback.innerHTML = "<strong>Thanks for the feedback.</strong>";
	    try {
	      await fetchJson(`${apiBase}/api/public/feedback`, {
	        method: "POST",
	        headers: { "content-type": "application/json" },
	        body: JSON.stringify({ botId, publicKey, conversationId, rating, note }),
	      }, 6000);
	    } catch {
	    }
	  }

  function persistedSessionId() {
    try {
      const existing = window.sessionStorage.getItem("siterep-session");
      if (existing) return existing;
      const next = createSessionId();
      window.sessionStorage.setItem("siterep-session", next);
      return next;
    } catch {
      return createSessionId();
    }
  }

  function createSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

	  async function fetchJson(url, options = {}, timeoutMs = 12000) {
	    const controller = new AbortController();
	    const timeout = setTimeout(() => controller.abort(), timeoutMs);
	    try {
	      const response = await fetch(url, {
	        ...options,
	        signal: controller.signal,
	      });
	      const data = await response.json().catch(() => ({}));
	      return { response, data };
	    } finally {
	      clearTimeout(timeout);
	    }
	  }

})();
