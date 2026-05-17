#!/usr/bin/env node
/**
 * tackle-harness - CLI entry point for the AI Agent Harness framework
 *
 * Usage:
 *   tackle-harness             Build all plugins into .claude/skills/ and update settings.json
 *   tackle-harness build       Same as above (default command)
 *   tackle-harness validate    Validate plugin.json files without building
 *   tackle-harness init        First-time setup: build + generate default config
 *   tackle-harness migrate     Migrate legacy project structure to global setup
 *   tackle-harness status      Show build status and plugin statistics
 *   tackle-harness config      Show/validate current configuration
 *   tackle-harness list        List all registered plugins
 *   tackle-harness interactive Interactive plugin management (alias: i)
 *   tackle-harness setup-global Install global skills to ~/.claude/skills/
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
var readline = require('readline');
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

// ---------------------------------------------------------------------------
// Color output support (must be defined before --root flag handling)
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

// Override target root if --root flag provided
if (flags.root) {
  // Fix Windows absolute path handling: D:path (no backslash) -> D:\path
  // Node's path.resolve treats D:path as relative to CWD on Windows
  var rootPath = flags.root;
  if (/^[a-zA-Z]:[^\\\/]/.test(rootPath)) {
    // Matches bare drive letter without separator: D:path
    rootPath = rootPath.substring(0, 2) + '\\' + rootPath.substring(2);
  }
  var resolvedRoot = path.resolve(rootPath);

  // Security check: prevent path traversal attacks
  // Ensure the resolved path is accessible and doesn't escape obvious boundaries
  var normalizedPath = path.normalize(resolvedRoot);

  // Additional safety: verify the path exists or can be created
  try {
    var stats = fs.statSync(normalizedPath);
    if (!stats.isDirectory()) {
      console.error(colorize('Error: --root path must be a directory', 'red'));
      process.exit(1);
    }
  } catch (e) {
    // Path doesn't exist yet - this is OK for 'init' command
    if (command !== 'init') {
      console.error(colorize('Error: --root path does not exist: ' + normalizedPath, 'red'));
      process.exit(1);
    }
  }

  // Warn if using relative path that resolves outside cwd
  var cwdResolved = path.resolve(flags.root);
  if (cwdResolved.indexOf(process.cwd()) !== 0 && command !== 'init') {
    console.warn(colorize('Warning: --root path is outside current working directory', 'yellow'));
  }

  targetRoot = normalizedPath;
}

function createBuilder() {
  return new HarnessBuild({
    rootDir: targetRoot,
    packageRoot: packageRoot,
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
  // Ensure harness-config.yaml exists (auto-create from template if missing)
  var configDir = path.join(targetRoot, '.claude', 'config');
  var targetConfigPath = path.join(configDir, 'harness-config.yaml');
  if (!fs.existsSync(targetConfigPath)) {
    var templatePath = path.join(packageRoot, 'templates', 'harness-config.yaml');
    if (fs.existsSync(templatePath)) {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      var content = fs.readFileSync(templatePath, 'utf-8');
      fs.writeFileSync(targetConfigPath, content, 'utf-8');
      console.log('[tackle-harness] Created default harness-config.yaml');
    }
  }

  // Detect if running in global mode (using --root to build external project)
  var isGlobalMode = flags.root !== null && targetRoot !== process.cwd();

  if (isGlobalMode) {
    console.log(colorize('[tackle-harness] Global mode detected (building external project)', 'cyan'));
    console.log('[tackle-harness] Skills and hooks will remain in the global installation.');
    console.log('[tackle-harness] Only settings.json will be updated in the target project.');
    console.log('');
  } else {
    console.log(colorize('[tackle-harness] Building plugins...', 'cyan'));
  }

  var builder = createBuilder();
  var result;

  if (isGlobalMode) {
    // Global mode: skip building skills/hooks to project, only update settings
    result = {
      success: true,
      built: [],
      errors: [],
      summary: '=== Build Report (Global Mode) ===\n\nInstallation: Global (external project)\nSkills output: ' + packageRoot + ' (global)\nHooks output:  ' + packageRoot + ' (global)\n\nNo files written to target project.\nSkills and hooks are read from global installation.\n\nBuild SUCCEEDED (global mode)\n'
    };
  } else {
    // Local mode: build normally
    result = builder.build();
  }

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
    if (isGlobalMode) {
      console.log(colorize('[tackle-harness] Done! Project configured for global skills/hooks.', 'green'));
    } else {
      console.log(colorize('[tackle-harness] Done! Skills are ready to use.', 'green'));
    }
  }

  process.exit(result.success ? 0 : 1);
}

/**
 * Remove stale output directories from disabled plugins.
 * Only removes directories whose names match a registered-but-disabled plugin.
 * User-created directories that don't match any plugin name are preserved.
 *
 * SECURITY: Ensures all deletion operations stay within the expected output directories.
 */
