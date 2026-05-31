/**
 * PluginLoader - Plugin discovery, dependency resolution, and lifecycle management
 *
 * @module plugin-loader
 *
 * Features:
 *   - Load plugins from plugin-registry.json
 *   - Topological sort for dependency order
 *   - Circular dependency detection
 *   - Lifecycle management: load -> activate -> deactivate
 *   - Graceful handling of empty registries
 *   - Error isolation per plugin
 */

// FILE-SIZE-MONITOR: 645 lines (as of 2026-05-31)
// SPLIT-THRESHOLD: 800 lines — if exceeded, consider splitting into:
//   - plugin-loader-core.js (loading, activation, dependency injection)
//   - plugin-loader-lifecycle.js (lifecycle management, event handling)

'use strict';

var fs = require('fs');
var path = require('path');
var pluginInterface = require('../contracts/plugin-interface');
var PluginState = pluginInterface.PluginState;
var PluginType = pluginInterface.PluginType;
var SkillPlugin = pluginInterface.SkillPlugin;
var HookPlugin = pluginInterface.HookPlugin;
var ValidatorPlugin = pluginInterface.ValidatorPlugin;
var ProviderPlugin = pluginInterface.ProviderPlugin;
var HookDispatcher = require('./hook-dispatcher').HookDispatcher;
var ValidatorPipeline = require('./validator-pipeline').ValidatorPipeline;

