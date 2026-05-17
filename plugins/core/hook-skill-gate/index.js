/**
 * Hook: Skill Gate (Unified)
 *
 * Merges three hook behaviors into one plugin:
 *   1. PreToolUse(Edit|Write) - block file edits when state is in a blocked state (e.g. "waiting")
 *   2. PostToolUse(Skill)     - set state to "waiting" after a gated skill completes
 *   3. Dynamic gated skill query - read gated skills from plugin-registry.json metadata
 *
 * Usage (CLI):
 *   node plugins/core/hook-skill-gate/index.js --pre-tool   (invoked by PreToolUse hook)
 *   node plugins/core/hook-skill-gate/index.js --post-skill  (invoked by PostToolUse hook)
 *
 * Usage (Programmatic):
 *   const SkillGateHook = require('./index.js');
 *   const hook = new SkillGateHook();
 *   await hook.onActivate(context);
 *   const result = await hook.handle({ event: 'PreToolUse', tool: 'Edit', ... });
 */

'use strict';

var fs = require('fs');
var path = require('path');
var { HookPlugin } = require('../../contracts/plugin-interface');
var { StateStore, FileSystemAdapter } = require('../../runtime/state-store');

/**
 * Default configuration values.
 */
var DEFAULT_CONFIG = {
  gatedSkills: [],
  blockedStates: ['waiting'],
  stateKey: 'harness.state',
};

/**
 * Resolve the package root directory from __dirname.
 * Walks up from the hook's location to find the tackle-harness package root.
 * Used to locate plugin-registry.json regardless of installation mode.
 *
 * For global installs, resolves to the global npm package directory.
 * For local installs, resolves to the project's node_modules/tackle-harness.
 *
 * @returns {string}
 */
function resolvePackageRoot() {
  // This hook is at: plugins/core/hook-skill-gate/index.js
  // Package root is three levels up from __dirname
  var dir = path.resolve(__dirname, '../../..');

  // Verify we're at the right location (should contain plugins/ directory)
  for (var i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'plugins'))) return dir;
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    var parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: try to find global tackle-harness in node_modules
  // Check common global npm directories
  var globalPaths = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'tackle-harness'),
    path.join(process.env.npm_config_prefix || '/usr/local', 'lib', 'node_modules', 'tackle-harness'),
  ];

  for (var j = 0; j < globalPaths.length; j++) {
    if (fs.existsSync(path.join(globalPaths[j], 'plugins'))) {
      return globalPaths[j];
    }
  }

  // Fallback to computed path
  return path.resolve(__dirname, '../../..');
}

/**
 * Resolve the project root directory from CWD.
 * Walks up from process.cwd() to find task.md or .claude/.
 * This works for both global and local hook execution.
 *
 * @param {string} [startDir] - directory to start from (default: process.cwd())
 * @returns {string}
 */
function resolveProjectRoot(startDir) {
  // Always use process.cwd() to find the actual project root
  // This allows hooks to work correctly regardless of installation mode
  var dir = startDir || process.cwd();
  for (var i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'task.md'))) return dir;
    if (fs.existsSync(path.join(dir, '.claude'))) return dir;
    var parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Read plugin-registry.json and return skill names that are marked as gated.
 *
 * A skill is considered "gated" if:
 *   - Its plugin.json has metadata.gatedByCode === true, OR
 *   - It appears in the hook-skill-gate config.gatedSkills list
 *
 * Uses packageRoot to locate registry and plugin directories.
 *
 * @param {string} packageRoot - the tackle-harness package root directory
 * @param {object} hookConfig - the hook-skill-gate config section
 * @returns {string[]} array of gated skill names
 */
