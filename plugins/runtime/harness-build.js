/**
 * HarnessBuild - Plugin-to-native format builder for AI Agent Harness
 *
 * Reads plugins from plugin-registry.json, converts them to Claude Code
 * native skill/hook format, and outputs to .claude/skills/ and .claude/hooks/.
 *
 * Usage:
 *   node plugins/runtime/harness-build.js             # build all plugins
 *   node plugins/runtime/harness-build.js --validate   # validate only
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var PLUGIN_REQUIRED_FIELDS = ['name', 'version', 'type', 'description'];
var VALID_PLUGIN_TYPES = ['skill', 'hook', 'validator', 'provider'];

// ---------------------------------------------------------------------------
// HarnessBuild class
// ---------------------------------------------------------------------------

/**
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
  var summary = this._formatValidationSummary(pluginEntries.length);

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

// ---------------------------------------------------------------------------
// Registry reading
// ---------------------------------------------------------------------------

/**
 * Read and parse the plugin registry.
 * Uses manifest-resolver to merge global registry with project manifest.
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
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a single plugin entry.
 * @param {object} entry - registry entry with at least a name field
 */
HarnessBuild.prototype._validatePlugin = function _validatePlugin(entry) {
  var pluginName = entry.name || entry.source || 'unknown';
  var pluginDir = this._resolvePluginDir(entry);

  // 1. Check plugin directory exists
  if (!fs.existsSync(pluginDir)) {
    this._validationErrors.push({
      plugin: pluginName,
      field: 'directory',
      message: 'Plugin directory not found: ' + pluginDir,
    });
    return; // can't validate further without directory
  }

  // 2. Check plugin.json exists
  var metaPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(metaPath)) {
    this._validationErrors.push({
      plugin: pluginName,
      field: 'plugin.json',
      message: 'plugin.json not found in ' + pluginDir,
    });
    return;
  }

  // 3. Parse and validate plugin.json
  var meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch (err) {
    this._validationErrors.push({
      plugin: pluginName,
      field: 'plugin.json',
      message: 'Invalid JSON in plugin.json: ' + err.message,
    });
    return;
  }

  // 4. Check required fields
  for (var i = 0; i < PLUGIN_REQUIRED_FIELDS.length; i++) {
    var field = PLUGIN_REQUIRED_FIELDS[i];
    if (!meta[field]) {
      this._validationErrors.push({
        plugin: pluginName,
        field: field,
        message: 'Missing required field: ' + field,
      });
    }
  }

  // 5. Check plugin type is valid
  if (meta.type && VALID_PLUGIN_TYPES.indexOf(meta.type) === -1) {
    this._validationErrors.push({
      plugin: pluginName,
      field: 'type',
      message: 'Invalid plugin type: "' + meta.type + '". Must be one of: ' + VALID_PLUGIN_TYPES.join(', '),
    });
  }

  // 6. Type-specific file checks
  if (meta.type === 'skill') {
    var skillMdPath = path.join(pluginDir, 'skill.md');
    if (!fs.existsSync(skillMdPath)) {
      this._validationErrors.push({
        plugin: pluginName,
        field: 'skill.md',
        message: 'Skill plugin is missing skill.md file',
      });
    }
  }

  if (meta.type === 'hook') {
    var indexPath = path.join(pluginDir, 'index.js');
    if (!fs.existsSync(indexPath)) {
      this._validationWarnings.push({
        plugin: pluginName,
        field: 'index.js',
        message: 'Hook plugin is missing index.js file (build will generate stub)',
      });
    }
  }

  // 7. Version format check (basic semver)
  if (meta.version && !/^\d+\.\d+\.\d+/.test(meta.version)) {
    this._validationWarnings.push({
      plugin: pluginName,
      field: 'version',
      message: 'Version "' + meta.version + '" does not follow semver format (x.y.z)',
    });
  }
};

