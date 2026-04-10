/**
 * OpenSpec Multi-Agent Pipeline Extension for Pi
 *
 * Implements the Orchestrator-Workers-Synthesizer pattern inspired by OpenSpec.
 *
 * Features:
 *   - Active agent tracking across turns (persisted in session)
 *   - Agent persona injection into system prompt via before_agent_start
 *   - Footer status showing current agent + workflow step
 *   - /agent <name|status|reset> command
 *   - /flow <standard|tdd|review|status> command
 *   - /flow-next to advance workflow step
 *   - /skill:agent-name interception for automatic tracking
 *   - context-log.jsonl append-only logging
 *
 * Agents:
 *   orchestrator, codegen, designer, tests, integrator, validator, review, sophos
 *
 * Workflows:
 *   standard: orchestrator → codegen → tests → integrator → validator → review
 *   tdd:      tests → codegen → integrator → validator → review
 *   review:   validator → review
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Agent Definitions ────────────────────────────────────────────────────────

const AGENT_ROLES = {
	orchestrator: { emoji: "🎯", label: "Orchestrator", color: "accent" as const },
	codegen: { emoji: "⚡", label: "CodeGen", color: "success" as const },
	designer: { emoji: "🎨", label: "Designer", color: "warning" as const },
	tests: { emoji: "🧪", label: "Tests", color: "info" as const },
	integrator: { emoji: "🔧", label: "Integrator", color: "accent" as const },
	validator: { emoji: "✅", label: "Validator", color: "success" as const },
	review: { emoji: "🔍", label: "Review", color: "warning" as const },
	sophos: { emoji: "🦉", label: "Sophos", color: "muted" as const },
} as const;

type AgentName = keyof typeof AGENT_ROLES;

const AGENT_NAMES = Object.keys(AGENT_ROLES) as AgentName[];

// ─── Workflow Definitions ─────────────────────────────────────────────────────

const WORKFLOWS = {
	standard: ["orchestrator", "codegen", "tests", "integrator", "validator", "review"] as AgentName[],
	tdd: ["tests", "codegen", "integrator", "validator", "review"] as AgentName[],
	review: ["validator", "review"] as AgentName[],
} as const;

type WorkflowName = keyof typeof WORKFLOWS;
const WORKFLOW_NAMES = Object.keys(WORKFLOWS) as WorkflowName[];

// ─── State ────────────────────────────────────────────────────────────────────

interface HistoryEntry {
	agent: AgentName;
	timestamp: string;
}

interface AgentState {
	current: AgentName | null;
	history: HistoryEntry[];
	workflow: WorkflowName | null;
	workflowStep: number;
}

const CUSTOM_TYPE = "openspec-agent-state";

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let state: AgentState = {
		current: null,
		history: [],
		workflow: null,
		workflowStep: 0,
	};

	// ── Session State ──────────────────────────────────────────────────────────

	// Restore state from session entries on startup or session switch
	pi.on("session_start", async (_event, ctx) => {
		state = { current: null, history: [], workflow: null, workflowStep: 0 };

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data) {
				// Take the last state entry (most recent wins)
				state = { ...state, ...(entry.data as Partial<AgentState>) };
			}
		}

		updateStatus(ctx);
	});

	// ── System Prompt Injection ────────────────────────────────────────────────

	// Inject active agent persona into system prompt on each turn
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state.current) return;

		const role = AGENT_ROLES[state.current];

		const workflowInfo =
			state.workflow && state.workflow in WORKFLOWS
				? (() => {
						const steps = WORKFLOWS[state.workflow];
						const stepNum = state.workflowStep + 1;
						const total = steps.length;
						const next = steps[state.workflowStep + 1];
						const nextHint = next
							? `\nNext step: use \`/flow-next\` to advance to @${next} when your work is complete.`
							: `\nThis is the final step. Use \`/flow-next\` to complete the workflow.`;
						return `\n\n**Workflow**: ${state.workflow} — Step ${stepNum}/${total}${nextHint}`;
					})()
				: "";

		const injection = `\n\n---\n## Active Agent: ${role.emoji} ${role.label}\n\nYou are currently acting as the **${role.label}** agent in the OpenSpec multi-agent pipeline. Stay in character — follow the responsibilities and constraints of this role.${workflowInfo}\n\nTo switch agents: \`/skill:<agent>\` or \`/agent <name>\`\n---`;

		return {
			systemPrompt: event.systemPrompt + injection,
		};
	});

	// ── Input Interception ────────────────────────────────────────────────────

	// Track /skill:agent-name activations to automatically update state
	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();
		const skillMatch = text.match(/^\/skill:(\S+)/);
		if (skillMatch) {
			const skillName = skillMatch[1];
			if (isAgentName(skillName)) {
				activateAgent(skillName, ctx);
			}
		}
		return { action: "continue" };
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	/**
	 * /agent <name|status|reset|list>
	 * Manage the active agent persona
	 */
	pi.registerCommand("agent", {
		description: "Manage active agent: /agent <name|status|reset|list>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [cmd] = trimmed.split(/\s+/);

			if (!cmd || cmd === "status") {
				showStatus(ctx);
				return;
			}

			if (cmd === "list") {
				const lines = AGENT_NAMES.map((name) => {
					const role = AGENT_ROLES[name];
					const active = state.current === name ? " ← active" : "";
					return `${role.emoji} ${name.padEnd(12)} ${role.label}${active}`;
				});
				ctx.ui.notify(`Available agents:\n\n${lines.join("\n")}`, "info");
				return;
			}

			if (cmd === "reset") {
				const prev = state.current;
				state.current = null;
				state.workflow = null;
				state.workflowStep = 0;
				saveState(ctx);
				updateStatus(ctx);
				ctx.ui.notify(prev ? `Agent ${prev} deactivated` : "No active agent", "info");
				return;
			}

			if (isAgentName(cmd)) {
				activateAgent(cmd, ctx);
				const role = AGENT_ROLES[cmd];
				ctx.ui.notify(`Switched to ${role.emoji} ${role.label}\n\nLoad persona: /skill:${cmd}`, "success");
			} else {
				ctx.ui.notify(
					`Unknown agent: "${cmd}"\nAvailable: ${AGENT_NAMES.join(", ")}\n\nUsage: /agent <name|status|reset|list>`,
					"error",
				);
			}
		},
	});

	/**
	 * /flow <standard|tdd|review|status>
	 * Start or check a multi-agent workflow
	 */
	pi.registerCommand("flow", {
		description: "Start or check workflow: /flow <standard|tdd|review|status>",
		handler: async (args, ctx) => {
			const name = args.trim() as WorkflowName | "status" | "";

			if (!name || name === "status") {
				if (!state.workflow) {
					const lines = [
						"No active workflow.\n",
						"Available workflows:",
						...WORKFLOW_NAMES.map((wf) => {
							const steps = WORKFLOWS[wf];
							const stepsStr = steps.map((s) => `${AGENT_ROLES[s].emoji} ${s}`).join(" → ");
							return `  • /flow:${wf}  ${stepsStr}`;
						}),
					];
					ctx.ui.notify(lines.join("\n"), "info");
				} else {
					showStatus(ctx);
				}
				return;
			}

			if (!isWorkflowName(name)) {
				ctx.ui.notify(
					`Unknown workflow: "${name}"\nAvailable: ${WORKFLOW_NAMES.join(", ")}\n\nUsage: /flow <${WORKFLOW_NAMES.join("|")}>`,
					"error",
				);
				return;
			}

			// Start the workflow
			state.workflow = name;
			state.workflowStep = 0;

			const steps = WORKFLOWS[name];
			const firstAgent = steps[0];

			activateAgent(firstAgent, ctx);
			saveState(ctx);

			const stepsStr = steps.map((s, i) => `  ${i + 1}. ${AGENT_ROLES[s].emoji} @${s}`).join("\n");

			ctx.ui.notify(
				`🚀 ${name.toUpperCase()} workflow started!\n\nPipeline:\n${stepsStr}\n\nCurrent: ${AGENT_ROLES[firstAgent].emoji} @${firstAgent}\n\nLoad persona with: /skill:${firstAgent}\nAdvance with: /flow-next`,
				"success",
			);

			logContextEntry(ctx, "workflow_start", { workflow: name, steps });
		},
	});

	/**
	 * /flow-next
	 * Advance to the next step in the active workflow
	 */
	pi.registerCommand("flow-next", {
		description: "Advance to the next step in the active workflow",
		handler: async (_args, ctx) => {
			if (!state.workflow) {
				ctx.ui.notify('No active workflow.\n\nStart one with: /flow <standard|tdd|review>', "error");
				return;
			}

			const steps = WORKFLOWS[state.workflow];

			if (state.workflowStep >= steps.length - 1) {
				// Workflow complete
				logContextEntry(ctx, "workflow_complete", { workflow: state.workflow });
				const completedWorkflow = state.workflow;
				state.workflow = null;
				state.workflowStep = 0;
				saveState(ctx);
				updateStatus(ctx);
				ctx.ui.notify(`🎉 ${completedWorkflow.toUpperCase()} workflow complete!\n\nAll agents have finished.`, "success");
				return;
			}

			const prevAgent = steps[state.workflowStep];
			state.workflowStep++;
			const nextAgent = steps[state.workflowStep];
			const remaining = steps.length - state.workflowStep - 1;

			activateAgent(nextAgent, ctx);
			saveState(ctx);

			const remainingStr =
				remaining > 0
					? `\nRemaining: ${steps.slice(state.workflowStep + 1).map((s) => `@${s}`).join(" → ")}`
					: "\n(Last step)";

			ctx.ui.notify(
				`Step ${state.workflowStep + 1}/${steps.length}: ${AGENT_ROLES[nextAgent].emoji} @${nextAgent}\n\nPrevious: @${prevAgent} → done${remainingStr}\n\nLoad persona: /skill:${nextAgent}`,
				"info",
			);

			logContextEntry(ctx, "workflow_step", {
				workflow: state.workflow,
				step: state.workflowStep,
				agent: nextAgent,
				prev: prevAgent,
			});
		},
	});

	// ── Helpers ───────────────────────────────────────────────────────────────

	function isAgentName(name: string): name is AgentName {
		return AGENT_NAMES.includes(name as AgentName);
	}

	function isWorkflowName(name: string): name is WorkflowName {
		return WORKFLOW_NAMES.includes(name as WorkflowName);
	}

	function activateAgent(name: AgentName, ctx: ExtensionContext) {
		const prev = state.current;
		state.current = name;

		state.history.push({ agent: name, timestamp: new Date().toISOString() });
		// Cap history to last 50 entries
		if (state.history.length > 50) {
			state.history = state.history.slice(-50);
		}

		saveState(ctx);
		updateStatus(ctx);
		logContextEntry(ctx, "agent_switch", { from: prev, to: name });
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		if (!state.current) {
			ctx.ui.setStatus("openspec", "");
			return;
		}

		const role = AGENT_ROLES[state.current];

		let workflowPart = "";
		if (state.workflow && state.workflow in WORKFLOWS) {
			const steps = WORKFLOWS[state.workflow];
			workflowPart = ` [${state.workflow} ${state.workflowStep + 1}/${steps.length}]`;
		}

		ctx.ui.setStatus("openspec", `${role.emoji} ${role.label}${workflowPart}`);
	}

	function showStatus(ctx: ExtensionContext) {
		const lines: string[] = [];

		// Active agent
		if (state.current) {
			const role = AGENT_ROLES[state.current];
			lines.push(`Active: ${role.emoji} ${role.label}`);
		} else {
			lines.push("No active agent");
		}

		// Workflow
		if (state.workflow && state.workflow in WORKFLOWS) {
			const steps = WORKFLOWS[state.workflow];
			const current = steps[state.workflowStep];
			const next = steps[state.workflowStep + 1];
			lines.push(`Workflow: ${state.workflow} — Step ${state.workflowStep + 1}/${steps.length}`);
			lines.push(`Current: @${current}`);
			if (next) lines.push(`Next: @${next} (use /flow-next)`);
			else lines.push("Last step (use /flow-next to complete)");
		} else {
			lines.push("No active workflow");
		}

		// Recent history
		if (state.history.length > 0) {
			const recent = state.history.slice(-4).reverse();
			const historyStr = recent.map((h) => `@${h.agent}`).join(" ← ");
			lines.push(`History: ${historyStr}`);
		}

		// Commands
		lines.push("\nCommands:");
		lines.push("  /agent <name|status|reset|list>");
		lines.push("  /flow <standard|tdd|review|status>");
		lines.push("  /flow-next");

		ctx.ui.notify(lines.join("\n"), "info");
	}

	function saveState(ctx: ExtensionContext) {
		try {
			pi.appendEntry(CUSTOM_TYPE, { ...state });
		} catch {
			// Ignore save errors
		}
	}

	function logContextEntry(ctx: ExtensionContext, type: string, data: Record<string, unknown>) {
		try {
			const logPath = join(ctx.cwd, "context-log.jsonl");
			const logDir = dirname(logPath);

			if (!existsSync(logDir)) {
				mkdirSync(logDir, { recursive: true });
			}

			const entry = JSON.stringify({
				seq: Date.now(),
				timestamp: new Date().toISOString(),
				type,
				agent: state.current,
				workflow: state.workflow,
				...data,
			});

			appendFileSync(logPath, entry + "\n", "utf-8");
		} catch {
			// Context log is best-effort, never throw
		}
	}
}
