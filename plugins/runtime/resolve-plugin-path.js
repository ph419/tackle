/**
 * resolve-plugin-path - Shared plugin path resolution
 *
 * Centralizes the path resolution logic used by both harness-build.js
 * and plugin-loader.js. Supports absolute paths, relative paths, and
 * the default core/ subdirectory convention.
 *
 * Supports sourceType field for external plugin sources:
 *   - 'core' (default) — built-in plugins under plugins/core/
 *   - 'npm'            — npm package resolved via require.resolve()
 *   - 'local'          — absolute or relative path outside core/
 *
 * @module resolve-plugin-path
 */

'use strict';

var fs = require('fs');
var path = require('path');

var VALID_SOURCE_TYPES = ['core', 'npm', 'local'];

/**
 * Resolve the filesystem directory for a plugin entry.
 *
 * Resolution strategy by sourceType:
 *   - 'core' (default):
 *       1. If source is absolute → use directly
 *       2. If source has path separators → resolve relative to registryDir
 *       3. Otherwise → join defaultPluginsDir with source
 *   - 'npm':
 *       Resolve via require.resolve(packageName) and extract the directory.
 *       The source field is interpreted as an npm package name (with optional
 *       sub-path, e.g. 'tackle-plugin-foo/sub/path').
 *   - 'local':
 *       Absolute or relative path. Relative paths resolve against registryDir.
 *
 * @public
 * @param {object}  entry              - Plugin registry entry
 * @param {string}  entry.name         - Plugin name
 * @param {string} [entry.source]      - Source identifier (defaults to entry.name)
 * @param {string} [entry.sourceType]  - Source type: 'core' (default), 'npm', 'local'
 * @param {string}  defaultPluginsDir  - Base directory for core plugins (e.g. .../plugins/core)
 * @param {string}  registryDir        - Directory containing plugin-registry.json
 * @returns {string} resolved absolute path to the plugin directory
 * @throws {Error} if sourceType is invalid or npm package cannot be resolved
 */
function resolvePluginPath(entry, defaultPluginsDir, registryDir) {
  var source = entry.source || entry.name;
  if (!source) {
    return path.join(defaultPluginsDir, 'unknown');
  }

  var sourceType = entry.sourceType || 'core';

  // Validate sourceType
  if (VALID_SOURCE_TYPES.indexOf(sourceType) === -1) {
    throw new Error(
      'Invalid sourceType "' + sourceType + '" for plugin "' + (entry.name || 'unknown') +
      '". Valid values: ' + VALID_SOURCE_TYPES.join(', ')
    );
  }

  // npm source: resolve via require.resolve
  if (sourceType === 'npm') {
    return resolveNpmPath(source, entry.name);
  }

  // local source: absolute or relative path
  if (sourceType === 'local') {
    if (path.isAbsolute(source)) {
      return source;
    }
    return path.resolve(registryDir, source);
  }

  // core (default): existing behavior
  // Absolute path → use directly
  if (path.isAbsolute(source)) {
    return source;
  }

  // Relative path containing path separators → resolve relative to registry directory
  // (e.g. '../custom-plugins/my-plugin' or './my-plugin')
  if (source.indexOf('/') !== -1 || source.indexOf('\\') !== -1) {
    return path.resolve(registryDir, source);
  }

  // Default: core plugin → join with defaultPluginsDir
  return path.join(defaultPluginsDir, source);
}

/**
 * Resolve an npm package path using require.resolve().
 *
 * For a package like 'tackle-plugin-foo', resolves to the package root.
 * For a scoped or sub-path like '@scope/foo/sub', resolves the sub-path.
 *
 * @internal
 * @param {string} source - npm package name (with optional sub-path)
 * @param {string} [pluginName] - plugin name for error messages
 * @returns {string} resolved absolute path to the package directory
 * @throws {Error} if the package cannot be resolved
 */
function resolveNpmPath(source, pluginName) {
  try {
    // require.resolve with the package name gives us the entry point
    // (package.json "main" or index.js). Extract directory from that.
    var resolved = require.resolve(source);
    // If the resolved path ends with index.js or similar, walk up to the package root.
    // For packages that export a directory, require.resolve may return the directory itself.
    var resolvedDir = resolved;

    // Check if the resolved path is a file (has extension) — get its directory
    var basename = path.basename(resolved);
    if (basename === 'index.js' || basename === 'index.json' || basename.endsWith('.js') || basename.endsWith('.json')) {
      // Walk up to find the package root (directory containing package.json)
      resolvedDir = findPackageRoot(resolved);
    }

    return resolvedDir;
  } catch (err) {
    throw new Error(
      'Failed to resolve npm plugin "' + source + '"' +
      (pluginName ? ' (plugin: ' + pluginName + ')' : '') +
      ': ' + err.message +
      '. Ensure the package is installed (npm install ' + source + ')'
    );
  }
}

/**
 * Walk up from a resolved file path to find the package root directory.
 * The package root is the nearest ancestor directory containing package.json.
 *
 * @internal
 * @param {string} startPath - starting file or directory path
 * @returns {string} package root directory
 */
function findPackageRoot(startPath) {
  var current = path.dirname(startPath);
  var root = path.parse(current).root;

  while (current !== root) {
    var pkgJsonPath = path.join(current, 'package.json');
    try {
      if (fs.existsSync(pkgJsonPath)) {
        return current;
      }
    } catch (e) {
      // ignore
    }
    current = path.dirname(current);
  }

  // Fallback: return the directory of the resolved file
  return path.dirname(startPath);
}

module.exports = {
  resolvePluginPath: resolvePluginPath,
  resolveNpmPath: resolveNpmPath,
  VALID_SOURCE_TYPES: VALID_SOURCE_TYPES
};
