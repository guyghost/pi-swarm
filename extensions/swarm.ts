/**
 * OpenSpec Multi-Agent Pipeline Extension for Pi
 *
 * Implements the Orchestrator-Workers-Synthesizer pattern.
 *
 * Features:
 *   - Active agent tracking across turns (persisted in session)
 *   - Agent persona injection into system prompt via before_agent_start
 *   - Status bar showing current agent + workflow step
 *   - TUI widget with agent cards during workflows
 *   - flow_complete tool — agent calls it to auto-advance to next step
 *   - /agent <name|status|reset|list> command
 *   - /flow <standard|ui|tdd|review|status> command
 *   - /flow-next to advance workflow step
 *   - /swarm compact status line
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
	correctionCycle: number;
	autoPersona: boolean;
	stepStartedAt: string | null;
	marshalLoop: MarshalLoop | null;
}

const CUSTOM_TYPE = "openspec-agent-state";

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let _isWorking = false;
	let _currentAction: string | null = null;

	let state: AgentState = {
		current: null,
		history: [],
		workflow: null,
		workflowStep: 0,
		correctionCycle: 0,
		autoPersona: true,
		stepStartedAt: null,
		marshalLoop: null,
	};

	// ── Session State ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		state = { current: null, history: [], workflow: null, workflowStep: 0, correctionCycle: 0, autoPersona: true, stepStartedAt: null, marshalLoop: null };

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data) {
				state = { ...state, ...(entry.data as Partial<AgentState>) };
			}
		}

		if (state.correctionCycle === undefined) state.correctionCycle = 0;
		if (state.autoPersona === undefined) state.autoPersona = true;
		if (state.stepStartedAt === undefined) state.stepStartedAt = null;
		if (state.marshalLoop === undefined) state.marshalLoop = null;

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
						return `\n\n**Workflow**: ${state.workflow} — Step ${stepNum}/${total}${completionHint}`;
					})()
				: "";

		const injection = `\n\n---\n## Active Agent: ${role.emoji} ${role.label}\n\nYou are currently acting as the **${role.label}** agent in the OpenSpec multi-agent pipeline. Stay in character — follow the responsibilities and constraints of this role.${workflowInfo}\n\nTo switch agents: \`/skill:<agent>\` or \`/agent <name>\`\n---`;

		return { systemPrompt: event.systemPrompt + injection };
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
			const stepDurationMs = state.stepStartedAt ? Date.now() - new Date(state.stepStartedAt).getTime() : null;

			if (state.workflowStep >= steps.length - 1) {
				logContextEntry(ctx, "workflow_complete", { workflow: state.workflow, stepDurationMs, totalCorrectionCycles: state.correctionCycle, notes: params.notes });
				const completedWorkflow = state.workflow;
				state.workflow = null;
				state.workflowStep = 0;
				state.correctionCycle = 0;
				state.stepStartedAt = null;
				saveState();
				updateStatus(ctx);
				updateWidget(ctx);
				return {
					content: [{ type: "text" as const, text: `🎉 ${completedWorkflow.toUpperCase()} workflow complete! All agents have finished.${params.notes ? `\n\nFinal notes: ${params.notes}` : ""}` }],
					details: { advanced: true, complete: true, workflow: completedWorkflow },
				};
			}

			const prevAgent = steps[state.workflowStep];
			const prevCorrectionCycle = state.correctionCycle;
			state.workflowStep++;
			const nextAgent = steps[state.workflowStep];
			state.correctionCycle = 0;
			state.stepStartedAt = new Date().toISOString();

			activateAgent(nextAgent, ctx);
			saveState();

			logContextEntry(ctx, "workflow_step", { workflow: state.workflow, step: state.workflowStep, agent: nextAgent, prev: prevAgent, stepDurationMs, correctionCycles: prevCorrectionCycle, notes: params.notes });

			const remaining = steps.length - state.workflowStep - 1;
			const remainingStr = remaining > 0 ? `Remaining: ${steps.slice(state.workflowStep + 1).map((s) => `@${s}`).join(" → ")}` : "(last step)";
			const handoff = params.notes ? `\n\nHandoff notes: ${params.notes}` : "";
			const result = `✅ @${prevAgent} done → Step ${state.workflowStep + 1}/${steps.length}: ${AGENT_ROLES[nextAgent].emoji} @${nextAgent}\n${remainingStr}${handoff}`;

			pi.sendUserMessage(`/skill:${nextAgent}`, { deliverAs: "followUp" });

			return {
				content: [{ type: "text" as const, text: result }],
				details: { advanced: true, complete: false, from: prevAgent, to: nextAgent, step: state.workflowStep },
			};
		},
	});

	// ── Marshal Tools ─────────────────────────────────────────────────────────

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
				return { content: [{ type: "text" as const, text: "No active Marshal loop." }], details: {} };
			}

			loop.iteration++;

			if (loop.iteration >= loop.maxIterations) {
				loop.status = "complete";
				saveState();
				if (ctx.hasUI) ctx.ui.notify(`⚠️ Marshal loop "${loop.name}" reached max iterations (${loop.maxIterations}).`, "warning");
				return { content: [{ type: "text" as const, text: `Max iterations (${loop.maxIterations}) reached. Loop stopped.` }], details: { stopped: true, reason: "max_iterations" } };
			}

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
		const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");

		if (text.includes("<promise>COMPLETE</promise>")) {
			loop.status = "complete";
			saveState();
			if (ctx.hasUI) {
				ctx.ui.notify(`✅ Marshal loop "${loop.name}" complete after ${loop.iteration + 1} iteration${loop.iteration !== 0 ? "s" : ""}!`, "info");
			}
		}
	});

	// ── Input Interception ────────────────────────────────────────────────────

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

	pi.registerCommand("agent", {
		description: "Manage active agent: /agent <name|status|reset|list>",
		handler: async (args, ctx) => {
			const [cmd] = args.trim().split(/\s+/);

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
				ctx.ui.notify(`Unknown agent: "${cmd}"\nAvailable: ${AGENT_NAMES.join(", ")}\n\nUsage: /agent <name|status|reset|list>`, "error");
			}
		},
	});

	pi.registerCommand("flow", {
		description: "Workflow control: /flow <name|status|back|goto|skip|restart|retry|autopersona>",
		handler: async (args, ctx) => {
			const [cmd, ...rest] = args.trim().split(/\s+/);
			const value = rest.join(" ");

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

			if (cmd === "back") {
				if (!state.workflow) { ctx.ui.notify("No active workflow.", "error"); return; }
				if (state.workflowStep === 0) { ctx.ui.notify("Already at step 1 — cannot go back.", "error"); return; }
				const steps = WORKFLOWS[state.workflow];
				const from = steps[state.workflowStep];
				state.workflowStep--;
				const to = steps[state.workflowStep];
				state.correctionCycle = 0;
				state.stepStartedAt = new Date().toISOString();
				activateAgent(to, ctx);
				saveState();
				logContextEntry(ctx, "workflow_back", { from, to, step: state.workflowStep });
				ctx.ui.notify(`◀ Back to step ${state.workflowStep + 1}/${steps.length}: ${AGENT_ROLES[to].emoji} @${to}`, "info");
				if (state.autoPersona) pi.sendUserMessage(`/skill:${to}`, { deliverAs: "followUp" });
				return;
			}

			if (cmd === "goto") {
				if (!state.workflow) { ctx.ui.notify("No active workflow.", "error"); return; }
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
				ctx.ui.notify(`⤵ Jumped to step ${targetStep + 1}/${steps.length}: ${AGENT_ROLES[to].emoji} @${to}`, "info");
				if (state.autoPersona) pi.sendUserMessage(`/skill:${to}`, { deliverAs: "followUp" });
				return;
			}

			if (cmd === "skip") {
				if (!state.workflow) { ctx.ui.notify("No active workflow.", "error"); return; }
				const steps = WORKFLOWS[state.workflow];
				if (state.workflowStep >= steps.length - 1) { ctx.ui.notify("Cannot skip the last step — use /flow-next to complete.", "error"); return; }
				const skipped = steps[state.workflowStep];
				state.workflowStep++;
				const next = steps[state.workflowStep];
				state.correctionCycle = 0;
				state.stepStartedAt = new Date().toISOString();
				activateAgent(next, ctx);
				saveState();
				logContextEntry(ctx, "workflow_skip", { skipped, next, step: state.workflowStep });
				ctx.ui.notify(`⏭ Skipped @${skipped} → step ${state.workflowStep + 1}/${steps.length}: ${AGENT_ROLES[next].emoji} @${next}`, "warning");
				if (state.autoPersona) pi.sendUserMessage(`/skill:${next}`, { deliverAs: "followUp" });
				return;
			}

			if (cmd === "restart") {
				if (!state.workflow) { ctx.ui.notify("No active workflow.", "error"); return; }
				const ok = await ctx.ui.confirm("Restart workflow?", `Reset ${state.workflow.toUpperCase()} to step 1?`);
				if (!ok) return;
				const steps = WORKFLOWS[state.workflow];
				state.workflowStep = 0;
				state.correctionCycle = 0;
				state.stepStartedAt = new Date().toISOString();
				activateAgent(steps[0], ctx);
				saveState();
				logContextEntry(ctx, "workflow_restart", { workflow: state.workflow });
				ctx.ui.notify(`🔄 Restarted ${state.workflow.toUpperCase()} from step 1: ${AGENT_ROLES[steps[0]].emoji} @${steps[0]}`, "info");
				if (state.autoPersona) pi.sendUserMessage(`/skill:${steps[0]}`, { deliverAs: "followUp" });
				return;
			}

			if (cmd === "retry") {
				if (!state.workflow) { ctx.ui.notify("No active workflow.", "error"); return; }
				state.correctionCycle++;
				saveState();
				updateStatus(ctx);
				const agent = state.current ? `@${state.current}` : "current agent";
				logContextEntry(ctx, "workflow_retry", { agent: state.current, cycle: state.correctionCycle });
				const sophosSuggestion = state.correctionCycle >= 2 ? `\n\n⚠️ ${state.correctionCycle} correction cycles — consider /skill:sophos for a second opinion.` : "";
				ctx.ui.notify(`🔁 Correction cycle ${state.correctionCycle} for ${agent}${sophosSuggestion}`, state.correctionCycle >= 2 ? "warning" : "info");
				return;
			}

			if (cmd === "autopersona") {
				state.autoPersona = !state.autoPersona;
				saveState();
				ctx.ui.notify(`Auto-persona ${state.autoPersona ? "✅ enabled" : "❌ disabled"}`, "info");
				return;
			}

			if (!isWorkflowName(cmd)) {
				ctx.ui.notify(`Unknown: "${cmd}"\n\nWorkflows: ${WORKFLOW_NAMES.join(", ")}\nNavigation: back | goto | skip | restart | retry | autopersona\n\nUsage: /flow <workflow|command>`, "error");
				return;
			}

			if (state.workflow && state.workflow !== cmd) {
				const steps = WORKFLOWS[state.workflow];
				const ok = await ctx.ui.confirm("Replace active workflow?", `${state.workflow.toUpperCase()} is at step ${state.workflowStep + 1}/${steps.length} (@${state.current}). Start ${cmd.toUpperCase()} instead?`);
				if (!ok) return;
			}

			state.workflow = cmd;
			state.workflowStep = 0;
			state.correctionCycle = 0;
			state.stepStartedAt = new Date().toISOString();

			const steps = WORKFLOWS[cmd];
			const firstAgent = steps[0];
			activateAgent(firstAgent, ctx);
			saveState();

			const stepsStr = steps.map((s, i) => `  ${i + 1}. ${AGENT_ROLES[s].emoji} @${s}`).join("\n");
			ctx.ui.notify(`🚀 ${cmd.toUpperCase()} workflow started!\n\nPipeline:\n${stepsStr}\n\nCurrent: ${AGENT_ROLES[firstAgent].emoji} @${firstAgent}`, "info");

			logContextEntry(ctx, "workflow_start", { workflow: cmd, steps });
			if (state.autoPersona) pi.sendUserMessage(`/skill:${firstAgent}`, { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("flow-next", {
		description: "Advance to the next step in the active workflow",
		handler: async (_args, ctx) => {
			if (!state.workflow) {
				ctx.ui.notify(`No active workflow.\n\nStart one with: /flow <${WORKFLOW_NAMES.join("|")}>`, "error");
				return;
			}

			const steps = WORKFLOWS[state.workflow];
			const stepDurationMs = state.stepStartedAt ? Date.now() - new Date(state.stepStartedAt).getTime() : null;

			if (state.workflowStep >= steps.length - 1) {
				logContextEntry(ctx, "workflow_complete", { workflow: state.workflow, stepDurationMs, totalCorrectionCycles: state.correctionCycle });
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

			const remainingStr = remaining > 0 ? `\nRemaining: ${steps.slice(state.workflowStep + 1).map((s) => `@${s}`).join(" → ")}` : "\n(Last step)";
			const cycleInfo = prevCorrectionCycle > 0 ? ` (${prevCorrectionCycle} correction cycle${prevCorrectionCycle > 1 ? "s" : ""})` : "";

			ctx.ui.notify(`Step ${state.workflowStep + 1}/${steps.length}: ${AGENT_ROLES[nextAgent].emoji} @${nextAgent}\n\nPrevious: @${prevAgent} ✓${cycleInfo}${remainingStr}`, "info");

			logContextEntry(ctx, "workflow_step", { workflow: state.workflow, step: state.workflowStep, agent: nextAgent, prev: prevAgent, stepDurationMs, correctionCycles: prevCorrectionCycle });
			if (state.autoPersona) pi.sendUserMessage(`/skill:${nextAgent}`, { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("swarm", {
		description: "Show Agent Swarm status: /swarm [compact|help]",
		handler: async (args, ctx) => {
			const [cmd] = args.trim().split(/\s+/, 1);

			if (!cmd || cmd === "compact") {
				ctx.ui.notify(buildCompactSwarmLine(), "info");
				return;
			}

			if (cmd === "help") {
				ctx.ui.notify([
					"Agent Swarm",
					"",
					"Commands:",
					"  /swarm            Compact status line",
					"  /swarm help       This help",
					"  /agent list       List all agents",
					"  /flow status      Workflow status",
				].join("\n"), "info");
				return;
			}

			ctx.ui.notify(`Unknown: "${cmd}"\nUse: /swarm [compact|help]`, "error");
		},
	});

	pi.registerCommand("marshal", {
		description: "Manage Marshal loops: /marshal <status|stop|resume>",
		handler: async (args, ctx) => {
			const [cmd, ...rest] = args.trim().split(/\s+/);
			const value = rest.join(" ");

			if (!cmd || cmd === "status") {
				const loop = state.marshalLoop;
				if (!loop) {
					ctx.ui.notify("No active Marshal loop.\n\nStart via: marshal_start tool", "info");
				} else {
					const elapsed = Math.round((Date.now() - new Date(loop.startedAt).getTime()) / 1000);
					ctx.ui.notify([
						`Marshal loop: "${loop.name}"`,
						`Status    : ${loop.status}`,
						`Iteration : ${loop.iteration + 1}/${loop.maxIterations}`,
						`Items/turn: ${loop.itemsPerIteration || "unlimited"}`,
						`Elapsed   : ${elapsed}s`,
						`Task file : .marshal/${loop.name}.md`,
					].join("\n"), "info");
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
				if (!loop) { ctx.ui.notify("No loop to resume.", "error"); return; }
				if (value && loop.name !== value) { ctx.ui.notify(`Loop "${value}" not found. Current: "${loop.name}".`, "error"); return; }
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
			`🔄 MARSHAL LOOP: ${loop.name} | ${iterLabel}`,
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

	function activateAgent(name: AgentName, ctx: ExtensionContext) {
		const prev = state.current;
		state.current = name;
		state.history.push({ agent: name, timestamp: new Date().toISOString(), workflowStep: state.workflowStep });
		if (state.history.length > 50) state.history = state.history.slice(-50);
		saveState();
		updateStatus(ctx);
		updateWidget(ctx);
		logContextEntry(ctx, "agent_switch", { from: prev, to: name });
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!state.current) { ctx.ui.setStatus("openspec", ""); return; }

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

		const snapAgent = state.current;
		const snapWorkflow = state.workflow as WorkflowName | null;
		const snapStep = state.workflowStep;
		const snapCycle = state.correctionCycle;
		const snapAction = _currentAction;
		const snapWorking = _isWorking;

		const usage = ctx.getContextUsage();
		const ctxWindow = (ctx.model as Record<string, unknown>)?.contextWindow as number ?? 200000;
		const ctxPct = usage ? Math.min(1, ((usage as Record<string, unknown>).tokens as number ?? 0) / ctxWindow) : 0;

		const DOT_COLS = 8;
		const CARD_GAP = 1;
		const CARD_LINES = 4;

		ctx.ui.setWidget(
			"openspec-agent",
			(_tui, theme) => {
				const t = theme;

				const dotRow = (pct: number): string => {
					const n = Math.round(DOT_COLS * Math.max(0, Math.min(1, pct)));
					return t.fg("success", "●".repeat(n)) + t.fg("dim", "·".repeat(DOT_COLS - n));
				};

				const fit = (str: string, w: number): string => {
					const vw = visibleWidth(str);
					if (vw > w) return truncateToWidth(str, w);
					if (vw < w) return str + " ".repeat(w - vw);
					return str;
				};

				return {
					render(width: number): string[] {
						const hasWf = !!(snapWorkflow && snapWorkflow in WORKFLOWS);

						if (!hasWf) {
							const role = AGENT_ROLES[snapAgent];
							const actDot = snapWorking ? t.fg("accent", "●") : t.fg("dim", "○");
							return [
								truncateToWidth(`  ` + actDot + `  ` + t.fg(role.color, t.bold(`${role.emoji}  ${role.label.toUpperCase()}`)), width),
								t.fg("dim", "  └ ") + t.fg("dim", AGENT_BLURBS[snapAgent]),
							];
						}

						const steps = WORKFLOWS[snapWorkflow!];
						const numCards = steps.length;
						let cardW = Math.floor((width - (numCards - 1) * CARD_GAP) / numCards);
						cardW = Math.max(20, Math.min(30, cardW));
						const perRow = Math.max(1, Math.floor((width + CARD_GAP) / (cardW + CARD_GAP)));
						const inner = cardW - 2;

						const cards: string[][] = steps.map((name, i) => {
							const role = AGENT_ROLES[name];
							const isDone = i < snapStep;
							const isActive = i === snapStep;
							const stepNum = (i + 1).toString().padStart(2, "0");

							const b = isActive
								? (s: string) => t.fg(role.color, s)
								: isDone
									? (s: string) => t.fg("success", s)
									: (s: string) => t.fg("dim", s);

							const top = b("┌" + "─".repeat(inner) + "┐");
							const bot = b("└" + "─".repeat(inner) + "┘");

							const icon = isDone
								? t.fg("success", "✓")
								: isActive
									? (snapWorking ? t.fg("accent", "●") : t.fg("dim", "○"))
									: t.fg("dim", "·");

							const nameStyled = isActive
								? t.fg(role.color, t.bold(role.label))
								: isDone
									? t.fg("muted", role.label)
									: t.fg("dim", role.label);

							const l1Left = ` ${icon} ${role.emoji} ${nameStyled}`;
							const l1Right = (isActive ? t.fg("muted", stepNum) : t.fg("dim", stepNum))
								+ (isActive && snapCycle > 0 ? t.fg("warning", `×${snapCycle}`) : "");
							const l1Gap = Math.max(1, inner - visibleWidth(l1Left) - visibleWidth(l1Right));
							const line1 = b("│") + fit(l1Left + " ".repeat(l1Gap) + l1Right, inner) + b("│");

							const dots = isDone ? dotRow(1) : isActive ? dotRow(ctxPct) : dotRow(0);

							let l2Content: string;
							if (isActive) {
								const actionStr = snapAction ?? truncate(AGENT_BLURBS[name], inner - DOT_COLS - 4);
								const prefix = t.fg("dim", "└ ") + t.fg("muted", truncate(actionStr, inner - DOT_COLS - 4));
								const l2Gap = Math.max(1, inner - visibleWidth(prefix) - DOT_COLS);
								l2Content = prefix + " ".repeat(l2Gap) + dots;
							} else {
								l2Content = " ".repeat(Math.max(0, inner - DOT_COLS)) + dots;
							}
							const line2 = b("│") + fit(l2Content, inner) + b("│");

							return [top, line1, line2, bot];
						});

						const gap = " ".repeat(CARD_GAP);
						const allLines: string[] = [];
						for (let r = 0; r < numCards; r += perRow) {
							const rowCards = cards.slice(r, r + perRow);
							for (let ln = 0; ln < CARD_LINES; ln++) {
								allLines.push(rowCards.map(c => c[ln]).join(gap));
							}
						}

						return allLines;
					},
					invalidate() {},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	function showStatus(ctx: ExtensionContext) {
		if (!state.current && !state.workflow) {
			ctx.ui.notify("No active agent or workflow.\n\nUse /agent <name> or /flow <workflow> to start.", "info");
			return;
		}

		const lines: string[] = [];

		if (state.current) {
			const role = AGENT_ROLES[state.current];
			lines.push(`Agent: ${role.emoji} ${role.label} (@${state.current})`);
			lines.push(`Role: ${AGENT_BLURBS[state.current]}`);
		}

		if (state.workflow && state.workflow in WORKFLOWS) {
			const steps = WORKFLOWS[state.workflow];
			const route = steps.map((s, i) => i === state.workflowStep ? `[${s}]` : i < state.workflowStep ? `✓${s}` : s).join(" → ");
			lines.push(`\nWorkflow: ${state.workflow.toUpperCase()} (${state.workflowStep + 1}/${steps.length})`);
			lines.push(`Route: ${route}`);
			if (state.correctionCycle > 0) lines.push(`Correction cycles: ${state.correctionCycle}`);
		}

		if (state.history.length > 0) {
			const recent = state.history.slice(-5).reverse();
			lines.push(`\nRecent: ${recent.map((h) => `@${h.agent}`).join(" ← ")}`);
		}

		ctx.ui.notify(lines.join("\n"), "info");
	}

	function buildCompactSwarmLine() {
		const agent = state.current ? `@${state.current}` : "none";
		if (!state.workflow || !(state.workflow in WORKFLOWS)) {
			return `Swarm | agent ${agent} | workflow none`;
		}
		const steps = WORKFLOWS[state.workflow];
		const pct = Math.round(((state.workflowStep + 1) / steps.length) * 100);
		return `Swarm | agent ${agent} | ${state.workflow} ${state.workflowStep + 1}/${steps.length} | ${pct}%`;
	}

	function truncate(text: string, maxLen: number) {
		if (text.length <= maxLen) return text;
		if (maxLen <= 3) return text.slice(0, maxLen);
		return `${text.slice(0, maxLen - 3)}...`;
	}

	function saveState() {
		try { pi.appendEntry(CUSTOM_TYPE, { ...state }); } catch { /* best-effort */ }
	}

	function logContextEntry(ctx: ExtensionContext, type: string, data: Record<string, unknown>) {
		try {
			const logPath = join(ctx.cwd, "context-log.jsonl");
			const logDir = dirname(logPath);
			if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

			const entry = JSON.stringify({
				...data,
				seq: _logSeq++,
				timestamp: new Date().toISOString(),
				type,
				agent: state.current,
				workflow: state.workflow,
			});

			appendFileSync(logPath, entry + "\n", "utf-8");
		} catch { /* best-effort */ }
	}
}
