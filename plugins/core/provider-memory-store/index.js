/**
 * Provider: Memory Store
 *
 * Wraps the agents/memories/ directory to provide role memory data access.
 * Implements the ProviderPlugin interface from plugin-interface.js.
 *
 * Capabilities:
 *   - getByRole(roleName)   return memory data for a specific role
 *   - setByRole(roleName, data)  write/update memory data for a role
 *   - list()                list all available memory entries
 *   - getByPath(filePath)   read a specific memory file by relative path
 */

'use strict';

var path = require('path');
var fs = require('fs');
var { ProviderPlugin } = require('../../contracts/plugin-interface');

/**
 * MemoryStoreProvider - provides memory data access
 */
class MemoryStoreProvider extends ProviderPlugin {
  constructor() {
    super();
    this.name = 'provider-memory-store';
    this.version = '1.0.0';
    this.description = 'Memory Store Provider';
    this.provides = 'provider:memory-store';
    this.dependencies = {};

    /** @type {string} absolute path to memories directory */
    this._memoriesDir = '';
    /** @type {Map<string, object>} cache of loaded memories */
    this._cache = new Map();
  }

  /**
   * Activate - set up the memories directory path.
   * @param {PluginContext} context
   */
  async onActivate(context) {
    var projectRoot = this._resolveProjectRoot();
    this._memoriesDir = path.join(projectRoot, '.claude', 'agents', 'memories');

    // Ensure the directory exists
    if (!fs.existsSync(this._memoriesDir)) {
      fs.mkdirSync(this._memoriesDir, { recursive: true });
    }
  }

  /**
   * Factory - return the provider API.
   * @param {PluginContext} context
   * @returns {Promise<object>}
   */
  async factory(context) {
    var self = this;

    return {
      /**
       * Get memory data for a specific role.
       * Looks for {roleName}.md in the memories directory.
       *
       * @param {string} roleName - role identifier (e.g. 'coordinator')
       * @returns {Promise<{ roleName: string, content: string, filePath: string, exists: boolean }>}
       */
      getByRole: function (roleName) {
        return self._getByRole(roleName);
      },

      /**
       * Write memory data for a specific role.
       * Creates or overwrites the memory file for the role.
       *
       * @param {string} roleName
       * @param {string|object} data - memory content (string) or structured data to serialize
       * @returns {Promise<{ roleName: string, filePath: string, written: boolean }>}
       */
      setByRole: function (roleName, data) {
        return self._setByRole(roleName, data);
      },

      /**
       * List all available memory entries.
       * @returns {Promise<{ name: string, roleName: string, filePath: string, size: number, modified: string }[]>}
       */
      list: function () {
        return self._list();
      },

      /**
       * Read a memory file by its relative path within the memories directory.
       * @param {string} relPath - relative path (e.g. 'coordinator.md')
       * @returns {Promise<{ content: string, filePath: string, exists: boolean }>}
       */
      getByPath: function (relPath) {
        return self._getByPath(relPath);
      },
    };
  }

  /**
   * Get memory data for a role.
   * @param {string} roleName
   * @returns {Promise<object>}
   */
  async _getByRole(roleName) {
    // Sanitize roleName to prevent path traversal
    var safeName = roleName.replace(/[^a-zA-Z0-9_\-]/g, '');
    var fileName = safeName + '.md';
    var filePath = path.join(this._memoriesDir, fileName);

    // Check cache first
    if (this._cache.has(safeName)) {
      var cached = this._cache.get(safeName);
      return {
        roleName: safeName,
        content: cached.content,
        filePath: filePath,
        exists: true,
        metadata: cached.metadata,
      };
    }

    try {
      var content = fs.readFileSync(filePath, 'utf-8');
      var metadata = this._parseMemoryMetadata(content);

      // Cache the result
      this._cache.set(safeName, { content: content, metadata: metadata });

      return {
        roleName: safeName,
        content: content,
        filePath: filePath,
        exists: true,
        metadata: metadata,
      };
    } catch (err) {
      return {
        roleName: safeName,
        content: '',
        filePath: filePath,
        exists: false,
        metadata: {},
      };
    }
  }

  /**
   * Write memory data for a role.
   * @param {string} roleName
   * @param {string|object} data
   * @returns {Promise<object>}
   */
  async _setByRole(roleName, data) {
    var safeName = roleName.replace(/[^a-zA-Z0-9_\-]/g, '');
    var fileName = safeName + '.md';
    var filePath = path.join(this._memoriesDir, fileName);

    var content;
    if (typeof data === 'string') {
      content = data;
    } else if (typeof data === 'object' && data !== null) {
      // Serialize structured data to markdown-like format
      content = this._serializeMemory(safeName, data);
    } else {
      content = String(data);
    }

    // Ensure directory exists
    var dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, 'utf-8');

    // Update cache
    var metadata = this._parseMemoryMetadata(content);
    this._cache.set(safeName, { content: content, metadata: metadata });