class PluginLoader {
  /**
   * @public
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
    /** @type {Map<string, object>} provider registry - factory outputs */
    this._providerRegistry = new Map();
    /** @type {HookDispatcher} hook dispatcher for internal mode */
    this._hookDispatcher = null;
    /** @type {ValidatorPipeline} validator pipeline for automated validation */
    this._validatorPipeline = null;
  }

  // --- public API ---

  /**
   * Load and activate all plugins from the registry.
   * Respects dependency order via topological sort.
   * Handles empty registries gracefully.
   *
   * @public
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
        await this.activate(name);
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
   * For Provider plugins, calls factory() and registers the output.
   * @public
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

    // For Provider plugins, call factory() and register the output
    if (plugin.type === PluginType.PROVIDER && typeof plugin.factory === 'function') {
      var providerInstance = await plugin.factory(context);
      // Register under provides names (e.g. "provider:state-store") and fallback to plugin name
      var provides = plugin.provides || [];
      var registeredAs = [];
      for (var i = 0; i < provides.length; i++) {
        var provName = provides[i].replace(/^provider:/, '');
        this._providerRegistry.set(provName, providerInstance);
        registeredAs.push(provName);
      }
      // Also register under full plugin name for backward compat
      this._providerRegistry.set(name, providerInstance);
      registeredAs.push(name);
      this._log('info', 'Provider "' + name + '" factory() called and registered as: ' + registeredAs.join(', '));
    }

    if (this._eventBus) {
      this._eventBus.emit('plugin:activated', { pluginName: name });
    }
    this._log('info', 'Plugin "' + name + '" activated');

    // Initialize HookDispatcher after first hook is activated
    if (plugin.type === PluginType.HOOK && !this._hookDispatcher) {
      this._hookDispatcher = new HookDispatcher({
        pluginLoader: this,
        logger: this._logger,
      });
      this._log('info', 'HookDispatcher initialized');
    }

    // Initialize ValidatorPipeline after first validator is activated
    if (plugin.type === PluginType.VALIDATOR && !this._validatorPipeline) {
      this._validatorPipeline = new ValidatorPipeline({
        pluginLoader: this,
        eventBus: this._eventBus,
        logger: this._logger,
      });
      this._log('info', 'ValidatorPipeline initialized');
    }
  }

  /**
   * Deactivate a single plugin.
   * @public
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
   * @public
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
   * @public
   * @param {string} name
   * @returns {object|undefined}
   */
  getPlugin(name) {
    return this.loadedPlugins.get(name);
  }

  /**
   * Check if a plugin is loaded.
   * @public
   * @param {string} name
   * @returns {boolean}
   */
  isLoaded(name) {
    return this.loadedPlugins.has(name);
  }

  /**
   * Get names of all loaded plugins.
   * @public
   * @returns {string[]}
   */
  getLoadedNames() {
    return Array.from(this.loadedPlugins.keys());
  }

  /**
   * Get a registered Provider instance by name.
   * @public
   * @param {string} name - provider name
   * @returns {object|undefined} Provider instance from factory()
   */
  getProvider(name) {
    return this._providerRegistry.get(name);
  }

  /**
   * Get all registered Provider names.
   * @public
   * @returns {string[]}
   */
  getRegisteredProviders() {
    return Array.from(this._providerRegistry.keys());
  }

  /**
   * Get the HookDispatcher instance for internal hook execution.
   * Returns null if no hooks have been activated yet.
   * @public
   * @returns {HookDispatcher|null}
   */
  getHookDispatcher() {
    return this._hookDispatcher;
  }

  /**
   * Get the ValidatorPipeline instance for automated validation.
   * Returns null if no validators have been activated yet.
   * @public
   * @returns {ValidatorPipeline|null}
   */
  getValidatorPipeline() {
    return this._validatorPipeline;
  }

  /**
   * Dispatch a hook event using internal mode.
   * Shortcut for HookDispatcher.dispatch() with mode='internal'.
   *
   * @public
   * @param {object} context - hook context { event, tool?, skill? }
   * @returns {Promise<{ allowed: boolean, results?, reason? }>}
   */
  async dispatchHook(context) {
    if (!this._hookDispatcher) {
      this._log('warn', 'HookDispatcher not initialized, cannot dispatch hook');
      return { allowed: true };
    }
    context.mode = 'internal';
    return await this._hookDispatcher.dispatch(context);
  }

  // --- internal ---

  /**
   * Read and parse the registry file.
   * @internal
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
   * @internal
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
   * Handles both plugin dependencies (dependencies.plugins) and
   * provider dependencies (dependencies.providers).
   *
   * Provider dependencies are resolved by scanning plugin.json files to
   * build a provider-name -> plugin-name mapping, then adding edges so
   * that plugins depending on a provider are loaded after the provider
   * plugin that provides it.
   *
   * @internal
   * @param {string[]} pluginNames
   * @returns {Map<string, string[]>} name -> dependency names
   */
  _buildDependencyGraph(pluginNames) {
    var graph = new Map();

    // Phase 1: Build a provider-name -> plugin-name mapping by scanning plugin.json
    var providerToPlugin = this._buildProviderMap(pluginNames);

    // Phase 2: Build dependency edges
    for (var i = 0; i < pluginNames.length; i++) {
      var name = pluginNames[i];
      var entry = this._pluginConfigs.get(name);
      var deps = [];

      // Plugin dependencies: entry.config.dependencies.plugins
      if (entry && entry.config && entry.config.dependencies) {
        var pluginDeps = entry.config.dependencies.plugins || [];
        if (Array.isArray(pluginDeps)) {
          for (var j = 0; j < pluginDeps.length; j++) {
            deps.push(pluginDeps[j]);
          }
        }
      }

      // Provider dependencies: entry.config.dependencies.providers
      if (entry && entry.config && entry.config.dependencies) {
        var providerDeps = entry.config.dependencies.providers || [];
        if (Array.isArray(providerDeps)) {
          for (var k = 0; k < providerDeps.length; k++) {
            var providerName = providerDeps[k];
            var resolvedPlugin = providerToPlugin.get(providerName);
            if (resolvedPlugin) {
              // Avoid duplicate edges
              if (deps.indexOf(resolvedPlugin) === -1) {
                deps.push(resolvedPlugin);
              }
            } else {
              this._log('warn', 'Plugin "' + name + '" depends on provider "' + providerName + '" which is not provided by any plugin');
            }
          }
        }
      }

      graph.set(name, deps);
    }
    return graph;
  }

  /**
   * Build a mapping from provider names to plugin names by scanning plugin.json files.
   * Reads each plugin's plugin.json to discover the "provides" field.
   *
   * @internal
   * @param {string[]} pluginNames
   * @returns {Map<string, string>} provider-name -> plugin-name
   */
  _buildProviderMap(pluginNames) {
    var providerToPlugin = new Map();

    for (var i = 0; i < pluginNames.length; i++) {
      var name = pluginNames[i];
      var entry = this._pluginConfigs.get(name);

      // Resolve plugin directory to read plugin.json
      try {
        var source = entry && entry.source ? entry.source : name;
        var sourceType = entry && entry.sourceType ? entry.sourceType : 'core';
        var resolvePluginPath = require('./resolve-plugin-path').resolvePluginPath;
        var registryDir = path.resolve(path.dirname(this._registryPath));
        var defaultPluginsDir = path.join(registryDir, 'core');
        var pluginDir = resolvePluginPath(
          { name: name, source: source, sourceType: sourceType },
          defaultPluginsDir,
          registryDir
        );

        var pluginJsonPath = path.join(pluginDir, 'plugin.json');
        var pluginJson = this._readPluginJson(pluginJsonPath);

        if (pluginJson.provides && Array.isArray(pluginJson.provides)) {
          for (var j = 0; j < pluginJson.provides.length; j++) {
            var providerName = pluginJson.provides[j].replace(/^provider:/, '');
            providerToPlugin.set(providerName, name);
            // Also store the full form (e.g. "provider:state-store")
            providerToPlugin.set(pluginJson.provides[j], name);
          }
        }
      } catch (err) {
        // If we can't resolve or read, skip — will be caught later during load
        this._log('warn', 'Could not scan plugin.json for "' + name + '": ' + err.message);
      }
    }

    return providerToPlugin;
  }

  /**
   * Topological sort with circular dependency detection.
   * @internal
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
   * @internal
   * @param {string} name
   * @param {object} config
   */
  async _loadPlugin(name, config) {
    var source = config && config.source ? config.source : name;
    var sourceType = config && config.sourceType ? config.sourceType : 'core';
    // Resolve plugin directory using shared resolver
    var resolvePluginPath = require('./resolve-plugin-path').resolvePluginPath;
    var registryDir = path.resolve(path.dirname(this._registryPath));
    var defaultPluginsDir = path.join(registryDir, 'core');
    var pluginDir;
    try {
      pluginDir = resolvePluginPath(
        { name: name, source: source, sourceType: sourceType },
        defaultPluginsDir,
        registryDir
      );
    } catch (resolveErr) {
      this._log('error', 'Path resolution failed for plugin "' + name + '": ' + resolveErr.message);
      throw resolveErr;
    }
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

      // Attach metadata from plugin.json to instance for all non-skill plugin types
      if (pluginJson.metadata) {
        pluginInstance.metadata = pluginJson.metadata;
      }
    }

    // Set common properties
    pluginInstance.config = config || {};
    pluginInstance.state = PluginState.LOADED;
    if (pluginJson.provides) {
      pluginInstance.provides = pluginJson.provides;
    }

    this.loadedPlugins.set(name, pluginInstance);
  }

  /**
   * Read and parse plugin.json.
   * @internal
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
   * Get a registered Provider instance by name.
   * Returns the factory output from the provider registry.
   * Used by PluginContext.getProvider().
   * @internal
   * @param {string} name - provider name
   * @returns {object|undefined} Provider instance or undefined
   */
  _getProvider(name) {
    return this._providerRegistry.get(name);
  }

  /**
   * Internal logging helper.
   * @internal
   */
  _log(level, message) {
    if (this._logger && typeof this._logger[level] === 'function') {
      this._logger[level]('plugin-loader', message);
    }
  }
}

module.exports = PluginLoader;