/**
 * Format validation summary for output.
 * @param {number} totalPlugins
 * @returns {string}
 */
HarnessBuild.prototype._formatValidationSummary = function _formatValidationSummary(totalPlugins) {
  var lines = [];
  lines.push('');
  lines.push('=== Validation Report ===');
  lines.push('Plugins checked: ' + totalPlugins);
  lines.push('Errors: ' + this._validationErrors.length);
  lines.push('Warnings: ' + this._validationWarnings.length);

  if (this._validationErrors.length > 0) {
    lines.push('');
    lines.push('--- Errors ---');
    for (var i = 0; i < this._validationErrors.length; i++) {
      var e = this._validationErrors[i];
      lines.push('  [' + e.plugin + '] ' + e.message);
    }
  }

  if (this._validationWarnings.length > 0) {
    lines.push('');
    lines.push('--- Warnings ---');
    for (var j = 0; j < this._validationWarnings.length; j++) {
      var w = this._validationWarnings[j];
      lines.push('  [' + w.plugin + '] ' + w.message);
    }
  }

  lines.push('');
  lines.push(this._validationErrors.length === 0 ? 'Validation PASSED' : 'Validation FAILED');
  lines.push('');

  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Resolve the plugin directory from a registry entry.
 * Uses entry.source if provided, otherwise derives from entry.name.
 *
 * @param {object} entry
 * @returns {string}
 */
HarnessBuild.prototype._resolvePluginDir = function _resolvePluginDir(entry) {
  var source = entry.source || entry.name;
  if (!source) {
    return path.join(this._pluginsDir, 'unknown');
  }
  // If source is an absolute path, use it directly
  if (path.isAbsolute(source)) {
    return source;
  }
  return path.join(this._pluginsDir, source);
};

/**
 * Build a single plugin.
 *
 * @param {object} entry - registry entry
 * @returns {{ name: string, type: string, outputPath: string, files: string[] }}
 */
HarnessBuild.prototype._buildPlugin = function _buildPlugin(entry) {
  var pluginDir = this._resolvePluginDir(entry);
  var metaPath = path.join(pluginDir, 'plugin.json');

  // Read plugin metadata
  if (!fs.existsSync(metaPath)) {
    throw new Error('plugin.json not found in ' + pluginDir);
  }
  var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

  var pluginName = meta.name || entry.name;
  var pluginType = meta.type;

  this._log('info', 'Building plugin: ' + pluginName + ' (type: ' + pluginType + ')');

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
 * @param {string} content
 * @returns {boolean}
 */
HarnessBuild.prototype._hasFrontMatter = function _hasFrontMatter(content) {
  return content.trimLeft().indexOf('---') === 0;
};

/**
 * Generate YAML front matter for a skill from plugin metadata.
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
// Utilities
// ---------------------------------------------------------------------------

/**
 * Ensure a directory exists, creating it recursively if needed.
 * @param {string} dirPath
 */
HarnessBuild.prototype._ensureDir = function _ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    this._mkdirRecursive(dirPath);
  }
};

/**
 * Recursively create directories (like mkdir -p).
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
 * @param {string} level
 * @param {string} message
 */
HarnessBuild.prototype._log = function _log(level, message) {
  // Skip info messages unless verbose mode is enabled
  if (level === 'info' && !this._verbose) {
    return;
  }
  var prefix = '[harness-build] [' + level + ']';
  if (level === 'error') {
    console.error(prefix, message);
  } else if (level === 'warn') {
    console.warn(prefix, message);
  } else {
    console.log(prefix, message);
  }
};

/**
 * Read and cache the harness config YAML file.
 * @returns {object}
 */
