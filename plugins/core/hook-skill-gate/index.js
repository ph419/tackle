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
 * Resolve the project root directory.
 * Walks up from a starting directory to find task.md or .claude/.
 *
 * @param {string} [startDir] - directory to start from (default: process.cwd())
 * @returns {string}
 */
function resolveProjectRoot(startDir) {
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
 * @param {string} projectRoot
 * @param {object} hookConfig - the hook-skill-gate config section
 * @returns {string[]} array of gated skill names
 */
function discoverGatedSkills(projectRoot, hookConfig) {
  var registryPath = path.join(projectRoot, 'plugins', 'plugin-registry.json');
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
      var pluginJsonPath = path.join(
        projectRoot,
        'plugins',
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
    var stateFilePath = path.join(this._projectRoot, '.claude-state');
    this._store = new StateStore({ filePath: stateFilePath });

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
    this._gatedSkillsCache = discoverGatedSkills(this._projectRoot, this._config);
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
      this._projectRoot,
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
}

// --- CLI Entry Point ---
//
// When invoked via `node index.js --pre-tool` or `node index.js --post-skill`,
// reads stdin for the hook context JSON and outputs a JSON result.

/**
 * Read all data from stdin and parse as JSON.
 * @param {function} callback - callback(error, data)
 */
function readStdin(callback) {
  var chunks = [];
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', function (chunk) {
    chunks.push(chunk);
  });
  process.stdin.on('end', function () {
    var raw = chunks.join('');
    if (!raw.trim()) {
      return callback(null, {});
    }
    try {
      var parsed = JSON.parse(raw);
      callback(null, parsed);
    } catch (e) {
      callback(e);
    }
  });
  process.stdin.on('error', function (err) {
    callback(err);
  });
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
