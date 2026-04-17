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
var { PluginState, PluginType, SkillPlugin, HookPlugin, ValidatorPlugin, ProviderPlugin } = require('../contracts/plugin-interface');

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
        await this.activate(name);
        loaded.push(name);
        if (this._eventBus) {
          this._eventBus.emit('plugin:loaded', { pluginName: name });
        }
        this._log('info', 'Plugin "' + name + '" loaded and activated successfully');
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
   * Creates PluginContext and injects EventBus, StateStore, ConfigManager, Logger.
   * @param {string} name - plugin name
   */
  async activate(name) {
    var plugin = this.loadedPlugins.get(name);
    if (!plugin) {
      throw new Error('Plugin "' + name + '" is not loaded');
    }

    var PluginContext = require('../contracts/plugin-interface').PluginContext;

    // Create runtime object with all services
    var runtime = {
      eventBus: this._eventBus,
      stateStore: this._stateStore,
      configManager: this._configManager,
      logger: this._logger ? this._logger.createChild(name) : null,
      getProvider: this._getProvider.bind(this),
      loadedPlugins: this.loadedPlugins,
    };

    var context = new PluginContext(name, runtime);

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
   * Load a single plugin by type.
   * - Skill: only metadata, no JS module
   * - Hook/Validator/Provider: require() index.js and instantiate
   *
   * @param {string} name
   * @param {object} config
   */
  async _loadPlugin(name, config) {
    var source = config && config.source ? config.source : name;
    // Resolve plugin directory using absolute path
    var registryDir = path.resolve(path.dirname(this._registryPath));
    var pluginDir = path.join(registryDir, 'core', source);
    var pluginJsonPath = path.join(pluginDir, 'plugin.json');

    // Read plugin.json to determine type
    var pluginJson = this._readPluginJson(pluginJsonPath);
    var type = pluginJson.type || PluginType.SKILL;

    var pluginInstance;

    if (type === PluginType.SKILL) {
      // Skill plugins have no JS module - store metadata only
      pluginInstance = new SkillPlugin();
      pluginInstance.name = name;
      pluginInstance.version = pluginJson.version || '0.0.0';
      pluginInstance.description = pluginJson.description || '';
      pluginInstance.triggers = pluginJson.triggers || [];
      pluginInstance.metadata = pluginJson.metadata || {};
    } else {
      // Hook/Validator/Provider: require and instantiate using absolute path
      var indexJsPath = path.resolve(pluginDir, 'index.js');
      var PluginClass = require(indexJsPath);

      // Verify the export is a constructor function
      if (typeof PluginClass !== 'function') {
        throw new Error('Plugin "' + name + '" does not export a constructor function');
      }

      if (type === PluginType.HOOK) {
        pluginInstance = new PluginClass();
      } else if (type === PluginType.VALIDATOR) {
        pluginInstance = new PluginClass();
      } else if (type === PluginType.PROVIDER) {
        pluginInstance = new PluginClass();
      } else {
        throw new Error('Unknown plugin type: ' + type);
      }
    }

    // Set common properties
    pluginInstance.config = config || {};
    pluginInstance.state = PluginState.LOADED;

    this.loadedPlugins.set(name, pluginInstance);
  }

  /**
   * Read and parse plugin.json.
   * @param {string} jsonPath
   * @returns {object} parsed JSON or empty object
   */
  _readPluginJson(jsonPath) {
    try {
      var content = fs.readFileSync(jsonPath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      this._log('warn', 'Could not read plugin.json at ' + jsonPath + ': ' + err.message);
      return {};
    }
  }

  /**
   * Get a loaded Provider plugin by name and call its factory() method.
   * Used by PluginContext.getProvider().
   * @param {string} name - provider name
   * @returns {Promise<object>} Provider instance from factory() or undefined
   */
  async _getProvider(name) {
    var plugin = this.loadedPlugins.get(name);
    if (!plugin) {
      return undefined;
    }
    if (plugin.type !== PluginType.PROVIDER) {
      return undefined;
    }
    if (plugin.state !== PluginState.ACTIVATED) {
      this._log('warn', 'Provider "' + name + '" is not activated yet');
      return undefined;
    }
    if (typeof plugin.factory === 'function') {
      var PluginContext = require('../contracts/plugin-interface').PluginContext;
      var runtime = {
        eventBus: this._eventBus,
        stateStore: this._stateStore,
        configManager: this._configManager,
        logger: this._logger ? this._logger.createChild(name) : null,
        getProvider: this._getProvider.bind(this),
        loadedPlugins: this.loadedPlugins,
      };
      var context = new PluginContext(name, runtime);
      return await plugin.factory(context);
    }
    return plugin;
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
