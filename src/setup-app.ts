// Served at /setup/app.js — Pinax-branded OpenClaw Setup (client-side)

interface AuthOption {
  value: string;
  label: string;
}

interface AuthGroup {
  value: string;
  label: string;
  hint?: string;
  options: AuthOption[];
}

interface StatusResponse {
  configured: boolean;
  entryExists?: boolean;
  gatewayTarget?: string;
  openclawVersion?: string;
  authGroups?: AuthGroup[];
}

interface ConfigResponse {
  ok: boolean;
  path?: string;
  exists?: boolean;
  content?: string;
}

interface ConsoleResponse {
  ok: boolean;
  output?: string;
}

interface DevicesResponse {
  ok: boolean;
  requestIds?: string[];
  output?: string;
}

(function () {
  const $ = (id: string) => document.getElementById(id);

  const statusEl = $("status")!;
  const statusDetailsEl = $("statusDetails");
  const authGroupEl = $("authGroup") as HTMLSelectElement;
  const authChoiceEl = $("authChoice") as HTMLSelectElement;
  const logEl = $("log") as HTMLPreElement;
  const consoleCmdEl = $("consoleCmd") as HTMLSelectElement;
  const consoleArgEl = $("consoleArg") as HTMLInputElement | null;
  const consoleRunEl = $("consoleRun");
  const consoleOutEl = $("consoleOut") as HTMLPreElement | null;
  const configPathEl = $("configPath");
  const configTextEl = $("configText") as HTMLTextAreaElement | null;
  const configReloadEl = $("configReload");
  const configSaveEl = $("configSave");
  const configOutEl = $("configOut") as HTMLPreElement | null;
  const importFileEl = $("importFile") as HTMLInputElement | null;
  const importRunEl = $("importRun");
  const importOutEl = $("importOut") as HTMLPreElement | null;

  // ---------------------------------------------------------------------------
  // Accordion logic
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLButtonElement>(".accordion-trigger").forEach((btn) => {
    btn.addEventListener("click", () => {
      const content = btn.nextElementSibling as HTMLElement;
      const isOpen = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!isOpen));
      if (!isOpen) {
        content.style.maxHeight = content.scrollHeight + "px";
        content.style.opacity = "1";
      } else {
        content.style.maxHeight = "0";
        content.style.opacity = "0";
      }
    });
  });

  // Auto-open first section
  const firstTrigger = document.querySelector<HTMLButtonElement>(".accordion-trigger");
  if (firstTrigger) firstTrigger.click();

  // ---------------------------------------------------------------------------
  // Auth provider rendering
  // ---------------------------------------------------------------------------
  function isInteractiveOAuth(optionValue: string, optionLabel: string): boolean {
    const v = String(optionValue || "");
    const l = String(optionLabel || "");
    return l.includes("OAuth") || v.includes("cli") || v.includes("codex") || v.includes("portal");
  }

  function renderAuth(groups: AuthGroup[]): void {
    authGroupEl.innerHTML = "";

    let advancedToggle = $("showAdvancedAuth") as HTMLInputElement | null;
    if (!advancedToggle) {
      const label = document.createElement("label");
      label.className = "toggle-label";
      label.innerHTML = '<input type="checkbox" id="showAdvancedAuth" /> Show interactive OAuth options';
      authGroupEl.parentNode!.insertBefore(label, authChoiceEl);
    }

    for (const g of groups) {
      const opt = document.createElement("option");
      opt.value = g.value;
      opt.textContent = g.label + (g.hint ? " — " + g.hint : "");
      authGroupEl.appendChild(opt);
    }

    function rerenderChoices(): void {
      const sel = groups.find((g) => g.value === authGroupEl.value) ?? null;
      authChoiceEl.innerHTML = "";
      const opts = sel?.options ?? [];
      const showAdv = Boolean(($("showAdvancedAuth") as HTMLInputElement | null)?.checked);

      let firstNonInteractive: string | null = null;
      for (const o of opts) {
        const interactive = isInteractiveOAuth(o.value, o.label);
        if (interactive && !showAdv) continue;
        if (!interactive && !firstNonInteractive) firstNonInteractive = o.value;

        const opt2 = document.createElement("option");
        opt2.value = o.value;
        opt2.textContent = o.label + (interactive ? " (interactive)" : "");
        authChoiceEl.appendChild(opt2);
      }
      if (firstNonInteractive) authChoiceEl.value = firstNonInteractive;
    }

    authGroupEl.onchange = rerenderChoices;
    advancedToggle = $("showAdvancedAuth") as HTMLInputElement | null;
    if (advancedToggle) advancedToggle.onchange = rerenderChoices;
    rerenderChoices();
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------
  async function httpJson<T = any>(url: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(url, { credentials: "same-origin", ...opts });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------
  async function refreshStatus(): Promise<void> {
    statusEl.textContent = "Checking...";
    if (statusDetailsEl) statusDetailsEl.textContent = "";

    try {
      const j = await httpJson<StatusResponse>("/setup/api/status");
      const ver = j.openclawVersion ?? "";
      let badge: string;
      if (j.entryExists === false) {
        badge = '<span class="badge badge-err">Not installed</span>';
      } else if (j.configured) {
        badge = '<span class="badge badge-ok">Configured</span>';
      } else {
        badge = '<span class="badge badge-warn">Not configured</span>';
      }
      statusEl.innerHTML = badge + (ver ? ` <span class="version-tag">${ver}</span>` : "");

      if (statusDetailsEl) {
        statusDetailsEl.textContent = j.entryExists === false
          ? "OpenClaw binary not found — check Dockerfile build"
          : `Gateway: ${j.gatewayTarget ?? "(unknown)"}`;
      }

      if (configReloadEl && configTextEl) loadConfigRaw();
    } catch (e) {
      statusEl.innerHTML = `<span class="badge badge-err">Error</span> ${String(e)}`;
    }
  }

  async function loadAuthGroupsFast(): Promise<void> {
    try {
      const j = await httpJson<{ authGroups?: AuthGroup[] }>("/setup/api/auth-groups");
      if (j.authGroups?.length) {
        renderAuth(j.authGroups);
        return;
      }
      throw new Error("Missing authGroups");
    } catch {
      renderAuth([]);
    }
  }

  // ---------------------------------------------------------------------------
  // Run setup
  // ---------------------------------------------------------------------------
  $("run")!.onclick = async () => {
    const payload = {
      flow: ($("flow") as HTMLSelectElement).value,
      authChoice: authChoiceEl.value,
      authSecret: ($("authSecret") as HTMLInputElement).value,
      telegramToken: ($("telegramToken") as HTMLInputElement).value,
      discordToken: ($("discordToken") as HTMLInputElement).value,
      slackBotToken: ($("slackBotToken") as HTMLInputElement).value,
      slackAppToken: ($("slackAppToken") as HTMLInputElement).value,
      customProviderId: ($("customProviderId") as HTMLInputElement).value,
      customProviderBaseUrl: ($("customProviderBaseUrl") as HTMLInputElement).value,
      customProviderApi: ($("customProviderApi") as HTMLSelectElement).value,
      customProviderApiKeyEnv: ($("customProviderApiKeyEnv") as HTMLInputElement).value,
      customProviderModelId: ($("customProviderModelId") as HTMLInputElement).value,
    };
    logEl.textContent = "Running setup...\n";
    try {
      const res = await fetch("/setup/api/run", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let j: { ok?: boolean; output?: string };
      try { j = JSON.parse(text); } catch { j = { ok: false, output: text }; }
      logEl.textContent += j.output ?? JSON.stringify(j, null, 2);
      await refreshStatus();
    } catch (e) {
      logEl.textContent += `\nError: ${String(e)}\n`;
    }
  };

  // ---------------------------------------------------------------------------
  // Debug console
  // ---------------------------------------------------------------------------
  async function runConsole(): Promise<void> {
    const cmd = consoleCmdEl.value;
    const arg = consoleArgEl?.value ?? "";
    if (consoleOutEl) consoleOutEl.textContent = `$ ${cmd}${arg ? " " + arg : ""}\n`;
    try {
      const j = await httpJson<ConsoleResponse>("/setup/api/console/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd, arg }),
      });
      if (consoleOutEl) consoleOutEl.textContent += j.output ?? JSON.stringify(j, null, 2);
      await refreshStatus();
    } catch (e) {
      if (consoleOutEl) consoleOutEl.textContent += `\nError: ${String(e)}\n`;
    }
  }
  if (consoleRunEl) consoleRunEl.onclick = runConsole;

  // Gateway restart button
  const gatewayRestartEl = $("gatewayRestart");
  if (gatewayRestartEl) {
    gatewayRestartEl.onclick = async () => {
      logEl.textContent = "Restarting gateway...\n";
      try {
        const j = await httpJson<ConsoleResponse>("/setup/api/console/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cmd: "gateway.restart" }),
        });
        logEl.textContent += j.output ?? "Done.\n";
        await refreshStatus();
      } catch (e) {
        logEl.textContent += `Error: ${String(e)}\n`;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Config editor
  // ---------------------------------------------------------------------------
  async function loadConfigRaw(): Promise<void> {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.textContent = "";
    try {
      const j = await httpJson<ConfigResponse>("/setup/api/config/raw");
      if (configPathEl) configPathEl.textContent = (j.path ?? "") + (j.exists ? "" : " (not created yet)");
      configTextEl.value = j.content ?? "";
    } catch (e) {
      if (configOutEl) configOutEl.textContent = `Error: ${String(e)}`;
    }
  }

  async function saveConfigRaw(): Promise<void> {
    if (!configTextEl) return;
    if (!confirm("Save config and restart gateway?")) return;
    if (configOutEl) configOutEl.textContent = "Saving...\n";
    try {
      const j = await httpJson<{ ok: boolean; path?: string }>("/setup/api/config/raw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: configTextEl.value }),
      });
      if (configOutEl) configOutEl.textContent = `Saved → ${j.path ?? ""}\nGateway restarted.`;
      await refreshStatus();
    } catch (e) {
      if (configOutEl) configOutEl.textContent += `\nError: ${String(e)}\n`;
    }
  }
  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------
  async function runImport(): Promise<void> {
    const f = importFileEl?.files?.[0];
    if (!f) { alert("Pick a .tar.gz file first"); return; }
    if (!confirm("Import backup? This overwrites files and restarts the gateway.")) return;
    if (importOutEl) importOutEl.textContent = `Uploading ${f.name}...\n`;
    try {
      const buf = await f.arrayBuffer();
      const res = await fetch("/setup/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/gzip" },
        body: buf,
      });
      const t = await res.text();
      if (importOutEl) importOutEl.textContent += t + "\n";
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${t}`);
      await refreshStatus();
    } catch (e) {
      if (importOutEl) importOutEl.textContent += `\nError: ${String(e)}\n`;
    }
  }
  if (importRunEl) importRunEl.onclick = runImport;

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------
  const pairingBtn = $("pairingApprove");
  if (pairingBtn) {
    pairingBtn.onclick = async () => {
      let channel = prompt("Channel (telegram or discord):");
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== "telegram" && channel !== "discord") {
        alert('Must be "telegram" or "discord"');
        return;
      }
      const code = prompt("Pairing code:");
      if (!code) return;
      logEl.textContent += `\nApproving ${channel} pairing...\n`;
      try {
        const res = await fetch("/setup/api/pairing/approve", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel, code: code.trim() }),
        });
        const t = await res.text();
        logEl.textContent += t + "\n";
      } catch (e) {
        logEl.textContent += `Error: ${String(e)}\n`;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Device pairing
  // ---------------------------------------------------------------------------
  const devicesRefreshBtn = $("devicesRefresh");
  const devicesListEl = $("devicesList");

  async function approveDevice(requestId: string): Promise<void> {
    if (!confirm(`Approve device ${requestId}?`)) return;
    if (devicesListEl) devicesListEl.textContent = "Approving...";
    try {
      const j = await httpJson<{ output?: string }>("/setup/api/devices/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      if (devicesListEl) devicesListEl.textContent = j.output ?? "Approved.";
      await refreshStatus();
    } catch (e) {
      if (devicesListEl) devicesListEl.textContent = `Error: ${String(e)}`;
    }
  }

  async function refreshDevices(): Promise<void> {
    if (!devicesListEl) return;
    devicesListEl.textContent = "Loading...";
    try {
      const j = await httpJson<DevicesResponse>("/setup/api/devices/pending");
      const ids = j.requestIds ?? [];
      if (!ids.length) {
        devicesListEl.textContent = "No pending requests.";
        return;
      }
      devicesListEl.innerHTML = "";
      for (const id of ids) {
        const row = document.createElement("div");
        row.style.marginTop = "0.25rem";
        const btn = document.createElement("button");
        btn.className = "btn btn-sm";
        btn.textContent = `Approve ${id}`;
        btn.onclick = () => approveDevice(id);
        row.appendChild(btn);
        devicesListEl.appendChild(row);
      }
    } catch (e) {
      devicesListEl.textContent = `Error: ${String(e)}`;
    }
  }
  if (devicesRefreshBtn) devicesRefreshBtn.onclick = refreshDevices;

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------
  $("reset")!.onclick = async () => {
    if (!confirm("Reset setup? This deletes the config so you can re-run onboarding.")) return;
    logEl.textContent = "Resetting...\n";
    try {
      const res = await fetch("/setup/api/reset", { method: "POST", credentials: "same-origin" });
      const t = await res.text();
      logEl.textContent += t + "\n";
      await refreshStatus();
    } catch (e) {
      logEl.textContent += `Error: ${String(e)}\n`;
    }
  };

  // ---------------------------------------------------------------------------
  // GitHub Webhook status
  // ---------------------------------------------------------------------------
  async function refreshWebhookStatus(): Promise<void> {
    const badgeEl = $("webhookBadge");
    const configEl = $("webhookConfig");

    try {
      const j = await httpJson<{
        enabled: boolean;
        config: Record<string, string | boolean>;
      }>("/setup/api/webhook/status");

      if (badgeEl) {
        badgeEl.innerHTML = j.enabled
          ? '<span class="badge badge-ok">Webhook</span>'
          : '<span class="badge badge-warn">Webhook off</span>';
      }

      if (configEl) {
        const rows = Object.entries(j.config).map(([key, val]) => {
          const display = typeof val === "boolean" ? (val ? "✓ exists" : "✗ missing") : String(val);
          const isSet = display !== "(not set)" && display !== "✗ missing";
          return `<div style="display:flex;justify-content:space-between;padding:0.3rem 0;border-bottom:1px solid var(--border)">
            <code style="font-size:0.78rem">${key}</code>
            <span style="color:${isSet ? "var(--aqua)" : "var(--text-dim)"};font-size:0.8rem">${display}</span>
          </div>`;
        });
        configEl.innerHTML = rows.join("");
      }
    } catch (e) {
      if (badgeEl) badgeEl.innerHTML = '<span class="badge badge-err">Webhook error</span>';
      if (configEl) configEl.textContent = `Error: ${String(e)}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  loadAuthGroupsFast();
  refreshStatus();
  refreshWebhookStatus();
})();
