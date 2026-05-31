'use strict';

var path = require('path');
var fs = require('fs');
var readline = require('readline');

/**
 * Interactive command - Interactive plugin management (alias: i)
 * @public
 */
module.exports = {
  name: 'interactive',
  aliases: ['i'],
  description: 'Interactive plugin management (alias: i)',
  /**
   * Execute the interactive command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    var rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    // Security check: prevent modifications to global registry
    var projectRegistryPath = path.join(ctx.targetRoot, '.claude', 'plugin-registry.json');

    // Warn if trying to modify global registry from project directory
    if (ctx.targetRoot !== ctx.packageRoot && ctx.targetRoot.indexOf(path.join(ctx.packageRoot, '..')) !== 0) {
      var settingsPath = ctx.settingsPath;
      if (fs.existsSync(settingsPath)) {
        try {
          var settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
          if (settings.globalRegistry || settings.hooks && settings.hooks.global) {
            console.warn(ctx.colorize('[tackle-harness] Warning: Interactive mode should not modify global registry.', 'yellow'));
            console.warn(ctx.colorize('[tackle-harness] Use project manifest (.claude/harness-manifest.json) for project-specific overrides.', 'yellow'));
            console.warn(ctx.colorize('[tackle-harness] Global registry is managed by npm install -g tackle-harness', 'yellow'));
            console.log('');
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    }

    var registryPath = ctx.registryPath;
    var registry;

    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    } catch (e) {
      console.error(ctx.colorize('Error: Failed to read plugin registry: ' + e.message, 'red'));
      ctx.exit(1);
    }

    var plugins = registry.plugins || [];

    function showMenu() {
      console.log('');
      console.log(ctx.colorize('=== Tackle Harness - Interactive Mode ===', 'cyan'));
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
      console.log(ctx.colorize('--- 插件列表 (Plugin List) ---', 'cyan'));
      console.log('');

      var byType = {
        skill: [],
        hook: [],
        validator: [],
        provider: [],
        unknown: []
      };

      for (var i = 0; i < plugins.length; i++) {
        var p = plugins[i];
        var pluginDir = path.join(ctx.packageRoot, 'plugins', 'core', p.source || p.name);
        var metaPath = path.join(pluginDir, 'plugin.json');
        var type = 'unknown';
        var description = '';

        if (fs.existsSync(metaPath)) {
          try {
            var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            type = meta.type || 'unknown';
            description = meta.description || '';
          } catch (e) {
            // use defaults
          }
        }

        var enabled = p.enabled !== false;
        var statusStr = enabled ? ctx.colorize('enabled', 'green') : ctx.colorize('disabled', 'dim');

        byType[type].push({
          name: p.name,
          status: statusStr,
          enabled: enabled,
          description: description
        });
      }

      var typeOrder = ['skill', 'hook', 'validator', 'provider'];
      for (var t = 0; t < typeOrder.length; t++) {
        var typeName = typeOrder[t];
        var typePlugins = byType[typeName];

        if (typePlugins.length > 0) {
          console.log(ctx.colorize(typeName.charAt(0).toUpperCase() + typeName.slice(1) + ' Plugins:', 'cyan'));

          var maxNameLen = 0;
          for (var j = 0; j < typePlugins.length; j++) {
            if (typePlugins[j].name.length > maxNameLen) {
              maxNameLen = typePlugins[j].name.length;
            }
          }

          for (var k = 0; k < typePlugins.length; k++) {
            var plugin = typePlugins[k];
            var namePadding = ' '.repeat(maxNameLen - plugin.name.length + 2);
            console.log('  ' + plugin.name + namePadding + '[' + plugin.status + ']');
            if (plugin.description) {
              console.log('    ' + ctx.colorize(plugin.description, 'dim'));
            }
          }
          console.log('');
        }
      }

      var enabledCount = plugins.filter(function (p) { return p.enabled !== false; }).length;
      console.log('Total: ' + plugins.length + ' plugins | Enabled: ' + ctx.colorize(enabledCount, 'green') + ', Disabled: ' + ctx.colorize(plugins.length - enabledCount, 'dim'));
    }

    function togglePlugin(pluginName) {
      var plugin = null;

      for (var i = 0; i < plugins.length; i++) {
        if (plugins[i].name.toLowerCase() === pluginName.toLowerCase()) {
          plugin = plugins[i];
          break;
        }
      }

      if (!plugin) {
        console.log('');
        console.log(ctx.colorize('Error: Plugin not found: ' + pluginName, 'red'));
        return;
      }

      var newEnabled = plugin.enabled === false;

      try {
        var ManifestResolver = require('../../plugins/runtime/manifest-resolver');
        var success = ManifestResolver.updatePluginInManifest(ctx.packageRoot, ctx.targetRoot, plugin.name, newEnabled);

        if (!success) {
          console.log('');
          console.error(ctx.colorize('Error: Failed to update plugin manifest', 'red'));
          return;
        }

        // Update in-memory registry for display
        plugin.enabled = newEnabled;

        console.log('');
        console.log(ctx.colorize('Plugin "' + plugin.name + '" is now ' + (newEnabled ? 'enabled' : 'disabled'), 'green'));
        console.log(ctx.colorize('(Updated project manifest: .claude/harness-manifest.json)', 'dim'));

        rl.question(ctx.colorize('是否重新构建? (y/N): ', 'yellow'), function (answer) {
          if (answer && answer.toLowerCase() === 'y') {
            console.log('');
            console.log(ctx.colorize('[tackle-harness] Rebuilding plugins...', 'cyan'));
            var builder = ctx.createBuilder();
            var result = builder.build();

            if (result.success) {
              if (ctx.flags.verbose) {
                console.log(ctx.colorize('[tackle-harness] Updating settings.json...', 'dim'));
              }
              builder.updateSettings(ctx.targetRoot, ctx.packageRoot);
              builder.injectClaudeMdRules(ctx.targetRoot);
            }

            var coloredSummary = result.summary
              .replace(/Build SUCCEEDED/g, ctx.colorize('Build SUCCEEDED', 'green'))
              .replace(/Build COMPLETED WITH ERRORS/g, ctx.colorize('Build COMPLETED WITH ERRORS', 'yellow'))
              .replace(/Validation PASSED/g, ctx.colorize('Validation PASSED', 'green'))
              .replace(/Validation FAILED/g, ctx.colorize('Validation FAILED', 'red'));

            console.log(coloredSummary);
          }
          showMenu();
          prompt();
        });
      } catch (e) {
        console.log('');
        console.error(ctx.colorize('Error: Failed to update manifest: ' + e.message, 'red'));
      }
    }

    function viewDetails(pluginName) {
      var plugin = null;

      for (var i = 0; i < plugins.length; i++) {
        if (plugins[i].name.toLowerCase() === pluginName.toLowerCase()) {
          plugin = plugins[i];
          break;
        }
      }

      if (!plugin) {
        console.log('');
        console.log(ctx.colorize('Error: Plugin not found: ' + pluginName, 'red'));
        return;
      }

      console.log('');
      console.log(ctx.colorize('--- Plugin Details: ' + plugin.name + ' ---', 'cyan'));
      console.log('');
      console.log('Name:    ' + plugin.name);
      console.log('Source:  ' + (plugin.source || '-'));
      console.log('Status:  ' + (plugin.enabled !== false ? ctx.colorize('enabled', 'green') : ctx.colorize('disabled', 'dim')));

      var pluginDir = path.join(ctx.packageRoot, 'plugins', 'core', plugin.source || plugin.name);
      var metaPath = path.join(pluginDir, 'plugin.json');

      if (fs.existsSync(metaPath)) {
        try {
          var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

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
            for (var i = 0; i < meta.dependencies.length; i++) {
              console.log('  - ' + meta.dependencies[i]);
            }
          }
          if (plugin.config && Object.keys(plugin.config).length > 0) {
            console.log('');
            console.log('Configuration:');
            for (var key in plugin.config) {
              if (plugin.config.hasOwnProperty(key)) {
                var value = plugin.config[key];
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
          console.log(ctx.colorize('Warning: Failed to parse plugin metadata', 'yellow'));
        }
      }
    }

    function rebuild() {
      console.log('');
      console.log(ctx.colorize('[tackle-harness] Rebuilding plugins...', 'cyan'));

      var builder = ctx.createBuilder();
      var result = builder.build();

      if (result.success) {
        if (ctx.flags.verbose) {
          console.log(ctx.colorize('[tackle-harness] Updating settings.json...', 'dim'));
        }
        builder.updateSettings(ctx.targetRoot, ctx.packageRoot);
        builder.injectClaudeMdRules(ctx.targetRoot);
      }

      var coloredSummary = result.summary
        .replace(/Build SUCCEEDED/g, ctx.colorize('Build SUCCEEDED', 'green'))
        .replace(/Build COMPLETED WITH ERRORS/g, ctx.colorize('Build COMPLETED WITH ERRORS', 'yellow'))
        .replace(/Validation PASSED/g, ctx.colorize('Validation PASSED', 'green'))
        .replace(/Validation FAILED/g, ctx.colorize('Validation FAILED', 'red'));

      console.log(coloredSummary);

      if (result.success) {
        console.log(ctx.colorize('[tackle-harness] Done!', 'green'));
      }
    }

    function prompt() {
      rl.question(ctx.colorize('选择操作 (Enter choice): ', 'cyan'), function (answer) {
        var cmd = answer.trim().toLowerCase();

        if (!cmd || cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
          console.log('');
          console.log(ctx.colorize('Goodbye!', 'green'));
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
          rl.question(ctx.colorize('输入插件名称 (Enter plugin name): ', 'yellow'), function (name) {
            togglePlugin(name.trim());
          });
        } else if (cmd === 'v' || cmd === 'view') {
          rl.question(ctx.colorize('输入插件名称 (Enter plugin name): ', 'yellow'), function (name) {
            viewDetails(name.trim());
            showMenu();
            prompt();
          });
        } else {
          console.log('');
          console.log(ctx.colorize('Unknown command: ' + cmd, 'red'));
          showMenu();
          prompt();
        }
      });
    }

    showMenu();
    prompt();
  },
};
