'use strict';

var path = require('path');
var fs = require('fs');

/**
 * Init command - First-time setup: build + generate default config
 * @public
 */
module.exports = {
  name: 'init',
  description: 'First-time setup (build + config)',
  /**
   * Execute the init command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    console.log('[tackle-harness] Initializing...');
    console.log('[tackle-harness] Target project: ' + ctx.targetRoot);
    console.log('[tackle-harness] Package root:   ' + ctx.packageRoot);
    console.log('');

    var hasLegacyStructure = false;
    var cleanupActions = [];

    // 1. Ensure .claude/ directory exists
    var claudeDir = path.join(ctx.targetRoot, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      console.log('[tackle-harness] Created .claude/ directory');
    }

    // 2. Ensure .claude/config/ directory exists
    var configDir = ctx.configDir;
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
      console.log('[tackle-harness] Created .claude/config/ directory');
    }

    // 3. Copy harness-config.yaml template if not exists
    var targetConfigPath = path.join(configDir, 'harness-config.yaml');
    var templatePath = path.join(ctx.packageRoot, 'templates', 'harness-config.yaml');

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
        var defaultManifest = ManifestResolver.createDefaultManifest(ctx.packageRoot);
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
    var builder = ctx.createBuilder();
    builder.updateSettings(ctx.targetRoot, ctx.packageRoot);
    console.log('[tackle-harness] Created .claude/settings.json with global hook registration');

    // 5. Detect and clean up legacy project-level hooks registration
    var settingsPath = ctx.settingsPath;
    if (fs.existsSync(settingsPath)) {
      try {
        var settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        var hadProjectHooks = false;

        // Helper to check if a hook command uses a relative path (legacy local install)
        function isLegacyLocalHook(command) {
          if (!command) return false;
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
          console.log(ctx.colorize('[tackle-harness] Cleaned up legacy project-level hooks registration', 'yellow'));
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
        var registry = JSON.parse(fs.readFileSync(ctx.registryPath, 'utf-8'));
        var globalSkillNames = {};

        for (var m = 0; m < registry.plugins.length; m++) {
          var p = registry.plugins[m];
          var metaPath = path.join(ctx.packageRoot, 'plugins', 'core', p.source || p.name, 'plugin.json');
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
        var removedSkills = [];

        for (var n = 0; n < projectSkills.length; n++) {
          var skillName = projectSkills[n];
          var skillPath = path.join(projectSkillsDir, skillName);

          if (globalSkillNames[skillName] && fs.statSync(skillPath).isDirectory()) {
            fs.rmSync(skillPath, { recursive: true, force: true });
            removedSkills.push(skillName);
          }
        }

        if (removedSkills.length > 0) {
          console.log(ctx.colorize('[tackle-harness] Cleaned up ' + removedSkills.length + ' project-level skills (now available globally)', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed ' + removedSkills.length + ' project-level skills (now available globally)');

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

          if (fs.statSync(hookPath).isDirectory()) {
            fs.rmSync(hookPath, { recursive: true, force: true });
            removedHooks.push(hookName);
          }
        }

        if (removedHooks.length > 0) {
          console.log(ctx.colorize('[tackle-harness] Cleaned up ' + removedHooks.length + ' project-level hooks (now available globally)', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed ' + removedHooks.length + ' project-level hooks (now available globally)');
        }

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
    builder.injectClaudeMdRules(ctx.targetRoot);

    // 9. Print migration summary if legacy structure was detected
    if (hasLegacyStructure) {
      console.log('');
      console.log(ctx.colorize('[tackle-harness] === Migration Summary ===', 'cyan'));
      console.log(ctx.colorize('[tackle-harness] Your project has been updated to use global skills/hooks.', 'cyan'));
      console.log('');
      for (var q = 0; q < cleanupActions.length; q++) {
        console.log('  - ' + cleanupActions[q]);
      }
      console.log('');
      console.log(ctx.colorize('[tackle-harness] All tackle-harness skills and hooks are now available globally.', 'green'));
      console.log(ctx.colorize('[tackle-harness] Your project only needs configuration files to use them.', 'green'));
      console.log('');
    }

    console.log(ctx.colorize('[tackle-harness] Done! Your project is ready to use tackle-harness.', 'green'));
  },
};