function _cleanStaleOutput(builder) {
  var registry = builder._readRegistry();
  var plugins = registry.plugins || [];
  var enabledNames = {};
  var disabledNames = {};
  for (var i = 0; i < plugins.length; i++) {
    var regName = plugins[i].name;
    var pDir = path.join(builder._pluginsDir, plugins[i].source || regName);
    var metaPath = path.join(pDir, 'plugin.json');
    var name = regName;
    if (fs.existsSync(metaPath)) {
      try {
        var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        name = meta.name || regName;
      } catch (e) {
        if (flags.verbose) {
          console.log(colorize('[tackle-harness] Warning: could not parse ' + metaPath, 'yellow'));
        }
      }
    }
    if (plugins[i].enabled !== false) {
      enabledNames[name] = true;
    } else {
      disabledNames[name] = true;
    }
  }

  var outputDirs = [
    path.join(targetRoot, '.claude', 'skills'),
    path.join(targetRoot, '.claude', 'hooks'),
  ];

  for (var d = 0; d < outputDirs.length; d++) {
    var dir = outputDirs[d];

    // Security check: ensure the directory is within the expected output tree
    var normalizedDir = path.normalize(dir);
    if (normalizedDir.indexOf(path.normalize(targetRoot)) !== 0) {
      console.log(colorize('[tackle-harness] Warning: skipping suspicious output directory', 'yellow'));
      continue;
    }

    if (!fs.existsSync(dir)) continue;
    var entries;
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    for (var e = 0; e < entries.length; e++) {
      var entryName = entries[e];

      // Security: prevent path traversal in entry names
      if (entryName.indexOf('..') !== -1 || entryName.indexOf('/') !== -1 || entryName.indexOf('\\') !== -1) {
        console.log(colorize('[tackle-harness] Warning: skipping suspicious entry name', 'yellow'));
        continue;
      }

      // Only clean up if: directory name belongs to a registered disabled plugin
      if (disabledNames[entryName] && !enabledNames[entryName]) {
        var stalePath = path.join(dir, entryName);

        // Final security check: verify the path is still within the output directory
        var normalizedStalePath = path.normalize(stalePath);
        if (normalizedStalePath.indexOf(normalizedDir) !== 0) {
          console.log(colorize('[tackle-harness] Warning: skipping suspicious stale path', 'yellow'));
          continue;
        }

        try {
          fs.rmSync(stalePath, { recursive: true, force: true });
          console.log(colorize('[tackle-harness] Cleaned disabled plugin output: ' + entryName, 'yellow'));
        } catch (err) {
          console.log(colorize('[tackle-harness] Warning: could not remove ' + entryName, 'yellow'));
        }
      }
    }
  }
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

  var hasLegacyStructure = false;
  var cleanupActions = [];

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

  // 4. Create harness-manifest.json if not exists
  var manifestPath = path.join(claudeDir, 'harness-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    try {
      var ManifestResolver = require('../plugins/runtime/manifest-resolver');
      var defaultManifest = ManifestResolver.createDefaultManifest(packageRoot);
      var manifestContent = JSON.stringify(defaultManifest, null, 2);
      fs.writeFileSync(manifestPath, manifestContent + '\n', 'utf-8');
      console.log('[tackle-harness] Created harness-manifest.json');

      // Print plugin activation summary
      var plugins = defaultManifest.plugins || {};
      var pluginNames = Object.keys(plugins);
      var enabledCount = 0;
      for (var i = 0; i < pluginNames.length; i++) {
        if (plugins[pluginNames[i]].enabled !== false) {
          enabledCount++;
        }
      }
      console.log('[tackle-harness] Plugin activation: ' + enabledCount + ' enabled, ' + (pluginNames.length - enabledCount) + ' disabled');
    } catch (err) {
      console.error('[tackle-harness] Warning: Failed to create harness-manifest.json');
      console.error('[tackle-harness] Error: ' + err.message);
    }
  } else {
    console.log('[tackle-harness] harness-manifest.json already exists, skipping');
  }

  // 4.5. Create settings.json with hook registration (global mode)
  var builder = createBuilder();
  builder.updateSettings(targetRoot, packageRoot);
  console.log('[tackle-harness] Created .claude/settings.json with global hook registration');

  // 5. Detect and clean up legacy project-level hooks registration
  // Only remove hooks with relative paths (old local installation), keep absolute paths (global mode)
  var settingsPath = path.join(claudeDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      var settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      var hadProjectHooks = false;

      // Helper to check if a hook command uses a relative path (legacy local install)
      function isLegacyLocalHook(command) {
        if (!command) return false;
        // Check for relative path patterns: "../" or no drive letter on Windows
        return command.indexOf('../') !== -1 || command.indexOf('..\\') !== -1 ||
               (command.indexOf('node "') === 0 && !/[a-zA-Z]:/.test(command) && command.indexOf('./') === -1);
      }

      // Check for PreToolUse hooks (Edit|Write gate)
      if (settings.hooks && settings.hooks.PreToolUse && settings.hooks.PreToolUse.length > 0) {
        var preMatcher = 'Edit|Write';
        for (var i = 0; i < settings.hooks.PreToolUse.length; i++) {
          if (settings.hooks.PreToolUse[i].matcher === preMatcher) {
            var hookCmd = settings.hooks.PreToolUse[i].hooks && settings.hooks.PreToolUse[i].hooks[0] && settings.hooks.PreToolUse[i].hooks[0].command;
            if (isLegacyLocalHook(hookCmd)) {
              settings.hooks.PreToolUse.splice(i, 1);
              i--;
              hadProjectHooks = true;
            }
          }
        }
      }

      // Check for PostToolUse hooks (Skill gate)
      if (settings.hooks && settings.hooks.PostToolUse && settings.hooks.PostToolUse.length > 0) {
        var postMatcher = 'Skill';
        for (var j = 0; j < settings.hooks.PostToolUse.length; j++) {
          if (settings.hooks.PostToolUse[j].matcher === postMatcher) {
            var hookCmd = settings.hooks.PostToolUse[j].hooks && settings.hooks.PostToolUse[j].hooks[0] && settings.hooks.PostToolUse[j].hooks[0].command;
            if (isLegacyLocalHook(hookCmd)) {
              settings.hooks.PostToolUse.splice(j, 1);
              j--;
              hadProjectHooks = true;
            }
          }
        }
      }

      // Check for SessionStart hooks (plan-mode rules)
      if (settings.hooks && settings.hooks.SessionStart && settings.hooks.SessionStart.length > 0) {
        var sessionMatcher = 'startup|clear|compact';
        for (var k = 0; k < settings.hooks.SessionStart.length; k++) {
          if (settings.hooks.SessionStart[k].matcher === sessionMatcher) {
            var hookCmd = settings.hooks.SessionStart[k].hooks && settings.hooks.SessionStart[k].hooks[0] && settings.hooks.SessionStart[k].hooks[0].command;
            if (isLegacyLocalHook(hookCmd)) {
              settings.hooks.SessionStart.splice(k, 1);
              k--;
              hadProjectHooks = true;
            }
          }
        }
      }

      if (hadProjectHooks) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
        console.log(colorize('[tackle-harness] Cleaned up legacy project-level hooks registration', 'yellow'));
        hasLegacyStructure = true;
        cleanupActions.push('Removed project-level hooks from .claude/settings.json');
      }
    } catch (err) {
      console.error('[tackle-harness] Warning: Failed to clean up project-level hooks');
      console.error('[tackle-harness] Error: ' + err.message);
    }
  }

  // 6. Detect and clean up legacy project-level skills
  var projectSkillsDir = path.join(claudeDir, 'skills');
  if (fs.existsSync(projectSkillsDir)) {
    try {
      var registryPath = path.join(packageRoot, 'plugins', 'plugin-registry.json');
      var registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      var globalSkillNames = {};

      // Build set of global skill names (both with and without 'skill-' prefix)
      for (var m = 0; m < registry.plugins.length; m++) {
        var p = registry.plugins[m];
        var metaPath = path.join(packageRoot, 'plugins', 'core', p.source || p.name, 'plugin.json');
        if (fs.existsSync(metaPath)) {
          try {
            var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            if (meta.type === 'skill') {
              var fullName = meta.name || p.name;
              // Store both full name (with skill- prefix) and short name (without prefix)
              globalSkillNames[fullName] = true;
              if (fullName.indexOf('skill-') === 0) {
                var shortName = fullName.substring(6); // remove 'skill-' prefix
                globalSkillNames[shortName] = true;
              }
            }
          } catch (e) {
            // skip unparseable plugins
          }
        }
      }

      // Check project skills directory for duplicates
      var projectSkills = fs.readdirSync(projectSkillsDir);
      var removedSkills = [];

      for (var n = 0; n < projectSkills.length; n++) {
        var skillName = projectSkills[n];
        var skillPath = path.join(projectSkillsDir, skillName);

        // Only remove directories that match global skill names
        if (globalSkillNames[skillName] && fs.statSync(skillPath).isDirectory()) {
          fs.rmSync(skillPath, { recursive: true, force: true });
          removedSkills.push(skillName);
        }
      }

      if (removedSkills.length > 0) {
        console.log(colorize('[tackle-harness] Cleaned up ' + removedSkills.length + ' project-level skills (now available globally)', 'yellow'));
        hasLegacyStructure = true;
        cleanupActions.push('Removed ' + removedSkills.length + ' project-level skills (now available globally)');

        // Try to remove empty skills directory
        try {
          var remainingSkillEntries = fs.readdirSync(projectSkillsDir);
          if (remainingSkillEntries.length === 0) {
            fs.rmdirSync(projectSkillsDir);
            console.log('[tackle-harness] Removed empty .claude/skills/ directory');
          }
        } catch (e) {
          // directory not empty or other error, leave it
        }
      }
    } catch (err) {
      console.error('[tackle-harness] Warning: Failed to clean up project-level skills');
      console.error('[tackle-harness] Error: ' + err.message);
    }
  }

  // 7. Detect and clean up legacy project-level hooks
  var projectHooksDir = path.join(claudeDir, 'hooks');
  if (fs.existsSync(projectHooksDir)) {
    try {
      var hookEntries = fs.readdirSync(projectHooksDir);
      var removedHooks = [];

      for (var o = 0; o < hookEntries.length; o++) {
        var hookName = hookEntries[o];
        var hookPath = path.join(projectHooksDir, hookName);

        // Remove all hook directories (they should be global now)
        if (fs.statSync(hookPath).isDirectory()) {
          fs.rmSync(hookPath, { recursive: true, force: true });
          removedHooks.push(hookName);
        }
      }

      if (removedHooks.length > 0) {
        console.log(colorize('[tackle-harness] Cleaned up ' + removedHooks.length + ' project-level hooks (now available globally)', 'yellow'));
        hasLegacyStructure = true;
        cleanupActions.push('Removed ' + removedHooks.length + ' project-level hooks (now available globally)');
      }

      // Try to remove empty hooks directory
      try {
        var remainingEntries = fs.readdirSync(projectHooksDir);
        if (remainingEntries.length === 0) {
          fs.rmdirSync(projectHooksDir);
          console.log('[tackle-harness] Removed empty .claude/hooks/ directory');
        }
      } catch (e) {
        // directory not empty or other error, leave it
      }
    } catch (err) {
      console.error('[tackle-harness] Warning: Failed to clean up project-level hooks');
      console.error('[tackle-harness] Error: ' + err.message);
    }
  }

  // 8. Inject CLAUDE.md plan-mode rules (independent of build)
  builder.injectClaudeMdRules(targetRoot);

  // 9. Print migration summary if legacy structure was detected
  if (hasLegacyStructure) {
    console.log('');
    console.log(colorize('[tackle-harness] === Migration Summary ===', 'cyan'));
    console.log(colorize('[tackle-harness] Your project has been updated to use global skills/hooks.', 'cyan'));
    console.log('');
    for (var q = 0; q < cleanupActions.length; q++) {
      console.log('  - ' + cleanupActions[q]);
    }
    console.log('');
    console.log(colorize('[tackle-harness] All tackle-harness skills and hooks are now available globally.', 'green'));
    console.log(colorize('[tackle-harness] Your project only needs configuration files to use them.', 'green'));
    console.log('');
  }

  console.log(colorize('[tackle-harness] Done! Your project is ready to use tackle-harness.', 'green'));
}