function discoverGatedSkills(packageRoot, hookConfig) {
  var registryPath = path.join(packageRoot, 'plugins', 'plugin-registry.json');
  var gatedFromMetadata = [];
  var gatedFromConfig = (hookConfig && hookConfig.gatedSkills) || [];

  // 1. Read registry and scan each plugin for metadata.gatedByCode
  try {
    var content = fs.readFileSync(registryPath, 'utf-8');
    var registry = JSON.parse(content);
    var plugins = registry.plugins || [];

    for (var i = 0; i < plugins.length; i++) {
      var entry = plugins[i];
      if (!entry.source) continue;

      // Attempt to read the plugin's plugin.json for metadata
      // Path: plugins/core/{source}/plugin.json
      // BUGFIX: Use entry.source directly (already includes 'hook-' prefix if needed)
      var pluginJsonPath = path.join(
        packageRoot,
        'plugins',
        'core',
        entry.source,
        'plugin.json'
      );
      try {
        var pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
        if (
          pluginJson.metadata &&
          (pluginJson.metadata.gatedByCode === true ||
            pluginJson.metadata.gatedByHuman === true)
        ) {
          gatedFromMetadata.push(pluginJson.name || entry.name);
        }
      } catch (e) {
        // plugin.json may not exist or be unreadable - skip
      }
    }
  } catch (e) {
    // Registry may not exist - continue with config-only list
  }

  // 2. Merge and deduplicate
  var all = gatedFromMetadata.concat(gatedFromConfig);
  var seen = {};
  var result = [];
  for (var j = 0; j < all.length; j++) {
    if (!seen[all[j]]) {
      seen[all[j]] = true;
      result.push(all[j]);
    }
  }

  return result;
}

/**
 * SkillGateHook - Unified skill gate hook plugin.
 *
 * Extends HookPlugin from the plugin interface contract.
 */
class SkillGateHook extends HookPlugin {
  constructor() {
    super();
    this.name = 'hook-skill-gate';
    this.version = '1.0.0';
    this.description = '统一技能门控 Hook';
    this.dependencies = { providers: ['provider:state-store'] };
    this.trigger = {
      event: 'PreToolUse',
      tools: ['Edit', 'Write'],
      skills: [],
    };
    this.priority = 10;

    /** @type {StateStore|null} */
    this._store = null;
    /** @type {object} */
    this._config = Object.assign({}, DEFAULT_CONFIG);
    /** @type {string} */
    this._projectRoot = '';
    /** @type {string} */
    this._packageRoot = '';
    /** @type {string[]|null} cached gated skills */
    this._gatedSkillsCache = null;
  }

  /**
   * Called during plugin activation.
   * Initializes state store and reads config.
   *
   * @param {PluginContext} context
   */
  async onActivate(context) {
    this._projectRoot = resolveProjectRoot();
    this._packageRoot = resolvePackageRoot();
    var stateFilePath = path.join(this._projectRoot, '.claude-state');
    this._store = new StateStore({ filePath: stateFilePath });

    // Load project-level config from harness-config.yaml
    this._loadProjectConfig();

    // Merge context config if available
    if (context && context.config) {
      var pluginConfig = context.config.getPluginConfig
        ? context.config.getPluginConfig(this.name)
        : null;
      if (pluginConfig) {
        for (var key in pluginConfig) {
          if (pluginConfig.hasOwnProperty(key)) {
            this._config[key] = pluginConfig[key];
          }
        }
      }
    }

    // Initial discovery of gated skills
    this._gatedSkillsCache = discoverGatedSkills(this._packageRoot, this._config);
  }

  /**
   * Main hook handler.
   * Dispatches to the appropriate sub-handler based on the event type.
   *
   * @param {object} context - hook context
   * @param {string} context.event - 'PreToolUse' or 'PostToolUse'
   * @param {string} [context.tool] - tool name (for PreToolUse)
   * @param {string} [context.skill] - skill name (for PostToolUse)
   * @returns {Promise<{ allowed: boolean, reason?: string, stateChanges?: object[] }>}
   */
  async handle(context) {
    if (!context || !context.event) {
      return { allowed: true };
    }

    if (context.event === 'PreToolUse') {
      return this._handlePreToolUse(context);
    }

    if (context.event === 'PostToolUse') {
      return this._handlePostToolUse(context);
    }

    return { allowed: true };
  }