HarnessBuild.prototype._readHarnessConfig = function _readHarnessConfig() {
  if (this._harnessConfig !== null) {
    return this._harnessConfig;
  }

  var configPath = path.join(this._rootDir, '.claude', 'config', 'harness-config.yaml');
  try {
    var content = fs.readFileSync(configPath, 'utf-8');
    // Extract multiple sections: context_window and agent_dispatcher
    var result = {};
    var inSection = false;
    var currentSection = null;
    var sectionIndent = -1;
    var lines = content.split('\n');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();

      // Detect section start (context_window or agent_dispatcher)
      if (/^(context_window|agent_dispatcher)\s*:/.test(trimmed)) {
        inSection = true;
        currentSection = trimmed.replace(/\s*:$/, '');
        sectionIndent = line.search(/\S/);
        result[currentSection] = { _source: currentSection };
        continue;
      }

      if (inSection && currentSection) {
        // Stop at next top-level section (--- separator or same-indent key)
        if (trimmed === '---' || (line.search(/\S/) >= 0 && line.search(/\S/) <= sectionIndent && !/^[\s#]/.test(trimmed) && trimmed.indexOf(currentSection) === -1 && /^[a-z_]/.test(trimmed))) {
          inSection = false;
          currentSection = null;
          continue;
        }

        // Skip empty lines and comments
        if (!trimmed || trimmed.indexOf('#') === 0) {
          continue;
        }

        // Parse simple key-value pairs (flat or one level nested)
        var colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;

        var key = trimmed.substring(0, colonIdx).trim();
        var valuePart = trimmed.substring(colonIdx + 1).trim();

        // Remove inline comments
        var commentIdx = valuePart.indexOf(' #');
        if (commentIdx >= 0) {
          valuePart = valuePart.substring(0, commentIdx).trim();
        }

        // Skip nested keys — delegate to _parseNestedBlock
        if (valuePart === '' || valuePart === null) {
          var nestedIndent = lines[i] ? lines[i].search(/\S/) : -1;
          var parsed = _parseNestedBlock(lines, i + 1, nestedIndent);
          result[currentSection][key] = parsed.value;
          i = parsed.endIdx;
          continue;
        }

        result[currentSection][key] = _parseValue(valuePart);
      }
    }

    // Clean up _source markers
    for (var section in result) {
      if (result.hasOwnProperty(section) && result[section]._source) {
        delete result[section]._source;
      }
    }

    this._harnessConfig = result;
  } catch (err) {
    this._harnessConfig = {};
  }

  return this._harnessConfig;
};

/**
 * Parse a YAML scalar value.
 */
function _parseValue(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  if ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
      (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")) {
    return val.substring(1, val.length - 1);
  }
  var num = Number(val);
  if (!isNaN(num) && val !== '') return num;
  return val;
}

/**
 * Parse a nested YAML block from raw string lines.
 * Called from _readHarnessConfig — converts raw lines to {text, indent} objects,
 * then delegates to _parseChildLines.
 *
 * @param {string[]} lines - all raw lines
 * @param {number} startIdx - index of the first child line
 * @param {number} parentIndent - indentation of the parent key
 * @returns {{value: object|Array, endIdx: number}}
 */
function _parseNestedBlock(lines, startIdx, parentIndent) {
  var childLines = [];
  var endIdx = startIdx;
  for (var i = startIdx; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim() || line.trim().indexOf('#') === 0) continue;
    var indent = line.search(/\S/);
    if (indent <= parentIndent) break;
    childLines.push({ text: line.trim(), indent: indent });
    endIdx = i;
  }

  if (childLines.length === 0) {
    return { value: {}, endIdx: startIdx - 1 };
  }

  return _parseChildLines(childLines, endIdx);
}

/**
 * Parse pre-collected child lines (always {text, indent} objects).
 * Determines list vs object block and dispatches accordingly.
 */
function _parseChildLines(childLines, rawEndIdx) {
  var isList = childLines[0].text.indexOf('- ') === 0;
  if (isList) {
    return { value: _parseListItems(childLines), endIdx: rawEndIdx };
  }
  return { value: _parseObjectItems(childLines), endIdx: rawEndIdx };
}

