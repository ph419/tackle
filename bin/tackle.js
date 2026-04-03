#!/usr/bin/env node
/**
 * tackle - CLI entry point for the AI Agent Harness framework
 *
 * Usage:
 *   tackle             Build all plugins into .claude/skills/ and update settings.json
 *   tackle build       Same as above (default command)
 *   tackle validate    Validate plugin.json files without building
 *   tackle init        First-time setup: build + generate default config
 *   tackle --help      Show usage info
 */

'use strict';

var path = require('path');
var fs = require('fs');
var HarnessBuild = require('../plugins/runtime/harness-build');

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
var command = args[0] || 'build';
var flags = {
  root: null,
};

for (var i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) {
    flags.root = args[++i];
  }
}

// Override target root if --root flag provided
if (flags.root) {
  targetRoot = path.resolve(flags.root);
}

// Subcommand aliases
if (command === '--validate') command = 'validate';
if (command === '--help' || command === '-h') command = 'help';

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
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdBuild() {
  var builder = createBuilder();
  var result = builder.build();

  if (result.success) {
    builder.updateSettings(targetRoot, packageRoot);
  }

  console.log(result.summary);

  if (result.success) {
    console.log('[tackle] Settings updated: .claude/settings.json');
    console.log('[tackle] Done! Skills are ready to use.');
  }

  process.exit(result.success ? 0 : 1);
}

function cmdValidate() {
  var builder = createBuilder();
  var result = builder.validate();
  console.log(result.summary);
  process.exit(result.valid ? 0 : 1);
}

function cmdInit() {
  console.log('[tackle] Initializing...');
  console.log('[tackle] Target project: ' + targetRoot);
  console.log('[tackle] Package root:   ' + packageRoot);
  console.log('');

  // 1. Ensure .claude/ directory exists
  var claudeDir = path.join(targetRoot, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    console.log('[tackle] Created .claude/ directory');
  }

  // 2. Run build
  cmdBuild();
}

function cmdHelp() {
  console.log('tackle - Plugin-based AI Agent Harness for Claude Code');
  console.log('');
  console.log('Usage:');
  console.log('  tackle             Build all plugins (default)');
  console.log('  tackle build       Build all plugins');
  console.log('  tackle validate    Validate plugin.json files');
  console.log('  tackle init        First-time setup (build + config)');
  console.log('');
  console.log('Options:');
  console.log('  --root <path>      Specify target project root (default: cwd)');
  console.log('  --help, -h         Show this help message');
  console.log('');
  console.log('After running tackle build, skills are available in .claude/skills/');
  console.log('and hooks are registered in .claude/settings.json');
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
  case 'init':
    cmdInit();
    break;
  case 'help':
  default:
    cmdHelp();
    break;
}
