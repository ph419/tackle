/**
 * Provider: State Store
 *
 * Wraps the StateStore runtime module to provide unified state and task data access.
 * Implements the ProviderPlugin interface from plugin-interface.js.
 *
 * Capabilities:
 *   - get(key)            read arbitrary state via dot-notation key
 *   - getTasks()          parse task.md into a structured task list
 *   - set(key, value)     write state
 *   - delete(key)         remove a state key
 *   - keys()              list all stored keys
 *   - subscribe(key, cb)  watch for changes on a key
 */

'use strict';

var path = require('path');
var fs = require('fs');
var { ProviderPlugin } = require('../../contracts/plugin-interface');
var { StateStore, FileSystemAdapter } = require('../../runtime/state-store');

/**
 * Minimal YAML-like parser for task.md
 * Extracts the task table rows (WP-xxx entries) and status info.
 */
function parseTaskMarkdown(content) {
  var lines = content.split('\n');
  var tasks = [];
  var stats = { total: 0, completed: 0, inProgress: 0, pending: 0 };

  // Find the table header row that starts with | WP |
  var tableStarted = false;
  var headerSkipped = false;
  var separatorSkipped = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (!tableStarted) {
      if (line.indexOf('| WP ') === 0 || line.indexOf('| WP\t') === 0) {
        tableStarted = true;
        headerSkipped = true; // this line IS the header, already skipped by continue
      }
      continue;
    }

    // The first line after tableStarted is the header - skip it
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }

    // The second line is the separator (|---|---|...) - skip it
    if (!separatorSkipped) {
      separatorSkipped = true;
      continue;
    }

    // Parse data rows
    var trimmed = line.trim();
    if (!trimmed || trimmed.indexOf('|') !== 0) {
      // End of table
      break;
    }

    var cells = trimmed.split('|').filter(function (c) { return c.trim() !== ''; });
    if (cells.length < 2) continue;

    var wpId = cells[0].trim();
    if (!wpId.match(/^WP-\d+$/)) continue;

    var title = cells.length > 1 ? cells[1].trim() : '';
    var statusCell = cells.length > 2 ? cells[2].trim() : '';
    var phase = cells.length > 3 ? cells[3].trim() : '';
    var priority = cells.length > 4 ? cells[4].trim() : '';
    var deps = cells.length > 5 ? cells[5].trim() : '';
    var estimate = cells.length > 6 ? cells[6].trim() : '';

    var status = 'pending';
    if (statusCell.indexOf('完成') !== -1 || statusCell.indexOf('Completed') !== -1) {
      status = 'completed';
    } else if (statusCell.indexOf('进行') !== -1 || statusCell.indexOf('In Progress') !== -1) {
      status = 'in_progress';
    } else if (statusCell.indexOf('待开始') !== -1 || statusCell.indexOf('Pending') !== -1) {
      status = 'pending';
    }

    stats.total++;
    if (status === 'completed') stats.completed++;
    else if (status === 'in_progress') stats.inProgress++;
    else stats.pending++;

    tasks.push({
      id: wpId,
      title: title,
      status: status,
      phase: phase,
      priority: priority,
      dependencies: deps ? deps.split(',').map(function (d) { return d.trim(); }) : [],
      estimate: estimate,
    });
  }

  return { tasks: tasks, stats: stats };
}

/**
 * StateStoreProvider - provides state access and task parsing
 */
class StateStoreProvider extends ProviderPlugin {
  constructor() {
    super();
    this.name = 'provider-state-store';
    this.version = '1.0.0';
    this.description = 'State Store Provider';
    this.provides = 'provider:state-store';
    this.dependencies = {};

    /** @type {StateStore|null} */
    this._store = null;
    /** @type {string} */
    this._projectRoot = '';
  }

  /**
   * Called when the plugin is activated.
   * Initializes the StateStore with the project root path.
   *
   * @param {PluginContext} context
   */
  async onActivate(context) {
    this._projectRoot = this._resolveProjectRoot();
    var stateFilePath = path.join(this._projectRoot, '.claude-state');
    this._store = new StateStore({ filePath: stateFilePath });
  }

  /**
   * Factory method - returns the provider instance (this provider itself).
   *
   * @param {PluginContext} context
   * @returns {Promise<object>} the state store provider API
   */
  async factory(context) {
    var self = this;

    return {
      /**
       * Get a value by dot-notation key from the state store.
       * @param {string} key - e.g. 'harness.state'
       * @returns {Promise<*|undefined>}
       */
      get: function (key) {
        return self._store.get(key);
      },

      /**
       * Set a value by dot-notation key.
       * @param {string} key
       * @param {*} value
       * @returns {Promise<void>}
       */
      set: function (key, value) {
        return self._store.set(key, value);
      },

      /**
       * Delete a key from the state store.
       * @param {string} key
       * @returns {Promise<void>}
       */
      delete: function (key) {
        return self._store.delete(key);
      },

      /**
       * List all stored keys.
       * @returns {Promise<string[]>}
       */
      keys: function () {
        return self._store.keys();
      },

      /**
       * Subscribe to changes on a specific key.
       * @param {string} key
       * @param {Function} callback - callback(key, oldValue, newValue)
       * @returns {{ unsubscribe: Function }}
       */
      subscribe: function (key, callback) {
        return self._store.subscribe(key, callback);
      },

      /**
       * Parse task.md into a structured task list.
       * @returns {Promise<{ tasks: object[], stats: object }>}
       */
      getTasks: function () {
        return self._parseTasks();
      },

      /**
       * Get the raw state store instance for advanced usage.
       * @returns {StateStore}
       */
      getStore: function () {
        return self._store;
      },
    };
  }

  /**
   * Parse the task.md file.
   * @returns {Promise<{ tasks: object[], stats: object }>}
   */
  async _parseTasks() {
    var taskFile = path.join(this._projectRoot, 'task.md');
    try {
      var content = fs.readFileSync(taskFile, 'utf-8');
      return parseTaskMarkdown(content);
    } catch (err) {
      return { tasks: [], stats: { total: 0, completed: 0, inProgress: 0, pending: 0 } };
    }
  }

  /**
   * Resolve the project root directory.
   * Walks up from cwd to find a directory containing task.md or .claude/.
   * @returns {string}
   */
  _resolveProjectRoot() {
    var dir = process.cwd();
    for (var i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, 'task.md'))) return dir;
      if (fs.existsSync(path.join(dir, '.claude'))) return dir;
      var parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }
}

module.exports = StateStoreProvider;
