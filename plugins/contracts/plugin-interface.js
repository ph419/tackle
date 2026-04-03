/**
 * Plugin Interface - Plugin contract definitions for AI Agent Harness
 *
 * Defines the base interface and type markers for all plugin types:
 * - ProviderPlugin: capability providers (role-registry, memory-store, etc.)
 * - HookPlugin: lifecycle hooks (pre/post tool use)
 * - ValidatorPlugin: output validators
 * - SkillPlugin: executable skills
 */

'use strict';

/**
 * Plugin lifecycle states
 */
const PluginState = {
  DISCOVERED: 'discovered',
  LOADED: 'loaded',
  RESOLVED: 'resolved',
  ACTIVATED: 'activated',
  RUNNING: 'running',
  DEACTIVATED: 'deactivated',
  UNLOADED: 'unloaded',
};

/**
 * Plugin type constants
 */
const PluginType = {
  SKILL: 'skill',
  HOOK: 'hook',
  VALIDATOR: 'validator',
  PROVIDER: 'provider',
};

/**
 * Base Plugin class. All plugin implementations should extend this.
 *
 * Subclasses must set:
 *   - type {string}       one of PluginType values
 *   - name {string}       unique kebab-case identifier
 *   - version {string}    semver version string
 *
 * Optional overrides:
 *   - description {string}
 *   - dependencies {{ plugins?: string[], providers?: string[] }}
 *   - onActivate(context)   called during activation
 *   - onDeactivate()        called during deactivation
 */
class Plugin {
  constructor() {
    /** @type {string} */
    this.type = '';
    /** @type {string} */
    this.name = '';
    /** @type {string} */
    this.version = '0.0.0';
    /** @type {string} */
    this.description = '';
    /** @type {{ plugins?: string[], providers?: string[] }} */
    this.dependencies = {};
    /** @type {string} current lifecycle state */
    this.state = PluginState.DISCOVERED;
  }

  /**
   * Called when the plugin is activated.
   * @param {PluginContext} context - injected runtime context
   */
  async onActivate(context) {
    // default no-op
  }

  /**
   * Called when the plugin is deactivated.
   */
  async onDeactivate() {
    // default no-op
  }
}

/**
 * SkillPlugin - executable skill plugin
 *
 * Additional properties:
 *   - triggers {string[]}     keywords that activate this skill
 *   - metadata.stage          workflow stage
 *   - metadata.requiresPlanMode
 *   - metadata.gatedByHuman
 *   - metadata.gatedByCode
 */
class SkillPlugin extends Plugin {
  constructor() {
    super();
    this.type = PluginType.SKILL;
    /** @type {string[]} */
    this.triggers = [];
    /** @type {object} */
    this.metadata = {};
  }

  /**
   * Execute the skill.
   * @param {PluginContext} context
   * @param {object} args - skill-specific arguments
   * @returns {Promise<object>} skill result
   */
  async execute(context, args) {
    throw new Error('SkillPlugin.execute() must be implemented by subclass');
  }
}

/**
 * HookPlugin - lifecycle hook plugin
 *
 * Additional properties:
 *   - trigger.event   {'PreToolUse' | 'PostToolUse'}
 *   - trigger.tools   {string[]}   (optional) tool filter
 *   - trigger.skills  {string[]}   (optional) skill filter
 *   - priority        {number}     execution priority (lower = earlier)
 */
class HookPlugin extends Plugin {
  constructor() {
    super();
    this.type = PluginType.HOOK;
    /** @type {{ event: string, tools?: string[], skills?: string[] }} */
    this.trigger = { event: '', tools: [], skills: [] };
    /** @type {number} */
    this.priority = 100;
  }

  /**
   * Handle a hook invocation.
   * @param {object} context - hook context
   * @returns {Promise<{ allowed: boolean, reason?: string, stateChanges?: object[] }>}
   */
  async handle(context) {
    throw new Error('HookPlugin.handle() must be implemented by subclass');
  }
}

/**
 * ValidatorPlugin - output validation plugin
 *
 * Additional properties:
 *   - targets   {string[]}  skill names this validator checks
 *   - blocking  {boolean}   whether failure stops the workflow
 */
class ValidatorPlugin extends Plugin {
  constructor() {
    super();
    this.type = PluginType.VALIDATOR;
    /** @type {string[]} */
    this.targets = [];
    /** @type {boolean} */
    this.blocking = true;
  }

  /**
   * Run validation.
   * @param {object} context - validation context
   * @returns {Promise<{ passed: boolean, errors: object[], warnings: object[] }>}
   */
  async validate(context) {
    throw new Error('ValidatorPlugin.validate() must be implemented by subclass');
  }
}

/**
 * ProviderPlugin - capability provider plugin
 *
 * Additional properties:
 *   - provides {string}  capability identifier
 */
class ProviderPlugin extends Plugin {
  constructor() {
    super();
    this.type = PluginType.PROVIDER;
    /** @type {string} */
    this.provides = '';
  }

  /**
   * Create the provider instance.
   * @param {PluginContext} context
   * @returns {Promise<object>} provider instance
   */
  async factory(context) {
    throw new Error('ProviderPlugin.factory() must be implemented by subclass');
  }
}

/**
 * PluginContext - injected into every plugin on activation.
 */
class PluginContext {
  /**
   * @param {string} pluginName
   * @param {object} runtime - { eventBus, stateStore, logger, configManager }
   */
  constructor(pluginName, runtime) {
    this.pluginName = pluginName;
    this.eventBus = runtime.eventBus;
    this.stateStore = runtime.stateStore;
    this.logger = runtime.logger;
    this.config = runtime.configManager;
    this._runtime = runtime;
    this._providerCache = new Map();
  }

  /**
   * Lazily query a provider by name.
   * @param {string} name - provider identifier
   * @returns {Promise<object>}
   */
  async getProvider(name) {
    if (this._providerCache.has(name)) {
      return this._providerCache.get(name);
    }
    const provider = await this._runtime.getProvider(name);
    this._providerCache.set(name, provider);
    return provider;
  }

  /**
   * Get another loaded plugin by name.
   * @param {string} name
   * @returns {Plugin|undefined}
   */
  getPlugin(name) {
    return this._runtime.loadedPlugins.get(name);
  }
}

module.exports = {
  PluginState,
  PluginType,
  Plugin,
  SkillPlugin,
  HookPlugin,
  ValidatorPlugin,
  ProviderPlugin,
  PluginContext,
};
