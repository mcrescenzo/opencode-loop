---
description: Repeatedly re-run a prompt in this session on a fixed interval or model-paced cadence until you stop it
---

Run an autonomous /loop in this session with arguments: `$ARGUMENTS`.

The loop plugin intercepts this command before it reaches the model. If you are reading this as a normal prompt, the plugin is not loaded — confirm `@mcrescenzo/opencode-loop` is in your opencode `plugin` config and restart OpenCode.

Forms:

- `/loop <interval> <prompt>` — fixed-interval, e.g. `/loop 5m run the test suite and report failures`. Interval is `<n>s|m|h`. Idle-gated: the next iteration fires at least `<interval>` after the previous one finishes.
- `/loop <prompt>` — dynamic self-pacing. Each iteration may call the `schedule_wakeup` tool to continue; finishing a turn without calling it ends the loop.
- `/loop status` — show the active loop (mode, iteration count, elapsed). Alias: `info`.
- `/loop stop` — stop the active loop (aliases: `off`, `cancel`, `clear`, `end`).

Safety: a loop stops automatically after 50 iterations or 60 minutes, and fixed intervals that cannot fit within that time limit are rejected. It pauses while a permission prompt is open and resumes when answered; a rejected permission ends the loop. If a running iteration reports `session.error`, the loop pauses until you run `/loop stop`; if OpenCode rejects dispatching the next prompt, the loop stops and writes diagnostics. The loop is in-memory only — closing or restarting OpenCode ends it.