/**
 * Parse list items from child lines.
 * Each "- " prefixed line starts a new item; subsequent more-indented lines
 * belong to that item as nested properties.
 */
function _parseListItems(childLines) {
  var arr = [];
  var currentItem = null;
  var itemStartIndent = -1;

  for (var i = 0; i < childLines.length; i++) {
    var cl = childLines[i];

    if (cl.text.indexOf('- ') === 0) {
      if (currentItem !== null) arr.push(currentItem);
      var itemContent = cl.text.substring(2);
      currentItem = _parseLineAsObject(itemContent);
      itemStartIndent = cl.indent;
    } else if (currentItem !== null && cl.indent > itemStartIndent) {
      var colonIdx = cl.text.indexOf(':');
      if (colonIdx >= 0) {
        var key = cl.text.substring(0, colonIdx).trim();
        var val = cl.text.substring(colonIdx + 1).trim();
        var commentIdx = val.indexOf(' #');
        if (commentIdx >= 0) val = val.substring(0, commentIdx).trim();

        if (val === '') {
          // Nested object within list item — collect and parse children inline
          var subChildren = _collectChildren(childLines, i + 1, cl.indent);
          var subResult = _parseChildLines(subChildren, 0);
          currentItem[key] = subResult.value;
          i = subChildren.length > 0 ? childLines.indexOf(subChildren[subChildren.length - 1]) : i;
        } else {
          currentItem[key] = _parseValue(val);
        }
      }
    }
  }
  if (currentItem !== null) arr.push(currentItem);
  return arr;
}

/**
 * Collect consecutive child lines with indent > parentIndent,
 * starting from startIdx in the childLines array.
 */
function _collectChildren(childLines, startIdx, parentIndent) {
  var result = [];
  for (var i = startIdx; i < childLines.length; i++) {
    if (childLines[i].indent <= parentIndent) break;
    result.push(childLines[i]);
  }
  return result;
}

/**
 * Parse a single "- key: value" or "- value" line into an object.
 */
function _parseLineAsObject(text) {
  var colonIdx = text.indexOf(':');
  if (colonIdx >= 0) {
    var key = text.substring(0, colonIdx).trim();
    var val = text.substring(colonIdx + 1).trim();
    var commentIdx = val.indexOf(' #');
    if (commentIdx >= 0) val = val.substring(0, commentIdx).trim();
    var obj = {};
    obj[key] = val === '' ? {} : _parseValue(val);
    return obj;
  }
  return _parseValue(text);
}

/**
 * Parse object block (key-value pairs from child lines).
 */
function _parseObjectItems(childLines) {
  var obj = {};
  for (var i = 0; i < childLines.length; i++) {
    var cl = childLines[i];
    var colonIdx = cl.text.indexOf(':');
    if (colonIdx === -1) continue;

    var key = cl.text.substring(0, colonIdx).trim();
    var val = cl.text.substring(colonIdx + 1).trim();
    var commentIdx = val.indexOf(' #');
    if (commentIdx >= 0) val = val.substring(0, commentIdx).trim();

    if (val === '') {
      var subChildren = _collectChildren(childLines, i + 1, cl.indent);
      if (subChildren.length === 0) {
        obj[key] = {};
      } else {
        var subResult = _parseChildLines(subChildren, 0);
        obj[key] = subResult.value;
      }
      i = childLines.indexOf(subChildren[subChildren.length - 1]);
    } else {
      obj[key] = _parseValue(val);
    }
  }
  return obj;
}

/**
 * Serialize a config value for injection into skill.md comment blocks.
 * Arrays and nested objects become compact JSON; scalars stay as-is.
 */
function _serializeConfigValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val !== 'object') return String(val);
  if (Array.isArray(val)) {
    return '[' + val.map(function (item) { return _serializeConfigValue(item); }).join(', ') + ']';
  }
  var parts = [];
  for (var k in val) {
    if (val.hasOwnProperty(k)) {
      parts.push(k + '=' + _serializeConfigValue(val[k]));
    }
  }
  return '{' + parts.join(', ') + '}';
}

