'use strict';

var path = require('path');
var fs = require('fs');

/**
 * Status command - Show build status and plugin statistics
 * @public
 */
module.exports = {
  name: 'status',
  description: 'Show build status and plugin statistics',
  /**
   * Execute the status command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    console.log(ctx.colorize('=== Tackle Harness Status ===', 'cyan'));
    console.log('');

    // Package version
    console.log('Version: ' + ctx.colorize(ctx.packageVersion, 'green'));
    console.log('');

    // Target and package roots
    console.log('Target project root: ' + ctx.targetRoot);
    console.log('Package root:         ' + ctx.packageRoot);
    console.log('');

    // Build status - check if .claude/skills exists
    var skillsDir = ctx.skillsDir;
    var hooksDir = ctx.hooksDir;
    var settingsPath = ctx.settingsPath;
    var configPath = ctx.configPath;

    console.log(ctx.colorize('Build Status:', 'cyan'));
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
      console.log('  ' + label + padding + (exists ? ctx.colorize('exists', 'green') : ctx.colorize('missing', 'red')));
    }
    console.log('');

    // Plugin statistics
    var builder = ctx.createBuilder();
    var registry = builder._readRegistry();
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
      var pluginDir = path.join(ctx.packageRoot, 'plugins', 'core', p.source || p.name);
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

    console.log(ctx.colorize('Plugin Statistics:', 'cyan'));
    console.log('  Total plugins:   ' + stats.total);
    console.log('  Enabled plugins: ' + ctx.colorize(stats.enabled, 'green'));
    console.log('  Disabled plugins: ' + (stats.disabled > 0 ? ctx.colorize(String(stats.disabled), 'yellow') : '0'));
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

    ctx.exit(0);
  },
};
