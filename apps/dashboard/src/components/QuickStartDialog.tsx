"use client";

import { useMemo, useState } from "react";
import type { PushState } from "@/components/ServiceWorker";
import type { AgentModel, ConnectedMachine } from "@/lib/types";

interface QuickStartDialogProps {
  models: AgentModel[];
  machines: ConnectedMachine[];
  availableSlots: number;
  pushState: PushState;
  onEnablePush: () => void;
  onLaunch: (launch: {
    templateId: string;
    title: string;
    tasks: string[];
    model: string;
    machine?: string;
    machineLabel: string;
  }) => void;
  onClose: () => void;
}

interface QuickStartTemplate {
  id: string;
  title: string;
  summary: string;
  outcome: string;
  agentCount: number;
  roles: string[];
  buildTasks: (focus: string) => string[];
}

function preferClaude(models: AgentModel[]): string {
  return models.find((model) => model.id === "claude")?.id || models[0]?.id || "claude";
}

const TEMPLATES: QuickStartTemplate[] = [
  {
    id: "competitor",
    title: "Research Competitor",
    summary: "Spin up a rapid market-intel team and get the short version without managing prompts one by one.",
    outcome: "A concise competitor brief with product moves, customer sentiment, and recommended response.",
    agentCount: 3,
    roles: [
      "Product and pricing scan",
      "Customer sentiment and complaints",
      "CEO-ready summary and next moves",
    ],
    buildTasks: (focus) => {
      const subject = focus || "your main competitor";
      return [
        `Research ${subject}'s product, pricing, positioning, and recent launches. Produce a concise fact sheet focused on what changed and why it matters.`,
        `Scan public customer sentiment about ${subject}. Group what people praise, what frustrates them, and what they keep asking for.`,
        `Write a CEO-ready brief on ${subject}: biggest threats, biggest openings, and three recommended moves for us next week.`,
      ];
    },
  },
  {
    id: "weekly-report",
    title: "Generate Weekly Report",
    summary: "Create a polished weekly update with clear wins, problems, metrics, and leadership-ready conclusions.",
    outcome: "A clean weekly report you can skim in two minutes and forward as-is.",
    agentCount: 4,
    roles: [
      "Metrics and KPI roundup",
      "Wins, blockers, and team momentum",
      "Customer and market signals",
      "Final narrative and next actions",
    ],
    buildTasks: (focus) => {
      const subject = focus || "this week";
      return [
        `Build the KPI roundup for ${subject}. Pull together the most important metrics, highlight the deltas, and flag anything that needs explanation.`,
        `Summarize the biggest wins, blockers, and delivery risks for ${subject}. Keep it crisp and plain English.`,
        `Review customer, market, or stakeholder signals for ${subject}. Highlight meaningful feedback, risks, and opportunities.`,
        `Assemble a leadership-ready weekly report for ${subject}. Merge the metrics, wins, blockers, and signals into one clean update with next steps.`,
      ];
    },
  },
  {
    id: "alerts",
    title: "Monitor Alerts",
    summary: "Stand up a lightweight incident desk that triages noise, investigates urgency, and drafts the update for you.",
    outcome: "A fast incident summary with triage, impact, owner actions, and the message to send upward.",
    agentCount: 5,
    roles: [
      "Urgent vs watch vs noise triage",
      "Technical signal investigation",
      "Customer or revenue impact check",
      "Leadership update draft",
      "Running summary and final wrap-up",
    ],
    buildTasks: (focus) => {
      const subject = focus || "your product and operations";
      return [
        `Triage alerts related to ${subject}. Sort them into urgent, watch, and noise, and explain the reasoning briefly.`,
        `Investigate the most urgent technical or operational signals tied to ${subject}. Focus on probable causes and what still needs confirmation.`,
        `Assess likely customer, revenue, or reputation impact for the urgent alerts tied to ${subject}. Call out what leadership should care about first.`,
        `Draft the leadership update for ${subject}: what happened, how serious it is, what is being done now, and what decision may be needed.`,
        `Maintain a running summary for ${subject} and produce the final wrap-up once the alert burst settles.`,
      ];
    },
  },
];