/**
 * Inject context window configuration into a skill.md file.
 * Inserts a <!-- CONTEXT-CONFIG --> block after front matter.
 *
 * In global mode, uses default context config instead of reading from project config.
 *
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
      lines.push(key + ': ' + _serializeConfigValue(val));
    } else if (typeof val === 'object' && val !== null) {
      // Flatten nested objects (e.g., thresholds)
      var parts = [];
      for (var sk in val) {
        if (val.hasOwnProperty(sk)) {
          parts.push(sk + '=' + _serializeConfigValue(val[sk]));
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
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Run the CLI.
 * @param {string[]} argv - process.argv
 */
HarnessBuild.run = function run(argv) {
  var args = argv.slice(2);
  var mode = 'build'; // default mode

  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--validate') {
      mode = 'validate';
    } else if (args[i] === '--validate-config') {
      mode = 'validate-config';
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node plugins/runtime/harness-build.js [OPTIONS]');
      console.log('');
      console.log('Options:');
      console.log('  --validate         Validate plugin.json files without building');
      console.log('  --validate-config  Validate harness-config.yaml file');
      console.log('  --help, -h         Show this help message');
      process.exit(0);
    }
  }

  var builder = new HarnessBuild();

  if (mode === 'validate') {
    var result = builder.validate();
    console.log(result.summary);
    process.exit(result.valid ? 0 : 1);
  } else if (mode === 'validate-config') {
    var configResult = builder.validateConfig();
    console.log(configResult.summary);
    if (!configResult.valid) {
      console.log('');
      console.log('Errors:');
      for (var j = 0; j < configResult.errors.length; j++) {
        console.log('  - ' + configResult.errors[j]);
      }
    }
    if (configResult.warnings.length > 0) {
      console.log('');
      console.log('Warnings:');
      for (var k = 0; k < configResult.warnings.length; k++) {
        console.log('  - ' + configResult.warnings[k]);
      }
    }
    process.exit(configResult.valid ? 0 : 1);
  } else {
    var buildResult = builder.build();
    console.log(buildResult.summary);
    process.exit(buildResult.success ? 0 : 1);
  }
};

// ---------------------------------------------------------------------------
// Path resolution utilities
// ---------------------------------------------------------------------------

/**
 * Detect whether this is a local or global installation.
 * Checks if packageRoot is an ancestor of targetRoot.
 *
 * @param {string} packageRoot - this package's root directory (node_modules/tackle-harness/)
 * @param {string} targetRoot - target project root directory
 * @returns {boolean} true if local install, false if global install
 */
HarnessBuild.prototype._isLocalInstall = function _isLocalInstall(packageRoot, targetRoot) {
  var path = require('path');

  // Normalize paths for comparison
  var normalizedPackage = path.resolve(packageRoot).replace(/\\/g, '/');
  var normalizedTarget = path.resolve(targetRoot).replace(/\\/g, '/');

  // Check if packageRoot is an ancestor of targetRoot
  var relative = path.relative(normalizedPackage, normalizedTarget);
  // If relative path doesn't start with '..', packageRoot is an ancestor
  return relative.indexOf('..') !== 0;
};

// ---------------------------------------------------------------------------
// Settings merge
// ---------------------------------------------------------------------------

/**
 * Merge tackle-harness hooks into the target project's .claude/settings.json.
 * Reads existing settings, adds tackle-harness-specific hooks, and writes back.
 * Idempotent: skips hooks that are already registered.
 *
 * Uses absolute paths for global installs, relative paths for local installs.
 *
 * @param {string} targetRoot  - target project root directory
 * @param {string} packageRoot - this package's root directory (node_modules/tackle-harness/)
 */
