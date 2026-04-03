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
 * @param {string} [options.rootDir]        - project root directory
 * @param {string} [options.registryPath]   - override path to plugin-registry.json
 * @param {string} [options.pluginsDir]     - override path to plugins/core/
 * @param {string} [options.outputSkillsDir] - override output .claude/skills/
 * @param {string} [options.outputHooksDir]  - override output .claude/hooks/
 */
function HarnessBuild(options) {
  options = options || {};

  this._rootDir = options.rootDir || process.cwd();
  this._registryPath = options.registryPath || path.join(this._rootDir, 'plugins', 'plugin-registry.json');
  this._pluginsDir = options.pluginsDir || path.join(this._rootDir, 'plugins', 'core');
  this._outputSkillsDir = options.outputSkillsDir || path.join(this._rootDir, '.claude', 'skills');
  this._outputHooksDir = options.outputHooksDir || path.join(this._rootDir, '.claude', 'hooks');

  /** @type {object[]} validation errors collected during --validate */
  this._validationErrors = [];
  /** @type {object[]} validation warnings */
  this._validationWarnings = [];
  /** @type {object[]} build results */
  this._buildResults = [];
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

  for (var i = 0; i < pluginEntries.length; i++) {
    try {
      var result = this._buildPlugin(pluginEntries[i]);
      this._buildResults.push(result);
    } catch (err) {
      buildErrors.push({
        plugin: pluginEntries[i].name || 'unknown',
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

// ---------------------------------------------------------------------------
// Registry reading
// ---------------------------------------------------------------------------

/**
 * Read and parse the plugin registry.
 * @returns {object}
 */
HarnessBuild.prototype._readRegistry = function _readRegistry() {
  try {
    var content = fs.readFileSync(this._registryPath, 'utf-8');
    return JSON.parse(content);
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

  // Check if source skill.md exists
  if (fs.existsSync(skillMdSrc)) {
    // Read the source skill content
    var content = fs.readFileSync(skillMdSrc, 'utf-8');

    // If the skill.md has a front-matter header, keep it.
    // If not, generate one from plugin.json metadata.
    if (!this._hasFrontMatter(content)) {
      content = this._generateSkillFrontMatter(meta) + '\n' + content;
    }

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
 *
 * @param {string} name
 * @param {string} pluginDir
 * @param {object} meta
 * @returns {{ name: string, type: string, outputPath: string, files: string[] }}
 */
HarnessBuild.prototype._buildProviderPlugin = function _buildProviderPlugin(name, pluginDir, meta) {
  this._log('info', '  -> Provider plugin (no native output, registered internally)');

  return {
    name: name,
    type: 'provider',
    outputPath: '(internal)',
    files: [],
  };
};

/**
 * Format build summary for output.
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
 * Internal logging.
 * @param {string} level
 * @param {string} message
 */
HarnessBuild.prototype._log = function _log(level, message) {
  var prefix = '[harness-build] [' + level + ']';
  if (level === 'error') {
    console.error(prefix, message);
  } else if (level === 'warn') {
    console.warn(prefix, message);
  } else {
    console.log(prefix, message);
  }
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
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node plugins/runtime/harness-build.js [--validate]');
      console.log('');
      console.log('Options:');
      console.log('  --validate    Validate plugin.json files without building');
      console.log('  --help, -h    Show this help message');
      process.exit(0);
    }
  }

  var builder = new HarnessBuild();

  if (mode === 'validate') {
    var result = builder.validate();
    console.log(result.summary);
    process.exit(result.valid ? 0 : 1);
  } else {
    var buildResult = builder.build();
    console.log(buildResult.summary);
    process.exit(buildResult.success ? 0 : 1);
  }
};

// ---------------------------------------------------------------------------
// Settings merge
// ---------------------------------------------------------------------------

/**
 * Merge tackle hooks into the target project's .claude/settings.json.
 * Reads existing settings, adds tackle-specific hooks, and writes back.
 * Idempotent: skips hooks that are already registered.
 *
 * @param {string} targetRoot  - target project root directory
 * @param {string} packageRoot - this package's root directory (node_modules/tackle/)
 */
HarnessBuild.prototype.updateSettings = function updateSettings(targetRoot, packageRoot) {
  var fs = require('fs');
  var path = require('path');
  var settingsPath = path.join(targetRoot, '.claude', 'settings.json');
  var settings = {};

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
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  // Resolve hook script path relative to target project
  var hookScriptPath = path.join(packageRoot, 'plugins', 'core', 'hook-skill-gate', 'index.js');
  // Use forward slashes for cross-platform compatibility
  var hookScriptRelative = path.relative(targetRoot, hookScriptPath).replace(/\\/g, '/');
  var hookCmd = 'node "' + hookScriptRelative + '"';

  // Add PreToolUse hook for Edit|Write (if not already present)
  var preMatcher = 'Edit|Write';
  var preExists = settings.hooks.PreToolUse.some(function (h) {
    return h.matcher === preMatcher;
  });
  if (!preExists) {
    settings.hooks.PreToolUse.push({
      matcher: preMatcher,
      hooks: [{
        type: 'command',
        command: hookCmd + ' --pre-tool'
      }]
    });
  }

  // Add PostToolUse hook for Skill (if not already present)
  var postMatcher = 'Skill';
  var postExists = settings.hooks.PostToolUse.some(function (h) {
    return h.matcher === postMatcher;
  });
  if (!postExists) {
    settings.hooks.PostToolUse.push({
      matcher: postMatcher,
      hooks: [{
        type: 'command',
        command: hookCmd + ' --post-skill'
      }]
    });
  }

  // Write back
  this._ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
};

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = HarnessBuild;

// Run directly if executed as main
if (require.main === module) {
  HarnessBuild.run(process.argv);
}
