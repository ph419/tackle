/**
 * cleanup-utils - Shared cleanup utility functions
 *
 * Extracted from commands/init.js and commands/migrate.js to eliminate
 * ~125 lines of duplicated cleanup logic. Provides functions for
 * detecting and removing legacy project-level hooks, skills, and
 * empty directories.
 *
 * Hook names are derived dynamically from plugin-registry.json
 * instead of being hardcoded.
 *
 * @module cleanup-utils
 */

'use strict';

var path = require('path');
var fs = require('fs');
var safePath = require('./safe-path');

// ---------------------------------------------------------------------------
// Hook name derivation from registry
// ---------------------------------------------------------------------------

/**
 * Get hook plugin names from the plugin registry.
 * Reads plugin-registry.json and filters plugins with type 'hook'.
 *
 * @public
 * @param {string} registryPath - Path to plugin-registry.json
 * @param {string} packageRoot - Root directory of tackle-harness package
 * @returns {string[]} Array of hook plugin names (e.g. ['hook-skill-gate', 'hook-session-start'])
 */
function getHookNamesFromRegistry(registryPath, packageRoot) {
  var hookNames = [];
  var registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  } catch (e) {
    return hookNames;
  }

  var plugins = registry.plugins || [];
  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    var metaPath = path.join(packageRoot, 'plugins', 'core', p.source || p.name, 'plugin.json');
    if (fs.existsSync(metaPath)) {
      try {
        var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.type === 'hook') {
          hookNames.push(meta.name || p.name);
        }
      } catch (e) {
        // skip unparseable plugin metadata
      }
    }
  }

  return hookNames;
}

// ---------------------------------------------------------------------------
// Legacy detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if a hook command uses a relative path (legacy local install).
 * Includes WP-168 fix: excludes absolute Unix paths (node "/...").
 *
 * @public
 * @param {string} command - The hook command string to check
 * @returns {boolean} true if the command appears to be a legacy local hook
 */
function isLegacyLocalHook(command) {
  if (!command) return false;
  return command.indexOf('../') !== -1 || command.indexOf('..\\') !== -1 ||
         (command.indexOf('node "') === 0 && !/[a-zA-Z]:/.test(command) && command.indexOf('./') === -1 && command.indexOf('node "/') !== 0);
}

// ---------------------------------------------------------------------------
// Settings hook cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up legacy project-level hooks from settings.json.
 * Removes hook entries that reference legacy local install paths.
 *
 * @public
 * @param {object} settings - Parsed settings.json object (mutated in place)
 * @returns {{ settings: object, hadProjectHooks: boolean }}
 */
function cleanupSettingsHooks(settings) {
  var hadProjectHooks = false;

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

  return { settings: settings, hadProjectHooks: hadProjectHooks };
}

// ---------------------------------------------------------------------------
// Project skills cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up legacy project-level skills directory.
 * Removes skills that are now available globally (registered in plugin-registry.json).
 *
 * @public
 * @param {string} projectSkillsDir - Path to .claude/skills/
 * @param {string} registryPath - Path to plugin-registry.json
 * @param {string} packageRoot - Root directory of tackle-harness package
 * @returns {string[]} Array of removed skill names
 */
function cleanupProjectSkills(projectSkillsDir, registryPath, packageRoot) {
  var removedSkills = [];

  if (!fs.existsSync(projectSkillsDir)) {
    return removedSkills;
  }

  try {
    var registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    var globalSkillNames = {};

    for (var m = 0; m < registry.plugins.length; m++) {
      var p = registry.plugins[m];
      var metaPath = path.join(packageRoot, 'plugins', 'core', p.source || p.name, 'plugin.json');
      if (fs.existsSync(metaPath)) {
        try {
          var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (meta.type === 'skill') {
            var fullName = meta.name || p.name;
            globalSkillNames[fullName] = true;
            if (fullName.indexOf('skill-') === 0) {
              var shortName = fullName.substring(6);
              globalSkillNames[shortName] = true;
            }
          }
        } catch (e) {
          // skip unparseable plugins
        }
      }
    }

    var projectSkills = fs.readdirSync(projectSkillsDir);

    for (var n = 0; n < projectSkills.length; n++) {
      var skillName = projectSkills[n];
      var skillPath = path.join(projectSkillsDir, skillName);

      if (globalSkillNames[skillName]) {
        // S5：拒绝符号链接/junction，避免 rmSync(recursive) 顺着链接递归删除目标。
        // .claude/skills/ 下的合法 skill 都是普通目录，不应为 symlink。
        if (safePath.isSymlink(skillPath)) {
          continue;
        }
        fs.rmSync(skillPath, { recursive: true, force: true });
        removedSkills.push(skillName);
      }
    }
  } catch (err) {
    // Return whatever was removed so far
  }

  return removedSkills;
}

// ---------------------------------------------------------------------------
// Project hooks cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up legacy project-level hooks directory.
 * Removes hook directories that are now available globally.
 * Uses getHookNamesFromRegistry to derive hook names dynamically.
 *
 * @public
 * @param {string} projectHooksDir - Path to .claude/hooks/
 * @param {string} registryPath - Path to plugin-registry.json
 * @param {string} packageRoot - Root directory of tackle-harness package
 * @returns {string[]} Array of removed hook names
 */
function cleanupProjectHooks(projectHooksDir, registryPath, packageRoot) {
  var removedHooks = [];

  if (!fs.existsSync(projectHooksDir)) {
    return removedHooks;
  }

  try {
    var tackleHooks = getHookNamesFromRegistry(registryPath, packageRoot);

    // Directly remove known hook paths instead of readdirSync+statSync loop
    for (var i = 0; i < tackleHooks.length; i++) {
      var hookPath = path.join(projectHooksDir, tackleHooks[i]);
      if (fs.existsSync(hookPath)) {
        // S5：拒绝符号链接/junction，避免 rmSync(recursive) 删除链接目标
        if (safePath.isSymlink(hookPath)) {
          continue;
        }
        fs.rmSync(hookPath, { recursive: true, force: true });
        removedHooks.push(tackleHooks[i]);
      }
    }
  } catch (err) {
    // Return whatever was removed so far
  }

  return removedHooks;
}

// ---------------------------------------------------------------------------
// Empty directory removal
// ---------------------------------------------------------------------------

/**
 * Remove a directory if it is empty.
 * No-op if the directory does not exist or is not empty.
 *
 * @public
 * @param {string} dirPath - Path to the directory to potentially remove
 * @returns {boolean} true if the directory was removed, false otherwise
 */
function removeEmptyDir(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      var entries = fs.readdirSync(dirPath);
      if (entries.length === 0) {
        fs.rmdirSync(dirPath);
        return true;
      }
    }
  } catch (e) {
    // directory not empty or other error, leave it
  }
  return false;
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  isLegacyLocalHook: isLegacyLocalHook,
  cleanupSettingsHooks: cleanupSettingsHooks,
  cleanupProjectSkills: cleanupProjectSkills,
  cleanupProjectHooks: cleanupProjectHooks,
  removeEmptyDir: removeEmptyDir,
  getHookNamesFromRegistry: getHookNamesFromRegistry
};
