'use strict';

var path = require('path');
var fs = require('fs');

/**
 * Migrate command - Migrate legacy project structure to global setup
 * @public
 */
module.exports = {
  name: 'migrate',
  description: 'Migrate legacy project structure to global setup',
  /**
   * Execute the migrate command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    console.log(ctx.colorize('[tackle-harness] Migrating legacy project structure...', 'cyan'));
    console.log('[tackle-harness] Target project: ' + ctx.targetRoot);
    console.log('');

    var hasLegacyStructure = false;
    var cleanupActions = [];

    // 1. Detect and clean up legacy project-level hooks registration
    var settingsPath = ctx.settingsPath;
    if (fs.existsSync(settingsPath)) {
      try {
        var settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        var hadProjectHooks = false;

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
          console.log(ctx.colorize('[tackle-harness] Removed project-level hooks from settings.json', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed project-level hooks');
        }
      } catch (err) {
        console.error('[tackle-harness] Warning: Failed to clean up project-level hooks');
        console.error('[tackle-harness] Error: ' + err.message);
      }
    }

    // 2. Detect and clean up legacy project-level skills
    var projectSkillsDir = path.join(ctx.targetRoot, '.claude', 'skills');
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
          console.log(ctx.colorize('[tackle-harness] Removed ' + removedSkills.length + ' project-level skills (now available globally)', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed ' + removedSkills.length + ' project-level skills');

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
    var projectHooksDir = path.join(ctx.targetRoot, '.claude', 'hooks');
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
          console.log(ctx.colorize('[tackle-harness] Removed ' + removedHooks.length + ' project-level hooks (now available globally)', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed ' + removedHooks.length + ' project-level hooks');

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
    var builder = ctx.createBuilder();
    builder.injectClaudeMdRules(ctx.targetRoot);

    // 5. Print migration summary
    if (!hasLegacyStructure) {
      console.log(ctx.colorize('[tackle-harness] No legacy structure found. Project is already using global setup.', 'green'));
    } else {
      console.log('');
      console.log(ctx.colorize('[tackle-harness] === Migration Complete ===', 'cyan'));
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
    ctx.exit(0);
  },
};
