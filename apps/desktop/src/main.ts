import { invoke } from "@tauri-apps/api/core";

type ConfigMode = "fresh" | "connect" | null;

interface CliStatus {
  claude: boolean;
  codex: boolean;
  openclaw: boolean;
}

interface DesktopStatus {
  configuredMode: ConfigMode;
  launcherRunning: boolean;
  localDashboardUrl: string | null;
  remoteDashboardUrl: string | null;
  adminToken: string | null;
  primaryUrl: string | null;
  aiCli: CliStatus;
  note: string | null;
}

let selectedMode: ConfigMode = "fresh";
let currentStatus: DesktopStatus | null = null;
let busy = false;
let frameUrl: string | null = null;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

async function loadStatus(): Promise<void> {
  currentStatus = await invoke<DesktopStatus>("desktop_status");
  if (currentStatus.configuredMode) {
    selectedMode = currentStatus.configuredMode;
  }

  if (currentStatus.launcherRunning) {
    if (currentStatus.configuredMode === "fresh" && currentStatus.localDashboardUrl && currentStatus.adminToken) {
      frameUrl = `${currentStatus.localDashboardUrl}/bootstrap.html?token=${encodeURIComponent(currentStatus.adminToken)}`;
    } else if (currentStatus.configuredMode === "connect" && currentStatus.remoteDashboardUrl) {
      frameUrl = currentStatus.remoteDashboardUrl;
    }
  }

  render();
}

function modeCard(mode: Exclude<ConfigMode, null>, title: string, body: string): string {
  return `
    <button class="mode-card ${selectedMode === mode ? "active" : ""}" data-mode="${mode}" type="button">
      <h3>${title}</h3>
      <p>${body}</p>
    </button>
  `;
}

function cliRow(name: string, installed: boolean, copy: string): string {
  return `
    <div class="cli-item">
      <div>
        <strong>${name}</strong>
        <span>${copy}</span>
      </div>
      <span>${installed ? "Installed" : "Not found"}</span>
    </div>
  `;
}

