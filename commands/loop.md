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

Safety: defaults are 50 iterations and 60 minutes. Plugin tuple options may set `maxIterations` to a positive integer from 1 to 50 and `maxWallClockMinutes` to a positive integer from 1 to 1440; for example `["./plugins/loop/loop.js", { "maxIterations": 50, "maxWallClockMinutes": 1440 }]`. Invalid fields independently fall back to their safe default with a redacted warning diagnostic. Restart OpenCode after changing options. Each loop snapshots its effective caps at start, and fixed intervals that cannot fit within its wall-clock cap are rejected. A longer cap does not guarantee 50 iterations: model completion, errors, rejected permissions, restart/session closure, or manual stop can end it sooner. The loop pauses while a permission prompt is open, but paused time still counts toward wall-clock elapsed time; a rejected permission ends the loop. If a running iteration reports `session.error`, the loop pauses until you run `/loop stop`; if OpenCode rejects dispatching the next prompt, the loop stops and writes diagnostics. The loop is in-memory only — closing or restarting OpenCode ends it.