  /**
   * PreToolUse handler - block Edit/Write when state is in a blocked state.
   *
   * @param {object} context
   * @param {string} context.tool - the tool being used ('Edit', 'Write', etc.)
   * @returns {Promise<{ allowed: boolean, reason?: string }>}
   */
  async _handlePreToolUse(context) {
    var tool = context.tool || '';
    var restrictedTools = ['Edit', 'Write'];

    // Only gate Edit and Write operations
    var isRestricted = false;
    for (var i = 0; i < restrictedTools.length; i++) {
      if (tool === restrictedTools[i]) {
        isRestricted = true;
        break;
      }
    }

    if (!isRestricted) {
      return { allowed: true };
    }

    // Read current state from store
    var currentState = await this._getState();
    var blockedStates = this._config.blockedStates || ['waiting'];

    for (var j = 0; j < blockedStates.length; j++) {
      if (currentState === blockedStates[j]) {
        return {
          allowed: false,
          reason:
            'Blocked: current state is "' +
            currentState +
            '". ' +
            'Edit/Write operations are not allowed while waiting for human confirmation.',
        };
      }
    }

    return { allowed: true };
  }

  /**
   * PostToolUse handler - after a gated skill executes, set state to "waiting".
   *
   * @param {object} context
   * @param {string} context.tool - tool name (should be 'Skill')
   * @param {string} [context.skill] - the skill that was executed
   * @param {string} [context.skillName] - alternative field for skill name
   * @returns {Promise<{ allowed: boolean, handled: boolean, newState?: string, stateChanges?: object[] }>}
   */
  async _handlePostToolUse(context) {
    var tool = context.tool || '';
    if (tool !== 'Skill') {
      return { allowed: true, handled: false };
    }

    // Get the skill name from context
    var skillName = context.skill || context.skillName || '';
    if (!skillName) {
      return { allowed: true, handled: false };
    }

    // Refresh gated skills list (dynamic query)
    var gatedSkills = this._getGatedSkills();

    // Check if the skill that just ran is gated
    var isGated = false;
    for (var i = 0; i < gatedSkills.length; i++) {
      if (gatedSkills[i] === skillName) {
        isGated = true;
        break;
      }
    }

    if (!isGated) {
      return { allowed: true, handled: false };
    }

    // Set state to "waiting" to pause for human confirmation
    var waitingState = 'waiting';
    await this._setState(waitingState);

    return {
      allowed: true,
      handled: true,
      newState: waitingState,
      stateChanges: [
        {
          key: this._config.stateKey,
          oldValue: await this._getState(),
          newValue: waitingState,
        },
      ],
    };
  }

  /**
   * Get the current list of gated skills.
   * Refreshes from registry on each call for dynamic discovery.
   *
   * @returns {string[]}
   */
  _getGatedSkills() {
    this._gatedSkillsCache = discoverGatedSkills(
      this._packageRoot,
      this._config
    );
    return this._gatedSkillsCache;
  }

  /**
   * Read the current state from the store.
   * @returns {Promise<string|undefined>}
   */
  async _getState() {
    if (!this._store) return undefined;
    return await this._store.get(this._config.stateKey);
  }

  /**
   * Write a new state to the store.
   * @param {string} value
   * @returns {Promise<void>}
   */
  async _setState(value) {
    if (!this._store) return;
    await this._store.set(this._config.stateKey, value);
  }

  /**
   * Load project-level config from harness-config.yaml.
   * Reads CWD/.claude/config/harness-config.yaml and merges hook-skill-gate section.
   */
  _loadProjectConfig() {
    var configPath = path.join(this._projectRoot, '.claude', 'config', 'harness-config.yaml');
    try {
      if (fs.existsSync(configPath)) {
        var content = fs.readFileSync(configPath, 'utf-8');
        var yamlConfig = this._parseSimpleYaml(content);

        // Extract hook-skill-gate specific config
        if (yamlConfig['hook-skill-gate']) {
          var hookConfig = yamlConfig['hook-skill-gate'];
          for (var key in hookConfig) {
            if (hookConfig.hasOwnProperty(key)) {
              this._config[key] = hookConfig[key];
            }
          }
        }
      }
    } catch (e) {
      // Config file doesn't exist or is invalid - use defaults
    }
  }

