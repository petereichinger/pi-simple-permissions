import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type BashRule = { source: string; regex: RegExp };

const WRITING_TOOLS = new Set(["write", "edit"]);

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return (
		rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel))
	);
}

async function realpathOrResolve(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

// Canonicalize existing paths, and for new files canonicalize the nearest
// existing parent. This prevents `cwd/link-to-/tmp/file` from being treated as
// inside CWD just because the textual path starts with CWD.
async function canonicalizeForPolicy(absolutePath: string): Promise<string> {
	let current = absolutePath;
	const missingParts: string[] = [];

	while (true) {
		try {
			const real = await realpath(current);
			return missingParts.length === 0
				? real
				: resolve(real, ...missingParts);
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(absolutePath);
			missingParts.unshift(basename(current));
			current = parent;
		}
	}
}

function addExactRule(command: string, rules: BashRule[]): BashRule {
	const source = `^${escapeRegExp(command)}$`;
	const rule = { source, regex: new RegExp(source) };
	rules.push(rule);
	return rule;
}

function allowedByBashRules(
	command: string,
	rules: BashRule[],
): BashRule | undefined {
	return rules.find((rule) => {
		rule.regex.lastIndex = 0;
		return rule.regex.test(command);
	});
}

async function confirmFileMutation(
	ctx: any,
	toolName: string,
	requestedPath: string,
	targetReal: string,
	cwdReal: string,
) {
	if (!ctx.hasUI)
		return {
			block: true,
			reason: `Write/edit outside CWD blocked: ${targetReal}`,
		} as const;

	const ok = await ctx.ui.confirm(
		"Allow write outside CWD?",
		`Tool: ${toolName}\nRequested path: ${requestedPath}\nResolved path: ${targetReal}\nCWD: ${cwdReal}\n\nAllow this file mutation?`,
	);

	return ok
		? undefined
		: ({ block: true, reason: "Blocked by user" } as const);
}

async function confirmBash(
	ctx: any,
	command: string,
	bashAllowRules: BashRule[],
) {
	if (!ctx.hasUI) {
		return {
			block: true,
			reason: "Bash command blocked because no UI is available for confirmation",
		} as const;
	}

	const choice = await ctx.ui.select(`Allow bash command?\n\n${command}`, [
		"Allow once",
		"Block",
		"Allow exact command for this session",
		"Add regex allow rule for this session...",
	]);

	if (choice === "Allow once") return undefined;

	if (choice === "Allow exact command for this session") {
		addExactRule(command, bashAllowRules);
		ctx.ui.notify("Added exact bash allow rule for this session.", "info");
		return undefined;
	}

	if (choice === "Add regex allow rule for this session...") {
		const source = await ctx.ui.input(
			"Bash allow regex",
			"Example: ^ssh\\b",
		);
		if (!source) return { block: true, reason: "Blocked by user" } as const;

		try {
			const regex = new RegExp(source);
			bashAllowRules.push({ source, regex });
			ctx.ui.notify(`Added bash allow rule: /${source}/`, "info");

			regex.lastIndex = 0;
			if (regex.test(command)) return undefined;
			return {
				block: true,
				reason: `Added regex /${source}/ does not match this command`,
			} as const;
		} catch (error: any) {
			ctx.ui.notify(`Invalid regex: ${error.message}`, "error");
			return {
				block: true,
				reason: `Invalid regex: ${error.message}`,
			} as const;
		}
	}

	return { block: true, reason: "Blocked by user" } as const;
}

export default function simplePermissions(pi: ExtensionAPI) {
	const bashAllowRules: BashRule[] = [];

	pi.registerCommand("perm-allow", {
		description:
			"Allow matching bash commands for this session. Usage: /perm-allow <regex>",
		handler: async (args, ctx) => {
			const source = args.trim();
			if (!source) {
				ctx.ui.notify(
					"Usage: /perm-allow <regex>  e.g. /perm-allow ^ssh\\b",
					"warning",
				);
				return;
			}

			try {
				const regex = new RegExp(source);
				bashAllowRules.push({ source, regex });
				ctx.ui.notify(
					`Added bash allow rule #${bashAllowRules.length}: /${source}/`,
					"info",
				);
			} catch (error: any) {
				ctx.ui.notify(`Invalid regex: ${error.message}`, "error");
			}
		},
	});

	pi.registerCommand("perm-allow-exact", {
		description:
			"Allow one exact bash command for this session. Usage: /perm-allow-exact <command>",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify("Usage: /perm-allow-exact <command>", "warning");
				return;
			}

			addExactRule(command, bashAllowRules);
			ctx.ui.notify(
				`Added exact bash allow rule #${bashAllowRules.length}`,
				"info",
			);
		},
	});

	pi.registerCommand("perm-list", {
		description: "List current session bash allow rules",
		handler: async (_args, ctx) => {
			if (bashAllowRules.length === 0) {
				ctx.ui.notify("No bash allow rules for this session.", "info");
				return;
			}

			ctx.ui.notify(
				bashAllowRules
					.map((rule, index) => `${index + 1}. /${rule.source}/`)
					.join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("perm-clear", {
		description:
			"Clear session bash allow rules. Usage: /perm-clear [all|number]",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target || target === "all") {
				bashAllowRules.splice(0, bashAllowRules.length);
				ctx.ui.notify("Cleared all bash allow rules.", "info");
				return;
			}

			const index = Number(target) - 1;
			if (
				!Number.isInteger(index) ||
				index < 0 ||
				index >= bashAllowRules.length
			) {
				ctx.ui.notify("Usage: /perm-clear [all|number]", "warning");
				return;
			}

			const [removed] = bashAllowRules.splice(index, 1);
			ctx.ui.notify(`Removed rule: /${removed.source}/`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(
				"simple-permissions",
				ctx.ui.theme.fg("accent", "perm: cwd-write + bash-confirm"),
			);
		}
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt:
			event.systemPrompt +
			"\n\nPermission policy active: read/list/search tools are allowed; write/edit targets inside the current working directory are allowed; write/edit targets outside the current working directory require user confirmation; bash commands require user confirmation unless they match a session allow regex added by /perm-allow or by the bash confirmation dialog.",
	}));

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String((event.input as any).command ?? "");
			if (allowedByBashRules(command, bashAllowRules)) return undefined;
			return confirmBash(ctx, command, bashAllowRules);
		}

		if (!WRITING_TOOLS.has(event.toolName)) return undefined;

		const inputPath = (event.input as any).path;
		if (typeof inputPath !== "string") return undefined;

		const cwdReal = await realpathOrResolve(ctx.cwd);
		const absolutePath = resolve(ctx.cwd, stripAtPrefix(inputPath));
		const targetReal = await canonicalizeForPolicy(absolutePath);

		if (isInside(cwdReal, targetReal)) return undefined;

		return confirmFileMutation(
			ctx,
			event.toolName,
			inputPath,
			targetReal,
			cwdReal,
		);
	});
}
