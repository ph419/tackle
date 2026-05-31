/**
 * HarnessBuild - Plugin-to-native format builder for AI Agent Harness
 *
 * Reads plugins from plugin-registry.json, converts them to Claude Code
 * native skill/hook format, and outputs to .claude/skills/ and .claude/hooks/.
 *
 * This module acts as a thin orchestrator that delegates to specialized modules:
 *   - yaml-parser.js      — YAML configuration parsing
 *   - plugin-validator.js  — Plugin format validation + capabilities validation
 *   - settings-merger.js   — Settings.json hook merging
 *   - claude-md-injector.js — CLAUDE.md rule injection
 *
 * @module harness-build
 *
 * CLI entry point moved to build-cli.js.
 *
 * Usage (via build-cli.js):
 *   node plugins/runtime/build-cli.js             # build all plugins
 *   node plugins/runtime/build-cli.js --validate   # validate only
 *
 * Features:
 *   - Builds skill plugins -> .claude/skills/{name}/skill.md
 *   - Builds hook plugins  -> .claude/hooks/{name}/index.js
 *   - Validates plugin.json required fields
 *   - Handles empty registries gracefully
 *   - Build report with plugin counts and output paths
 */

'use strict';

var fs = require('fs');
var path = require('path');

// Sub-modules
var yamlParser = require('./yaml-parser');
var pluginValidator = require('./plugin-validator');
var settingsMerger = require('./settings-merger');
var claudeMdInjector = require('./claude-md-injector');

// ---------------------------------------------------------------------------
// HarnessBuild class
// ---------------------------------------------------------------------------

/**
 * HarnessBuild constructor.
 * @public
 * @param {object} [options]
 * @param {string} [options.rootDir]        - project root directory (deprecated, use targetRoot)
 * @param {string} [options.targetRoot]     - target project root directory
 * @param {string} [options.packageRoot]    - tackle-harness package root directory
 * @param {string} [options.registryPath]   - override path to plugin-registry.json
 * @param {string} [options.pluginsDir]     - override path to plugins/core/
 * @param {string} [options.outputSkillsDir] - override output .claude/skills/
 * @param {string} [options.outputHooksDir]  - override output .claude/hooks/
 * @param {boolean} [options.verbose]       - enable verbose logging
 * @param {boolean} [options.globalMode]    - global install mode (use default context config)
 * @param {string} [options.cliPath]        - absolute path to CLI binary for __TACKLE_CLI_PATH__ replacement
 */
function HarnessBuild(options) {
  options = options || {};

  // Support both old rootDir and new targetRoot naming
  this._targetRoot = options.targetRoot || options.rootDir || process.cwd();
  this._packageRoot = options.packageRoot || this._targetRoot;
  this._registryPath = options.registryPath || path.join(this._packageRoot, 'plugins', 'plugin-registry.json');
  this._pluginsDir = options.pluginsDir || path.join(this._packageRoot, 'plugins', 'core');
  this._outputSkillsDir = options.outputSkillsDir || path.join(this._targetRoot, '.claude', 'skills');
  this._outputHooksDir = options.outputHooksDir || path.join(this._targetRoot, '.claude', 'hooks');
  this._verbose = options.verbose || false;
  this._globalMode = options.globalMode || false;
  this._cliPath = options.cliPath || null;
  this._logger = options.logger || null;

  // Legacy alias for backward compatibility
  this._rootDir = this._targetRoot;

  /** @type {object[]} validation errors collected during --validate */
  this._validationErrors = [];
  /** @type {object[]} validation warnings */
  this._validationWarnings = [];
  /** @type {object[]} build results */
  this._buildResults = [];
  /** @type {object|null} cached harness config */
  this._harnessConfig = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run validation on all plugins listed in the registry.
 * Checks plugin.json format, required fields, and companion files.
 *
 * @public
 * @returns {{ valid: boolean, errors: object[], warnings: object[], summary: string }}
 */
HarnessBuild.prototype.validate = function validate() {
  this._validationErrors = [];
  this._validationWarnings = [];

  var registry = this._readRegistry();
  var pluginEntries = this._getPluginEntries(registry);

  if (pluginEntries.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [],
      summary: 'Registry is empty, nothing to validate.',
    };
  }

  for (var i = 0; i < pluginEntries.length; i++) {
    this._validatePlugin(pluginEntries[i]);
  }

  var valid = this._validationErrors.length === 0;
  var summary = pluginValidator.formatValidationSummary({
    totalPlugins: pluginEntries.length,
    errors: this._validationErrors,
    warnings: this._validationWarnings,
  });

  return {
    valid: valid,
    errors: this._validationErrors,
    warnings: this._validationWarnings,
    summary: summary,
  };
};