  /**
   * Minimal YAML-like parser for simple key-value YAML files.
   * Handles nested structure via indentation (spaces only).
   * This is NOT a full YAML parser - it covers the subset used by harness-config.yaml.
   * @param {string} content
   * @returns {object}
   */
  _parseSimpleYaml(content) {
    var result = {};
    var lines = content.split('\n');
    var stack = [{ obj: result, indent: -1 }];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Skip empty lines, comments, and document separators
      if (!line.trim() || line.trim().indexOf('#') === 0 || line.trim() === '---') {
        continue;
      }

      // Calculate indentation
      var indent = line.search(/\S/);
      if (indent < 0) continue;

      // Pop stack to find parent
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      var parent = stack[stack.length - 1].obj;
      var trimmed = line.trim();

      // Check if it's a list item
      if (trimmed.indexOf('- ') === 0) {
        if (!Array.isArray(parent)) continue;
        var itemValue = this._parseYamlValue(trimmed.substring(2));
        parent.push(itemValue);
        continue;
      }

      // Key-value pair: split on first colon only
      var colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;

      var key = trimmed.substring(0, colonIdx).trim();
      var valuePart = trimmed.substring(colonIdx + 1).trim();

      // Handle inline comments (only outside quoted strings)
      if (valuePart && valuePart.indexOf('#') > -1) {
        var inQuote = false;
        var quoteChar = '';
        var commentIdx = -1;
        for (var ci = 0; ci < valuePart.length; ci++) {
          var ch = valuePart.charAt(ci);
          if (!inQuote && (ch === '"' || ch === "'")) {
            inQuote = true;
            quoteChar = ch;
          } else if (inQuote && ch === quoteChar) {
            inQuote = false;
          } else if (!inQuote && ch === '#') {
            commentIdx = ci;
            break;
          }
        }
        if (commentIdx > -1) {
          valuePart = valuePart.substring(0, commentIdx).trim();
        }
      }

      if (valuePart === '' || valuePart === null) {
        // Nested object
        var child = {};
        parent[key] = child;
        stack.push({ obj: child, indent: indent });
      } else {
        parent[key] = this._parseYamlValue(valuePart);
      }
    }

    return result;
  }

  /**
   * Parse a YAML scalar value.
   * @param {*} val
   * @returns {*}
   */
  _parseYamlValue(val) {
    if (val === null || val === undefined) return val;
    if (typeof val !== 'string') return val;
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'null' || val === '~') return null;

    // Remove surrounding quotes
    if ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
        (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")) {
      return val.substring(1, val.length - 1);
    }

    // Try number
    var num = Number(val);
    if (!isNaN(num) && val !== '') return num;

    return val;
  }

  /**
   * Check if this hook execution should be skipped to prevent double-triggering.
   *
   * Double-triggering can occur when:
   * 1. A hook is registered globally (via global npm install)
   * 2. The same hook is also registered at project level (via local build)
   *
   * We detect this by checking:
   * - Whether HOOK_EXECUTION_ID env var is set (set by first execution)
   * - Whether a marker file exists in the project
   *
   * @returns {boolean} true if this execution should be skipped
   */
  _shouldSkipForDoubleTrigger() {
    var markerPath = path.join(this._projectRoot, '.claude', '.hook-execution-marker');

    // If another hook process is marked as active, skip
    if (fs.existsSync(markerPath)) {
      try {
        var marker = fs.readFileSync(markerPath, 'utf-8');
        var markerData = JSON.parse(marker);

        // If marker is recent (< 5 seconds), skip to prevent double execution
        var now = Date.now();
        if (markerData.timestamp && (now - markerData.timestamp) < 5000) {
          return true;
        }
        // Stale marker — clean it up
        try { fs.unlinkSync(markerPath); } catch (e) { /* ignore */ }
      } catch (e) {
        // Invalid marker, clean up
        try { fs.unlinkSync(markerPath); } catch (e2) { /* ignore */ }
      }
    }

    // Mark this hook as active
    try {
      fs.writeFileSync(
        markerPath,
        JSON.stringify({ timestamp: Date.now(), pid: process.pid }),
        'utf-8'
      );
    } catch (e) {
      // Failed to write marker, continue anyway
    }

    return false;
  }
}

