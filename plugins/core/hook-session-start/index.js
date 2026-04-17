/**
 * Hook: Session Start
 *
 * SessionStart hook that injects tackle-harness rules into Claude Code's
 * system-reminder context via hookSpecificOutput.additionalContext.
 *
 * This ensures plan-mode rules appear at the same priority level as
 * superpowers skills, rather than relying on CLAUDE.md static files.
 *
 * Usage (CLI):
 *   node plugins/core/hook-session-start/index.js
 *
 * Output: JSON with hookSpecificOutput.additionalContext containing
 * plan-mode priority rules for task-creation skills.
 */

'use strict';

var fs = require('fs');
var path = require('path');

/**
 * Walk up from a directory to find the project root (contains .claude/ or plugins/).
 * @param {string} [startDir]
 * @returns {string}
 */
function resolveProjectRoot(startDir) {
  var dir = startDir || __dirname;
  for (var i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.claude'))) return dir;
    if (fs.existsSync(path.join(dir, 'plugins'))) return dir;
    var parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Read plugin-registry.json and find skills with plan_mode_required.
 * @param {string} projectRoot
 * @returns {string[]} skill names
 */
function findPlanModeSkills(projectRoot) {
  var registryPath = path.join(projectRoot, 'plugins', 'plugin-registry.json');
  var planModeSkills = [];

  try {
    var content = fs.readFileSync(registryPath, 'utf-8');
    var registry = JSON.parse(content);
    var plugins = registry.plugins || [];

    for (var i = 0; i < plugins.length; i++) {
      var entry = plugins[i];
      if (!entry.source) continue;

      var pluginDir = path.join(projectRoot, 'plugins', 'core', entry.source);
      var pluginJsonPath = path.join(pluginDir, 'plugin.json');

      try {
        var meta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
        if (meta.type !== 'skill') continue;

        var hasPlanMode = false;

        // Check plugin.json config
        if (meta.config && meta.config.plan_mode_required) {
          hasPlanMode = true;
        }

        // Fallback: check skill.md front-matter
        if (!hasPlanMode) {
          var skillMdPath = path.join(pluginDir, 'skill.md');
          if (fs.existsSync(skillMdPath)) {
            var skillContent = fs.readFileSync(skillMdPath, 'utf-8');
            if (/^---[\s\S]*?plan_mode_required:\s*true[\s\S]*?---/.test(skillContent)) {
              hasPlanMode = true;
            }
          }
        }

        if (hasPlanMode) {
          planModeSkills.push(meta.name || entry.name);
        }
      } catch (e) {
        // skip unparseable
      }
    }
  } catch (e) {
    // registry may not exist
  }

  return planModeSkills;
}

/**
 * Build the additionalContext string for SessionStart hook output.
 * @param {string} projectRoot
 * @returns {string}
 */
function buildContext(projectRoot) {
  var planModeSkills = findPlanModeSkills(projectRoot);

  if (planModeSkills.length === 0) return '';

  var lines = [];
  lines.push('Tackle Harness Plan Mode 规则已激活。');
  lines.push('');
  lines.push('当以下 skill 被触发时，必须直接调用 EnterPlanMode 进入 Plan 模式，不得先执行 brainstorming 或其他分析工作：');

  for (var i = 0; i < planModeSkills.length; i++) {
    lines.push('- ' + planModeSkills[i]);
  }

  lines.push('');
  lines.push('这些 skill 已标注 plan_mode_required: true，优先级高于 superpowers:brainstorming。收到匹配请求时，跳过 brainstorming 检查，立即进入 Plan 模式。');

  return lines.join('\n');
}

/**
 * Escape a string for safe embedding in a JSON string value.
 * @param {string} s
 * @returns {string}
 */
function escapeForJson(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// --- Main ---
(function main() {
  // Only run main if executed directly (not required as a module)
  if (require.main === module) {
    var root = resolveProjectRoot();
    var context = buildContext(root);

    if (!context) {
      // No plan-mode skills found, output empty context
      process.stdout.write('{}\n');
      process.exit(0);
    }

    var escaped = escapeForJson(context);

    // Claude Code SessionStart hook output format
    var output = '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "' + escaped + '"\n  }\n}\n';

    process.stdout.write(output);
    process.exit(0);
  }
})();

// Export a no-op class for PluginLoader compatibility
class SessionStartHook {
  constructor() {
    this.name = 'hook-session-start';
    this.version = '1.0.0';
    this.description = 'SessionStart hook for plan-mode rules';
    this.type = 'hook';
  }

  async onActivate(context) {
    // No-op - this hook is CLI-only
  }

  async handle(context) {
    return { allowed: true };
  }
}

module.exports = SessionStartHook;
