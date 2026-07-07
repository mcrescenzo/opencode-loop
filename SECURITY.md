# Security Policy

## Supported Versions

Security fixes target the latest published `0.x` release and the current `main`
branch. This plugin is tested with the OpenCode and plugin API versions listed
in `package.json`.

## Reporting a Vulnerability

Report suspected vulnerabilities privately using GitHub Security Advisories
for this repository:
<https://github.com/mcrescenzo/opencode-loop/security/advisories/new>

If that form is unavailable for some reason, open a public issue with a
minimal impact summary and omit exploit details, secrets, diagnostic log
contents, or reproduction data that could expose another user.

Diagnostics are local JSONL files. Before sharing logs, inspect them and remove
project paths, prompts, model output, environment values, tokens, and any other
private data. The plugin applies best-effort redaction, but reporters should not
treat diagnostic output as guaranteed safe to publish unchanged.