HarnessBuild.prototype.updateSettings = function updateSettings(targetRoot, packageRoot) {
  var fs = require('fs');
  var path = require('path');
  var settingsPath = path.join(targetRoot, '.claude', 'settings.json');
  var settings = {};

  // Detect installation mode
  var isLocalInstall = this._isLocalInstall(packageRoot, targetRoot);

  // Read existing settings if present
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (e) {
      settings = {};
    }
  }

  // Ensure hooks structure exists
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  // Resolve hook script paths based on installation mode
  var hookScriptPath = path.join(packageRoot, 'plugins', 'core', 'hook-skill-gate', 'index.js');
  var hookCmd;
  if (isLocalInstall) {
    // Local install: use relative path
    var hookScriptRelative = path.relative(targetRoot, hookScriptPath).replace(/\\/g, '/');
    hookCmd = 'node "' + hookScriptRelative + '"';
  } else {
    // Global install: use absolute path with forward slashes
    hookCmd = 'node "' + hookScriptPath.replace(/\\/g, '/') + '"';
  }

  // Update or add PreToolUse hook for Edit|Write
  var preMatcher = 'Edit|Write';
  _upsertHookEntry(settings.hooks.PreToolUse, preMatcher, hookCmd + ' --pre-tool');

  // Update or add PostToolUse hook for Skill
  var postMatcher = 'Skill';
  _upsertHookEntry(settings.hooks.PostToolUse, postMatcher, hookCmd + ' --post-skill');

  // Update or add SessionStart hook for plan-mode rule injection
  var sessionHookScriptPath = path.join(packageRoot, 'plugins', 'core', 'hook-session-start', 'index.js');
  var sessionHookCmd;
  if (isLocalInstall) {
    var sessionHookRelative = path.relative(targetRoot, sessionHookScriptPath).replace(/\\/g, '/');
    sessionHookCmd = 'node "' + sessionHookRelative + '"';
  } else {
    sessionHookCmd = 'node "' + sessionHookScriptPath.replace(/\\/g, '/') + '"';
  }
  var sessionMatcher = 'startup|clear|compact';
  _upsertHookEntry(settings.hooks.SessionStart, sessionMatcher, sessionHookCmd);

  // Write back
  this._ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
};

// ---------------------------------------------------------------------------
// CLAUDE.md injection
// ---------------------------------------------------------------------------

/**
 * Block marker for tackle-harness managed rules in CLAUDE.md.
 * @type {string}
 */
var CLAUDE_MD_MARKER = '<!-- tackle-harness -->';

/**
 * Rule content to inject into CLAUDE.md.
 * Scans all skill plugins for plan_mode_required and builds the skill name list.
 *
 * @param {object[]} pluginEntries - enabled plugin entries from registry
 * @returns {string} the rule block to inject (including markers)
 */
HarnessBuild.prototype._buildClaudeMdRuleBlock = function _buildClaudeMdRuleBlock(pluginEntries) {
  var planModeSkills = [];

  for (var i = 0; i < pluginEntries.length; i++) {
    var entry = pluginEntries[i];
    var pluginDir = this._resolvePluginDir(entry);
    var metaPath = path.join(pluginDir, 'plugin.json');

    if (!fs.existsSync(metaPath)) continue;

    try {
      var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.type !== 'skill') continue;

      // Check plan_mode_required in plugin.json config or in skill.md front-matter
      var hasPlanMode = false;

      if (meta.config && meta.config.plan_mode_required) {
        hasPlanMode = true;
      }

      if (!hasPlanMode) {
        var skillMdPath = path.join(pluginDir, 'skill.md');
        if (fs.existsSync(skillMdPath)) {
          var content = fs.readFileSync(skillMdPath, 'utf-8');
          if (/^---[\s\S]*?plan_mode_required:\s*true[\s\S]*?---/.test(content)) {
            hasPlanMode = true;
          }
        }
      }

      if (hasPlanMode) {
        planModeSkills.push(meta.name || entry.name);
      }
    } catch (e) {
      // skip unparseable plugins
    }
  }

  if (planModeSkills.length === 0) return '';

  var lines = [CLAUDE_MD_MARKER];
  lines.push('');
  lines.push('## Harness Plan Mode 优先级规则');
  lines.push('');
  lines.push('当以下 skill 被触发时，必须直接调用 `EnterPlanMode` 进入 Plan 模式，不得先执行 brainstorming 或其他分析工作：');
  lines.push('');

  for (var j = 0; j < planModeSkills.length; j++) {
    lines.push('- `' + planModeSkills[j] + '`');
  }

  lines.push('');
  lines.push('这些 skill 的 skill.md 中已标注 `plan_mode_required: true`，优先级高于 superpowers:brainstorming。');
  lines.push('收到匹配上述 skill 的请求时，跳过 brainstorming 检查，立即进入 Plan 模式。');
  lines.push('');
  lines.push(CLAUDE_MD_MARKER);

  return lines.join('\n');
};