/**
 * Build all plugins from the registry into Claude Code native format.
 *
 * @public
 * @returns {{ success: boolean, built: object[], errors: object[], summary: string }}
 */
HarnessBuild.prototype.build = function build() {
  this._buildResults = [];

  // Validate configuration first - degrade to warning on failure
  var configValidation = this.validateConfig();
  if (!configValidation.valid) {
    // Config validation failed - log warnings and continue with defaults
    this._log('warn', 'Configuration file not found or invalid. Using default values.');
    for (var i = 0; i < configValidation.errors.length; i++) {
      this._log('warn', '  - ' + configValidation.errors[i]);
    }
    this._log('warn', 'Run "npm run init" to create a default configuration file.');
  } else if (configValidation.warnings.length > 0) {
    for (var j = 0; j < configValidation.warnings.length; j++) {
      this._log('warn', 'Config warning: ' + configValidation.warnings[j]);
    }
  }

  var registry = this._readRegistry();
  var pluginEntries = this._getPluginEntries(registry);

  if (pluginEntries.length === 0) {
    return {
      success: true,
      built: [],
      errors: [],
      summary: 'Registry is empty, build produced no output.',
    };
  }

  var buildErrors = [];

  for (var k = 0; k < pluginEntries.length; k++) {
    try {
      var result = this._buildPlugin(pluginEntries[k]);
      this._buildResults.push(result);
    } catch (err) {
      buildErrors.push({
        plugin: pluginEntries[k].name || 'unknown',
        error: err.message,
      });
    }
  }

  var success = buildErrors.length === 0;
  var summary = this._formatBuildSummary(this._buildResults, buildErrors);

  return {
    success: success,
    built: this._buildResults,
    errors: buildErrors,
    summary: summary,
  };
};

/**
 * Validate the harness-config.yaml file.
 * Uses ConfigValidator to check structure and report issues.
 *
 * @public
 * @returns {{ valid: boolean, errors: string[], warnings: string[], summary: string }}
 */
HarnessBuild.prototype.validateConfig = function validateConfig() {
  var ConfigValidator = require('./config-validator');
  var validator = new ConfigValidator();

  var configPath = path.join(this._rootDir, '.claude', 'config', 'harness-config.yaml');

  var result = validator.validateFile(configPath);

  var summary = '[Config Validation] ';
  if (result.valid) {
    summary += 'OK - Configuration is valid';
    if (result.warnings.length > 0) {
      summary += ' (' + result.warnings.length + ' warning' + (result.warnings.length > 1 ? 's' : '') + ')';
    }
  } else {
    summary += 'FAILED - ' + result.errors.length + ' error' + (result.errors.length > 1 ? 's' : '') + ' found';
  }

  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    summary: summary,
  };
};

/**
 * Merge tackle-harness hooks into the target project's .claude/settings.json.
 * Delegates to settings-merger module.
 *
 * @public
 * @param {string} targetRoot  - target project root directory
 * @param {string} packageRoot - this package's root directory (node_modules/tackle-harness/)
 */
HarnessBuild.prototype.updateSettings = function updateSettings(targetRoot, packageRoot) {
  return settingsMerger.mergeSettings({
    targetRoot: targetRoot,
    packageRoot: packageRoot,
    ensureDir: this._ensureDir.bind(this),
  });
};