function render(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app || !currentStatus) return;

  const showFresh = selectedMode === "fresh";
  const showConnect = selectedMode === "connect";
  const openButtonDisabled = busy || !currentStatus.launcherRunning;

  const remoteUrl = escapeHtml(currentStatus.remoteDashboardUrl || "");
  const primaryUrl = escapeHtml(currentStatus.primaryUrl || "");
  const note = currentStatus.note ? `<div class="banner">${escapeHtml(currentStatus.note)}</div>` : "";

  app.innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div class="brand">
          <h1>Hive Desktop</h1>
          <p>macOS wrapper for the existing Hive daemon and dashboard. No shell scripts exposed to the end user.</p>
        </div>
        <div class="status-row">
          <div class="status-pill"><span class="dot ${currentStatus.launcherRunning ? "ok" : ""}"></span><strong>${currentStatus.launcherRunning ? "Running" : "Stopped"}</strong></div>
          <div class="status-pill"><strong>Mode</strong>${currentStatus.configuredMode || "unset"}</div>
          <div class="status-pill"><strong>Dashboard</strong>${currentStatus.localDashboardUrl ? "local" : currentStatus.remoteDashboardUrl ? "remote" : "pending"}</div>
        </div>
      </div>
      ${note}
      <div class="content">
        <aside class="panel sidebar">
          <section class="hero">
            <p class="section-title">Desktop Wrapper</p>
            <h2>Launch Hive like an app, not a repo.</h2>
            <p>This wrapper keeps the current daemon and dashboard intact. It adds first-run onboarding, a bundled runtime, and a native place to start or join a Hive network.</p>
          </section>

          <section class="stack">
            <p class="section-title">First Run</p>
            <div class="mode-grid">
              ${modeCard("fresh", "Start New Hive", "Run the local primary daemon, serve the dashboard locally, and open the full grid inside the app.")}
              ${modeCard("connect", "Join Existing Hive", "Run this Mac as a satellite. Optionally open the primary dashboard URL in the same app window.")}
            </div>
          </section>

          <section class="stack">
            <p class="section-title">${showFresh ? "New Hive Setup" : "Join Existing Hive"}</p>
            <p class="section-copy">${showFresh
              ? "Fresh mode keeps the current Hive backend exactly as-is. The wrapper handles launch and token bootstrap instead of public shell scripts."
              : "Connect mode writes the same primary URL and token files used by the existing satellite install. The remote dashboard URL is optional but recommended."}</p>
            ${showConnect ? `
              <div class="field">
                <label for="primary-url">Primary WebSocket URL</label>
                <input id="primary-url" value="${primaryUrl}" placeholder="wss://your-primary.ngrok-free.dev" />
              </div>
              <div class="field">
                <label for="primary-token">Primary Token</label>
                <input id="primary-token" value="" placeholder="Paste admin token from the primary" />
              </div>
              <div class="field">
                <label for="dashboard-url">Primary Dashboard URL (optional)</label>
                <input id="dashboard-url" value="${remoteUrl}" placeholder="https://dashboard-flame-two-83.vercel.app" />
              </div>
              <p class="hint">Without a dashboard URL, this Mac can still join the swarm, but the wrapper cannot auto-open the full remote grid in-app.</p>
            ` : `
              <p class="hint">Fresh mode uses the local token in <code>~/.hive/token</code>, boots the daemon sidecar, and opens the grid through a local bootstrap page so the user never pastes a token into the desktop app.</p>
            `}
            <div class="button-row">
              <button class="button" id="save-launch">${showFresh ? "Start Hive" : "Save & Connect"}</button>
              <button class="button secondary" id="reload-status">Refresh Status</button>
              <button class="button ghost" id="stop-launcher" ${currentStatus.launcherRunning ? "" : "disabled"}>Stop Wrapper Sidecar</button>
            </div>
          </section>

          <section class="stack">
            <p class="section-title">Detected AI CLIs</p>
            <div class="cli-list">
              ${cliRow("Claude", currentStatus.aiCli.claude, "Best telemetry path.")}
              ${cliRow("Codex", currentStatus.aiCli.codex, "Works through JSONL, CPU, and PTY detection.")}
              ${cliRow("OpenClaw", currentStatus.aiCli.openclaw, "Optional third model path.")}
            </div>
          </section>

          <section class="stack">
            <p class="section-title">Wrapper Notes</p>
            <p class="section-copy">This branch does not reintroduce Quick Start, tile logs, or jump-to-output. It only adds a macOS desktop shell around the existing Hive runtime.</p>
            <div class="button-row">
              <button class="button secondary" id="open-dashboard" ${openButtonDisabled ? "disabled" : ""}>Open Dashboard Surface</button>
            </div>
          </section>
        </aside>

        <section class="panel viewer">
          ${frameUrl ? `
            <iframe class="viewer-frame" src="${escapeHtml(frameUrl)}" title="Hive Dashboard"></iframe>
          ` : `
            <div class="viewer-empty">
              <div class="viewer-empty-card">
                <h3>Dashboard Surface</h3>
                <p>${showFresh
                  ? "Start Hive to launch the local daemon, bootstrap the admin token automatically, and load the grid in this window."
                  : "After this Mac joins an existing Hive network, add the primary dashboard URL above if you want the wrapper to open the remote control plane here."}</p>
                <ul>
                  <li>Fresh mode gives you the full local primary dashboard experience.</li>
                  <li>Connect mode preserves the existing satellite behavior without changing daemon or dashboard code.</li>
                  <li>The removed dashboard features stay removed on main.</li>
                </ul>
              </div>
            </div>
          `}
        </section>
      </div>
    </div>
  `;

  app.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedMode = button.dataset.mode as ConfigMode;
      frameUrl = null;
      render();
    });
  });

  app.querySelector<HTMLButtonElement>("#reload-status")?.addEventListener("click", () => {
    void loadStatus();
  });

  app.querySelector<HTMLButtonElement>("#stop-launcher")?.addEventListener("click", async () => {
    busy = true;
    render();
    try {
      await invoke("stop_hive");
      frameUrl = null;
      await loadStatus();
    } finally {
      busy = false;
      render();
    }
  });

  app.querySelector<HTMLButtonElement>("#open-dashboard")?.addEventListener("click", () => {
    if (!currentStatus) return;
    if (currentStatus.configuredMode === "fresh" && currentStatus.localDashboardUrl && currentStatus.adminToken) {
      frameUrl = `${currentStatus.localDashboardUrl}/bootstrap.html?token=${encodeURIComponent(currentStatus.adminToken)}`;
      render();
      return;
    }
    if (currentStatus.remoteDashboardUrl) {
      frameUrl = currentStatus.remoteDashboardUrl;
      render();
    }
  });

  app.querySelector<HTMLButtonElement>("#save-launch")?.addEventListener("click", async () => {
    busy = true;
    render();
    try {
      if (selectedMode === "fresh") {
        await invoke("save_fresh_setup");
      } else {
        const nextPrimaryUrl = (document.querySelector<HTMLInputElement>("#primary-url")?.value || "").trim();
        const nextPrimaryToken = (document.querySelector<HTMLInputElement>("#primary-token")?.value || "").trim();
        const nextDashboardUrl = (document.querySelector<HTMLInputElement>("#dashboard-url")?.value || "").trim();
        await invoke("save_connect_setup", {
          primaryUrl: nextPrimaryUrl,
          primaryToken: nextPrimaryToken,
          dashboardUrl: nextDashboardUrl || null,
        });
      }

      const nextFrame = await invoke<string | null>("launch_hive");
      frameUrl = nextFrame;
      await loadStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      currentStatus.note = message;
      frameUrl = null;
      render();
    } finally {
      busy = false;
      render();
    }
  });
}

void loadStatus();
