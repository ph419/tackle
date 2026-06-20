/**
 * settings-merger - Merge tackle-harness hooks into project settings
 *
 * Handles the merging of tackle-harness hook configurations into the
 * target project's .claude/settings.json. Supports both global and local
 * install modes with appropriate path resolution.
 *
 * @module settings-merger
 */

'use strict';

var fs = require('fs');
var path = require('path');

// ---------------------------------------------------------------------------
// Install mode detection
// ---------------------------------------------------------------------------

/**
 * Detect whether this is a local or global installation.
 * Checks if packageRoot is an ancestor of targetRoot.
 *
 * @public
 * @param {string} packageRoot - this package's root directory (node_modules/tackle-harness/)
 * @param {string} targetRoot - target project root directory
 * @returns {boolean} true if local install, false if global install
 */
function isLocalInstall(packageRoot, targetRoot) {
  // Normalize paths for comparison
  var normalizedPackage = path.resolve(packageRoot).replace(/\\/g, '/');
  var normalizedTarget = path.resolve(targetRoot).replace(/\\/g, '/');

  // Check if packageRoot is an ancestor of targetRoot
  var relative = path.relative(normalizedPackage, normalizedTarget);
  // If relative path doesn't start with '..', packageRoot is an ancestor
  return relative.indexOf('..') !== 0;
}

// ---------------------------------------------------------------------------
// Hook entry management
// ---------------------------------------------------------------------------

/**
 * Update or insert a hook entry in a hooks array.
 * If a hook with the same matcher exists, update its command; otherwise add a new entry.
 *
 * @public
 * @param {object[]} hookArray - the hooks array (e.g. settings.hooks.PreToolUse)
 * @param {string} matcher - the matcher string (e.g. 'Edit|Write')
 * @param {string} command - the full command string
 */
function upsertHookEntry(hookArray, matcher, command) {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge tackle-harness hooks into the target project's .claude/settings.json.
 * Reads existing settings, adds tackle-harness-specific hooks, and writes back.
 * Idempotent: skips hooks that are already registered.
 *
 * Uses absolute paths for global installs, relative paths for local installs.
 *
 * @public
 * @param {object} options
 * @param {string} options.targetRoot  - target project root directory
 * @param {string} options.packageRoot - this package's root directory (node_modules/tackle-harness/)
 * @param {Function} [options.ensureDir] - directory creation function (injectable for testing)
 */
function mergeSettings(options) {
  var targetRoot = options.targetRoot;
  var packageRoot = options.packageRoot;
  var ensureDir = options.ensureDir || defaultEnsureDir;

  var settingsPath = path.join(targetRoot, '.claude', 'settings.json');
  var settings = {};

  // Detect installation mode
  var localInstall = isLocalInstall(packageRoot, targetRoot);

  // Read existing settings if present
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (e) {
      // B3：损坏的 settings.json 不能静默重置（会丢失用户的多 matcher/多 command 配置）。
      // 先备份原文件，再抛错让调用方中止——绝不直接覆盖。
      var backupPath = settingsPath + '.corrupt.' + Date.now();
      try {
        fs.copyFileSync(settingsPath, backupPath);
      } catch (_backupErr) {
        // 备份失败也不掩盖问题：仍抛错（备份路径仅用于提示）
      }
      throw new Error(
        'settings.json 解析失败，已停止以避免覆盖用户配置。' +
        '原文件已备份到 ' + backupPath + '。解析错误：' + (e && e.message ? e.message : String(e)) +
        '。请修正后重试。'
      );
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
  if (localInstall) {
    // Local install: use relative path
    var hookScriptRelative = path.relative(targetRoot, hookScriptPath).replace(/\\/g, '/');
    hookCmd = 'node "' + hookScriptRelative + '"';
  } else {
    // Global install: use absolute path with forward slashes
    hookCmd = 'node "' + hookScriptPath.replace(/\\/g, '/') + '"';
  }

  // Update or add PreToolUse hook for Edit|Write
  var preMatcher = 'Edit|Write';
  upsertHookEntry(settings.hooks.PreToolUse, preMatcher, hookCmd + ' --pre-tool');

  // Update or add PostToolUse hook for Skill
  var postMatcher = 'Skill';
  upsertHookEntry(settings.hooks.PostToolUse, postMatcher, hookCmd + ' --post-skill');

  // Update or add SessionStart hook for plan-mode rule injection
  var sessionHookScriptPath = path.join(packageRoot, 'plugins', 'core', 'hook-session-start', 'index.js');
  var sessionHookCmd;
  if (localInstall) {
    var sessionHookRelative = path.relative(targetRoot, sessionHookScriptPath).replace(/\\/g, '/');
    sessionHookCmd = 'node "' + sessionHookRelative + '"';
  } else {
    sessionHookCmd = 'node "' + sessionHookScriptPath.replace(/\\/g, '/') + '"';
  }
  var sessionMatcher = 'startup|clear|compact';
  upsertHookEntry(settings.hooks.SessionStart, sessionMatcher, sessionHookCmd);

  // Write back
  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Default directory creation function.
 * @param {string} dirPath
 */
function defaultEnsureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

module.exports = {
  mergeSettings: mergeSettings,
  isLocalInstall: isLocalInstall,
  upsertHookEntry: upsertHookEntry,
};