function cmdHelp() {
  console.log(colorize('tackle-harness - Plugin-based AI Agent Harness for Claude Code', 'cyan'));
  console.log('');
  console.log('Usage:');
  console.log('  tackle-harness [command] [options]');
  console.log('');
  console.log('Commands:');
  var helpCommands = [
    ['build', 'Build all plugins (default)'],
    ['validate', 'Validate plugin.json files'],
    ['validate-config', 'Validate harness-config.yaml'],
    ['init', 'First-time setup (build + config)'],
    ['migrate', 'Migrate legacy project structure to global setup'],
    ['status', 'Show build status and plugin statistics'],
    ['config', 'Show/validate current configuration'],
    ['list', 'List all registered plugins'],
    ['interactive', 'Interactive plugin management (alias: i)'],
    ['setup-global', 'Install global skills to ~/.claude/skills/'],
    ['version', 'Show version information'],
    ['help', 'Show this help message'],
  ];
  var maxCmdLen = 0;
  for (var ci = 0; ci < helpCommands.length; ci++) {
    if (helpCommands[ci][0].length > maxCmdLen) maxCmdLen = helpCommands[ci][0].length;
  }
  for (var hi = 0; hi < helpCommands.length; hi++) {
    var cmdName = helpCommands[hi][0];
    var cmdPad = ' '.repeat(maxCmdLen - cmdName.length + 2);
    console.log('  ' + colorize(cmdName, 'green') + cmdPad + helpCommands[hi][1]);
  }
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
  var statusLabels = [
    ['.claude/skills/:', skillsDir],
    ['.claude/hooks/:', hooksDir],
    ['settings.json:', settingsPath],
    ['harness-config.yaml:', configPath],
  ];
  var maxLabelLen = 0;
  for (var li = 0; li < statusLabels.length; li++) {
    if (statusLabels[li][0].length > maxLabelLen) maxLabelLen = statusLabels[li][0].length;
  }
  for (var si = 0; si < statusLabels.length; si++) {
    var label = statusLabels[si][0];
    var padding = ' '.repeat(maxLabelLen - label.length + 2);
    var exists = fs.existsSync(statusLabels[si][1]);
    console.log('  ' + label + padding + (exists ? colorize('exists', 'green') : colorize('missing', 'red')));
  }
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
          for (var fi = 0; fi < skillFiles.length; fi++) {
            try {
              var fileStat = fs.statSync(path.join(skillEntryDir, skillFiles[fi]));
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

function cmdMigrate() {
  console.log(colorize('[tackle-harness] Migrating legacy project structure...', 'cyan'));
  console.log('[tackle-harness] Target project: ' + targetRoot);
  console.log('');

  var hasLegacyStructure = false;
  var cleanupActions = [];

  // 1. Detect and clean up legacy project-level hooks registration
  // Only remove hooks with relative paths (old local installation), keep absolute paths (global mode)
  var settingsPath = path.join(targetRoot, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      var settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      var hadProjectHooks = false;

      // Helper to check if a hook command uses a relative path (legacy local install)
      function isLegacyLocalHook(command) {
        if (!command) return false;
        // Check for relative path patterns: "../" or no drive letter on Windows
        return command.indexOf('../') !== -1 || command.indexOf('..\\') !== -1 ||
               (command.indexOf('node "') === 0 && !/[a-zA-Z]:/.test(command) && command.indexOf('./') === -1);
      }

      // Check for PreToolUse hooks (Edit|Write gate)
      if (settings.hooks && settings.hooks.PreToolUse && settings.hooks.PreToolUse.length > 0) {
        var preMatcher = 'Edit|Write';
        for (var i = 0; i < settings.hooks.PreToolUse.length; i++) {
          if (settings.hooks.PreToolUse[i].matcher === preMatcher) {
            var hookCmd = settings.hooks.PreToolUse[i].hooks && settings.hooks.PreToolUse[i].hooks[0] && settings.hooks.PreToolUse[i].hooks[0].command;
            if (isLegacyLocalHook(hookCmd)) {
              settings.hooks.PreToolUse.splice(i, 1);
              i--;
              hadProjectHooks = true;
            }
          }
        }
      }

      // Check for PostToolUse hooks (Skill gate)
      if (settings.hooks && settings.hooks.PostToolUse && settings.hooks.PostToolUse.length > 0) {
        var postMatcher = 'Skill';
        for (var j = 0; j < settings.hooks.PostToolUse.length; j++) {
          if (settings.hooks.PostToolUse[j].matcher === postMatcher) {
            var hookCmd = settings.hooks.PostToolUse[j].hooks && settings.hooks.PostToolUse[j].hooks[0] && settings.hooks.PostToolUse[j].hooks[0].command;
            if (isLegacyLocalHook(hookCmd)) {
              settings.hooks.PostToolUse.splice(j, 1);
              j--;
              hadProjectHooks = true;
            }
          }
        }
      }

      // Check for SessionStart hooks (plan-mode rules)
      if (settings.hooks && settings.hooks.SessionStart && settings.hooks.SessionStart.length > 0) {
        var sessionMatcher = 'startup|clear|compact';
        for (var k = 0; k < settings.hooks.SessionStart.length; k++) {
          if (settings.hooks.SessionStart[k].matcher === sessionMatcher) {
            var hookCmd = settings.hooks.SessionStart[k].hooks && settings.hooks.SessionStart[k].hooks[0] && settings.hooks.SessionStart[k].hooks[0].command;
            if (isLegacyLocalHook(hookCmd)) {
              settings.hooks.SessionStart.splice(k, 1);
              k--;
              hadProjectHooks = true;
            }
          }
        }
      }

      if (hadProjectHooks) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
        console.log(colorize('[tackle-harness] Removed project-level hooks from settings.json', 'yellow'));
        hasLegacyStructure = true;
        cleanupActions.push('Removed project-level hooks');
      }
    } catch (err) {
      console.error('[tackle-harness] Warning: Failed to clean up project-level hooks');
      console.error('[tackle-harness] Error: ' + err.message);
    }
  }

  // 2. Detect and clean up legacy project-level skills
  var projectSkillsDir = path.join(targetRoot, '.claude', 'skills');
  if (fs.existsSync(projectSkillsDir)) {
    try {
      var registryPath = path.join(packageRoot, 'plugins', 'plugin-registry.json');
      var registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      var globalSkillNames = {};

      // Build set of global skill names (both with and without 'skill-' prefix)
      for (var m = 0; m < registry.plugins.length; m++) {
        var p = registry.plugins[m];
        var metaPath = path.join(packageRoot, 'plugins', 'core', p.source || p.name, 'plugin.json');
        if (fs.existsSync(metaPath)) {
          try {
            var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            if (meta.type === 'skill') {
              var fullName = meta.name || p.name;
              // Store both full name (with skill- prefix) and short name (without prefix)
              globalSkillNames[fullName] = true;
              if (fullName.indexOf('skill-') === 0) {
                var shortName = fullName.substring(6); // remove 'skill-' prefix
                globalSkillNames[shortName] = true;
              }
            }
          } catch (e) {
            // skip unparseable plugins
          }
        }
      }

      // Check project skills directory for duplicates
      var projectSkills = fs.readdirSync(projectSkillsDir);
      var removedSkills = [];

      for (var n = 0; n < projectSkills.length; n++) {
        var skillName = projectSkills[n];
        var skillPath = path.join(projectSkillsDir, skillName);

        // Only remove directories that match global skill names
        if (globalSkillNames[skillName] && fs.statSync(skillPath).isDirectory()) {
          fs.rmSync(skillPath, { recursive: true, force: true });
          removedSkills.push(skillName);
        }
      }

      if (removedSkills.length > 0) {
        console.log(colorize('[tackle-harness] Removed ' + removedSkills.length + ' project-level skills (now available globally)', 'yellow'));
        hasLegacyStructure = true;
        cleanupActions.push('Removed ' + removedSkills.length + ' project-level skills');

        // Try to remove empty skills directory
        try {
          var remainingSkillEntries = fs.readdirSync(projectSkillsDir);
          if (remainingSkillEntries.length === 0) {
            fs.rmdirSync(projectSkillsDir);
            console.log('[tackle-harness] Removed empty .claude/skills/ directory');
          }
        } catch (e) {
          // directory not empty or other error, leave it
        }
      }
    } catch (err) {
      console.error('[tackle-harness] Warning: Failed to clean up project-level skills');
      console.error('[tackle-harness] Error: ' + err.message);
    }
  }

  // 3. Detect and clean up legacy project-level hooks
  var projectHooksDir = path.join(targetRoot, '.claude', 'hooks');
  if (fs.existsSync(projectHooksDir)) {
    try {
      var hookEntries = fs.readdirSync(projectHooksDir);
      var removedHooks = [];

      for (var o = 0; o < hookEntries.length; o++) {
        var hookName = hookEntries[o];
        var hookPath = path.join(projectHooksDir, hookName);

        // Remove all hook directories (they should be global now)
        if (fs.statSync(hookPath).isDirectory()) {
          fs.rmSync(hookPath, { recursive: true, force: true });
          removedHooks.push(hookName);
        }
      }

      if (removedHooks.length > 0) {
        console.log(colorize('[tackle-harness] Removed ' + removedHooks.length + ' project-level hooks (now available globally)', 'yellow'));
        hasLegacyStructure = true;
        cleanupActions.push('Removed ' + removedHooks.length + ' project-level hooks');

        // Try to remove empty hooks directory
        try {
          var remainingEntries = fs.readdirSync(projectHooksDir);
          if (remainingEntries.length === 0) {
            fs.rmdirSync(projectHooksDir);
            console.log('[tackle-harness] Removed empty .claude/hooks/ directory');
          }
        } catch (e) {
          // directory not empty or other error, leave it
        }
      }
    } catch (err) {
      console.error('[tackle-harness] Warning: Failed to clean up project-level hooks');
      console.error('[tackle-harness] Error: ' + err.message);
    }
  }

  // 4. Inject CLAUDE.md plan-mode rules
  var builder = createBuilder();
  builder.injectClaudeMdRules(targetRoot);

  // 5. Print migration summary
  if (!hasLegacyStructure) {
    console.log(colorize('[tackle-harness] No legacy structure found. Project is already using global setup.', 'green'));
  } else {
    console.log('');
    console.log(colorize('[tackle-harness] === Migration Complete ===', 'cyan'));
    console.log('');
    for (var q = 0; q < cleanupActions.length; q++) {
      console.log('  - ' + cleanupActions[q]);
    }
    console.log('');
    console.log(colorize('[tackle-harness] All tackle-harness skills and hooks are now available globally.', 'green'));
    console.log(colorize('[tackle-harness] Your project only needs configuration files to use them.', 'green'));
    console.log('');
  }

  console.log(colorize('[tackle-harness] Done! Your project is ready to use tackle-harness.', 'green'));
  process.exit(0);
}

function cmdInteractive() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Security check: prevent modifications to global registry
  // when running in interactive mode from a project directory
  const globalRegistryPath = path.join(packageRoot, 'plugins', 'plugin-registry.json');
  const projectRegistryPath = path.join(targetRoot, '.claude', 'plugin-registry.json');

  // Warn if trying to modify global registry from project directory
  if (targetRoot !== packageRoot && targetRoot.indexOf(path.join(packageRoot, '..')) !== 0) {
    // Check if user is trying to modify global registry
    const settingsPath = path.join(targetRoot, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        // Check if this project has global registry references
        if (settings.globalRegistry || settings.hooks && settings.hooks.global) {
          console.warn(colorize('[tackle-harness] Warning: Interactive mode should not modify global registry.', 'yellow'));
          console.warn(colorize('[tackle-harness] Use project manifest (.claude/harness-manifest.json) for project-specific overrides.', 'yellow'));
          console.warn(colorize('[tackle-harness] Global registry is managed by npm install -g tackle-harness', 'yellow'));
          console.log('');
        }
      } catch (e) {
        // ignore parse errors
      }
    }
  }

  const registryPath = path.join(packageRoot, 'plugins', 'plugin-registry.json');
  let registry;

  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  } catch (e) {
    console.error(colorize('Error: Failed to read plugin registry: ' + e.message, 'red'));
    process.exit(1);
  }

  const plugins = registry.plugins || [];

  function showMenu() {
    console.log('');
    console.log(colorize('=== Tackle Harness - Interactive Mode ===', 'cyan'));
    console.log('');
    console.log('  [L] 列出插件 (List plugins)');
    console.log('  [T] 切换插件 (Toggle plugin)');
    console.log('  [V] 查看详情 (View details)');
    console.log('  [R] 重新构建 (Rebuild)');
    console.log('  [Q] 退出 (Quit)');
    console.log('');
  }

  function listPlugins() {
    console.log('');
    console.log(colorize('--- 插件列表 (Plugin List) ---', 'cyan'));
    console.log('');

    const byType = {
      skill: [],
      hook: [],
      validator: [],
      provider: [],
      unknown: []
    };

    for (let i = 0; i < plugins.length; i++) {
      const p = plugins[i];
      const pluginDir = path.join(packageRoot, 'plugins', 'core', p.source || p.name);
      const metaPath = path.join(pluginDir, 'plugin.json');
      let type = 'unknown';
      let description = '';

      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          type = meta.type || 'unknown';
          description = meta.description || '';
        } catch (e) {
          // use defaults
        }
      }

      const enabled = p.enabled !== false;
      const statusStr = enabled ? colorize('enabled', 'green') : colorize('disabled', 'dim');

      byType[type].push({
        name: p.name,
        status: statusStr,
        enabled: enabled,
        description: description
      });
    }

    const typeOrder = ['skill', 'hook', 'validator', 'provider'];
    for (let t = 0; t < typeOrder.length; t++) {
      const typeName = typeOrder[t];
      const typePlugins = byType[typeName];

      if (typePlugins.length > 0) {
        console.log(colorize(typeName.charAt(0).toUpperCase() + typeName.slice(1) + ' Plugins:', 'cyan'));

        let maxNameLen = 0;
        for (let j = 0; j < typePlugins.length; j++) {
          if (typePlugins[j].name.length > maxNameLen) {
            maxNameLen = typePlugins[j].name.length;
          }
        }

        for (let k = 0; k < typePlugins.length; k++) {
          const plugin = typePlugins[k];
          const namePadding = ' '.repeat(maxNameLen - plugin.name.length + 2);
          console.log('  ' + plugin.name + namePadding + '[' + plugin.status + ']');
          if (plugin.description) {
            console.log('    ' + colorize(plugin.description, 'dim'));
          }
        }
        console.log('');
      }
    }

    const enabledCount = plugins.filter(function (p) { return p.enabled !== false; }).length;
    console.log('Total: ' + plugins.length + ' plugins | Enabled: ' + colorize(enabledCount, 'green') + ', Disabled: ' + colorize(plugins.length - enabledCount, 'dim'));
  }

  function togglePlugin(pluginName) {
    let plugin = null;
    let pluginIndex = -1;

    for (let i = 0; i < plugins.length; i++) {
      if (plugins[i].name.toLowerCase() === pluginName.toLowerCase()) {
        plugin = plugins[i];
        pluginIndex = i;
        break;
      }
    }

    if (!plugin) {
      console.log('');
      console.log(colorize('Error: Plugin not found: ' + pluginName, 'red'));
      return;
    }

    const newEnabled = plugin.enabled === false;

    try {
      // Use manifest-resolver to update project manifest
      const ManifestResolver = require('../plugins/runtime/manifest-resolver');
      const success = ManifestResolver.updatePluginInManifest(packageRoot, targetRoot, plugin.name, newEnabled);

      if (!success) {
        console.log('');
        console.error(colorize('Error: Failed to update plugin manifest', 'red'));
        return;
      }

      // Update in-memory registry for display
      plugin.enabled = newEnabled;

      console.log('');
      console.log(colorize('Plugin "' + plugin.name + '" is now ' + (newEnabled ? 'enabled' : 'disabled'), 'green'));
      console.log(colorize('(Updated project manifest: .claude/harness-manifest.json)', 'dim'));

      rl.question(colorize('是否重新构建? (y/N): ', 'yellow'), function (answer) {
        if (answer && answer.toLowerCase() === 'y') {
          console.log('');
          console.log(colorize('[tackle-harness] Rebuilding plugins...', 'cyan'));
          const builder = createBuilder();
          const result = builder.build();

          if (result.success) {
            if (flags.verbose) {
              console.log(colorize('[tackle-harness] Updating settings.json...', 'dim'));
            }
            builder.updateSettings(targetRoot, packageRoot);
            builder.injectClaudeMdRules(targetRoot);
            _cleanStaleOutput(builder);
          }

          const coloredSummary = result.summary
            .replace(/Build SUCCEEDED/g, colorize('Build SUCCEEDED', 'green'))
            .replace(/Build COMPLETED WITH ERRORS/g, colorize('Build COMPLETED WITH ERRORS', 'yellow'))
            .replace(/Validation PASSED/g, colorize('Validation PASSED', 'green'))
            .replace(/Validation FAILED/g, colorize('Validation FAILED', 'red'));

          console.log(coloredSummary);
        }
        showMenu();
        prompt();
      });
    } catch (e) {
      console.log('');
      console.error(colorize('Error: Failed to update manifest: ' + e.message, 'red'));
    }
  }

  function viewDetails(pluginName) {
    let plugin = null;

    for (let i = 0; i < plugins.length; i++) {
      if (plugins[i].name.toLowerCase() === pluginName.toLowerCase()) {
        plugin = plugins[i];
        break;
      }
    }

    if (!plugin) {
      console.log('');
      console.log(colorize('Error: Plugin not found: ' + pluginName, 'red'));
      return;
    }

    console.log('');
    console.log(colorize('--- Plugin Details: ' + plugin.name + ' ---', 'cyan'));
    console.log('');
    console.log('Name:    ' + plugin.name);
    console.log('Source:  ' + (plugin.source || '-'));
    console.log('Status:  ' + (plugin.enabled !== false ? colorize('enabled', 'green') : colorize('disabled', 'dim')));

    const pluginDir = path.join(packageRoot, 'plugins', 'core', plugin.source || plugin.name);
    const metaPath = path.join(pluginDir, 'plugin.json');

    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

        if (meta.type) {
          console.log('Type:    ' + meta.type);
        }
        if (meta.version) {
          console.log('Version: ' + meta.version);
        }
        if (meta.description) {
          console.log('');
          console.log('Description:');
          console.log('  ' + meta.description);
        }
        if (meta.dependencies && meta.dependencies.length > 0) {
          console.log('');
          console.log('Dependencies:');
          for (let i = 0; i < meta.dependencies.length; i++) {
            console.log('  - ' + meta.dependencies[i]);
          }
        }
        if (plugin.config && Object.keys(plugin.config).length > 0) {
          console.log('');
          console.log('Configuration:');
          for (const key in plugin.config) {
            if (plugin.config.hasOwnProperty(key)) {
              const value = plugin.config[key];
              if (typeof value === 'object') {
                console.log('  ' + key + ': ' + JSON.stringify(value));
              } else {
                console.log('  ' + key + ': ' + value);
              }
            }
          }
        }
      } catch (e) {
        console.log('');
        console.log(colorize('Warning: Failed to parse plugin metadata', 'yellow'));
      }
    }
  }

  function rebuild() {
    console.log('');
    console.log(colorize('[tackle-harness] Rebuilding plugins...', 'cyan'));

    const builder = createBuilder();
    const result = builder.build();

    if (result.success) {
      if (flags.verbose) {
        console.log(colorize('[tackle-harness] Updating settings.json...', 'dim'));
      }
      builder.updateSettings(targetRoot, packageRoot);
      builder.injectClaudeMdRules(targetRoot);
      _cleanStaleOutput(builder);
    }

    const coloredSummary = result.summary
      .replace(/Build SUCCEEDED/g, colorize('Build SUCCEEDED', 'green'))
      .replace(/Build COMPLETED WITH ERRORS/g, colorize('Build COMPLETED WITH ERRORS', 'yellow'))
      .replace(/Validation PASSED/g, colorize('Validation PASSED', 'green'))
      .replace(/Validation FAILED/g, colorize('Validation FAILED', 'red'));

    console.log(coloredSummary);

    if (result.success) {
      console.log(colorize('[tackle-harness] Done!', 'green'));
    }
  }

  function prompt() {
    rl.question(colorize('选择操作 (Enter choice): ', 'cyan'), function (answer) {
      const cmd = answer.trim().toLowerCase();

      if (!cmd || cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
        console.log('');
        console.log(colorize('Goodbye!', 'green'));
        rl.close();
        process.exit(0);
      } else if (cmd === 'l' || cmd === 'list') {
        listPlugins();
        showMenu();
        prompt();
      } else if (cmd === 'r' || cmd === 'rebuild') {
        rebuild();
        showMenu();
        prompt();
      } else if (cmd === 't' || cmd === 'toggle') {
        rl.question(colorize('输入插件名称 (Enter plugin name): ', 'yellow'), function (name) {
          togglePlugin(name.trim());
        });
      } else if (cmd === 'v' || cmd === 'view') {
        rl.question(colorize('输入插件名称 (Enter plugin name): ', 'yellow'), function (name) {
          viewDetails(name.trim());
          showMenu();
          prompt();
        });
      } else {
        console.log('');
        console.log(colorize('Unknown command: ' + cmd, 'red'));
        showMenu();
        prompt();
      }
    });
  }

  showMenu();
  prompt();
}