    return {
      roleName: safeName,
      filePath: filePath,
      written: true,
    };
  }

  /**
   * List all memory files.
   * @returns {Promise<object[]>}
   */
  async _list() {
    var results = [];

    try {
      var files = fs.readdirSync(this._memoriesDir);
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (!file.match(/\.(md|yaml|yml|json)$/)) continue;

        var fullPath = path.join(this._memoriesDir, file);
        try {
          var stat = fs.statSync(fullPath);
          var roleName = file.replace(/\.[^/.]+$/, '');

          results.push({
            name: file,
            roleName: roleName,
            filePath: fullPath,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        } catch (statErr) {
          // Skip files that can't be stat'd
        }
      }
    } catch (err) {
      // Directory doesn't exist or can't be read
    }

    return results;
  }

  /**
   * Read a memory file by relative path.
   * @param {string} relPath
   * @returns {Promise<object>}
   */
  async _getByPath(relPath) {
    // Sanitize to prevent path traversal
    var safePath = relPath.replace(/\.\./g, '').replace(/[\\]/g, '/');
    var filePath = path.join(this._memoriesDir, safePath);

    // Ensure the resolved path is still within the memories directory
    if (!filePath.startsWith(this._memoriesDir)) {
      return { content: '', filePath: safePath, exists: false };
    }

    try {
      var content = fs.readFileSync(filePath, 'utf-8');
      return { content: content, filePath: filePath, exists: true };
    } catch (err) {
      return { content: '', filePath: safePath, exists: false };
    }
  }

  /**
   * Parse metadata from a memory markdown file.
   * Extracts role name, creation date, usage, and experience count.
   * @param {string} content
   * @returns {object}
   */
  _parseMemoryMetadata(content) {
    var metadata = {};
    var lines = content.split('\n');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Role name from heading
      var headingMatch = line.match(/^#\s+(.+)角色记忆库/);
      if (headingMatch) {
        metadata.roleTitle = headingMatch[1].trim();
        continue;
      }

      // Role from metadata line
      var roleMatch = line.match(/^>\s*角色:\s*(.+)/);
      if (roleMatch) {
        metadata.role = roleMatch[1].trim();
        continue;
      }

      // Creation date
      var dateMatch = line.match(/^>\s*创建日期:\s*(.+)/);
      if (dateMatch) {
        metadata.createdDate = dateMatch[1].trim();
        continue;
      }

      // Usage
      var usageMatch = line.match(/^>\s*用途:\s*(.+)/);
      if (usageMatch) {
        metadata.usage = usageMatch[1].trim();
        continue;
      }

      // Experience count
      var expMatch = line.match(/^-?\s*总经验数:\s*(\d+)/);
      if (expMatch) {
        metadata.experienceCount = parseInt(expMatch[1], 10);
        continue;
      }

      // Last update
      var updateMatch = line.match(/^-?\s*最后更新:\s*(.+)/);
      if (updateMatch) {
        metadata.lastUpdate = updateMatch[1].trim();
        continue;
      }

      // Total tasks
      var taskMatch = line.match(/^-?\s*累计执行任务:\s*(\d+)/);
      if (taskMatch) {
        metadata.totalTasks = parseInt(taskMatch[1], 10);
        continue;
      }
    }

    return metadata;
  }

  /**
   * Serialize structured data to a memory markdown file.
   * @param {string} roleName
   * @param {object} data
   * @returns {string}
   */
  _serializeMemory(roleName, data) {
    var lines = [];
    var title = data.title || roleName;
    var role = data.role || roleName;
    var createdDate = data.createdDate || new Date().toISOString().split('T')[0];
    var usage = data.usage || '';
    var experienceCount = data.experienceCount || 0;
    var lastUpdate = data.lastUpdate || createdDate;
    var totalTasks = data.totalTasks || 0;
    var experiences = data.experiences || [];
    var notes = data.notes || '';

    lines.push('# ' + title + '角色记忆库');
    lines.push('');
    lines.push('> 角色: ' + role);
    lines.push('> 创建日期: ' + createdDate);
    lines.push('> 用途: ' + usage);
    lines.push('');
    lines.push('## 统计');
    lines.push('');
    lines.push('- 总经验数: ' + experienceCount);
    lines.push('- 最后更新: ' + lastUpdate);
    lines.push('- 累计执行任务: ' + totalTasks + ' 次');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 经验列表');
    lines.push('');

    if (experiences.length > 0) {
      for (var i = 0; i < experiences.length; i++) {
        var exp = experiences[i];
        lines.push('### [' + (exp.tag || '') + '] ' + (exp.title || ''));
        lines.push('');
        if (exp.description) {
          lines.push('**问题描述**: ' + exp.description);
          lines.push('');
        }
        if (exp.solution) {
          lines.push('**解决方案**: ' + exp.solution);
          lines.push('');
        }
        if (exp.source) {
          lines.push('**来源工作包**: ' + exp.source);
        }
        if (exp.date) {
          lines.push('**记录日期**: ' + exp.date);
        }
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
    lines.push('## 注意事项');
    lines.push('');

    if (notes) {
      lines.push(notes);
    }

    return lines.join('\n');
  }

  /**
   * Resolve the project root directory.
   * @returns {string}
   */
  _resolveProjectRoot() {
    var dir = process.cwd();
    for (var i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, 'task.md'))) return dir;
      if (fs.existsSync(path.join(dir, '.claude'))) return dir;
      var parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }
}

module.exports = MemoryStoreProvider;