export function QuickStartDialog({
  models,
  machines,
  availableSlots,
  pushState,
  onEnablePush,
  onLaunch,
  onClose,
}: QuickStartDialogProps) {
  const [selectedModel, setSelectedModel] = useState(preferClaude(models));
  const [selectedMachine, setSelectedMachine] = useState<string>("local");
  const [focus, setFocus] = useState("");

  const hasSatellites = machines.length > 0;
  const selectedMachineName = useMemo(() => {
    if (selectedMachine === "local") return "This Mac";
    return machines.find((machine) => machine.id === selectedMachine)?.hostname || selectedMachine;
  }, [machines, selectedMachine]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} role="presentation" />

      <div className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-[24px] border border-[var(--border)] bg-[var(--bg-card)] shadow-[0_30px_120px_rgba(0,0,0,0.45)]">
        <div className="border-b border-[var(--border)] px-5 py-5 sm:px-7">
          <div className="flex items-start justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">Quick Start</p>
              <h2 className="mt-2 text-2xl font-semibold text-[var(--text)]">Launch a ready-made team in one click</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                Pick a playbook. Hive will spawn a small team, assign plain-English tasks, and keep the normal dashboard controls available the whole time.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:border-[var(--border-light)] hover:text-[var(--text)] transition-colors"
            >
              Close
            </button>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-[1.2fr_1fr_1fr]">
            <div className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-4 py-3">
              <label htmlFor="quickstart-focus" className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">
                Focus
              </label>
              <input
                id="quickstart-focus"
                value={focus}
                onChange={(event) => setFocus(event.target.value)}
                placeholder="Optional: competitor, team, product, or alert source"
                className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]"
              />
              <p className="mt-2 text-xs text-[var(--text-light)]">Leave blank and the template still works.</p>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">Run on</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedMachine("local")}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    selectedMachine === "local"
                      ? "border-[var(--accent)] bg-[rgba(59,130,246,0.12)] text-[var(--text)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-light)] hover:text-[var(--text)]"
                  }`}
                >
                  This Mac
                </button>
                {hasSatellites && machines.map((machine) => (
                  <button
                    key={machine.id}
                    type="button"
                    onClick={() => setSelectedMachine(machine.id)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      selectedMachine === machine.id
                        ? "border-[var(--accent)] bg-[rgba(59,130,246,0.12)] text-[var(--text)]"
                        : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-light)] hover:text-[var(--text)]"
                    }`}
                  >
                    {machine.hostname}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-[var(--text-light)]">{availableSlots} open slots across the current grid.</p>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">Phone ping</p>
              {pushState === "subscribed" ? (
                <p className="mt-2 text-sm text-[var(--text)]">On. Hive will notify this device when agents finish.</p>
              ) : (
                <>
                  <p className="mt-2 text-sm text-[var(--text-muted)]">
                    {pushState === "denied"
                      ? "Notifications are blocked in this browser."
                      : pushState === "unsupported"
                        ? "This browser does not support push notifications."
                        : "Turn on a phone ping before you walk away."}
                  </p>
                  {pushState === "prompt" && (
                    <button
                      type="button"
                      onClick={onEnablePush}
                      className="mt-3 rounded-full border border-[var(--accent)] bg-[rgba(59,130,246,0.12)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:bg-[rgba(59,130,246,0.18)]"
                    >
                      Enable phone ping
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-7 xl:grid-cols-3">
          {TEMPLATES.map((template) => {
            const disabled = template.agentCount > availableSlots;
            const machine = selectedMachine === "local" ? undefined : selectedMachine;
            return (
              <div
                key={template.id}
                className={`rounded-[24px] border p-5 transition-colors ${
                  disabled
                    ? "border-[var(--border)] bg-[rgba(255,255,255,0.02)] opacity-55"
                    : "border-[rgba(59,130,246,0.18)] bg-[linear-gradient(180deg,rgba(59,130,246,0.08),rgba(20,20,22,0.95))]"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
                      {template.agentCount}-agent playbook
                    </p>
                    <h3 className="mt-2 text-xl font-semibold text-[var(--text)]">{template.title}</h3>
                  </div>
                  <div className="rounded-full border border-[rgba(59,130,246,0.28)] px-3 py-1 text-xs font-semibold text-[var(--text)]">
                    {template.agentCount} slots
                  </div>
                </div>

                <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">{template.summary}</p>

                <div className="mt-4 space-y-2">
                  {template.roles.map((role, index) => (
                    <div key={role} className="flex items-start gap-3 rounded-2xl border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.03)] px-3 py-2.5">
                      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[rgba(59,130,246,0.16)] text-[10px] font-semibold text-[var(--text)]">
                        {index + 1}
                      </span>
                      <span className="text-sm text-[var(--text)]">{role}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-4 rounded-2xl border border-[rgba(255,255,255,0.05)] bg-[rgba(10,10,11,0.35)] px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">You get</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">{template.outcome}</p>
                </div>

                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onLaunch({
                    templateId: template.id,
                    title: template.title,
                    tasks: template.buildTasks(focus.trim()),
                    model: selectedModel,
                    machine,
                    machineLabel: selectedMachineName,
                  })}
                  className={`mt-5 w-full rounded-2xl px-4 py-3 text-sm font-semibold transition-all ${
                    disabled
                      ? "cursor-not-allowed border border-[var(--border)] bg-[rgba(255,255,255,0.03)] text-[var(--text-light)]"
                      : "border border-[var(--accent)] bg-[var(--accent)] text-white hover:translate-y-[-1px] hover:opacity-95"
                  }`}
                >
                  {disabled ? `Needs ${template.agentCount} open slots` : `Launch on ${selectedMachineName}`}
                </button>
              </div>
            );
          })}
        </div>

        <div className="border-t border-[var(--border)] px-5 py-4 sm:px-7">
          <div className="flex flex-col gap-2 text-xs text-[var(--text-light)] sm:flex-row sm:items-center sm:justify-between">
            <p>Manual spawn and manage controls stay exactly as they are. Quick Start just batches the same spawn action for you.</p>
            <div className="flex flex-wrap gap-2">
              {models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => setSelectedModel(model.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    selectedModel === model.id
                      ? "border-[var(--accent)] bg-[rgba(59,130,246,0.12)] text-[var(--text)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-light)] hover:text-[var(--text)]"
                  }`}
                >
                  {model.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