/**
 * Update or insert a hook entry in a hooks array.
 * If a hook with the same matcher exists, update its command; otherwise add a new entry.
 *
 * @param {object[]} hookArray - the hooks array (e.g. settings.hooks.PreToolUse)
 * @param {string} matcher - the matcher string (e.g. 'Edit|Write')
 * @param {string} command - the full command string
 */
function _upsertHookEntry(hookArray, matcher, command) {
  for (var i = 0; i < hookArray.length; i++) {
    if (hookArray[i].matcher === matcher) {
      hookArray[i].hooks = [{ type: 'command', command: command }];
      return;
    }
  }
  hookArray.push({
    matcher: matcher,
    hooks: [{ type: 'command', command: command }]
  });
}

/**
 * Inject tackle-harness managed rules into the target project's CLAUDE.md.
 * Idempotent: replaces existing marked block if present, appends if not.
 * Creates CLAUDE.md if it does not exist.
 *
 * @param {string} targetRoot - target project root directory
 */
HarnessBuild.prototype.injectClaudeMdRules = function injectClaudeMdRules(targetRoot) {
  var registry = this._readRegistry();
  var pluginEntries = this._getPluginEntries(registry);

  var ruleBlock = this._buildClaudeMdRuleBlock(pluginEntries);
  if (!ruleBlock) {
    this._log('info', 'No plan_mode_required skills found, skipping CLAUDE.md injection.');
    return;
  }

  var claudeMdPath = path.join(targetRoot, 'CLAUDE.md');
  var content = '';

  if (fs.existsSync(claudeMdPath)) {
    content = fs.readFileSync(claudeMdPath, 'utf-8');
  }

  // Check if existing block is present and identical
  var startIdx = content.indexOf(CLAUDE_MD_MARKER);
  if (startIdx !== -1) {
    var endIdx = content.indexOf(CLAUDE_MD_MARKER, startIdx + CLAUDE_MD_MARKER.length);
    if (endIdx !== -1) {
      var existingBlock = content.substring(startIdx, endIdx + CLAUDE_MD_MARKER.length);
      if (existingBlock === ruleBlock) {
        this._log('info', 'CLAUDE.md rules up-to-date, no changes needed.');
        return;
      }
      // Replace existing block
      content = content.substring(0, startIdx) + ruleBlock + content.substring(endIdx + CLAUDE_MD_MARKER.length);
      fs.writeFileSync(claudeMdPath, content, 'utf-8');
      this._log('info', 'CLAUDE.md rules updated.');
      return;
    }
  }

  // Append new block
  var separator = content.length > 0 && !content.endsWith('\n') ? '\n\n' : '\n';
  fs.writeFileSync(claudeMdPath, content + separator + ruleBlock + '\n', 'utf-8');
  this._log('info', 'CLAUDE.md rules injected.');
};

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = HarnessBuild;

// Run directly if executed as main
if (require.main === module) {
  HarnessBuild.run(process.argv);
}