/**
 * Inject tackle-harness managed rules into the target project's CLAUDE.md.
 * Delegates to claude-md-injector module.
 *
 * @public
 * @param {string} targetRoot - target project root directory
 */
HarnessBuild.prototype.injectClaudeMdRules = function injectClaudeMdRules(targetRoot) {
  var registry = this._readRegistry();
  var pluginEntries = this._getPluginEntries(registry);

  return claudeMdInjector.injectClaudeMdRules({
    targetRoot: targetRoot,
    pluginEntries: pluginEntries,
    resolvePluginDir: this._resolvePluginDir.bind(this),
    log: this._log.bind(this),
  });
};

// ---------------------------------------------------------------------------
// Registry reading
// ---------------------------------------------------------------------------

/**
 * Read and parse the plugin registry.
 * Uses manifest-resolver to merge global registry with project manifest.
 * @internal
 * @returns {object}
 */
HarnessBuild.prototype._readRegistry = function _readRegistry() {
  try {
    var ManifestResolver = require('./manifest-resolver');
    return ManifestResolver.resolveEffectivePlugins(this._packageRoot, this._targetRoot);
  } catch (err) {
    this._log('warn', 'Could not read registry: ' + err.message + '. Using empty registry.');
    return { version: '1.0.0', plugins: [] };
  }
};

/**
 * Extract plugin entries from the registry.
 * Supports array format: [{ name, source, enabled, config }]
 *
 * @internal
 * @param {object} registry
 * @returns {object[]}
 */
HarnessBuild.prototype._getPluginEntries = function _getPluginEntries(registry) {
  var plugins = registry.plugins;
  if (!plugins || !Array.isArray(plugins)) {
    return [];
  }
  // Filter out disabled plugins
  var entries = [];
  for (var i = 0; i < plugins.length; i++) {
    var entry = plugins[i];
    if (entry && entry.enabled !== false) {
      entries.push(entry);
    }
  }
  return entries;
};

// ---------------------------------------------------------------------------
// Validation (delegates to plugin-validator, with capabilities check)
// ---------------------------------------------------------------------------

/**
 * Validate a single plugin entry.
 * Uses plugin-validator for structural checks, then adds capabilities validation.
 * @internal
 * @param {object} entry - registry entry with at least a name field
 */
