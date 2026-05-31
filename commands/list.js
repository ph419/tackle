'use strict';

var path = require('path');
var fs = require('fs');

/**
 * List command - List all registered plugins
 * @public
 */
module.exports = {
  name: 'list',
  description: 'List all registered plugins',
  /**
   * Execute the list command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    console.log(ctx.colorize('=== Registered Plugins ===', 'cyan'));
    console.log('');

    var registry = ctx.createBuilder()._readRegistry();
    var plugins = registry.plugins || [];

    if (plugins.length === 0) {
      console.log('No plugins registered.');
      ctx.exit(0);
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
      var pluginDir = path.join(ctx.packageRoot, 'plugins', 'core', p.source || p.name);
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

      var status = p.enabled === false ? ctx.colorize('disabled', 'dim') : ctx.colorize('enabled', 'green');

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
        console.log(ctx.colorize(typeName.charAt(0).toUpperCase() + typeName.slice(1) + ' Plugins:', 'cyan'));
        console.log('');

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
      console.log(ctx.colorize('Unknown Plugins:', 'yellow'));
      console.log('');
      for (var u = 0; u < byType.unknown.length; u++) {
        console.log('  ' + byType.unknown[u].name);
      }
      console.log('');
    }

    // Summary
    console.log('Total: ' + plugins.length + ' plugins');
    var enabledCount = plugins.filter(function (p) { return p.enabled !== false; }).length;
    console.log('Enabled: ' + ctx.colorize(enabledCount, 'green') + ', Disabled: ' + ctx.colorize(plugins.length - enabledCount, 'dim'));

    ctx.exit(0);
  },
};
