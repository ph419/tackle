#!/usr/bin/env node
/**
 * tackle-harness - CLI entry point for the AI Agent Harness framework
 *
 * Usage:
 *   tackle-harness             Build all plugins into .claude/skills/ and update settings.json
 *   tackle-harness build       Same as above (default command)
 *   tackle-harness validate    Validate plugin.json files without building
 *   tackle-harness init        First-time setup: build + generate default config
 *   tackle-harness status      Show build status and plugin statistics
 *   tackle-harness config      Show/validate current configuration
 *   tackle-harness list        List all registered plugins
 *   tackle-harness version     Show version information
 *   tackle-harness --help      Show usage info
 *
 * Options:
 *   --verbose                  Show detailed build output
 *   --no-color                 Disable colored output
 *   --root <path>              Specify target project root (default: cwd)
 */

'use strict';

var path = require('path');
var fs = require('fs');
var HarnessBuild = require('../plugins/runtime/harness-build');

// Read package version
var packageJson = require('../package.json');
var PACKAGE_VERSION = packageJson.version;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Root directory of this npm package (where plugins/ lives) */
var packageRoot = path.resolve(__dirname, '..');

/** Target project root directory (where output goes) */
var targetRoot = process.cwd();

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

var args = process.argv.slice(2);
var flags = {
  root: null,
  verbose: false,
  noColor: false,
  help: false,
  version: false,
};

// First, parse flags to filter them out from command
var filteredArgs = [];
for (var i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) {
    flags.root = args[++i];
  } else if (args[i] === '--verbose') {
    flags.verbose = true;
  } else if (args[i] === '--no-color') {
    flags.noColor = true;
  } else if (args[i] === '--version' || args[i] === '-v') {
    flags.version = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    flags.help = true;
  } else {
    // Keep non-flag arguments as potential commands
    filteredArgs.push(args[i]);
  }
}

// Determine command: --help/--version take priority over positional args
var command;
if (flags.help) {
  command = 'help';
} else if (flags.version) {
  command = 'version';
} else {
  command = filteredArgs[0] || 'build';
}

// Override target root if --root flag provided
if (flags.root) {
  targetRoot = path.resolve(flags.root);
}

// Subcommand aliases
if (command === '--validate') command = 'validate';
if (command === '--validate-config') command = 'validate-config';

// ---------------------------------------------------------------------------
// Color output support
// ---------------------------------------------------------------------------

var colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

/**
 * Apply color to text if colors are enabled.
 * @param {string} text - The text to color
 * @param {string} color - Color name from colors object
 * @returns {string}
 */
function colorize(text, color) {
  if (flags.noColor) {
    return text;
  }
  return (colors[color] || '') + text + (colors.reset || '');
}

// ---------------------------------------------------------------------------
// Helper: create builder instance with correct paths
// ---------------------------------------------------------------------------