// --- CLI Entry Point ---
//
// When invoked via `node index.js --pre-tool` or `node index.js --post-skill`,
// reads stdin for the hook context JSON and outputs a JSON result.

/**
 * Read all data from stdin and parse as JSON.
 * Sanitizes input to prevent prototype pollution and limits size.
 * @param {function} callback - callback(error, data)
 */
function readStdin(callback) {
  var chunks = [];
  var totalSize = 0;
  var MAX_SIZE = 1024 * 1024; // 1MB limit

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', function (chunk) {
    totalSize += chunk.length;
    if (totalSize > MAX_SIZE) {
      process.stdin.destroy();
      callback(new Error('Input exceeds maximum size limit'));
      return;
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', function () {
    var raw = chunks.join('');
    if (!raw.trim()) {
      return callback(null, {});
    }
    try {
      var parsed = JSON.parse(raw);

      // Prevent prototype pollution: strip dangerous keys
      var sanitized = sanitizeObject(parsed);
      callback(null, sanitized);
    } catch (e) {
      callback(new Error('Invalid JSON input'));
    }
  });
  process.stdin.on('error', function (err) {
    callback(new Error('Failed to read stdin'));
  });
}

/**
 * Sanitize an object to prevent prototype pollution attacks.
 * Removes __proto__, constructor, and prototype properties.
 * @param {*} obj - object to sanitize
 * @returns {*} sanitized object
 */
function sanitizeObject(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }

  var result = {};
  var keys = Object.keys(obj); // Object.keys ignores prototype chain
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];

    // Block dangerous property names that could cause prototype pollution
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }

    // Recursively sanitize nested objects
    try {
      result[key] = sanitizeObject(obj[key]);
    } catch (e) {
      // Skip values that cause errors during sanitization
    }
  }
  return result;
}

/**
 * Main CLI function.
 */
function main() {
  var args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      'Usage: node index.js --pre-tool | --post-skill\n' +
        '  --pre-tool   Run PreToolUse check (reads context from stdin)\n' +
        '  --post-skill Run PostToolUse handler (reads context from stdin)'
    );
    process.exit(1);
  }

  var mode = args[0];
  if (mode !== '--pre-tool' && mode !== '--post-skill') {
    console.error('Unknown mode: ' + mode);
    console.error('Valid modes: --pre-tool, --post-skill');
    process.exit(1);
  }

  readStdin(function (err, context) {
    if (err) {
      console.error('Failed to read stdin: ' + err.message);
      process.exit(1);
    }

    var hook = new SkillGateHook();

    // Activate the hook (initialize state store, etc.)
    hook
      .onActivate(null)
      .then(function () {
        // Check for double-triggering prevention
        if (hook._shouldSkipForDoubleTrigger()) {
          // Skip execution to prevent double-triggering
          process.stdout.write(JSON.stringify({ allowed: true, skipped: true, reason: 'Double-trigger prevention' }) + '\n');
          process.exit(0);
        }

        // Set the event type based on CLI mode
        if (mode === '--pre-tool') {
          context.event = 'PreToolUse';
        } else if (mode === '--post-skill') {
          context.event = 'PostToolUse';
          // Normalize: if tool is not set, default to 'Skill' for post-skill mode
          if (!context.tool) {
            context.tool = 'Skill';
          }
        }

        return hook.handle(context);
      })
      .then(function (result) {
        // Output the result as JSON
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');

        // Exit with code 0 if allowed, 2 if blocked (Claude Code hook convention)
        if (result.allowed === false) {
          process.exit(2);
        }
        process.exit(0);
      })
      .catch(function (error) {
        console.error('Hook execution failed: ' + error.message);
        process.exit(1);
      });
  });
}

// Run CLI if executed directly (not required as a module)
if (require.main === module) {
  main();
}

module.exports = SkillGateHook;
