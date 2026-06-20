# Sandbox Threat Model (S3)

> **Status**: Explicit security disclosure. The sandbox machinery in this
> repository is **decorative** — it is NOT a security boundary. Read this
> document before loading any plugin you did not author.

This document is the response to code-review finding **S3** (HIGH) in
`docs/reports/code-review-2026-06-20.html`. It states the threat model
explicitly so operators can make informed trust decisions.

## TL;DR

- **Only load plugins you fully trust.** Loading a Hook/Validator/Provider
  plugin executes its constructor in the main process with full filesystem,
  network, process, and environment-variable access.
- `capabilities.js` (e.g. `child_process: 'forbidden'` for `npm`/`local`
  source types) is **declarative only** — it is never enforced on the load
  path.
- `SandboxManager` + `sandbox-worker.js` exist as scaffolding for a future
  isolation layer, but the plugin loader **does not route through them**. A
  worker_thread does not isolate filesystem/network/process access anyway
  (same OS process, same credentials, same env).
- Since v0.3.x (this fix), the loader emits a `warn`-level log line whenever
  a third-party (`npm`/`local`) plugin is loaded via `require()`.

## What is checked

| Check                                       | Where                          | Enforced? |
|---------------------------------------------|--------------------------------|-----------|
| `sourceType` ∈ {core, npm, local}           | `resolve-plugin-path.js`       | ✅ yes    |
| Plugin name path-traversal (`../..` escape) | `resolve-plugin-path.js` (S3)  | ✅ yes    |
| `pluginPath` is absolute + exists + dir     | `sandbox-manager.js`           | ✅ yes\*  |
| Capability declaration in `plugin.json`     | `capabilities.js`              | ⚠️ declared but NOT enforced on load |

\* Only when the sandbox worker is actually used, which the loader does not do.

## What is NOT checked

The plugin loader (`plugin-loader.js:_loadPlugin`) does this for every
non-Skill plugin:

```js
var PluginClass = require(indexJsPath);  // constructor runs in main process
pluginInstance = new PluginClass();
```

At that point the plugin code can:

1. **Read secrets** — `process.env`, files in the project, `~/.ssh`, the
   harness state store, configuration files.
2. **Spawn processes** — `require('child_process').execSync('rm -rf ~')`.
3. **Make network requests** — exfiltrate data, download payloads.
4. **Modify the filesystem** — overwrite source files, plant backdoors.
5. **Monkey-patch** the runtime — replace `stateStore`, `eventBus`, hooks,
   validators, or the loader itself.

The `capabilities.js` matrix says `child_process: 'forbidden'` for
`npm`/`local`. **That declaration has no effect on the require path.** It is
only consulted by `SandboxManager._handleRpcRequest`, which is reached only
when a sandboxed worker forwards an RPC — and no plugin ever goes through the
sandboxed worker.

## Why not just enforce the sandbox?

Three reasons, in order of importance:

1. **worker_thread is not isolation.** A `worker_threads.Worker` shares the
   same OS process, same user credentials, same filesystem namespace, same
   network egress, and same environment variables as the main thread. Even
   with a fully wired sandbox, `require('child_process').execSync(...)`
   inside the worker still runs as the host user. The capability checks in
   `sandbox-context` only proxy *harness services* (eventBus/stateStore/logger
   /config/getProvider) — they cannot intercept a direct `require()`.
2. **Real isolation is a separate project.** True isolation requires a
   separate OS process with dropped privileges, a `vm`/`isolated-vm`
   context with a frozen require, or a WASM runtime. Each is a substantial
   architecture change that interacts with how providers expose sync
   factories and how hooks block tool calls.
3. **The current loader contract assumes in-process plugins.** Providers
   return live objects (e.g. `stateStore`) used synchronously by skills and
   hooks; routing them through an RPC boundary would require an async shim
   across every consumer.

## Decision (this round)

Per operator direction, this round **documents the threat model** rather
than re-architecting isolation. Concretely:

- The loader now emits a `warn` log when loading a third-party plugin via
  `require()` (see `plugin-loader.js:_loadPlugin`).
- This document exists.
- `SandboxManager` / `sandbox-worker.js` / `capabilities.js` are kept as
  scaffolding for a future isolation layer; their dead state
  (`_pendingRpc`, `_rpcIdCounter`, the dangling 2s terminate timer) has been
  cleaned up but their "decorative" status is unchanged.

## Operator guidance

- **Trust your registry.** `plugin-registry.json` is the trust root. Anyone
  who can write to it (or to any directory it points at) can run arbitrary
  code on load.
- **Prefer `core` plugins.** Only `core` source-type plugins are
  first-party; everything else is third-party code.
- **Audit `npm`/`local` plugins.** Before adding one to the registry, read
  its `index.js`. There is no sandbox between it and your secrets.
- **CI: pin and review.** Pin transitive deps (`npm ci`), and treat any new
  entry in `plugin-registry.json` as a code-execution PR.

## Future hardening (not in scope this round)

If real isolation is later required, the candidate approaches are:

| Approach           | Isolation strength | Effort | Compatibility impact |
|--------------------|--------------------|--------|----------------------|
| Separate child process + IPC | high            | high   | breaks sync providers |
| `isolated-vm`      | high              | high   | no `require`, rewrite APIs |
| WASM runtime       | high              | very high | no Node APIs |
| `worker_threads` + `eval`-freezed require | low | medium | same OS process, weak |

Any of these is a multi-week project and must be planned as such.