function createBuilder() {
  return new HarnessBuild({
    rootDir: targetRoot,
    registryPath: path.join(packageRoot, 'plugins', 'plugin-registry.json'),
    pluginsDir: path.join(packageRoot, 'plugins', 'core'),
    outputSkillsDir: path.join(targetRoot, '.claude', 'skills'),
    outputHooksDir: path.join(targetRoot, '.claude', 'hooks'),
    verbose: flags.verbose,
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdBuild() {
  console.log(colorize('[tackle-harness] Building plugins...', 'cyan'));

  var builder = createBuilder();
  var result = builder.build();

  if (result.success) {
    if (flags.verbose) {
      console.log(colorize('[tackle-harness] Updating settings.json...', 'dim'));
    }
    builder.updateSettings(targetRoot, packageRoot);
    builder.injectClaudeMdRules(targetRoot);
    _cleanStaleOutput(builder);
  }

  // Apply colors to summary output
  var coloredSummary = result.summary
    .replace(/Build SUCCEEDED/g, colorize('Build SUCCEEDED', 'green'))
    .replace(/Build COMPLETED WITH ERRORS/g, colorize('Build COMPLETED WITH ERRORS', 'yellow'))
    .replace(/Validation PASSED/g, colorize('Validation PASSED', 'green'))
    .replace(/Validation FAILED/g, colorize('Validation FAILED', 'red'));

  console.log(coloredSummary);

  if (result.success) {
    console.log(colorize('[tackle-harness] Settings updated: .claude/settings.json', 'green'));
    console.log(colorize('[tackle-harness] CLAUDE.md rules injected.', 'green'));
    console.log(colorize('[tackle-harness] Done! Skills are ready to use.', 'green'));
  }

  process.exit(result.success ? 0 : 1);
}

/**
 * Remove stale output directories from disabled or removed plugins.
 */
function _cleanStaleOutput(builder) {
  var registry = builder._readRegistry();
  var plugins = registry.plugins || [];
  var activeNames = {};
  for (var i = 0; i < plugins.length; i++) {
    if (plugins[i].enabled !== false) {
      var pDir = path.join(packageRoot, 'plugins', 'core', plugins[i].source || plugins[i].name);
      var metaPath = path.join(pDir, 'plugin.json');
      if (fs.existsSync(metaPath)) {
        try {
          var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          activeNames[meta.name || plugins[i].name] = true;
        } catch (e) {}
      }
    }
  }

  var outputDirs = [
    { dir: path.join(targetRoot, '.claude', 'skills'), label: 'skill' },
    { dir: path.join(targetRoot, '.claude', 'hooks'), label: 'hook' },
  ];

  for (var d = 0; d < outputDirs.length; d++) {
    var dir = outputDirs[d].dir;
    if (!fs.existsSync(dir)) continue;
    var entries;
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    for (var e = 0; e < entries.length; e++) {
      if (!activeNames[entries[e]]) {
        var stalePath = path.join(dir, entries[e]);
        try {
          _rmRecursive(stalePath);
          console.log(colorize('[tackle-harness] Cleaned stale output: ' + entries[e], 'yellow'));
        } catch (err) {
          console.log(colorize('[tackle-harness] Warning: could not remove ' + entries[e], 'yellow'));
        }
      }
    }
  }
}

/**
 * Recursively remove a directory.
 */
function _rmRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  var entries = fs.readdirSync(dirPath);
  for (var i = 0; i < entries.length; i++) {
    var entryPath = path.join(dirPath, entries[i]);
    if (fs.statSync(entryPath).isDirectory()) {
      _rmRecursive(entryPath);
    } else {
      fs.unlinkSync(entryPath);
    }
  }
  fs.rmdirSync(dirPath);
}

function cmdValidate() {
  var builder = createBuilder();
  var result = builder.validate();
  console.log(result.summary);
  process.exit(result.valid ? 0 : 1);
}

function cmdInit() {
  console.log('[tackle-harness] Initializing...');
  console.log('[tackle-harness] Target project: ' + targetRoot);
  console.log('[tackle-harness] Package root:   ' + packageRoot);
  console.log('');

  // 1. Ensure .claude/ directory exists
  var claudeDir = path.join(targetRoot, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    console.log('[tackle-harness] Created .claude/ directory');
  }

  // 2. Ensure .claude/config/ directory exists
  var configDir = path.join(targetRoot, '.claude', 'config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    console.log('[tackle-harness] Created .claude/config/ directory');
  }

  // 3. Copy harness-config.yaml template if not exists
  var targetConfigPath = path.join(configDir, 'harness-config.yaml');
  var templatePath = path.join(packageRoot, 'templates', 'harness-config.yaml');

  if (!fs.existsSync(targetConfigPath)) {
    try {
      var content = fs.readFileSync(templatePath, 'utf-8');
      fs.writeFileSync(targetConfigPath, content, 'utf-8');
      console.log('[tackle-harness] Created harness-config.yaml');
    } catch (err) {
      console.error('[tackle-harness] Warning: Failed to copy harness-config.yaml template');
      console.error('[tackle-harness] Error: ' + err.message);
    }
  } else {
    console.log('[tackle-harness] harness-config.yaml already exists, skipping');
  }

  // 4. Run build
  cmdBuild();
}

function cmdHelp() {
  console.log(colorize('tackle-harness - Plugin-based AI Agent Harness for Claude Code', 'cyan'));
  console.log('');
  console.log('Usage:');
  console.log('  tackle-harness [command] [options]');
  console.log('');
  console.log('Commands:');
  console.log('  ' + colorize('build', 'green') + '              Build all plugins (default)');
  console.log('  ' + colorize('validate', 'green') + '           Validate plugin.json files');
  console.log('  ' + colorize('validate-config', 'green') + '   Validate harness-config.yaml');
  console.log('  ' + colorize('init', 'green') + '              First-time setup (build + config)');
  console.log('  ' + colorize('status', 'green') + '             Show build status and plugin statistics');
  console.log('  ' + colorize('config', 'green') + '             Show/validate current configuration');
  console.log('  ' + colorize('list', 'green') + '               List all registered plugins');
  console.log('  ' + colorize('version', 'green') + '            Show version information');
  console.log('  ' + colorize('help', 'green') + '               Show this help message');
  console.log('');
  console.log('Options:');
  console.log('  --root <path>       Specify target project root (default: cwd)');
  console.log('  --verbose           Show detailed build output');
  console.log('  --no-color          Disable colored output');
  console.log('  --help, -h          Show this help message');
  console.log('  --version, -v       Show version information');
  console.log('');
  console.log('After running ' + colorize('tackle-harness build', 'green') + ', skills are available in .claude/skills/');
  console.log('and hooks are registered in .claude/settings.json');
}

function cmdValidateConfig() {
  var builder = createBuilder();
  var result = builder.validateConfig();
  console.log(result.summary);
  if (!result.valid) {
    console.log('');
    console.log('Errors:');
    for (var i = 0; i < result.errors.length; i++) {
      console.log('  - ' + result.errors[i]);
    }
  }
  if (result.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (var j = 0; j < result.warnings.length; j++) {
      console.log('  - ' + result.warnings[j]);
    }
  }
  process.exit(result.valid ? 0 : 1);
}

function cmdStatus() {
  console.log(colorize('=== Tackle Harness Status ===', 'cyan'));
  console.log('');

  // Package version
  console.log('Version: ' + colorize(PACKAGE_VERSION, 'green'));
  console.log('');

  // Target and package roots
  console.log('Target project root: ' + targetRoot);
  console.log('Package root:         ' + packageRoot);
  console.log('');

  // Build status - check if .claude/skills exists
  var skillsDir = path.join(targetRoot, '.claude', 'skills');
  var hooksDir = path.join(targetRoot, '.claude', 'hooks');
  var settingsPath = path.join(targetRoot, '.claude', 'settings.json');
  var configPath = path.join(targetRoot, '.claude', 'config', 'harness-config.yaml');

  console.log(colorize('Build Status:', 'cyan'));
  console.log('  .claude/skills/:    ' + (fs.existsSync(skillsDir) ? colorize('exists', 'green') : colorize('missing', 'red')));
  console.log('  .claude/hooks/:     ' + (fs.existsSync(hooksDir) ? colorize('exists', 'green') : colorize('missing', 'red')));
  console.log('  settings.json:      ' + (fs.existsSync(settingsPath) ? colorize('exists', 'green') : colorize('missing', 'red')));
  console.log('  harness-config.yaml: ' + (fs.existsSync(configPath) ? colorize('exists', 'green') : colorize('missing', 'red')));
  console.log('');

  // Plugin statistics
  var registry = createBuilder()._readRegistry();
  var plugins = registry.plugins || [];

  var stats = {
    total: plugins.length,
    enabled: 0,
    disabled: 0,
    skill: 0,
    hook: 0,
    validator: 0,
    provider: 0,
  };

  var pluginTypes = {};
  var pluginNames = [];

  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    if (p.enabled !== false) {
      stats.enabled++;
      pluginNames.push(p.name);
    } else {
      stats.disabled++;
      continue;
    }

    // Read plugin type from plugin.json (enabled only)
    var pluginDir = path.join(packageRoot, 'plugins', 'core', p.source || p.name);
    var metaPath = path.join(pluginDir, 'plugin.json');
    if (fs.existsSync(metaPath)) {
      try {
        var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        var type = meta.type || 'unknown';
        pluginTypes[p.name] = type;
        if (stats.hasOwnProperty(type)) {
          stats[type]++;
        }
      } catch (e) {
        // skip parse errors
      }
    }
  }

  console.log(colorize('Plugin Statistics:', 'cyan'));
  console.log('  Total plugins:   ' + stats.total);
  console.log('  Enabled plugins: ' + colorize(stats.enabled, 'green'));
  console.log('  Disabled plugins: ' + (stats.disabled > 0 ? colorize(String(stats.disabled), 'yellow') : '0'));
  console.log('');
  console.log('  By type:');
  console.log('    Skills:     ' + stats.skill);
  console.log('    Hooks:      ' + stats.hook);
  console.log('    Validators: ' + stats.validator);
  console.log('    Providers:  ' + stats.provider);
  console.log('');

  // Show last build time if available (scan files inside skill subdirs)
  if (fs.existsSync(skillsDir)) {
    var latestTime = null;
    try {
      var entries = fs.readdirSync(skillsDir);
      for (var ei = 0; ei < entries.length; ei++) {
        var skillEntryDir = path.join(skillsDir, entries[ei]);
        try {
          var skillFiles = fs.readdirSync(skillEntryDir);
          for (var si = 0; si < skillFiles.length; si++) {
            try {
              var fileStat = fs.statSync(path.join(skillEntryDir, skillFiles[si]));
              if (!latestTime || fileStat.mtime > latestTime) {
                latestTime = fileStat.mtime;
              }
            } catch (ignore) {}
          }
        } catch (ignore) {}
      }
    } catch (ignore) {}
    if (latestTime) {
      console.log('Last build: ' + latestTime.toLocaleString());
    }
  }

  process.exit(0);
}

function cmdConfig() {
  console.log(colorize('=== Tackle Harness Configuration ===', 'cyan'));
  console.log('');

  var configPath = path.join(targetRoot, '.claude', 'config', 'harness-config.yaml');

  if (!fs.existsSync(configPath)) {
    console.log(colorize('Configuration file not found:', 'yellow'));
    console.log('  ' + configPath);
    console.log('');
    console.log('Run "tackle-harness init" to create a default configuration.');
    process.exit(1);
  }

  console.log('Configuration file: ' + configPath);
  console.log('');

  // Validate configuration
  var builder = createBuilder();
  var result = builder.validateConfig();

  console.log('Validation status: ' + (result.valid ? colorize('Valid', 'green') : colorize('Invalid', 'red')));

  if (result.warnings.length > 0) {
    console.log('');
    console.log(colorize('Warnings:', 'yellow'));
    for (var i = 0; i < result.warnings.length; i++) {
      console.log('  - ' + result.warnings[i]);
    }
  }

  if (!result.valid) {
    console.log('');
    console.log(colorize('Errors:', 'red'));
    for (var j = 0; j < result.errors.length; j++) {
      console.log('  - ' + result.errors[j]);
    }
    process.exit(1);
  }

  // Show configuration summary
  console.log('');
  console.log(colorize('Configuration Summary:', 'cyan'));

  try {
    var content = fs.readFileSync(configPath, 'utf-8');
    var lines = content.split('\n');

    // Extract and display top-level sections (zero-indent keys only)
    var sections = [];
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k];
      var trimmed = line.trim();
      // Top-level keys: line starts with non-space, non-dash, non-comment, has colon
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-') &&
          line === line.trimStart() && line.indexOf(':') !== -1) {
        var sectionName = line.split(':')[0].trim();
        if (sectionName && /^[a-z_]/.test(sectionName)) {
          sections.push(sectionName);
        }
      }
    }

    if (sections.length > 0) {
      console.log('  Sections: ' + sections.join(', '));
    }
  } catch (e) {
    console.log('  (Unable to parse configuration for summary)');
  }

  process.exit(0);
}

