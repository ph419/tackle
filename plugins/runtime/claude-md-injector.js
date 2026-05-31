/**
 * claude-md-injector - Inject tackle-harness rules into CLAUDE.md
 *
 * Scans all skill plugins for plan_mode_required declarations and injects
 * Plan Mode priority rules into the target project's CLAUDE.md file.
 * Supports idempotent updates using marker-based block replacement.
 *
 * @module claude-md-injector
 */

'use strict';

var fs = require('fs');
var path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Block marker for tackle-harness managed rules in CLAUDE.md.
 * @type {string}
 */
var CLAUDE_MD_MARKER = '<!-- tackle-harness -->';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the rule block content for CLAUDE.md injection.
 * Scans plugin entries for plan_mode_required skills.
 *
 * @public
 * @param {object[]} pluginEntries - enabled plugin entries from registry
 * @param {Function} resolvePluginDir - function(entry) => string, resolves plugin directory
 * @returns {string} rule block content (empty string if no plan_mode_required skills)
 */
function buildRuleBlock(pluginEntries, resolvePluginDir) {
  var planModeSkills = [];

  for (var i = 0; i < pluginEntries.length; i++) {
    var entry = pluginEntries[i];
    var pluginDir = resolvePluginDir(entry);
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
}

/**
 * Inject tackle-harness managed rules into the target project's CLAUDE.md.
 * Idempotent: replaces existing marked block if present, appends if not.
 * Creates CLAUDE.md if it does not exist.
 *
 * @public
 * @param {object} options
 * @param {string} options.targetRoot - target project root directory
 * @param {object[]} options.pluginEntries - enabled plugin entries
 * @param {Function} options.resolvePluginDir - plugin directory resolver function
 * @param {Function} [options.log] - logging function(level, message)
 */
function injectClaudeMdRules(options) {
  var targetRoot = options.targetRoot;
  var pluginEntries = options.pluginEntries;
  var resolvePluginDir = options.resolvePluginDir;
  var log = options.log || function () {};

  var ruleBlock = buildRuleBlock(pluginEntries, resolvePluginDir);
  if (!ruleBlock) {
    log('info', 'No plan_mode_required skills found, skipping CLAUDE.md injection.');
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
        log('info', 'CLAUDE.md rules up-to-date, no changes needed.');
        return;
      }
      // Replace existing block
      content = content.substring(0, startIdx) + ruleBlock + content.substring(endIdx + CLAUDE_MD_MARKER.length);
      fs.writeFileSync(claudeMdPath, content, 'utf-8');
      log('info', 'CLAUDE.md rules updated.');
      return;
    }
  }

  // Append new block
  var separator = content.length > 0 && !content.endsWith('\n') ? '\n\n' : '\n';
  fs.writeFileSync(claudeMdPath, content + separator + ruleBlock + '\n', 'utf-8');
  log('info', 'CLAUDE.md rules injected.');
}

module.exports = {
  buildRuleBlock: buildRuleBlock,
  injectClaudeMdRules: injectClaudeMdRules,
  CLAUDE_MD_MARKER: CLAUDE_MD_MARKER,
};