// ---------------------------------------------------------------------------
// setup-global: install all skills and hooks globally to ~/.claude/
// ---------------------------------------------------------------------------

function cmdSetupGlobal() {
  var homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) {
    console.error(colorize('Error: Cannot determine home directory', 'red'));
    process.exit(1);
  }

  console.log(colorize('[tackle-harness] Installing global skills and hooks...', 'cyan'));
  console.log('[tackle-harness] Home directory: ' + homeDir);
  console.log('[tackle-harness] Package root:   ' + packageRoot);
  console.log('');

  // Create a global builder with home directory as target
  var globalBuilder = new HarnessBuild({
    targetRoot: homeDir,
    packageRoot: packageRoot,
    registryPath: path.join(packageRoot, 'plugins', 'plugin-registry.json'),
    pluginsDir: path.join(packageRoot, 'plugins', 'core'),
    outputSkillsDir: path.join(homeDir, '.claude', 'skills'),
    outputHooksDir: path.join(homeDir, '.claude', 'hooks'),
    verbose: flags.verbose,
    globalMode: true, // Enable global mode for default context config
    cliPath: process.argv[1] || path.join(packageRoot, 'bin', 'tackle.js'), // For __TACKLE_CLI_PATH__ replacement
  });

  // Build all plugins (skills + hooks)
  var result = globalBuilder.build();

  if (result.success) {
    if (flags.verbose) {
      console.log(colorize('[tackle-harness] Updating global settings.json...', 'dim'));
    }
    // Register hooks in global settings.json
    globalBuilder.updateSettings(homeDir, packageRoot);
  }

  // Apply colors to summary output
  var coloredSummary = result.summary
    .replace(/Build SUCCEEDED/g, colorize('Build SUCCEEDED', 'green'))
    .replace(/Build COMPLETED WITH ERRORS/g, colorize('Build COMPLETED WITH ERRORS', 'yellow'))
    .replace(/Validation PASSED/g, colorize('Validation PASSED', 'green'))
    .replace(/Validation FAILED/g, colorize('Validation FAILED', 'red'));

  console.log(coloredSummary);

  if (result.success) {
    console.log(colorize('[tackle-harness] Global settings updated: ~/.claude/settings.json', 'green'));
    console.log(colorize('[tackle-harness] Done! Skills and hooks are globally available.', 'green'));
    console.log('');
    console.log(colorize('You can now use tackle-harness in any project directory.', 'cyan'));
    console.log(colorize('Run "tackle-harness init" in your project to get started.', 'dim'));
  }

  process.exit(result.success ? 0 : 1);
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
  case 'migrate':
    cmdMigrate();
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
  case 'interactive':
  case 'i':
    cmdInteractive();
    break;
  case 'setup-global':
    cmdSetupGlobal();
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