function cmdList() {
  console.log(colorize('=== Registered Plugins ===', 'cyan'));
  console.log('');

  var registry = createBuilder()._readRegistry();
  var plugins = registry.plugins || [];

  if (plugins.length === 0) {
    console.log('No plugins registered.');
    process.exit(0);
  }

  // Group by type
  var byType = {
    skill: [],
    hook: [],
    validator: [],
    provider: [],
    unknown: [],
  };

  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    var pluginDir = path.join(packageRoot, 'plugins', 'core', p.source || p.name);
    var metaPath = path.join(pluginDir, 'plugin.json');
    var type = 'unknown';
    var version = '-';

    if (fs.existsSync(metaPath)) {
      try {
        var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        type = meta.type || 'unknown';
        version = meta.version || '-';
      } catch (e) {
        // use defaults
      }
    }

    var status = p.enabled === false ? colorize('disabled', 'dim') : colorize('enabled', 'green');

    byType[type].push({
      name: p.name,
      version: version,
      status: status,
    });
  }

  // Display by type
  var typeOrder = ['skill', 'hook', 'validator', 'provider'];
  for (var t = 0; t < typeOrder.length; t++) {
    var typeName = typeOrder[t];
    var typePlugins = byType[typeName];

    if (typePlugins.length > 0) {
      console.log(colorize(typeName.charAt(0).toUpperCase() + typeName.slice(1) + ' Plugins:', 'cyan'));
      console.log('');

      // Find max name length for alignment
      var maxNameLen = 0;
      for (var j = 0; j < typePlugins.length; j++) {
        if (typePlugins[j].name.length > maxNameLen) {
          maxNameLen = typePlugins[j].name.length;
        }
      }

      for (var k = 0; k < typePlugins.length; k++) {
        var plugin = typePlugins[k];
        var namePadding = ' '.repeat(maxNameLen - plugin.name.length + 2);
        console.log('  ' + plugin.name + namePadding + '[' + plugin.status + ']  ' + (plugin.version !== '-' ? 'v' : '') + plugin.version);
      }
      console.log('');
    }
  }

  // Show unknown types
  if (byType.unknown.length > 0) {
    console.log(colorize('Unknown Plugins:', 'yellow'));
    console.log('');
    for (var u = 0; u < byType.unknown.length; u++) {
      console.log('  ' + byType.unknown[u].name);
    }
    console.log('');
  }

  // Summary
  console.log('Total: ' + plugins.length + ' plugins');
  var enabledCount = plugins.filter(function (p) { return p.enabled !== false; }).length;
  console.log('Enabled: ' + colorize(enabledCount, 'green') + ', Disabled: ' + colorize(plugins.length - enabledCount, 'dim'));

  process.exit(0);
}

function cmdVersion() {
  console.log('tackle-harness v' + PACKAGE_VERSION);
  console.log('');
  console.log('Node.js version: ' + process.version);
  console.log('Package root: ' + packageRoot);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

switch (command) {
  case 'build':
    cmdBuild();
    break;
  case 'validate':
    cmdValidate();
    break;
  case 'validate-config':
    cmdValidateConfig();
    break;
  case 'init':
    cmdInit();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'config':
    cmdConfig();
    break;
  case 'list':
    cmdList();
    break;
  case 'version':
    cmdVersion();
    break;
  case 'help':
    cmdHelp();
    process.exit(0);
    break;
  default:
    console.error(colorize('Error: Unknown command "' + command + '"', 'red'));
    console.error('');
    cmdHelp();
    process.exit(1);
}
