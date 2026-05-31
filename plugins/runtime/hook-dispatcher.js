/**
 * HookDispatcher - Dual-mode hook execution dispatcher for AI Agent Harness
 *
 * Two execution modes:
 *   - External: Command-based execution via settings.json (default, backward compatible)
 *   - Internal: Programmatic execution by calling HookPlugin.handle() directly
 *
 * Features:
 *   - Route hook events to appropriate hooks based on trigger configuration
 *   - Support PreToolUse, PostToolUse, SessionStart event types
 *   - Priority-based hook execution (lower priority = earlier execution)
 *   - Graceful handling of unregistered events
 *   - Integration with PluginLoader for internal mode
 *
 * Usage:
 *   const dispatcher = new HookDispatcher({ pluginLoader, logger });
 *   await dispatcher.dispatch({ event: 'PreToolUse', tool: 'Edit', ... });
 */

'use strict';

var { PluginType, PluginState } = require('../contracts/plugin-interface');

/**
 * Execution mode constants.
 * @public
 */
var ExecutionMode = Object.freeze({
  EXTERNAL: 'external', // Command-based via settings.json (default)
  INTERNAL: 'internal', // Programmatic via HookPlugin.handle()
});

/**
 * Default configuration.
 */
var DEFAULT_CONFIG = {
  mode: ExecutionMode.EXTERNAL,
  priorityThreshold: 1000,
};

/**
 * HookDispatcher class.
 * @public
 */
class HookDispatcher {
  /**
   * @public
   * @param {object} options
   * @param {object} options.pluginLoader - PluginLoader instance (required for internal mode)
   * @param {object} options.logger       - Logger instance (optional)
   * @param {string} [options.mode]       - default execution mode
   */
  constructor(options) {
    options = options || {};
    this._pluginLoader = options.pluginLoader || null;
    this._logger = options.logger || null;
    this._mode = options.mode || DEFAULT_CONFIG.mode;
    this._priorityThreshold = options.priorityThreshold || DEFAULT_CONFIG.priorityThreshold;
  }

  /**
   * Dispatch a hook event to appropriate hooks.
   *
   * @public
   * @param {object} context
   * @param {string} context.event   - Event type: 'PreToolUse', 'PostToolUse', 'SessionStart'
   * @param {string} [context.tool]  - Tool name (for PreToolUse/PostToolUse)
   * @param {string} [context.skill] - Skill name (for PostToolUse)
   * @param {string} [context.mode]  - Override execution mode for this call
   * @returns {Promise<{ allowed: boolean, results?: object[], reason?: string }>}
   */
  async dispatch(context) {
    if (!context || !context.event) {
      this._log('warn', 'dispatch() called with invalid context');
      return { allowed: true, results: [] };
    }

    var mode = context.mode || this._mode;
    this._log('debug', 'Dispatching event "' + context.event + '" in ' + mode + ' mode');

    if (mode === ExecutionMode.INTERNAL) {
      return await this._dispatchInternal(context);
    }

    // External mode: no-op (hooks are executed via settings.json commands)
    return { allowed: true, results: [], mode: 'external' };
  }

  /**
   * Internal mode dispatch: call loaded HookPlugin.handle() directly.
   *
   * @param {object} context
   * @returns {Promise<{ allowed: boolean, results: object[], reason?: string }>}
   * @private
   */
  async _dispatchInternal(context) {
    if (!this._pluginLoader) {
      this._log('warn', 'Internal mode requested but no pluginLoader provided');
      return { allowed: true, results: [], mode: 'internal' };
    }

    var matchingHooks = this._findMatchingHooks(context);
    if (matchingHooks.length === 0) {
      this._log('debug', 'No matching hooks found for event "' + context.event + '"');
      return { allowed: true, results: [], mode: 'internal' };
    }

    // Sort by priority (lower = earlier execution)
    matchingHooks.sort(function (a, b) {
      var pa = (a.plugin && a.plugin.priority) || 100;
      var pb = (b.plugin && b.plugin.priority) || 100;
      return pa - pb;
    });

    this._log('debug', 'Found ' + matchingHooks.length + ' matching hook(s)');

    var results = [];
    var overallAllowed = true;
    var blockReason = null;

    for (var i = 0; i < matchingHooks.length; i++) {
      var item = matchingHooks[i];
      var plugin = item.plugin;

      // Skip inactive plugins
      if (plugin.state !== PluginState.ACTIVATED) {
        this._log('debug', 'Hook "' + plugin.name + '" is not activated, skipping');
        continue;
      }

      try {
        this._log('debug', 'Executing hook "' + plugin.name + '" (priority: ' + plugin.priority + ')');
        var result = await plugin.handle(context);
        results.push({
          hook: plugin.name,
          result: result,
        });

        // If any hook disallows, set overall allowed to false
        if (result && result.allowed === false) {
          overallAllowed = false;
          blockReason = result.reason || ('Blocked by hook: ' + plugin.name);
          this._log('info', 'Hook "' + plugin.name + '" disallowed action: ' + blockReason);
          // Continue executing remaining hooks for side effects
        }
      } catch (err) {
        this._log('error', 'Hook "' + plugin.name + '" threw error: ' + err.message);
        results.push({
          hook: plugin.name,
          error: err.message,
        });
      }
    }

    var response = {
      allowed: overallAllowed,
      results: results,
      mode: 'internal',
    };

    if (blockReason) {
      response.reason = blockReason;
    }

    return response;
  }

