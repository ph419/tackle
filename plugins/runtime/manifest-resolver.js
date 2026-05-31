/**
 * ManifestResolver - Project-level plugin selection system
 *
 * Manages project-specific plugin overrides via .claude/harness-manifest.json.
 * Projects can override the global plugin-registry.json enabled status,
 * and also register external plugins not present in the global registry.
 *
 * Rules:
 * - Manifest only records overrides (plugins where project != global)
 * - Unlisted plugins use global registry defaults
 * - New plugins appear automatically unless explicitly disabled
 * - External plugins (not in global registry) can be declared via manifest
 *   with sourceType and source fields for path resolution
 *
 * Manifest format:
 * {
 *   "version": "1.0.0",
 *   "tackleHarnessVersion": "0.0.19",
 *   "plugins": {
 *     "skill-task-creator": { "enabled": true },
 *     "hook-skill-gate": { "enabled": false },
 *     "my-external-plugin": {
 *       "enabled": true,
 *       "sourceType": "npm",
 *       "source": "tackle-plugin-my-external"
 *     }
 *   }
 * }
 */

'use strict';

var fs = require('fs');
var path = require('path');

// Default manifest version
var MANIFEST_VERSION = '1.0.0';

// Read package.json for version
var packageJsonPath = path.resolve(__dirname, '../../package.json');
var TACKLE_HARNESS_VERSION = '0.0.19';
try {
  var pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  TACKLE_HARNESS_VERSION = pkg.version || TACKLE_HARNESS_VERSION;
} catch (e) {
  // Use default version
}

/**
 * Read the global plugin registry.
 * @public
 * @param {string} packageRoot - Root directory of tackle-harness package
 * @returns {object} Parsed registry object
 */
function readGlobalRegistry(packageRoot) {
  var registryPath = path.join(packageRoot, 'plugins', 'plugin-registry.json');

  if (!fs.existsSync(registryPath)) {
    return { version: '1.0.0', plugins: [] };
  }

  try {
    var content = fs.readFileSync(registryPath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return { version: '1.0.0', plugins: [] };
  }
}

/**
 * Read the project manifest file.
 * @public
 * @param {string} targetRoot - Target project root directory
 * @returns {object|null} Parsed manifest object or null if not exists
 */
function readProjectManifest(targetRoot) {
  var manifestPath = path.join(targetRoot, '.claude', 'harness-manifest.json');

  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    var content = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    // Invalid manifest, treat as missing
    return null;
  }
}

/**
 * Resolve effective plugin list by merging global registry with project manifest.
 * Project manifest overrides take precedence.
 *
 * @public
 * @param {string} packageRoot - Root directory of tackle-harness package
 * @param {string} targetRoot - Target project root directory
 * @returns {object} Registry object with merged plugin states
 */
function resolveEffectivePlugins(packageRoot, targetRoot) {
  var globalRegistry = readGlobalRegistry(packageRoot);
  var projectManifest = readProjectManifest(targetRoot);

  // If no manifest, return global registry as-is (backward compatibility)
  if (!projectManifest || !projectManifest.plugins) {
    return globalRegistry;
  }

  // Create a copy of global plugins
  var mergedPlugins = [];
  var globalPlugins = globalRegistry.plugins || [];

  // Build map of global plugins by name for quick lookup
  var globalMap = {};
  for (var i = 0; i < globalPlugins.length; i++) {
    var p = globalPlugins[i];
    globalMap[p.name] = p;
  }

  // Process all global plugins with manifest overrides
  for (var j = 0; j < globalPlugins.length; j++) {
    var globalPlugin = globalPlugins[j];
    var pluginName = globalPlugin.name;

    // Create merged entry (start with global)
    var merged = {
      name: globalPlugin.name,
      source: globalPlugin.source,
      sourceType: globalPlugin.sourceType || 'core',
      enabled: globalPlugin.enabled,
      config: globalPlugin.config || {}
    };

    // Apply manifest override if exists
    if (projectManifest.plugins[pluginName]) {
      var override = projectManifest.plugins[pluginName];
      if (typeof override.enabled === 'boolean') {
        merged.enabled = override.enabled;
      }
      if (override.config) {
        merged.config = override.config;
      }
    }

    mergedPlugins.push(merged);
  }

  // Note: New plugins in global registry will appear automatically
  // because we iterate over all globalPlugins above.
  // Only explicitly disabled plugins in manifest are overridden.

  // Merge external plugins from manifest (plugins not in global registry)
  var manifestPluginNames = Object.keys(projectManifest.plugins);
  for (var k = 0; k < manifestPluginNames.length; k++) {
    var externalName = manifestPluginNames[k];

    // Skip if already in global registry (already merged above)
    if (globalMap[externalName]) {
      continue;
    }

    var externalEntry = projectManifest.plugins[externalName];

    // Build a complete plugin entry for the external plugin
    var externalPlugin = {
      name: externalName,
      source: externalEntry.source || externalName,
      sourceType: externalEntry.sourceType || 'local',
      enabled: externalEntry.enabled !== false,
      config: externalEntry.config || {}
    };

    mergedPlugins.push(externalPlugin);
  }

  return {
    version: globalRegistry.version,
    plugins: mergedPlugins
  };
}