HarnessBuild.prototype._validatePlugin = function _validatePlugin(entry) {
  var pluginDir = this._resolvePluginDir(entry);

  // Delegate structural validation to plugin-validator
  var result = pluginValidator.validatePlugin(entry, pluginDir);
  this._validationErrors = this._validationErrors.concat(result.errors);
  this._validationWarnings = this._validationWarnings.concat(result.warnings);

  // Capabilities field validation (v0.2.0 security minimum)
  // Check if plugin directory and meta exist (validator may have returned early)
  if (fs.existsSync(pluginDir)) {
    var metaPath = path.join(pluginDir, 'plugin.json');
    if (fs.existsSync(metaPath)) {
      try {
        var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.capabilities) {
          var capWarnings = pluginValidator.validateCapabilities(meta.capabilities);
          var pluginName = entry.name || entry.source || 'unknown';
          for (var c = 0; c < capWarnings.length; c++) {
            this._validationWarnings.push({
              plugin: pluginName,
              field: capWarnings[c].field,
              message: capWarnings[c].message,
            });
          }
        }
      } catch (e) {
        // already caught by validatePlugin
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Resolve the plugin directory from a registry entry.
 * Uses entry.source if provided, otherwise derives from entry.name.
 *
 * @internal
 * @param {object} entry
 * @returns {string}
 */
HarnessBuild.prototype._resolvePluginDir = function _resolvePluginDir(entry) {
  var resolvePluginPath = require('./resolve-plugin-path').resolvePluginPath;
  var registryDir = path.resolve(path.dirname(this._registryPath));
  return resolvePluginPath(entry, this._pluginsDir, registryDir);
};

/**
 * Build a single plugin.
 *
 * @internal
 * @param {object} entry - registry entry
 * @returns {{ name: string, type: string, outputPath: string, files: string[] }}
 */
HarnessBuild.prototype._buildPlugin = function _buildPlugin(entry) {
  var pluginDir;
  try {
    pluginDir = this._resolvePluginDir(entry);
  } catch (resolveErr) {
    throw new Error('Path resolution failed for plugin "' + (entry.name || 'unknown') + '": ' + resolveErr.message);
  }
  var metaPath = path.join(pluginDir, 'plugin.json');

  // Read plugin metadata
  if (!fs.existsSync(metaPath)) {
    throw new Error('plugin.json not found in ' + pluginDir);
  }
  var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

  var pluginName = meta.name || entry.name;
  var pluginType = meta.type;

  this._log('info', 'Building plugin: ' + pluginName + ' (type: ' + pluginType + ')');

  // External plugin source warning (npm/local sourceType only)
  var sourceType = entry.sourceType || 'core';
  if (sourceType === 'npm' || sourceType === 'local') {
    this._log('warn', 'Building external plugin: ' + pluginName + ' (source: ' + sourceType + ')');
    if (meta.capabilities && Object.keys(meta.capabilities).length > 0) {
      this._log('warn', '  Declared capabilities: ' + Object.keys(meta.capabilities).join(', '));
    } else {
      this._log('warn', '  No capabilities declared (limited to basic services)');
    }
  }

  // Dispatch by type
  switch (pluginType) {
    case 'skill':
      return this._buildSkillPlugin(pluginName, pluginDir, meta);
    case 'hook':
      return this._buildHookPlugin(pluginName, pluginDir, meta);
    case 'validator':
      return this._buildValidatorPlugin(pluginName, pluginDir, meta);
    case 'provider':
      return this._buildProviderPlugin(pluginName, pluginDir, meta);
    default:
      throw new Error('Unknown plugin type: ' + pluginType);
  }
};

/**
 * Build a skill plugin.
 * Copies skill.md from plugin directory to .claude/skills/{name}/skill.md.
 *
 * @internal
 * @param {string} name
 * @param {string} pluginDir
 * @param {object} meta
 * @returns {{ name: string, type: string, outputPath: string, files: string[] }}
 */
HarnessBuild.prototype._buildSkillPlugin = function _buildSkillPlugin(name, pluginDir, meta) {
  var skillMdSrc = path.join(pluginDir, 'skill.md');
  var outputDir = path.join(this._outputSkillsDir, name);
  var skillMdDest = path.join(outputDir, 'skill.md');
  var files = [];

  // Ensure output directory exists
  this._ensureDir(outputDir);

  // Copy companion reference files (*.md except skill.md) to output directory
  var companionFiles = fs.readdirSync(pluginDir).filter(function(f) {
    return f !== 'skill.md' && f !== 'plugin.json' && f.endsWith('.md');
  });
  companionFiles.forEach(function(refFile) {
    var src = path.join(pluginDir, refFile);
    var dest = path.join(outputDir, refFile);
    fs.writeFileSync(dest, fs.readFileSync(src, 'utf-8'), 'utf-8');
    files.push(dest);
  });

  // Check if source skill.md exists
  if (fs.existsSync(skillMdSrc)) {
    // Read the source skill content
    var content = fs.readFileSync(skillMdSrc, 'utf-8');

    // Replace source-relative paths with output-relative paths
    var sourcePath = 'plugins/core/' + name + '/';
    var targetPath = '.claude/skills/' + name + '/';
    content = content.split(sourcePath).join(targetPath);

    // Replace __TACKLE_CLI_PATH__ placeholder with actual CLI path
    if (this._cliPath) {
      var cliPath = this._cliPath.replace(/\\/g, '/'); // Normalize to forward slashes
      content = content.split('__TACKLE_CLI_PATH__').join(cliPath);
    }

    // If the skill.md has a front-matter header, keep it.
    // If not, generate one from plugin.json metadata.
    if (!this._hasFrontMatter(content)) {
      content = this._generateSkillFrontMatter(meta) + '\n' + content;
    }

    // Inject context window configuration
    content = this._injectContextConfig(content, name);

    fs.writeFileSync(skillMdDest, content, 'utf-8');
    files.push(skillMdDest);
    this._log('info', '  -> ' + skillMdDest);
  } else {
    // Generate a minimal skill.md from metadata
    var generated = this._generateSkillContent(meta);
    fs.writeFileSync(skillMdDest, generated, 'utf-8');
    files.push(skillMdDest);
    this._log('info', '  -> ' + skillMdDest + ' (generated from metadata)');
  }

  return {
    name: name,
    type: 'skill',
    outputPath: outputDir,
    files: files,
  };
};

/**
 * Build a hook plugin.
 * Copies index.js from plugin directory to .claude/hooks/{name}/index.js.
 *
 * @internal
 * @param {string} name
 * @param {string} pluginDir
 * @param {object} meta
 * @returns {{ name: string, type: string, outputPath: string, files: string[] }}
 */
HarnessBuild.prototype._buildHookPlugin = function _buildHookPlugin(name, pluginDir, meta) {
  var indexJsSrc = path.join(pluginDir, 'index.js');
  var outputDir = path.join(this._outputHooksDir, name);
  var indexJsDest = path.join(outputDir, 'index.js');
  var files = [];

  this._ensureDir(outputDir);

  if (fs.existsSync(indexJsSrc)) {
    var content = fs.readFileSync(indexJsSrc, 'utf-8');
    fs.writeFileSync(indexJsDest, content, 'utf-8');
    files.push(indexJsDest);
    this._log('info', '  -> ' + indexJsDest);
  } else {
    // Generate a stub hook
    var stub = this._generateHookStub(meta);
    fs.writeFileSync(indexJsDest, stub, 'utf-8');
    files.push(indexJsDest);
    this._log('info', '  -> ' + indexJsDest + ' (stub generated)');
  }

  return {
    name: name,
    type: 'hook',
    outputPath: outputDir,
    files: files,
  };
};

/**
 * Build a validator plugin.
 * Validator plugins don't have a native Claude Code output format,
 * so we record them but don't write files to skills/hooks.
 *
 * @internal
 * @param {string} name
 * @param {string} pluginDir
 * @param {object} meta
 * @returns {{ name: string, type: string, outputPath: string, files: string[] }}
 */
HarnessBuild.prototype._buildValidatorPlugin = function _buildValidatorPlugin(name, pluginDir, meta) {
  this._log('info', '  -> Validator plugin (no native output, registered internally)');

  return {
    name: name,
    type: 'validator',
    outputPath: '(internal)',
    files: [],
  };
};

/**
 * Build a provider plugin.
 * Provider plugins are runtime-only, no native Claude Code output.
 * If metadata.deploy_assets is true, copy assets/ directory to .claude/{deploy_path}/.
 *
 * @internal
 * @param {string} name
 * @param {string} pluginDir
 * @param {object} meta
 * @returns {{ name: string, type: string, outputPath: string, files: string[] }}
 */
HarnessBuild.prototype._buildProviderPlugin = function _buildProviderPlugin(name, pluginDir, meta) {
  var files = [];

  // Check for asset deployment
  if (meta.metadata && meta.metadata.deploy_assets) {
    var assetsDir = path.join(pluginDir, 'assets');
    var deployPath = meta.metadata.deploy_path || name;
    var outputDir = path.join(this._rootDir, '.claude', deployPath);

    if (fs.existsSync(assetsDir)) {
      this._log('info', '  -> Deploying provider assets to ' + outputDir);
      files = this._copyDirectory(assetsDir, outputDir);
      this._log('info', '  -> ' + files.length + ' files deployed');
    } else {
      this._log('warn', '  -> deploy_assets set but no assets/ directory found in ' + pluginDir);
    }
  } else {
    this._log('info', '  -> Provider plugin (no native output, registered internally)');
  }

  return {
    name: name,
    type: 'provider',
    outputPath: files.length > 0 ? path.join(this._rootDir, '.claude', deployPath) : '(internal)',
    files: files,
  };
};

/**
 * Format build summary for output.
 * Enhanced with installation path and global mode indicator.
 *
 * @internal
 * @param {object[]} results
 * @param {object[]} errors
 * @returns {string}
 */
HarnessBuild.prototype._formatBuildSummary = function _formatBuildSummary(results, errors) {
  var lines = [];
  lines.push('');
  lines.push('=== Build Report ===');

  var skillCount = 0;
  var hookCount = 0;
  var validatorCount = 0;
  var providerCount = 0;
  var totalFiles = 0;

  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    totalFiles += r.files.length;
    switch (r.type) {
      case 'skill': skillCount++; break;
      case 'hook': hookCount++; break;
      case 'validator': validatorCount++; break;
      case 'provider': providerCount++; break;
    }
  }

  // Show installation mode
  if (this._globalMode) {
    lines.push('Installation: Global (home directory)');
  } else {
    lines.push('Installation: Project (local)');
  }

  // Show output paths
  lines.push('Skills output: ' + this._outputSkillsDir);
  lines.push('Hooks output:  ' + this._outputHooksDir);
  lines.push('');

  lines.push('Plugins built: ' + results.length);
  lines.push('  Skills:     ' + skillCount);
  lines.push('  Hooks:      ' + hookCount);
  lines.push('  Validators: ' + validatorCount);
  lines.push('  Providers:  ' + providerCount);
  lines.push('Files written: ' + totalFiles);

  if (results.length > 0) {
    lines.push('');
    lines.push('--- Output Details ---');
    for (var j = 0; j < results.length; j++) {
      var item = results[j];
      lines.push('  [' + item.type + '] ' + item.name + ' -> ' + item.outputPath);
      for (var k = 0; k < item.files.length; k++) {
        lines.push('    ' + item.files[k]);
      }
    }
  }

  if (errors.length > 0) {
    lines.push('');
    lines.push('--- Build Errors ---');
    for (var m = 0; m < errors.length; m++) {
      lines.push('  [' + errors[m].plugin + '] ' + errors[m].error);
    }
  }

  lines.push('');
  lines.push(errors.length === 0 ? 'Build SUCCEEDED' : 'Build COMPLETED WITH ERRORS');
  lines.push('');

  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Content generation helpers
// ---------------------------------------------------------------------------

/**
 * Check if a skill.md already has YAML front matter.
 * @internal
 * @param {string} content
 * @returns {boolean}
 */
HarnessBuild.prototype._hasFrontMatter = function _hasFrontMatter(content) {
  return content.trimLeft().indexOf('---') === 0;
};

/**
 * Generate YAML front matter for a skill from plugin metadata.
 * @internal
 * @param {object} meta
 * @returns {string}
 */
HarnessBuild.prototype._generateSkillFrontMatter = function _generateSkillFrontMatter(meta) {
  var lines = ['---'];
  lines.push('name: ' + (meta.name || ''));
  lines.push('description: ' + (meta.description || ''));

  if (meta.triggers && meta.triggers.length > 0) {
    lines.push('triggers:');
    for (var i = 0; i < meta.triggers.length; i++) {
      lines.push('  - ' + meta.triggers[i]);
    }
  }

  if (meta.config) {
    if (meta.config.plan_mode_required) {
      lines.push('plan_mode_required: true');
    }
  }

  lines.push('---');
  return lines.join('\n');
};

/**
 * Generate a full skill.md content from plugin metadata when no skill.md exists.
 * @internal
 * @param {object} meta
 * @returns {string}
 */
HarnessBuild.prototype._generateSkillContent = function _generateSkillContent(meta) {
  var frontMatter = this._generateSkillFrontMatter(meta);

  var body = '\n# ' + (meta.name || 'Unnamed Skill') + '\n';
  body += '\n' + (meta.description || '') + '\n';

  if (meta.triggers && meta.triggers.length > 0) {
    body += '\n## Triggers\n';
    for (var i = 0; i < meta.triggers.length; i++) {
      body += '- ' + meta.triggers[i] + '\n';
    }
  }

  body += '\n> Auto-generated by harness-build from plugin.json metadata.\n';

  return frontMatter + body;
};

/**
 * Generate a stub hook index.js from plugin metadata.
 * @internal
 * @param {object} meta
 * @returns {string}
 */
HarnessBuild.prototype._generateHookStub = function _generateHookStub(meta) {
  var lines = [
    '/**',
    ' * Hook plugin: ' + (meta.name || 'unnamed'),
    ' *',
    ' * Auto-generated stub by harness-build.',
    ' * Replace with actual hook implementation.',
    ' */',
    '',
    '\'use strict\';',
    '',
    'module.exports = {',
    '  name: \'' + (meta.name || 'unnamed-hook') + '\',',
    '  version: \'' + (meta.version || '0.0.0') + '\',',
    '',
    '  /**',
    '   * Handle hook invocation.',
    '   * @param {object} context',
    '   * @returns {Promise<{ allowed: boolean, reason?: string }>}',
    '   */',
    '  async handle(context) {',
    '    return { allowed: true };',
    '  },',
    '};',
    '',
  ];
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// YAML config reading (delegates to yaml-parser)
// ---------------------------------------------------------------------------

/**
 * Read and cache the harness config YAML file.
 * Delegates to yaml-parser module.
 * @internal
 * @returns {object}
 */
HarnessBuild.prototype._readHarnessConfig = function _readHarnessConfig() {
  if (this._harnessConfig !== null) {
    return this._harnessConfig;
  }

  var configPath = path.join(this._rootDir, '.claude', 'config', 'harness-config.yaml');
  this._harnessConfig = yamlParser.parseYamlFile(configPath);
  return this._harnessConfig;
};

// ---------------------------------------------------------------------------
// Context injection (uses yaml-parser for serialization)
// ---------------------------------------------------------------------------

/**
 * Inject context window configuration into a skill.md file.
 * Inserts a <!-- CONTEXT-CONFIG --> block after front matter.
 *
 * In global mode, uses default context config instead of reading from project config.
 *
 * @internal
 * @param {string} content - the skill.md content
 * @param {string} pluginName - the plugin name for per-plugin overrides
 * @returns {string} content with injected config block
 */
HarnessBuild.prototype._injectContextConfig = function _injectContextConfig(content, pluginName) {
  var relevantConfig = null;
  var configBlockName = '';

  if (this._globalMode) {
    // Global mode: use default context config
    relevantConfig = {
      enabled: true,
      chunk_size: 120000,
      overlap: 2000,
      thresholds: {
        small: 50000,
        medium: 150000,
        large: 300000
      }
    };
    configBlockName = 'CONTEXT-CONFIG';
  } else {
    // Project mode: read from harness config
    var config = this._readHarnessConfig();
    if (!config || Object.keys(config).length === 0) {
      return content; // No config, skip injection
    }

    // Determine which config section to inject based on plugin name
    if ((pluginName === 'skill-agent-dispatcher' || pluginName === 'agent-dispatcher') && config.agent_dispatcher) {
      relevantConfig = config.agent_dispatcher;
      configBlockName = 'AGENT-DISPATCHER-CONFIG';
    } else if (config.context_window) {
      relevantConfig = config.context_window;
      configBlockName = 'CONTEXT-CONFIG';
    }

    if (!relevantConfig || Object.keys(relevantConfig).length === 0) {
      return content;
    }

    // Apply per-plugin override if exists (only for context_window)
    if (config.overrides && config.overrides[pluginName] && relevantConfig === config.context_window) {
      var override = config.overrides[pluginName];
      for (var k in override) {
        if (override.hasOwnProperty(k)) {
          relevantConfig[k] = override[k];
        }
      }
    }
  }

  // Build config block
  var lines = ['\n<!-- ' + configBlockName];
  for (var key in relevantConfig) {
    if (!relevantConfig.hasOwnProperty(key)) continue;
    var val = relevantConfig[key];
    if (Array.isArray(val)) {
      lines.push(key + ': ' + yamlParser.serializeConfigValue(val));
    } else if (typeof val === 'object' && val !== null) {
      // Flatten nested objects (e.g., thresholds)
      var parts = [];
      for (var sk in val) {
        if (val.hasOwnProperty(sk)) {
          parts.push(sk + '=' + yamlParser.serializeConfigValue(val[sk]));
        }
      }
      lines.push(key + ': ' + parts.join(', '));
    } else {
      lines.push(key + ': ' + val);
    }
  }
  lines.push(configBlockName + ' -->\n');

  var configBlock = lines.join('\n');

  // Find insertion point: after front matter closing ---
  var fmCloseIdx = content.indexOf('---', 1); // skip first ---
  if (fmCloseIdx === -1) {
    // No front matter, prepend
    return configBlock + content;
  }

  var afterFm = content.indexOf('\n', fmCloseIdx + 3);
  if (afterFm === -1) {
    afterFm = content.length;
  } else {
    afterFm += 1; // skip the newline itself
  }

  return content.substring(0, afterFm) + configBlock + content.substring(afterFm);
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Ensure a directory exists, creating it recursively if needed.
 * @internal
 * @param {string} dirPath
 */
HarnessBuild.prototype._ensureDir = function _ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    this._mkdirRecursive(dirPath);
  }
};

/**
 * Recursively create directories (like mkdir -p).
 * @internal
 * @param {string} dirPath
 */
HarnessBuild.prototype._mkdirRecursive = function _mkdirRecursive(dirPath) {
  var parent = path.dirname(dirPath);
  if (!fs.existsSync(parent)) {
    this._mkdirRecursive(parent);
  }
  fs.mkdirSync(dirPath);
};

/**
 * Recursively copy a directory.
 * @internal
 * @param {string} srcDir - Source directory
 * @param {string} destDir - Destination directory
 * @returns {string[]} List of copied file paths
 */
HarnessBuild.prototype._copyDirectory = function _copyDirectory(srcDir, destDir) {
  var copiedFiles = [];

  if (!fs.existsSync(destDir)) {
    this._mkdirRecursive(destDir);
  }

  var entries = fs.readdirSync(srcDir);
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var srcPath = path.join(srcDir, entry);
    var destPath = path.join(destDir, entry);
    var stat = fs.statSync(srcPath);

    if (stat.isDirectory()) {
      var subFiles = this._copyDirectory(srcPath, destPath);
      copiedFiles = copiedFiles.concat(subFiles);
    } else {
      fs.writeFileSync(destPath, fs.readFileSync(srcPath));
      copiedFiles.push(destPath);
    }
  }

  return copiedFiles;
};

/**
 * Internal logging.
 * @internal
 * @param {string} level
 * @param {string} message
 */
HarnessBuild.prototype._log = function _log(level, message) {
  // Skip info messages unless verbose mode is enabled
  if (level === 'info' && !this._verbose) {
    return;
  }
  if (this._logger && typeof this._logger[level] === 'function') {
    this._logger[level]('harness-build', message);
  } else {
    var prefix = '[harness-build] [' + level + ']';
    if (level === 'error') {
      console.error(prefix, message);
    } else if (level === 'warn') {
      console.warn(prefix, message);
    } else {
      console.log(prefix, message);
    }
  }
};

/**
 * Detect whether this is a local or global installation.
 * Delegates to settings-merger module.
 *
 * @internal
 * @param {string} packageRoot - this package's root directory
 * @param {string} targetRoot - target project root directory
 * @returns {boolean} true if local install, false if global install
 */
HarnessBuild.prototype._isLocalInstall = function _isLocalInstall(packageRoot, targetRoot) {
  return settingsMerger.isLocalInstall(packageRoot, targetRoot);
};

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = HarnessBuild;