  /**
   * Find all loaded hooks that match the event context.
   *
   * @param {object} context
   * @returns {Array<{ plugin: HookPlugin, trigger: object }>}
   * @private
   */
  _findMatchingHooks(context) {
    var matches = [];
    var loadedNames = this._pluginLoader.getLoadedNames();

    for (var i = 0; i < loadedNames.length; i++) {
      var plugin = this._pluginLoader.getPlugin(loadedNames[i]);

      if (!plugin || plugin.type !== PluginType.HOOK) {
        continue;
      }

      var trigger = plugin.trigger || {};

      // Check event type match
      if (trigger.event !== context.event) {
        continue;
      }

      // Check tool filter (for PreToolUse/PostToolUse)
      if (trigger.tools && trigger.tools.length > 0) {
        var tool = context.tool || '';
        var toolMatched = false;
        for (var j = 0; j < trigger.tools.length; j++) {
          if (trigger.tools[j] === tool) {
            toolMatched = true;
            break;
          }
        }
        if (!toolMatched) continue;
      }

      // Check skill filter (for PostToolUse)
      if (trigger.skills && trigger.skills.length > 0) {
        var skill = context.skill || '';
        var skillMatched = false;
        for (var k = 0; k < trigger.skills.length; k++) {
          if (trigger.skills[k] === skill) {
            skillMatched = true;
            break;
          }
        }
        if (!skillMatched) continue;
      }

      matches.push({
        plugin: plugin,
        trigger: trigger,
      });
    }

    return matches;
  }

  /**
   * Set the default execution mode.
   * @public
   * @param {string} mode - 'external' or 'internal'
   */
  setMode(mode) {
    if (mode !== ExecutionMode.EXTERNAL && mode !== ExecutionMode.INTERNAL) {
      throw new Error('Invalid mode: ' + mode + '. Use "external" or "internal"');
    }
    this._mode = mode;
    this._log('info', 'Execution mode set to "' + mode + '"');
  }

  /**
   * Get the current default execution mode.
   * @public
   * @returns {string}
   */
  getMode() {
    return this._mode;
  }

  /**
   * Check if internal mode is available (requires pluginLoader).
   * @public
   * @returns {boolean}
   */
  canUseInternalMode() {
    return this._pluginLoader !== null;
  }

  /**
   * Get statistics about loaded hooks.
   * @public
   * @returns {{ total: number, byEvent: object, byPriority: object[] }}
   */
  getHookStats() {
    if (!this._pluginLoader) {
      return { total: 0, byEvent: {}, byPriority: [] };
    }

    var stats = {
      total: 0,
      byEvent: {},
      byPriority: [],
    };

    var loadedNames = this._pluginLoader.getLoadedNames();
    for (var i = 0; i < loadedNames.length; i++) {
      var plugin = this._pluginLoader.getPlugin(loadedNames[i]);
      if (!plugin || plugin.type !== PluginType.HOOK) continue;

      stats.total++;

      var event = (plugin.trigger && plugin.trigger.event) || 'unknown';
      stats.byEvent[event] = (stats.byEvent[event] || 0) + 1;

      stats.byPriority.push({
        name: plugin.name,
        event: event,
        priority: plugin.priority || 100,
      });
    }

    stats.byPriority.sort(function (a, b) {
      return a.priority - b.priority;
    });

    return stats;
  }

  /**
   * Internal logging helper.
   * @param {string} level
   * @param {string} message
   * @private
   */
  _log(level, message) {
    if (this._logger && typeof this._logger[level] === 'function') {
      this._logger[level]('hook-dispatcher', message);
    }
  }
}

module.exports = {
  HookDispatcher,
  ExecutionMode,
};
