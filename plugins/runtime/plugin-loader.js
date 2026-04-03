/**
 * PluginLoader - Plugin discovery, dependency resolution, and lifecycle management
 *
 * Features:
 *   - Load plugins from plugin-registry.json
 *   - Topological sort for dependency order
 *   - Circular dependency detection
 *   - Lifecycle management: load -> activate -> deactivate
 *   - Graceful handling of empty registries
 *   - Error isolation per plugin
 */

'use strict';

var fs = require('fs');
var path = require('path');
var { PluginState } = require('../contracts/plugin-interface');

class PluginLoader {
  /**
   * @param {object} options
   * @param {string} options.registryPath  - path to plugin-registry.json
   * @param {object} options.eventBus      - EventBus instance
   * @param {object} options.stateStore    - StateStore instance
   * @param {object} options.configManager - ConfigManager instance
   * @param {object} options.logger        - Logger instance
   */
  constructor(options) {
    options = options || {};
    this._registryPath = options.registryPath || path.join(process.cwd(), 'plugins', 'plugin-registry.json');
    this._eventBus = options.eventBus || null;
    this._stateStore = options.stateStore || null;
    this._configManager = options.configManager || null;
    this._logger = options.logger || null;

    /** @type {Map<string, object>} loaded plugin instances */
    this.loadedPlugins = new Map();
    /** @type {Map<string, object>} plugin configs from registry */
    this._pluginConfigs = new Map();
    /** @type {object} registry data */
    this._registry = null;
  }

  // --- public API ---

  /**
   * Load and activate all plugins from the registry.
   * Respects dependency order via topological sort.
   * Handles empty registries gracefully.
   *
   * @returns {Promise<string[]>} names of successfully loaded plugins
   */
  async loadAll() {
    this._log('info', 'Starting plugin loading...');

    // 1. Read registry
    this._registry = this._readRegistry();
    var pluginNames = this._getPluginNames();

    if (pluginNames.length === 0) {
      this._log('info', 'Registry is empty, no plugins to load');
      return [];
    }

    // 2. Build dependency graph from registry entries
    var depGraph = this._buildDependencyGraph(pluginNames);

    // 3. Topological sort (with cycle detection)
    var loadOrder = this._topologicalSort(depGraph);

    this._log('info', 'Load order resolved: ' + loadOrder.join(', '));

    // 4. Load and activate in order
    var loaded = [];
    for (var i = 0; i < loadOrder.length; i++) {
      var name = loadOrder[i];
      var config = this._pluginConfigs.get(name);

      if (config && config.enabled === false) {
        this._log('info', 'Plugin "' + name + '" is disabled, skipping');
        continue;
      }

      try {
        await this._loadPlugin(name, config);
        loaded.push(name);
        if (this._eventBus) {
          this._eventBus.emit('plugin:loaded', { pluginName: name });
        }
        this._log('info', 'Plugin "' + name + '" loaded successfully');
      } catch (err) {
        this._log('error', 'Failed to load plugin "' + name + '": ' + err.message);
        // Non-critical plugins don't block others
      }
    }

    this._log('info', 'Plugin loading complete. ' + loaded.length + ' plugins loaded');
    return loaded;
  }

  /**
   * Activate a single loaded plugin.
   * @param {string} name - plugin name
   * @param {object} context - PluginContext to inject
   */
  async activate(name, context) {
    var plugin = this.loadedPlugins.get(name);
    if (!plugin) {
      throw new Error('Plugin "' + name + '" is not loaded');
    }

    if (typeof plugin.onActivate === 'function') {
      await plugin.onActivate(context);
    }
    plugin.state = PluginState.ACTIVATED;

    if (this._eventBus) {
      this._eventBus.emit('plugin:activated', { pluginName: name });
    }
    this._log('info', 'Plugin "' + name + '" activated');
  }

  /**
   * Deactivate a single plugin.
   * @param {string} name
   */
  async deactivate(name) {
    var plugin = this.loadedPlugins.get(name);
    if (!plugin) {
      throw new Error('Plugin "' + name + '" is not loaded');
    }

    if (typeof plugin.onDeactivate === 'function') {
      await plugin.onDeactivate();
    }
    plugin.state = PluginState.DEACTIVATED;

    if (this._eventBus) {
      this._eventBus.emit('plugin:deactivated', { pluginName: name });
    }
    this._log('info', 'Plugin "' + name + '" deactivated');
  }

  /**
   * Deactivate all loaded plugins in reverse order.
   */
  async deactivateAll() {
    var names = Array.from(this.loadedPlugins.keys()).reverse();
    for (var i = 0; i < names.length; i++) {
      try {
        await this.deactivate(names[i]);
      } catch (err) {
        this._log('error', 'Error deactivating "' + names[i] + '": ' + err.message);
      }
    }
  }

