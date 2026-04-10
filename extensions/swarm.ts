/**
 * OpenSpec Multi-Agent Pipeline Extension for Pi
 *
 * Implements the Orchestrator-Workers-Synthesizer pattern inspired by OpenSpec.
 *
 * Features:
 *   - Active agent tracking across turns (persisted in session)
 *   - Agent persona injection into system prompt via before_agent_start
 *   - Footer status showing current agent + workflow step
 *   - flow_complete tool — agent calls it to auto-advance to next step
 *   - /agent <name|status|reset> command
 *   - /flow <standard|ui|tdd|review|status> command
 *   - /flow-next to advance workflow step
 *   - /swarm dashboard command (agent swarm command center)
 *   - /skill:agent-name interception for automatic tracking
 *   - context-log.jsonl append-only logging
 *
 * Agents:
 *   orchestrator, codegen, designer, tests, integrator, validator, review, sophos
 *
 * Workflows:
 *   standard: orchestrator → codegen → tests → integrator → validator → review
 *   ui:       orchestrator → designer → codegen → tests → integrator → validator → review
 *   tdd:      tests → codegen → integrator → validator → review
 *   review:   validator → review
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

// Monotonic counter for context-log entries (resets per process; timestamp handles cross-session ordering)
let _logSeq = 0;

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

// Tool name → human-readable action label (shown in the agent card)
const TOOL_ACTION_LABELS: Record<string, string> = {
	read: "Reading",
	write: "Writing",
	edit: "Editing",
	bash: "Executing",
	grep: "Searching",
	flow_complete: "Completing step",
	marshal_start: "Starting loop",
	marshal_done: "Iterating",
};

const AGENT_BLURBS = {
	orchestrator: "Plans and coordinates the full pipeline",
	codegen: "Implements production code with FC&IS",
	designer: "Shapes UI direction and visual system",
	tests: "Drives TDD and regression safety",
	integrator: "Merges outputs and tidies structure",
	validator: "Checks architecture and constraints",
	review: "Delivers final APPROVED or fixes verdict",
	sophos: "Provides second-opinion and risk analysis",
} as const;

type AgentName = keyof typeof AGENT_ROLES;

const AGENT_NAMES = Object.keys(AGENT_ROLES) as AgentName[];

// ─── Workflow Definitions ─────────────────────────────────────────────────────

const WORKFLOWS = {
	standard: ["orchestrator", "codegen", "tests", "integrator", "validator", "review"] as AgentName[],
	ui: ["orchestrator", "designer", "codegen", "tests", "integrator", "validator", "review"] as AgentName[],
	tdd: ["tests", "codegen", "integrator", "validator", "review"] as AgentName[],
	review: ["validator", "review"] as AgentName[],
} as const;

type WorkflowName = keyof typeof WORKFLOWS;
const WORKFLOW_NAMES = Object.keys(WORKFLOWS) as WorkflowName[];

type SwarmTheme = "kimi" | "blueprint" | "minimal" | "hangar";

interface ThemeTokens {
	name: SwarmTheme;
	label: string;
	border: string;
	divider: string;
	sectionOpen: string;
	sectionClose: string;
	progressFill: string;
	progressHead: string;
	progressEmpty: string;
	cardTopLeft: string;
	cardTopRight: string;
	cardBottomLeft: string;
	cardBottomRight: string;
	cardHorizontal: string;
	cardVertical: string;
}

const SWARM_THEMES: Record<SwarmTheme, ThemeTokens> = {
	kimi: {
		name: "kimi",
		label: "Kimi Cards",
		border: "=",
		divider: "-",
		sectionOpen: "[",
		sectionClose: "]",
		progressFill: "#",
		progressHead: ">",
		progressEmpty: ".",
		cardTopLeft: "+",
		cardTopRight: "+",
		cardBottomLeft: "+",
		cardBottomRight: "+",
		cardHorizontal: "-",
		cardVertical: "|",
	},
	blueprint: {
		name: "blueprint",
		label: "Blueprint",
		border: "~",
		divider: "·",
		sectionOpen: "<",
		sectionClose: ">",
		progressFill: "=",
		progressHead: ">",
		progressEmpty: " ",
		cardTopLeft: "/",
		cardTopRight: "\\",
		cardBottomLeft: "\\",
		cardBottomRight: "/",
		cardHorizontal: "=",
		cardVertical: "!",
	},
	minimal: {
		name: "minimal",
		label: "Minimal",
		border: "-",
		divider: "-",
		sectionOpen: "(",
		sectionClose: ")",
		progressFill: "=",
		progressHead: ">",
		progressEmpty: ".",
		cardTopLeft: "+",
		cardTopRight: "+",
		cardBottomLeft: "+",
		cardBottomRight: "+",
		cardHorizontal: "-",
		cardVertical: "|",
	},
	hangar: {
		name: "hangar",
		label: "Hanging Cards V3",
		border: "#",
		divider: "=",
		sectionOpen: "[",
		sectionClose: "]",
		progressFill: "=",
		progressHead: ">",
		progressEmpty: ".",
		cardTopLeft: "+",
		cardTopRight: "+",
		cardBottomLeft: "+",
		cardBottomRight: "+",
		cardHorizontal: "-",
		cardVertical: "|",
	},
};

const SWARM_THEME_NAMES = Object.keys(SWARM_THEMES) as SwarmTheme[];

// ─── Marshal Loop ─────────────────────────────────────────────────────────────

interface MarshalLoop {
	name: string;
	iteration: number;
	maxIterations: number;
	itemsPerIteration: number;
	reflectEvery: number;
	status: "running" | "paused" | "complete";
	startedAt: string;
}

// ─── State ────────────────────────────────────────────────────────────────────

interface HistoryEntry {
	agent: AgentName;
	timestamp: string;
	workflowStep?: number;
}

interface AgentState {
	current: AgentName | null;
	history: HistoryEntry[];
	workflow: WorkflowName | null;
	workflowStep: number;
	theme: SwarmTheme;
	// Correction loop
	correctionCycle: number;
	// Auto-persona: auto-inject /skill:<agent> on flow transitions
	autoPersona: boolean;
	// Step timing
	stepStartedAt: string | null;
	// Marshal loop
	marshalLoop: MarshalLoop | null;
}

const CUSTOM_TYPE = "openspec-agent-state";

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Volatile — not persisted, reset on session start
	let _isWorking = false;
	let _currentAction: string | null = null;

	let state: AgentState = {
		current: null,
		history: [],
		workflow: null,
		workflowStep: 0,
		theme: "kimi",
		correctionCycle: 0,
		autoPersona: true,
		stepStartedAt: null,
		marshalLoop: null,
	};

	// ── Session State ──────────────────────────────────────────────────────────

	// Restore state from session entries on startup or session switch
	pi.on("session_start", async (_event, ctx) => {
		state = { current: null, history: [], workflow: null, workflowStep: 0, theme: "kimi", correctionCycle: 0, autoPersona: true, stepStartedAt: null, marshalLoop: null };

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data) {
				// Take the last state entry (most recent wins)
				state = { ...state, ...(entry.data as Partial<AgentState>) };
			}
		}

		// Apply defaults for new fields (backward compat with older persisted state)
		if (state.correctionCycle === undefined) state.correctionCycle = 0;
		if (state.autoPersona === undefined) state.autoPersona = true;
		if (state.stepStartedAt === undefined) state.stepStartedAt = null;
		if (state.marshalLoop === undefined) state.marshalLoop = null;
		state.theme = normalizeTheme(state.theme);

		_isWorking = false;
		_currentAction = null;
		updateStatus(ctx);
		updateWidget(ctx);
	});

	// ── Agent Working Indicator ───────────────────────────────────────────────

	pi.on("agent_start", async (_event, ctx) => {
		_isWorking = true;
		_currentAction = null;
		updateWidget(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		_isWorking = false;
		_currentAction = null;
		updateWidget(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		_currentAction = TOOL_ACTION_LABELS[event.toolName] ?? event.toolName;
		updateWidget(ctx);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		_currentAction = null;
		updateWidget(ctx);
	});

	// ── System Prompt Injection ────────────────────────────────────────────────

	// Inject active agent persona into system prompt on each turn
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state.current) return;

		const role = AGENT_ROLES[state.current];

		const workflowInfo =
			state.workflow && state.workflow in WORKFLOWS
				? (() => {
						const steps = WORKFLOWS[state.workflow!];
						const stepNum = state.workflowStep + 1;
						const total = steps.length;
						const next = steps[state.workflowStep + 1];
						const completionHint = next
							? `\nWhen your work is complete, call the \`flow_complete\` tool to automatically hand off to @${next}.`
							: `\nThis is the final step. Call \`flow_complete\` to complete the workflow.`;
						return `\n\n**Workflow**: ${state.workflow} \u2014 Step ${stepNum}/${total}${completionHint}`;
					})()
				: "";

		const injection = `\n\n---\n## Active Agent: ${role.emoji} ${role.label}\n\nYou are currently acting as the **${role.label}** agent in the OpenSpec multi-agent pipeline. Stay in character \u2014 follow the responsibilities and constraints of this role.${workflowInfo}\n\nTo switch agents: \`/skill:<agent>\` or \`/agent <name>\`\n---`;

		return {
			systemPrompt: event.systemPrompt + injection,
		};
	});

	// ── flow_complete tool ────────────────────────────────────────────────────

	pi.registerTool({
		name: "flow_complete",
		label: "Flow Complete",
		description: "Signal that the current agent has finished its work. Automatically advances to the next workflow step and loads the next agent persona. Call this when your deliverables for this step are done.",
		promptSnippet: "Signal step completion and auto-advance to the next agent in the workflow",
		parameters: Type.Object({
			notes: Type.Optional(Type.String({ description: "Optional handoff notes for the next agent" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.workflow) {
				return {
					content: [{ type: "text" as const, text: "No active workflow. Start one with /flow <standard|ui|tdd|review>." }],
					details: { advanced: false },
				};
			}

			const steps = WORKFLOWS[state.workflow];
			const stepDurationMs = state.stepStartedAt
				? Date.now() - new Date(state.stepStartedAt).getTime()
				: null;

			// Workflow complete
			if (state.workflowStep >= steps.length - 1) {
				logContextEntry(ctx, "workflow_complete", {
					workflow: state.workflow,
					stepDurationMs,
					totalCorrectionCycles: state.correctionCycle,
					notes: params.notes,
				});
				const completedWorkflow = state.workflow;
				state.workflow = null;
				state.workflowStep = 0;
				state.correctionCycle = 0;
				state.stepStartedAt = null;
				saveState();
				updateStatus(ctx);
				updateWidget(ctx);
				return {
					content: [{ type: "text" as const, text: `\ud83c\udf89 ${completedWorkflow.toUpperCase()} workflow complete! All agents have finished.${params.notes ? `\n\nFinal notes: ${params.notes}` : ""}` }],
					details: { advanced: true, complete: true, workflow: completedWorkflow },
				};
			}

			// Advance to next step
			const prevAgent = steps[state.workflowStep];
			const prevCorrectionCycle = state.correctionCycle;
			state.workflowStep++;
			const nextAgent = steps[state.workflowStep];
			state.correctionCycle = 0;
			state.stepStartedAt = new Date().toISOString();

			activateAgent(nextAgent, ctx);
			saveState();

			logContextEntry(ctx, "workflow_step", {
				workflow: state.workflow,
				step: state.workflowStep,
				agent: nextAgent,
				prev: prevAgent,
				stepDurationMs,
				correctionCycles: prevCorrectionCycle,
				notes: params.notes,
			});

			const remaining = steps.length - state.workflowStep - 1;
			const remainingStr = remaining > 0
				? `Remaining: ${steps.slice(state.workflowStep + 1).map((s) => `@${s}`).join(" \u2192 ")}`
				: "(last step)";

			const handoff = params.notes ? `\n\nHandoff notes: ${params.notes}` : "";
			const result = `\u2705 @${prevAgent} done \u2192 Step ${state.workflowStep + 1}/${steps.length}: ${AGENT_ROLES[nextAgent].emoji} @${nextAgent}\n${remainingStr}${handoff}`;

			// Auto-load next persona
			pi.sendUserMessage(`/skill:${nextAgent}`, { deliverAs: "followUp" });
			
			return {
				content: [{ type: "text" as const, text: result }],
				details: { advanced: true, complete: false, from: prevAgent, to: nextAgent, step: state.workflowStep },
			};
		},
	});


	// ── Marshal Tools ─────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "marshal_start",
		label: "Marshal Start",
		description: "Start a long-running iterative development loop. Creates .marshal/<name>.md with the task content and begins the first iteration.",
		promptSnippet: "Start an iterative loop with a task checklist and max iterations",
		parameters: Type.Object({
			name: Type.String({ description: "Loop name, e.g. 'refactor-auth'" }),
			taskContent: Type.String({ description: "Task in markdown with Goals and Checklist sections" }),
			maxIterations: Type.Optional(Type.Number({ description: "Max iterations (default: 50)" })),
			itemsPerIteration: Type.Optional(Type.Number({ description: "Suggest N items per turn, 0 = no limit (default: 0)" })),
			reflectEvery: Type.Optional(Type.Number({ description: "Insert a reflection checkpoint every N iterations" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const taskFile = join(ctx.cwd, ".marshal", `${params.name}.md`);
			mkdirSync(dirname(taskFile), { recursive: true });
			writeFileSync(taskFile, params.taskContent, "utf-8");

			const loop: MarshalLoop = {
				name: params.name,
				iteration: 0,
				maxIterations: params.maxIterations ?? 50,
				itemsPerIteration: params.itemsPerIteration ?? 0,
				reflectEvery: params.reflectEvery ?? 0,
				status: "running",
				startedAt: new Date().toISOString(),
			};
			state.marshalLoop = loop;
			saveState();

			pi.sendUserMessage(buildMarshalPrompt(loop, params.taskContent), { deliverAs: "followUp" });

			return {
				content: [{ type: "text" as const, text: `Started loop "${params.name}" (max ${loop.maxIterations} iterations).\nTask: .marshal/${params.name}.md` }],
				details: { name: params.name, maxIterations: loop.maxIterations },
			};
		},
	});

	pi.registerTool({
		name: "marshal_done",
		label: "Marshal Done",
		description: "Signal the end of the current Marshal loop iteration. Reads the updated task file and queues the next iteration. Do NOT call if you output <promise>COMPLETE</promise>.",
		promptSnippet: "Advance to the next Marshal loop iteration",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const loop = state.marshalLoop;
			if (!loop || loop.status !== "running") {
				return {
					content: [{ type: "text" as const, text: "No active Marshal loop." }],
					details: {},
				};
			}

			loop.iteration++;

			if (loop.iteration >= loop.maxIterations) {
				loop.status = "complete";
				saveState();
				if (ctx.hasUI) ctx.ui.notify(`⚠️ Marshal loop "${loop.name}" reached max iterations (${loop.maxIterations}).`, "warning");
				return {
					content: [{ type: "text" as const, text: `Max iterations (${loop.maxIterations}) reached. Loop stopped.` }],
					details: { stopped: true, reason: "max_iterations" },
				};
			}

			// Read updated task file (agent may have edited it this iteration)
			const taskFile = join(ctx.cwd, ".marshal", `${loop.name}.md`);
			let taskContent = "(task file not found)";
			try { taskContent = readFileSync(taskFile, "utf-8"); } catch { /* ok */ }

			saveState();
			pi.sendUserMessage(buildMarshalPrompt(loop, taskContent), { deliverAs: "followUp" });

			return {
				content: [{ type: "text" as const, text: `Iteration ${loop.iteration + 1}/${loop.maxIterations} queued.` }],
				details: { iteration: loop.iteration, maxIterations: loop.maxIterations },
			};
		},
	});

	// Detect <promise>COMPLETE</promise> in assistant messages to close the loop
	pi.on("message_end", async (event, ctx) => {
		const loop = state.marshalLoop;
		if (!loop || loop.status !== "running") return;

		const msg = event.message;
		if ((msg as { role?: string }).role !== "assistant") return;

		const content = (msg as { content?: Array<{ type: string; text?: string }> }).content ?? [];
		const text = content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");

		if (text.includes("<promise>COMPLETE</promise>")) {
			loop.status = "complete";
			saveState();
			if (ctx.hasUI) {
				ctx.ui.notify(`✅ Marshal loop "${loop.name}" complete after ${loop.iteration + 1} iteration${loop.iteration !== 0 ? "s" : ""}!`, "info");
			}
		}
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
				saveState();
				updateStatus(ctx);
				ctx.ui.notify(prev ? `Agent ${prev} deactivated` : "No active agent", "info");
				return;
			}

			if (isAgentName(cmd)) {
				activateAgent(cmd, ctx);
				const role = AGENT_ROLES[cmd];
				ctx.ui.notify(`Switched to ${role.emoji} ${role.label}\n\nLoad persona: /skill:${cmd}`, "info");
			} else {
				ctx.ui.notify(
					`Unknown agent: "${cmd}"\nAvailable: ${AGENT_NAMES.join(", ")}\n\nUsage: /agent <name|status|reset|list>`,
					"error",
				);
			}
		},
	});

	/**
	 * /flow <standard|ui|tdd|review|status|back|goto|skip|restart|retry|autopersona>
	 * Start, navigate, or inspect a multi-agent workflow
	 */
	pi.registerCommand("flow", {
		description: "Workflow control: /flow <name|status|back|goto|skip|restart|retry|autopersona>",
		handler: async (args, ctx) => {
			const [cmd, ...rest] = args.trim().split(/\s+/);
			const value = rest.join(" ");

			// ── status ──────────────────────────────────────────────────────────
			if (!cmd || cmd === "status") {
				if (!state.workflow) {
					const lines = [
						"No active workflow.\n",
						"Available workflows:",
						...WORKFLOW_NAMES.map((wf) => {
							const steps = WORKFLOWS[wf];
							const stepsStr = steps.map((s) => `${AGENT_ROLES[s].emoji} ${s}`).join(" → ");
							return `  • /flow ${wf}  ${stepsStr}`;
						}),
						"",
						"Navigation: /flow back | /flow goto <N|agent> | /flow skip | /flow restart",
						"Correction: /flow retry",
						`Auto-persona: ${state.autoPersona ? "on" : "off"} (/flow autopersona to toggle)`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
				} else {
					showStatus(ctx);
				}
				return;
			}

			// ── back ────────────────────────────────────────────────────────────
			if (cmd === "back") {
				if (!state.workflow) {
					ctx.ui.notify("No active workflow.", "error");
					return;
				}
				if (state.workflowStep === 0) {
					ctx.ui.notify("Already at step 1 — cannot go back.", "error");
					return;
				}
				const steps = WORKFLOWS[state.workflow];
				const from = steps[state.workflowStep];
				state.workflowStep--;
				const to = steps[state.workflowStep];
				state.correctionCycle = 0;
				state.stepStartedAt = new Date().toISOString();
				activateAgent(to, ctx);
				saveState();
				logContextEntry(ctx, "workflow_back", { from, to, step: state.workflowStep });
				const msg = `◀ Back to step ${state.workflowStep + 1}/${steps.length}: ${AGENT_ROLES[to].emoji} @${to}`;
				ctx.ui.notify(msg + (state.autoPersona ? `\n\nLoading persona...` : `\n\nLoad persona: /skill:${to}`), "info");
				if (state.autoPersona) pi.sendUserMessage(`/skill:${to}`, { deliverAs: "followUp" });
				return;
			}

			// ── goto ────────────────────────────────────────────────────────────
			if (cmd === "goto") {
				if (!state.workflow) {
					ctx.ui.notify("No active workflow.", "error");
					return;
				}
				const steps = WORKFLOWS[state.workflow];
				let targetStep = -1;

				const asNum = parseInt(value, 10);
				if (!isNaN(asNum) && asNum >= 1 && asNum <= steps.length) {
					targetStep = asNum - 1;
				} else if (isAgentName(value as AgentName)) {
					targetStep = steps.indexOf(value as AgentName);
				}

				if (targetStep === -1) {
					const hint = steps.map((s, i) => `  ${i + 1}. @${s}`).join("\n");
					ctx.ui.notify(`Invalid target: "${value}"\n\nSteps:\n${hint}\n\nUsage: /flow goto <1-${steps.length}|agent>`, "error");
					return;
				}

				const from = steps[state.workflowStep];
				state.workflowStep = targetStep;
				const to = steps[targetStep];
				state.correctionCycle = 0;
				state.stepStartedAt = new Date().toISOString();
				activateAgent(to, ctx);
				saveState();
				logContextEntry(ctx, "workflow_goto", { from, to, step: targetStep });
				ctx.ui.notify(
					`⤵ Jumped to step ${targetStep + 1}/${steps.length}: ${AGENT_ROLES[to].emoji} @${to}` +
					(state.autoPersona ? `\n\nLoading persona...` : `\n\nLoad persona: /skill:${to}`),
					"info",
				);
				if (state.autoPersona) pi.sendUserMessage(`/skill:${to}`, { deliverAs: "followUp" });
				return;
			}

			// ── skip ────────────────────────────────────────────────────────────
			if (cmd === "skip") {
				if (!state.workflow) {
					ctx.ui.notify("No active workflow.", "error");
					return;
				}
				const steps = WORKFLOWS[state.workflow];
				if (state.workflowStep >= steps.length - 1) {
					ctx.ui.notify("Cannot skip the last step — use /flow-next to complete.", "error");
					return;
				}
				const skipped = steps[state.workflowStep];
				state.workflowStep++;
				const next = steps[state.workflowStep];
				state.correctionCycle = 0;
				state.stepStartedAt = new Date().toISOString();
				activateAgent(next, ctx);
				saveState();
				logContextEntry(ctx, "workflow_skip", { skipped, next, step: state.workflowStep });
				ctx.ui.notify(
					`⏭ Skipped @${skipped} → step ${state.workflowStep + 1}/${steps.length}: ${AGENT_ROLES[next].emoji} @${next}` +
					(state.autoPersona ? `\n\nLoading persona...` : `\n\nLoad persona: /skill:${next}`),
					"warning",
				);
				if (state.autoPersona) pi.sendUserMessage(`/skill:${next}`, { deliverAs: "followUp" });
				return;
			}

			// ── restart ─────────────────────────────────────────────────────────
			if (cmd === "restart") {
				if (!state.workflow) {
					ctx.ui.notify("No active workflow.", "error");
					return;
				}
				const ok = await ctx.ui.confirm("Restart workflow?", `Reset ${state.workflow.toUpperCase()} to step 1?`);
				if (!ok) return;
				const steps = WORKFLOWS[state.workflow];
				state.workflowStep = 0;
				state.correctionCycle = 0;
				state.stepStartedAt = new Date().toISOString();
				activateAgent(steps[0], ctx);
				saveState();
				logContextEntry(ctx, "workflow_restart", { workflow: state.workflow });
				ctx.ui.notify(
					`🔄 Restarted ${state.workflow.toUpperCase()} from step 1: ${AGENT_ROLES[steps[0]].emoji} @${steps[0]}` +
					(state.autoPersona ? `\n\nLoading persona...` : `\n\nLoad persona: /skill:${steps[0]}`),
					"info",
				);
				if (state.autoPersona) pi.sendUserMessage(`/skill:${steps[0]}`, { deliverAs: "followUp" });
				return;
			}

			// ── retry ────────────────────────────────────────────────────────────
			if (cmd === "retry") {
				if (!state.workflow) {
					ctx.ui.notify("No active workflow.", "error");
					return;
				}
				state.correctionCycle++;
				saveState();
				updateStatus(ctx);
				const agent = state.current ? `@${state.current}` : "current agent";
				logContextEntry(ctx, "workflow_retry", { agent: state.current, cycle: state.correctionCycle });
				const sophosSuggestion = state.correctionCycle >= 2
					? `\n\n⚠️ ${state.correctionCycle} correction cycles — consider /skill:sophos for a second opinion.`
					: "";
				ctx.ui.notify(
					`🔁 Correction cycle ${state.correctionCycle} for ${agent}${sophosSuggestion}`,
					state.correctionCycle >= 2 ? "warning" : "info",
				);
				return;
			}

			// ── autopersona toggle ───────────────────────────────────────────────
			if (cmd === "autopersona") {
				state.autoPersona = !state.autoPersona;
				saveState();
				ctx.ui.notify(
					`Auto-persona ${state.autoPersona ? "✅ enabled" : "❌ disabled"}\n\n${state.autoPersona ? "Flow transitions will auto-load /skill:<agent>" : "Manual: use /skill:<agent> after each transition"}`
					, "info"
				);
				return;
			}

			// ── start workflow ───────────────────────────────────────────────────
			if (!isWorkflowName(cmd)) {
				const navCmds = "back | goto <N|agent> | skip | restart | retry | autopersona";
				ctx.ui.notify(
					`Unknown: "${cmd}"\n\nWorkflows: ${WORKFLOW_NAMES.join(", ")}\nNavigation: ${navCmds}\n\nUsage: /flow <workflow|command>`,
					"error",
				);
				return;
			}

			// Confirm if overriding an active workflow
			if (state.workflow && state.workflow !== cmd) {
				const steps = WORKFLOWS[state.workflow];
				const ok = await ctx.ui.confirm(
					"Replace active workflow?",
					`${state.workflow.toUpperCase()} is at step ${state.workflowStep + 1}/${steps.length} (@${state.current}). Start ${cmd.toUpperCase()} instead?`,
				);
				if (!ok) return;
			}

			// Start the workflow
			state.workflow = cmd;
			state.workflowStep = 0;
			state.correctionCycle = 0;
			state.stepStartedAt = new Date().toISOString();

			const steps = WORKFLOWS[cmd];
			const firstAgent = steps[0];

			activateAgent(firstAgent, ctx);
			saveState();

			const stepsStr = steps.map((s, i) => `  ${i + 1}. ${AGENT_ROLES[s].emoji} @${s}`).join("\n");

			ctx.ui.notify(
				`🚀 ${cmd.toUpperCase()} workflow started!\n\nPipeline:\n${stepsStr}\n\nCurrent: ${AGENT_ROLES[firstAgent].emoji} @${firstAgent}\n\n` +
				(state.autoPersona ? `Loading persona...` : `Load persona: /skill:${firstAgent}\nAdvance: /flow-next`),
				"info",
			);

			logContextEntry(ctx, "workflow_start", { workflow: cmd, steps });
			if (state.autoPersona) pi.sendUserMessage(`/skill:${firstAgent}`, { deliverAs: "followUp" });
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
				ctx.ui.notify(`No active workflow.\n\nStart one with: /flow <${WORKFLOW_NAMES.join("|")}>`, "error");
				return;
			}

			const steps = WORKFLOWS[state.workflow];

			// Log step duration
			const stepDurationMs = state.stepStartedAt
				? Date.now() - new Date(state.stepStartedAt).getTime()
				: null;

			if (state.workflowStep >= steps.length - 1) {
				// Workflow complete
				logContextEntry(ctx, "workflow_complete", {
					workflow: state.workflow,
					stepDurationMs,
					totalCorrectionCycles: state.correctionCycle,
				});
				const completedWorkflow = state.workflow;
				state.workflow = null;
				state.workflowStep = 0;
				state.correctionCycle = 0;
				state.stepStartedAt = null;
				saveState();
				updateStatus(ctx);
				updateWidget(ctx);
				ctx.ui.notify(`🎉 ${completedWorkflow.toUpperCase()} workflow complete!\n\nAll agents have finished.`, "info");
				return;
			}

			const prevAgent = steps[state.workflowStep];
			state.workflowStep++;
			const nextAgent = steps[state.workflowStep];
			const remaining = steps.length - state.workflowStep - 1;
			const prevCorrectionCycle = state.correctionCycle;
			state.correctionCycle = 0;
			state.stepStartedAt = new Date().toISOString();

			activateAgent(nextAgent, ctx);
			saveState();

			const remainingStr =
				remaining > 0
					? `\nRemaining: ${steps.slice(state.workflowStep + 1).map((s) => `@${s}`).join(" → ")}`
					: "\n(Last step)";

			const cycleInfo = prevCorrectionCycle > 0 ? ` (${prevCorrectionCycle} correction cycle${prevCorrectionCycle > 1 ? "s" : ""})` : "";

			ctx.ui.notify(
				`Step ${state.workflowStep + 1}/${steps.length}: ${AGENT_ROLES[nextAgent].emoji} @${nextAgent}\n\nPrevious: @${prevAgent} ✓${cycleInfo}${remainingStr}\n\n` +
				(state.autoPersona ? `Loading persona...` : `Load persona: /skill:${nextAgent}`),
				"info",
			);

			logContextEntry(ctx, "workflow_step", {
				workflow: state.workflow,
				step: state.workflowStep,
				agent: nextAgent,
				prev: prevAgent,
				stepDurationMs,
				correctionCycles: prevCorrectionCycle,
			});

			if (state.autoPersona) pi.sendUserMessage(`/skill:${nextAgent}`, { deliverAs: "followUp" });
		},
	});

	/**
	 * /swarm [show|compact|theme|themes|help]
	 * Dashboard for the agent swarm
	 */
	pi.registerCommand("swarm", {
		description: "Show Agent Swarm dashboard: /swarm [show|compact|theme|themes|help]",
		handler: async (args, ctx) => {
			const [cmd, value] = args.trim().split(/\s+/, 2);

			if (!cmd || cmd === "show") {
				showSwarmDashboard(ctx);
				return;
			}

			if (cmd === "compact") {
				const line = buildCompactSwarmLine();
				ctx.ui.notify(line, "info");
				return;
			}

			if (cmd === "help") {
				const themeHint = SWARM_THEME_NAMES.join("|");
				ctx.ui.notify(
					[
						"Agent Swarm Dashboard",
						"",
						"Commands:",
						"  /swarm            Show full dashboard",
						"  /swarm compact    Show single-line status",
						"  /swarm themes     List available themes",
						`  /swarm theme x    Set theme (${themeHint})`,
						"  /swarm help       Show this help",
						"",
						`Current theme: ${state.theme}`,
						"Tip: /agent status also opens the full dashboard.",
					].join("\n"),
					"info",
				);
				return;
			}

			if (cmd === "themes") {
				const list = SWARM_THEME_NAMES.map((name) => {
					const marker = state.theme === name ? "*" : " ";
					return `${marker} ${name.padEnd(10)} ${SWARM_THEMES[name].label}`;
				});
				ctx.ui.notify(["Swarm themes:", "", ...list, "", "Use: /swarm theme <name>"].join("\n"), "info");
				return;
			}

			if (cmd === "theme") {
				if (!value) {
					ctx.ui.notify(
						`Current theme: ${state.theme}\nAvailable: ${SWARM_THEME_NAMES.join(", ")}\nUse: /swarm theme <name>`,
						"info",
					);
					return;
				}

				if (!isSwarmTheme(value)) {
					ctx.ui.notify(`Unknown theme: "${value}"\nAvailable: ${SWARM_THEME_NAMES.join(", ")}`, "error");
					return;
				}

				state.theme = value;
				saveState();
				ctx.ui.notify(`Theme switched to ${value} (${SWARM_THEMES[value].label})`, "info");
				showSwarmDashboard(ctx);
				return;
			}

			ctx.ui.notify('Unknown option: "' + cmd + '"\nUse: /swarm [show|compact|theme|themes|help]', "error");
		},
	});

	/**
	 * /marshal <status|stop|resume>
	 * Manage Marshal loops
	 */
	pi.registerCommand("marshal", {
		description: "Manage Marshal loops: /marshal <status|stop|resume [name]>",
		handler: async (args, ctx) => {
			const [cmd, ...rest] = args.trim().split(/\s+/);
			const value = rest.join(" ");

			if (!cmd || cmd === "status") {
				const loop = state.marshalLoop;
				if (!loop) {
					ctx.ui.notify("No active Marshal loop.\n\nStart via: marshal_start tool", "info");
				} else {
					const elapsed = Math.round((Date.now() - new Date(loop.startedAt).getTime()) / 1000);
					ctx.ui.notify(
						[
							`Marshal loop: "${loop.name}"`,
							`Status    : ${loop.status}`,
							`Iteration : ${loop.iteration + 1}/${loop.maxIterations}`,
							`Items/turn: ${loop.itemsPerIteration || "unlimited"}`,
							`Elapsed   : ${elapsed}s`,
							`Task file : .marshal/${loop.name}.md`,
						].join("\n"),
						"info",
					);
				}
				return;
			}

			if (cmd === "stop") {
				if (!state.marshalLoop) { ctx.ui.notify("No active Marshal loop.", "error"); return; }
				state.marshalLoop.status = "paused";
				saveState();
				ctx.ui.notify(`Paused loop "${state.marshalLoop.name}" at iteration ${state.marshalLoop.iteration + 1}.`, "info");
				return;
			}

			if (cmd === "resume") {
				const loop = state.marshalLoop;
				if (!loop) { ctx.ui.notify("No loop to resume in this session.", "error"); return; }
				if (value && loop.name !== value) {
					ctx.ui.notify(`Loop "${value}" not found. Current: "${loop.name}".`, "error"); return;
				}
				loop.status = "running";
				saveState();
				const taskFile = join(ctx.cwd, ".marshal", `${loop.name}.md`);
				let taskContent = "(task file not found)";
				try { taskContent = readFileSync(taskFile, "utf-8"); } catch { /* ok */ }
				pi.sendUserMessage(buildMarshalPrompt(loop, taskContent), { deliverAs: "followUp" });
				ctx.ui.notify(`Resumed loop "${loop.name}" at iteration ${loop.iteration + 1}.`, "info");
				return;
			}

			ctx.ui.notify(`Unknown: "${cmd}"\nUsage: /marshal <status|stop|resume>`, "error");
		},
	});

	/**
	 * /marshal-stop
	 * Pause the active loop (use when agent is idle)
	 */
	pi.registerCommand("marshal-stop", {
		description: "Stop (pause) the active Marshal loop",
		handler: async (_args, ctx) => {
			if (!state.marshalLoop) { ctx.ui.notify("No active Marshal loop.", "error"); return; }
			state.marshalLoop.status = "paused";
			saveState();
			ctx.ui.notify(`Stopped loop "${state.marshalLoop.name}".`, "info");
		},
	});

	// ── Helpers ───────────────────────────────────────────────────────────────

	function buildMarshalPrompt(loop: MarshalLoop, taskContent: string): string {
		const divider = "─".repeat(71);
		const iterLabel = `Iteration ${loop.iteration + 1}/${loop.maxIterations}`;
		const itemsHint = loop.itemsPerIteration > 0
			? `**THIS ITERATION: Process approximately ${loop.itemsPerIteration} items, then call marshal_done.**`
			: `**Work on the next items from your checklist, then call marshal_done.**`;
		const reflectHint = loop.reflectEvery > 0 && loop.iteration > 0 && loop.iteration % loop.reflectEvery === 0
			? `\n\n**REFLECTION POINT** (every ${loop.reflectEvery} iterations): Assess progress before continuing.\n`
			: "";

		return [
			divider,
			`\ud83d\udd04 MARSHAL LOOP: ${loop.name} | ${iterLabel}`,
			divider,
			"",
			`## Current Task (from .marshal/${loop.name}.md)`,
			"",
			taskContent,
			"",
			"---",
			"",
			"## Instructions",
			"",
			`User controls: ESC pauses the assistant. Send a message to resume. Run /marshal-stop when idle to stop the loop.`,
			"",
			`You are in a Marshal loop (${iterLabel}).${reflectHint}`,
			"",
			itemsHint,
			"",
			`1. Work on the next items from your checklist`,
			`2. Update the task file (.marshal/${loop.name}.md) with your progress`,
			`3. When FULLY COMPLETE, respond with: <promise>COMPLETE</promise>`,
			`4. Otherwise, call the \`marshal_done\` tool to proceed to next iteration`,
		].join("\n");
	}

	function isAgentName(name: string): name is AgentName {
		return AGENT_NAMES.includes(name as AgentName);
	}

	function isWorkflowName(name: string): name is WorkflowName {
		return WORKFLOW_NAMES.includes(name as WorkflowName);
	}

	function isSwarmTheme(name: string): name is SwarmTheme {
		return SWARM_THEME_NAMES.includes(name as SwarmTheme);
	}

	function normalizeTheme(theme: unknown): SwarmTheme {
		if (typeof theme === "string" && isSwarmTheme(theme)) return theme;
		return "kimi";
	}

	function activateAgent(name: AgentName, ctx: ExtensionContext) {
		const prev = state.current;
		state.current = name;

		state.history.push({ agent: name, timestamp: new Date().toISOString(), workflowStep: state.workflowStep });
		// Cap history to last 50 entries
		if (state.history.length > 50) {
			state.history = state.history.slice(-50);
		}

		saveState();
		updateStatus(ctx);
		updateWidget(ctx);
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
			const retryPart = state.correctionCycle > 0 ? ` retry:${state.correctionCycle}` : "";
			workflowPart = ` [${state.workflow} ${state.workflowStep + 1}/${steps.length}${retryPart}]`;
		}

		ctx.ui.setStatus("openspec", `${role.emoji} ${role.label}${workflowPart}`);
	}

	function updateWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		if (!state.current) {
			ctx.ui.setWidget("openspec-agent", undefined);
			return;
		}

		// Snapshot volatile state for the render closure
		const snapAgent    = state.current;
		const snapWorkflow = state.workflow as WorkflowName | null;
		const snapStep     = state.workflowStep;
		const snapCycle    = state.correctionCycle;
		const snapAction   = _currentAction;
		const snapWorking  = _isWorking;

		const DOT_COLS = 12;

		ctx.ui.setWidget(
			"openspec-agent",
			(_tui, theme) => {
				const makeDotRow = (filled: number, total: number): string => {
					const n = Math.round(DOT_COLS * Math.max(0, Math.min(filled / Math.max(total, 1), 1)));
					return theme.fg("success", "●".repeat(n)) + theme.fg("dim", "·".repeat(DOT_COLS - n));
				};

				return {
					render(width: number): string[] {
						const t = theme;
						const lines: string[] = [];

						const hasWorkflow = !!(snapWorkflow && snapWorkflow in WORKFLOWS);

						// ── No workflow: minimal 2-line badge ────────────────────────
						if (!hasWorkflow) {
							const role   = AGENT_ROLES[snapAgent];
							const actDot = snapWorking ? t.fg("accent", "●") : t.fg("dim", "○");
							lines.push(truncateToWidth(
								`  ` + actDot + `  ` + t.fg(role.color, t.bold(`${role.emoji}  ${role.label.toUpperCase()}`)),
								width,
							));
							lines.push(t.fg("dim", "  └ ") + t.fg("dim", AGENT_BLURBS[snapAgent]));
							return lines;
						}

						// ── Full pipeline tree ───────────────────────────────────────
						const steps    = WORKFLOWS[snapWorkflow!];
						const total    = steps.length;
						const dotRow   = makeDotRow(snapStep + 1, total);
						const dotRowVW = DOT_COLS + 2; // dots + 2 trailing spaces

						for (let i = 0; i < steps.length; i++) {
							const stepName = steps[i];
							const stepRole = AGENT_ROLES[stepName];
							const stepNum  = (i + 1).toString().padStart(2, "0");
							const isActive = i === snapStep;
							const isDone   = i < snapStep;
							const isNext   = i === snapStep + 1;

							if (isDone) {
								// ── Completed: single dim line with ✓ ───────────────────
								const l = `  ` + t.fg("success", `✓`) + `  ` +
									t.fg("dim", `${stepRole.emoji}  ${stepRole.label.toUpperCase()}`);
								const r = t.fg("dim", stepNum) + `  `;
								const pad = Math.max(1, width - visibleWidth(l) - visibleWidth(r));
								lines.push(truncateToWidth(l + " ".repeat(pad) + r, width));

							} else if (isActive) {
								// ── Active: 3-line card with dot grid ───────────────────
								const actDot  = snapWorking ? t.fg("accent", "●") : t.fg("dim", "○");
								const l1Left  = `  ` + actDot + `  ` +
									t.fg(stepRole.color, t.bold(`${stepRole.emoji}  ${stepRole.label.toUpperCase()}`));
								const l1Right = t.fg("muted", stepNum) +
									(snapCycle > 0 ? t.fg("warning", ` ×${snapCycle}`) : ``) + `  `;
								const l1Pad   = Math.max(1, width - visibleWidth(l1Left) - visibleWidth(l1Right));
								lines.push(truncateToWidth(l1Left + " ".repeat(l1Pad) + l1Right, width));

								const actionLabel = snapAction ?? AGENT_BLURBS[stepName];
								const l2Left      = t.fg("dim", "  └ ") + t.fg("muted", actionLabel);
								const dotStartCol = width - dotRowVW;
								const l2Pad       = Math.max(1, dotStartCol - visibleWidth(l2Left));
								lines.push(truncateToWidth(l2Left + " ".repeat(l2Pad) + dotRow + `  `, width));
								lines.push(" ".repeat(Math.max(0, dotStartCol)) + dotRow + `  `);

							} else if (isNext) {
								// ── Next: muted single line with › marker ───────────────
								const l = `  ›  ` +
									t.fg("muted", `${stepRole.emoji}  ${stepRole.label.toUpperCase()}`);
								lines.push(truncateToWidth(l, width));

							} else {
								// ── Queued: dim single line with · marker ───────────────
								const l = `  ·  ` +
									t.fg("dim", `${stepRole.emoji}  ${stepRole.label}`);
								lines.push(truncateToWidth(l, width));
							}
						}

						return lines;
					},
					invalidate() {},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	function showStatus(ctx: ExtensionContext) {
		showSwarmDashboard(ctx);
	}

	function showSwarmDashboard(ctx: ExtensionContext) {
		const panel = renderSwarmDashboard();
		ctx.ui.notify(panel, "info");
	}

	function renderSwarmDashboard() {
		if (state.theme === "hangar") {
			return renderHangarSwarmDashboard();
		}

		const lines: string[] = [];
		const width = 100;
		const theme = SWARM_THEMES[normalizeTheme(state.theme)];

		const border = theme.border.repeat(width);
		const divider = theme.divider.repeat(width);

		lines.push(border);
		lines.push(centerText("AGENT SWARM V2", width));
		lines.push(centerText("Agent Swarm Command Theatre", width));
		lines.push(centerText(`Theme: ${theme.name} (${theme.label})`, width));
		lines.push(border);
		lines.push(sectionTitle("CONTROL", theme));

		if (state.current) {
			const role = AGENT_ROLES[state.current];
			const blurb = AGENT_BLURBS[state.current];
			lines.push(`Lead agent : ${role.emoji} ${role.label} (@${state.current})`);
			lines.push(`Objective  : ${blurb}`);
		} else {
			lines.push("Lead agent : none");
			lines.push("Objective  : select an agent with /agent <name> or /flow <name>");
		}
		lines.push(`Signal     : ${state.workflow ? "workflow locked" : "standby"}`);

		lines.push(divider);
		lines.push(sectionTitle("WORKFLOW", theme));

		if (state.workflow && state.workflow in WORKFLOWS) {
			const steps = WORKFLOWS[state.workflow];
			const current = steps[state.workflowStep];
			const next = steps[state.workflowStep + 1];

			lines.push(`Mode       : ${state.workflow.toUpperCase()} (${state.workflowStep + 1}/${steps.length})`);
			lines.push(`Progress   : ${renderWorkflowProgressBar(steps, state.workflowStep, 34, theme)} ${state.workflowStep + 1}/${steps.length}`);
			lines.push(`Route      : ${renderWorkflowPath(steps, state.workflowStep)}`);
			lines.push(`Current    : @${current}`);
			lines.push(next ? `Next       : @${next} (run /flow-next)` : "Next       : final step (run /flow-next to complete)");
		} else {
			lines.push("Mode       : none");
			lines.push("Progress   : [..................................] 0/0");
			lines.push("Route      : start with /flow standard | /flow ui | /flow tdd | /flow review");
		}

		lines.push(divider);
		lines.push(sectionTitle("AGENT CARDS", theme));
		lines.push(...renderAgentGrid(2, theme));

		if (state.history.length > 0) {
			lines.push(divider);
			lines.push(sectionTitle("TIMELINE", theme));
			const recent = state.history.slice(-6).reverse();
			for (let i = 0; i < recent.length; i++) {
				const h = recent[i];
				const t = h.timestamp.slice(11, 19);
				const pos = i === 0 ? "latest" : `t-${i}`;
				lines.push(`  ${pos.padEnd(7)} ${t}  @${h.agent}`);
			}
		}

		lines.push(divider);
		lines.push(sectionTitle("QUICK ACTIONS", theme));
		lines.push("  /agent list | /agent <name> | /agent reset");
		lines.push("  /flow <standard|ui|tdd|review> | /flow-next");
		lines.push(`  /swarm theme <${SWARM_THEME_NAMES.join("|")}> | /swarm themes`);
		lines.push("  /swarm compact");
		lines.push(border);

		return lines.join("\n");
	}

	function renderHangarSwarmDashboard() {
		const lines: string[] = [];
		const width = 118;
		const theme = SWARM_THEMES.hangar;
		const border = theme.border.repeat(width);
		const divider = theme.divider.repeat(width);

		lines.push(border);
		lines.push(centerText("AGENT SWARM V3", width));
		lines.push(centerText("Create Subagent | Hanging Cards Command Deck", width));
		lines.push(centerText("Theme: hangar (Kimi-inspired)", width));
		lines.push(border);
		lines.push(centerPill("[ Create Subagent ]   [ Role: " + getLeadAgentName() + " ]", width));
		lines.push(divider);
		lines.push(...renderHangingAgentGrid(4, theme));
		lines.push(divider);

		if (state.workflow && state.workflow in WORKFLOWS) {
			const steps = WORKFLOWS[state.workflow];
			lines.push(`Workflow : ${state.workflow.toUpperCase()} ${state.workflowStep + 1}/${steps.length}`);
			lines.push(`Progress : ${renderWorkflowProgressBar(steps, state.workflowStep, 42, theme)}`);
			lines.push(`Route    : ${renderWorkflowPath(steps, state.workflowStep)}`);
		} else {
			lines.push("Workflow : none");
			lines.push("Progress : [..........................................]");
			lines.push("Route    : /flow standard | /flow ui | /flow tdd | /flow review");
		}

		if (state.history.length > 0) {
			const recent = state.history.slice(-4).reverse();
			lines.push(`Recent   : ${recent.map((h) => `@${h.agent}`).join(" <- ")}`);
		}

		lines.push(divider);
		lines.push(`Commands : /swarm theme <${SWARM_THEME_NAMES.join("|")}> | /swarm compact | /flow-next`);
		lines.push(border);

		return lines.join("\n");
	}

	function renderHangingAgentGrid(columns: number, theme: ThemeTokens) {
		const cards = AGENT_NAMES.map((name) => renderHangingAgentCard(name, theme));
		const out: string[] = [];

		for (let i = 0; i < cards.length; i += columns) {
			const row = cards.slice(i, i + columns);
			const rowHeight = row[0].length;
			for (let line = 0; line < rowHeight; line++) {
				out.push(row.map((card) => card[line]).join("  "));
			}
		}

		return out;
	}

	function renderHangingAgentCard(name: AgentName, theme: ThemeTokens) {
		const inner = 24;
		const role = AGENT_ROLES[name];
		const active = state.current === name;
		const flow = getAgentFlowState(name);
		const blurb = truncate(AGENT_BLURBS[name], inner - 2);

		const stem = " ".repeat(Math.floor(inner / 2)) + "|" + " ".repeat(Math.ceil(inner / 2) - 1);
		const hook = " ".repeat(Math.floor(inner / 2) - 1) + "(_ )" + " ".repeat(Math.ceil(inner / 2) - 2);
		const top = `${theme.cardTopLeft}${theme.cardHorizontal.repeat(inner)}${theme.cardTopRight}`;
		const l1 = cardLine(`${active ? "*" : " "} ${role.emoji} ${name}`, inner, theme);
		const l2 = cardLine(role.label, inner, theme);
		const l3 = cardLine(blurb, inner, theme);
		const l4 = cardLine(`state: ${active ? "ACTIVE" : "IDLE"} | ${flow}`, inner, theme);
		const l5 = cardLine("KIMI", inner, theme);
		const bottom = `${theme.cardBottomLeft}${theme.cardHorizontal.repeat(inner)}${theme.cardBottomRight}`;

		return [stem, hook, top, l1, l2, l3, l4, l5, bottom];
	}

	function getLeadAgentName() {
		if (!state.current) return "none";
		return state.current;
	}

	function centerPill(text: string, width: number) {
		return centerText(text, width);
	}

	function renderWorkflowPath(steps: AgentName[], currentIndex: number) {
		return steps
			.map((step, idx) => {
				if (idx < currentIndex) return `@${step}`;
				if (idx === currentIndex) return `[${step}]`;
				return step;
			})
			.join(" -> ");
	}

	function renderWorkflowProgressBar(steps: AgentName[], currentIndex: number, size: number, theme: ThemeTokens) {
		const total = steps.length;
		if (total <= 0) return `[${theme.progressEmpty.repeat(size)}]`;

		const ratio = Math.max(0, Math.min(1, (currentIndex + 1) / total));
		const filled = Math.round(size * ratio);
		const headIndex = Math.max(0, Math.min(size - 1, filled - 1));

		let body = "";
		for (let i = 0; i < size; i++) {
			if (i < headIndex) body += theme.progressFill;
			else if (i === headIndex) body += theme.progressHead;
			else body += theme.progressEmpty;
		}

		return `[${body}]`;
	}

	function renderAgentGrid(columns: number, theme: ThemeTokens) {
		const cells = AGENT_NAMES.map((name) => renderAgentCard(name, theme));
		const gridLines: string[] = [];

		for (let i = 0; i < cells.length; i += columns) {
			const row = cells.slice(i, i + columns);
			const height = row[0].length;

			for (let line = 0; line < height; line++) {
				const content = row.map((cell) => cell[line]).join("  ");
				gridLines.push(content);
			}
		}

		return gridLines;
	}

	function renderAgentCard(name: AgentName, theme: ThemeTokens) {
		const inner = 46;
		const role = AGENT_ROLES[name];
		const active = state.current === name;
		const status = active ? "ACTIVE" : "IDLE";
		const flowState = getAgentFlowState(name);
		const blurb = AGENT_BLURBS[name];

		const top = `${theme.cardTopLeft}${theme.cardHorizontal.repeat(inner)}${theme.cardTopRight}`;
		const l1 = cardLine(`${active ? "*" : " "} ${role.emoji} @${name.toUpperCase()}  ${status}`, inner, theme);
		const l2 = cardLine(`${role.label} | flow: ${flowState}`, inner, theme);
		const l3 = cardLine(blurb, inner, theme);
		const bottom = `${theme.cardBottomLeft}${theme.cardHorizontal.repeat(inner)}${theme.cardBottomRight}`;

		return [top, l1, l2, l3, bottom];
	}

	function getAgentFlowState(name: AgentName) {
		if (!state.workflow || !(state.workflow in WORKFLOWS)) return "standby";
		const steps = WORKFLOWS[state.workflow];
		const idx = steps.indexOf(name);
		if (idx === -1) return "offline";
		if (idx < state.workflowStep) return "done";
		if (idx === state.workflowStep) return "now";
		if (idx === state.workflowStep + 1) return "next";
		return "queued";
	}

	function cardLine(text: string, inner: number, theme: ThemeTokens) {
		return `${theme.cardVertical} ${truncate(text, inner - 2).padEnd(inner - 2)} ${theme.cardVertical}`;
	}

	function truncate(text: string, maxLen: number) {
		if (text.length <= maxLen) return text;
		if (maxLen <= 3) return text.slice(0, maxLen);
		return `${text.slice(0, maxLen - 3)}...`;
	}

	function sectionTitle(text: string, theme: ThemeTokens) {
		return `${theme.sectionOpen} ${text} ${theme.sectionClose}`;
	}

	function centerText(text: string, width: number) {
		if (text.length >= width) return text;
		const left = Math.floor((width - text.length) / 2);
		return `${" ".repeat(left)}${text}`;
	}

	function buildCompactSwarmLine() {
		const agent = state.current ? `@${state.current}` : "none";
		if (!state.workflow || !(state.workflow in WORKFLOWS)) {
			return `Swarm | theme ${state.theme} | agent ${agent} | workflow none`;
		}

		const steps = WORKFLOWS[state.workflow];
		const pct = Math.round(((state.workflowStep + 1) / steps.length) * 100);
		return `Swarm | theme ${state.theme} | agent ${agent} | ${state.workflow} ${state.workflowStep + 1}/${steps.length} | ${pct}%`;
	}

	// Note: pi.appendEntry is append-only (no overwrite). Entries accumulate in the session;
	// session_start iterates all of them and keeps the last one (most-recent-wins). Pi API constraint.
	function saveState() {
		try {
			pi.appendEntry(CUSTOM_TYPE, { ...state });
		} catch {
			// Ignore — persistence is best-effort
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
				...data,
				seq: _logSeq++,        // always wins — monotonic counter
				timestamp: new Date().toISOString(),
				type,                  // base fields always override caller data
				agent: state.current,
				workflow: state.workflow,
			});

			appendFileSync(logPath, entry + "\n", "utf-8");
		} catch {
			// Context log is best-effort, never throw
		}
	}
}
