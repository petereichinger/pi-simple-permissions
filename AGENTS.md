# AGENTS.md

Guidance for coding agents working in this repository.

## Project overview

`pi-simple-permissions` is a small pi extension that adds a convenience permission gate for agent activity:

- `write` and `edit` tool calls are allowed inside the current pi working directory.
- `write` and `edit` outside the current working directory ask the user for confirmation.
- `bash` tool calls and user `!` / `!!` shell escapes are parsed with `tree-sitter-bash` and classified command-by-command.
- Known read-only bash commands are allowed automatically.
- Unknown or potentially mutating bash commands require confirmation unless allowed by a session rule.

This is **not** a sandbox. It is a pi extension that runs with normal user permissions.

## Important files

- `extensions/simple-permissions.ts` — the extension implementation.
- `README.md` — user-facing documentation and command examples.
- `package.json` — package metadata and pi extension entry point.

## Local usage

Run pi with this extension from a checkout:

```bash
pi -e /path/to/pi-simple-permissions
```

The package advertises the extension via:

```json
{
  "pi": {
    "extensions": ["./extensions/simple-permissions.ts"]
  }
}
```

## Extension behavior to preserve

When modifying the extension, preserve these policy expectations unless explicitly asked otherwise:

1. Reads/list/searches are not gated by this extension.
2. Only `write` and `edit` tool calls are path-gated.
3. Paths are canonicalized through existing parents so symlinks cannot make outside-CWD writes look inside CWD.
4. Bash analysis is conservative: unknown commands should be treated as potentially harmful.
5. Shell redirection that writes (`>`, `>>`, `&>`, etc.) makes a command potentially harmful.
6. Session allow rules are temporary in-memory rules, not persisted.
7. Non-UI sessions should block operations that require confirmation.

## User commands provided by the extension

- `/perm-allow <regex>` — allow matching bash commands for the current session.
- `/perm-allow-exact <command>` — allow one exact bash command for the current session.
- `/perm-list` — list current session allow rules.
- `/perm-clear [all|number]` — clear all rules or a specific numbered rule.

## Development notes

- The project is ESM (`"type": "module"`).
- Runtime dependencies are `tree-sitter` and `tree-sitter-bash`.
- There are currently no npm test/lint scripts in `package.json`; do not invent them in documentation unless adding them.
- Keep README behavior descriptions in sync with `extensions/simple-permissions.ts`.
- Be careful when changing bash parsing logic: compound commands should still be analyzed per simple command where possible.