  /**
   * Get a loaded plugin by name.
   * @param {string} name
   * @returns {object|undefined}
   */
  getPlugin(name) {
    return this.loadedPlugins.get(name);
  }

  /**
   * Check if a plugin is loaded.
   * @param {string} name
   * @returns {boolean}
   */
  isLoaded(name) {
    return this.loadedPlugins.has(name);
  }

  /**
   * Get names of all loaded plugins.
   * @returns {string[]}
   */
  getLoadedNames() {
    return Array.from(this.loadedPlugins.keys());
  }

  // --- internal ---

  /**
   * Read and parse the registry file.
   * @returns {object}
   */
  _readRegistry() {
    try {
      var content = fs.readFileSync(this._registryPath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      // If file doesn't exist or is invalid, return empty registry
      this._log('warn', 'Could not read registry: ' + err.message + '. Using empty registry.');
      return { version: '1.0.0', plugins: [] };
    }
  }

  /**
   * Extract plugin names and configs from registry.
   * Supports both array format and object format.
   * @returns {string[]}
   */
  _getPluginNames() {
    var plugins = this._registry.plugins;
    if (!plugins) return [];

    // Array format: [{ name, source, enabled, config }]
    if (Array.isArray(plugins)) {
      var names = [];
      for (var i = 0; i < plugins.length; i++) {
        var entry = plugins[i];
        var name = entry.name || entry;
        this._pluginConfigs.set(name, entry);
        names.push(name);
      }
      return names;
    }

    // Object format: { name: { source, enabled, config } }
    if (typeof plugins === 'object') {
      var keys = Object.keys(plugins);
      for (var j = 0; j < keys.length; j++) {
        this._pluginConfigs.set(keys[j], plugins[keys[j]]);
      }
      return keys;
    }

    return [];
  }

  /**
   * Build a dependency graph from plugin configs.
   * @param {string[]} pluginNames
   * @returns {Map<string, string[]>} name -> dependency names
   */
  _buildDependencyGraph(pluginNames) {
    var graph = new Map();
    for (var i = 0; i < pluginNames.length; i++) {
      var name = pluginNames[i];
      var config = this._pluginConfigs.get(name);
      var deps = [];

      if (config && config.dependencies) {
        deps = config.dependencies.plugins || config.dependencies || [];
        if (!Array.isArray(deps)) deps = [];
      }

      graph.set(name, deps);
    }
    return graph;
  }

  /**
   * Topological sort with circular dependency detection.
   * @param {Map<string, string[]>} graph - name -> dependencies
   * @returns {string[]} sorted plugin names
   * @throws {Error} on circular dependency or missing dependency
   */
  _topologicalSort(graph) {
    var WHITE = 0, GRAY = 1, BLACK = 2;
    var color = new Map();
    var result = [];

    // Initialize all as white
    var keys = Array.from(graph.keys());
    for (var i = 0; i < keys.length; i++) {
      color.set(keys[i], WHITE);
    }

    function visit(node) {
      var c = color.get(node);
      if (c === GRAY) {
        throw new Error('Circular dependency detected involving plugin: ' + node);
      }
      if (c === BLACK) return;

      color.set(node, GRAY);

      var deps = graph.get(node) || [];
      for (var j = 0; j < deps.length; j++) {
        var dep = deps[j];
        if (!graph.has(dep)) {
          throw new Error('Plugin "' + node + '" depends on unknown plugin: ' + dep);
        }
        visit(dep);
      }

      color.set(node, BLACK);
      result.push(node);
    }

    for (var k = 0; k < keys.length; k++) {
      if (color.get(keys[k]) === WHITE) {
        visit(keys[k]);
      }
    }

    return result;
  }

  /**
   * Load a single plugin.
   * For now, records the plugin in the loaded map.
   * Actual JS module loading will be added when plugins have executable code.
   *
   * @param {string} name
   * @param {object} config
   */
  async _loadPlugin(name, config) {
    // Store the plugin with metadata
    // In future iterations, this will require() the actual plugin module
    var pluginEntry = {
      name: name,
      config: config || {},
      state: PluginState.LOADED,
      // Placeholder - real plugins will have onActivate/onDeactivate
      onActivate: function () {},
      onDeactivate: function () {},
    };

    this.loadedPlugins.set(name, pluginEntry);
  }

  /**
   * Internal logging helper.
   */
  _log(level, message) {
    if (this._logger && typeof this._logger[level] === 'function') {
      this._logger[level]('plugin-loader', message);
    } else {
      console.log('[plugin-loader] [' + level + '] ' + message);
    }
  }
}

module.exports = PluginLoader;