/**
 * Write a project manifest file.
 * @public
 * @param {string} targetRoot - Target project root directory
 * @param {object} manifest - Manifest object to write
 * @returns {boolean} Success status
 */
function writeProjectManifest(targetRoot, manifest) {
  var claudeDir = path.join(targetRoot, '.claude');
  var manifestPath = path.join(claudeDir, 'harness-manifest.json');

  try {
    // Ensure .claude directory exists
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Write manifest with proper formatting
    manifest.version = manifest.version || MANIFEST_VERSION;
    manifest.tackleHarnessVersion = manifest.tackleHarnessVersion || TACKLE_HARNESS_VERSION;

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Create a default manifest from the global registry.
 * Only includes plugins that differ from global defaults (for now, all enabled).
 *
 * @public
 * @param {string} packageRoot - Root directory of tackle-harness package
 * @returns {object} Default manifest object
 */
function createDefaultManifest(packageRoot) {
  var globalRegistry = readGlobalRegistry(packageRoot);
  var plugins = globalRegistry.plugins || [];

  var manifestPlugins = {};

  // By default, all plugins are enabled (inherit global state)
  // Only record if we want to override (for now, record all for clarity)
  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    manifestPlugins[p.name] = {
      enabled: (p.enabled !== false)
    };
  }

  return {
    version: MANIFEST_VERSION,
    tackleHarnessVersion: TACKLE_HARNESS_VERSION,
    plugins: manifestPlugins
  };
}

/**
 * Update a single plugin's enabled status in the project manifest.
 * Creates or updates manifest as needed.
 *
 * @public
 * @param {string} packageRoot - Root directory of tackle-harness package
 * @param {string} targetRoot - Target project root directory
 * @param {string} pluginName - Name of the plugin to update
 * @param {boolean} enabled - New enabled status
 * @returns {boolean} Success status
 */
function updatePluginInManifest(packageRoot, targetRoot, pluginName, enabled) {
  var manifest = readProjectManifest(targetRoot);

  // If no manifest exists, create default first
  if (!manifest) {
    manifest = createDefaultManifest(packageRoot);
  }

  // Ensure plugins object exists
  if (!manifest.plugins) {
    manifest.plugins = {};
  }

  // Get global default for this plugin
  var globalRegistry = readGlobalRegistry(packageRoot);
  var globalPlugins = globalRegistry.plugins || [];
  var globalPlugin = null;
  for (var i = 0; i < globalPlugins.length; i++) {
    if (globalPlugins[i].name === pluginName) {
      globalPlugin = globalPlugins[i];
      break;
    }
  }

  // If plugin not found in global registry, it may be an external plugin.
  // Allow registering external plugins in the manifest.
  if (!globalPlugin) {
    // External plugin: ensure the entry exists in manifest with required fields
    if (!manifest.plugins[pluginName]) {
      manifest.plugins[pluginName] = { enabled: enabled };
    } else {
      manifest.plugins[pluginName].enabled = enabled;
    }
    // Update version
    manifest.tackleHarnessVersion = TACKLE_HARNESS_VERSION;
    return writeProjectManifest(targetRoot, manifest);
  }

  var globalDefault = (globalPlugin.enabled !== false);

  // If new status matches global default, remove from manifest (use default)
  if (enabled === globalDefault) {
    delete manifest.plugins[pluginName];
  } else {
    // Override global default
    manifest.plugins[pluginName] = { enabled: enabled };
  }

  // Update version
  manifest.tackleHarnessVersion = TACKLE_HARNESS_VERSION;

  return writeProjectManifest(targetRoot, manifest);
}

/**
 * Register an external plugin in the project manifest.
 * This is the primary API for `tackle install` to add external plugins.
 *
 * If the plugin is already registered, its entry is updated.
 * If the plugin exists in the global registry, this still works but
 * log a note that it is overriding a core plugin.
 *
 * @public
 * @param {string} packageRoot - Root directory of tackle-harness package
 * @param {string} targetRoot - Target project root directory
 * @param {string} pluginName - Name of the external plugin
 * @param {object} options - Plugin registration options
 * @param {string} [options.sourceType='local'] - Source type: 'npm' or 'local'
 * @param {string} [options.source] - Source identifier (npm package name or path)
 * @param {boolean} [options.enabled=true] - Initial enabled status
 * @param {object} [options.config={}] - Plugin configuration
 * @returns {boolean} Success status
 */
function registerExternalPlugin(packageRoot, targetRoot, pluginName, options) {
  options = options || {};

  var manifest = readProjectManifest(targetRoot);

  // If no manifest exists, create default first
  if (!manifest) {
    manifest = createDefaultManifest(packageRoot);
  }

  // Ensure plugins object exists
  if (!manifest.plugins) {
    manifest.plugins = {};
  }

  // Build the manifest entry
  manifest.plugins[pluginName] = {
    enabled: options.enabled !== false,
    sourceType: options.sourceType || 'local',
    source: options.source || pluginName,
    config: options.config || {}
  };

  // Update version
  manifest.tackleHarnessVersion = TACKLE_HARNESS_VERSION;

  return writeProjectManifest(targetRoot, manifest);
}

/**
 * Unregister an external plugin from the project manifest.
 * Only removes plugins that are not in the global registry.
 * Core plugins can be disabled but not removed via this API.
 *
 * @public
 * @param {string} packageRoot - Root directory of tackle-harness package
 * @param {string} targetRoot - Target project root directory
 * @param {string} pluginName - Name of the plugin to unregister
 * @returns {boolean} Success status (false if plugin is a core plugin or not found)
 */
function unregisterExternalPlugin(packageRoot, targetRoot, pluginName) {
  var manifest = readProjectManifest(targetRoot);
  if (!manifest || !manifest.plugins || !manifest.plugins[pluginName]) {
    return false;
  }

  // Check if this is a core plugin (exists in global registry)
  var globalRegistry = readGlobalRegistry(packageRoot);
  var globalPlugins = globalRegistry.plugins || [];
  var isCore = false;
  for (var i = 0; i < globalPlugins.length; i++) {
    if (globalPlugins[i].name === pluginName) {
      isCore = true;
      break;
    }
  }

  if (isCore) {
    // Core plugins can only be disabled, not removed
    return false;
  }

  delete manifest.plugins[pluginName];
  manifest.tackleHarnessVersion = TACKLE_HARNESS_VERSION;

  return writeProjectManifest(targetRoot, manifest);
}

/**
 * List all external plugins in the project manifest
 * (plugins that are NOT in the global registry).
 *
 * @public
 * @param {string} packageRoot - Root directory of tackle-harness package
 * @param {string} targetRoot - Target project root directory
 * @returns {object[]} Array of external plugin entries with name, sourceType, source, enabled, config
 */
function listExternalPlugins(packageRoot, targetRoot) {
  var manifest = readProjectManifest(targetRoot);
  if (!manifest || !manifest.plugins) {
    return [];
  }

  var globalRegistry = readGlobalRegistry(packageRoot);
  var globalPlugins = globalRegistry.plugins || [];
  var globalNames = {};
  for (var i = 0; i < globalPlugins.length; i++) {
    globalNames[globalPlugins[i].name] = true;
  }

  var externalPlugins = [];
  var names = Object.keys(manifest.plugins);
  for (var j = 0; j < names.length; j++) {
    var name = names[j];
    if (!globalNames[name]) {
      var entry = manifest.plugins[name];
      externalPlugins.push({
        name: name,
        sourceType: entry.sourceType || 'local',
        source: entry.source || name,
        enabled: entry.enabled !== false,
        config: entry.config || {}
      });
    }
  }

  return externalPlugins;
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  readGlobalRegistry: readGlobalRegistry,
  readProjectManifest: readProjectManifest,
  resolveEffectivePlugins: resolveEffectivePlugins,
  writeProjectManifest: writeProjectManifest,
  createDefaultManifest: createDefaultManifest,
  updatePluginInManifest: updatePluginInManifest,
  registerExternalPlugin: registerExternalPlugin,
  unregisterExternalPlugin: unregisterExternalPlugin,
  listExternalPlugins: listExternalPlugins
};
