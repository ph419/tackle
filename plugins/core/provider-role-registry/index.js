/**
 * Provider: Role Registry
 *
 * Wraps role-registry.yaml and individual role YAML files to provide
 * role matching, querying, and listing capabilities.
 * Implements the ProviderPlugin interface from plugin-interface.js.
 *
 * Capabilities:
 *   - match(query)        match roles by keyword, alias, or tag
 *   - getAll()            return all loaded roles
 *   - getById(roleId)     return a specific role by its id
 *   - getByAlias(alias)   lookup role by Chinese alias
 *   - getAliases()        return the full alias mapping
 *   - getCategories()     return role category definitions
 */

'use strict';

var path = require('path');
var fs = require('fs');
var { ProviderPlugin } = require('../../contracts/plugin-interface');

/**
 * Minimal YAML parser for flat and simple nested structures.
 * Handles: key: value, nested via indentation, list items via "- ", comments via #.
 * Returns a plain JS object.
 */
function parseSimpleYaml(content) {
  var lines = content.split('\n');
  var root = {};
  var stack = [{ obj: root, indent: -1 }];

  for (var i = 0; i < lines.length; i++) {
    var rawLine = lines[i];

    // Strip comments (but not inside quoted strings - simple approach)
    var commentIdx = rawLine.indexOf('#');
    if (commentIdx === 0) continue; // full-line comment
    var line = commentIdx > 0 ? rawLine.substring(0, commentIdx) : rawLine;
    line = line.replace(/\s+$/, ''); // trim trailing whitespace

    if (!line) continue;

    // Calculate indentation
    var indent = 0;
    while (indent < line.length && (line[indent] === ' ' || line[indent] === '\t')) {
      indent++;
    }

    // Pop stack to find the correct parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    var parent = stack[stack.length - 1].obj;

    // List item
    if (line.indexOf('- ', indent) === indent) {
      var value = line.substring(indent + 2).trim();
      // value could be "key: val" format in a list
      var kvMatch = value.match(/^(\S+):\s*(.*)$/);
      if (kvMatch && parent && typeof parent === 'object' && !Array.isArray(parent)) {
        // If parent is not an array, this is a list of objects that should
        // be converted - but we handle list items as array entries
        if (!Array.isArray(parent)) {
          // We need the grandparent to have the array
          // Skip complex list-of-objects for role files
        }
      }
      // Determine parent array
      // The key name should be on the previous stack entry
      var listValue = parseYamlValue(value);
      // Ensure parent is the array
      if (Array.isArray(parent)) {
        parent.push(listValue);
      }
      continue;
    }

    // Key-value pair
    var colonIdx = line.indexOf(':', indent);
    if (colonIdx === -1) continue;

    var key = line.substring(indent, colonIdx).trim();
    var val = line.substring(colonIdx + 1).trim();

    if (!val) {
      // Nested structure - check if next non-empty line is a list
      var nextNonEmpty = findNextNonEmpty(lines, i + 1);
      if (nextNonEmpty && nextNonEmpty.line.indexOf('- ', nextNonEmpty.indent) === nextNonEmpty.indent) {
        // It's a list
        var arr = [];
        parent[key] = arr;
        stack.push({ obj: arr, indent: indent });
      } else {
        // It's an object
        var newObj = {};
        parent[key] = newObj;
        stack.push({ obj: newObj, indent: indent });
      }
    } else {
      parent[key] = parseYamlValue(val);
    }
  }

  return root;
}

/**
 * Parse a YAML scalar value.
 */
function parseYamlValue(val) {
  if (!val) return val;

  // Quoted string
  if ((val[0] === '"' && val[val.length - 1] === '"') ||
      (val[0] === "'" && val[val.length - 1] === "'")) {
    return val.substring(1, val.length - 1);
  }

  // Boolean
  if (val === 'true') return true;
  if (val === 'false') return false;

  // Number
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);

  // Plain string
  return val;
}

/**
 * Find the next non-empty, non-comment line starting from the given index.
 */
function findNextNonEmpty(lines, startIdx) {
  for (var i = startIdx; i < lines.length; i++) {
    var l = lines[i];
    var trimmed = l.trim();
    if (!trimmed || trimmed[0] === '#') continue;
    var indent = 0;
    while (indent < l.length && (l[indent] === ' ' || l[indent] === '\t')) indent++;
    return { line: l, indent: indent, trimmed: trimmed, lineNum: i };
  }
  return null;
}

/**
 * Parse a role definition YAML file.
 * Extracts structured role data from a role file like coordinator.yaml.
 */
function parseRoleYaml(content) {
  var data = parseSimpleYaml(content);

  // Handle multi-line description (pipe | syntax) - already stripped by our parser
  // Just return the parsed structure
  return {
    id: data.id || '',
    name: data.name || '',
    version: data.version || '1.0.0',
    tier: data.tier || '',
    description: data.description || '',
    expertise: Array.isArray(data.expertise) ? data.expertise : [],
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
    task_types: Array.isArray(data.task_types) ? data.task_types : [],
    module_tags: Array.isArray(data.module_tags) ? data.module_tags : [],
    tools: Array.isArray(data.tools) ? data.tools : [],
    subagent_type: data.subagent_type || 'general-purpose',
    abstract: data.abstract || false,
    memory_file: data.memory_file || '',
    experience_tags: Array.isArray(data.experience_tags) ? data.experience_tags : [],
    prompt_template: data.prompt_template || '',
  };
}


/**
 * RoleRegistryProvider - provides role matching and querying
 */
class RoleRegistryProvider extends ProviderPlugin {
  constructor() {
    super();
    this.name = 'provider-role-registry';
    this.version = '1.0.0';
    this.description = 'Role Registry Provider';
    this.provides = 'provider:role-registry';
    this.dependencies = {};

    /** @type {object|null} parsed registry data */
    this._registry = null;
    /** @type {Map<string, object>} loaded role definitions by id */
    this._roles = new Map();
    /** @type {object} alias mapping */
    this._aliases = {};
    /** @type {string} project root */
    this._projectRoot = '';
  }

  /**
   * Activate - load and parse the registry and role files.
   * @param {PluginContext} context
   */
  async onActivate(context) {
    this._projectRoot = this._resolveProjectRoot();
    var registryPath = path.join(this._projectRoot, '.claude', 'agents', 'role-registry.yaml');
    this._loadRegistry(registryPath);
    this._loadRoleFiles();
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
       * Match roles by keyword, alias, tag, or expertise.
       * @param {string} query - search term
       * @returns {{ id: string, name: string, score: number }[]}
       */
      match: function (query) {
        return self._match(query);
      },

      /**
       * Get all loaded roles.
       * @returns {object[]}
       */
      getAll: function () {
        return Array.from(self._roles.values());
      },

      /**
       * Get a role by its ID.
       * @param {string} roleId
       * @returns {object|undefined}
       */
      getById: function (roleId) {
        return self._roles.get(roleId);
      },

      /**
       * Get a role by its Chinese alias.
       * @param {string} alias
       * @returns {object|undefined}
       */
      getByAlias: function (alias) {
        var roleId = self._aliases[alias];
        if (!roleId) return undefined;
        return self._roles.get(roleId);
      },

      /**
       * Get the full alias mapping.
       * @returns {object}
       */
      getAliases: function () {
        return Object.assign({}, self._aliases);
      },

      /**
       * Get category definitions from the registry.
       * @returns {object}
       */
      getCategories: function () {
        if (!self._registry || !self._registry.categories) return {};
        return self._registry.categories;
      },

      /**
       * Get the default fallback role ID.
       * @returns {string}
       */
      getDefaultRole: function () {
        return (self._registry && self._registry.default_role) || 'implementer';
      },

      /**
       * Get tag-to-role mappings.
       * @returns {object}
       */
      getTagMappings: function () {
        if (!self._registry || !self._registry.tag_to_role) return {};
        return self._registry.tag_to_role;
      },
    };
  }

  /**
   * Match roles by query string.
   * Scores each role based on keyword, expertise, alias, and tag matches.
   * @param {string} query
   * @returns {{ id: string, name: string, score: number }[]}
   */
  _match(query) {
    if (!query) return [];
    var self = this;
    var q = query.toLowerCase();
    var scores = new Map();
    var weights = (this._registry && this._registry.matching_weights) || {
      keyword: 0.5,
      task_type: 0.3,
      module_tag: 0.2,
      inheritance_factor: 0.5,
    };

    // Check aliases (exact match)
    var aliasRoleIds = [];
    for (var alias in this._aliases) {
      if (alias.toLowerCase().indexOf(q) !== -1) {
        aliasRoleIds.push(this._aliases[alias]);
      }
    }

    // Check tag_to_role
    var tagMappings = (this._registry && this._registry.tag_to_role) || {};
    for (var tag in tagMappings) {
      var tagClean = tag.replace(/[\[\]]/g, '').toLowerCase();
      if (tagClean.indexOf(q) !== -1 || q.indexOf(tagClean) !== -1) {
        var roleIds = tagMappings[tag];
        if (Array.isArray(roleIds)) {
          for (var t = 0; t < roleIds.length; t++) {
            var rid = roleIds[t];
            var prev = scores.get(rid) || 0;
            scores.set(rid, prev + 0.4);
          }
        }
      }
    }

    // Score each role by keywords, expertise, and task_types
    this._roles.forEach(function (role, id) {
      var score = 0;

      // Keyword match
      if (role.keywords) {
        for (var k = 0; k < role.keywords.length; k++) {
          if (role.keywords[k].toLowerCase().indexOf(q) !== -1) {
            score += weights.keyword;
            break;
          }
        }
      }

      // Expertise match
      if (role.expertise) {
        for (var e = 0; e < role.expertise.length; e++) {
          if (role.expertise[e].toLowerCase().indexOf(q) !== -1) {
            score += 0.3;
            break;
          }
        }
      }

      // Task type match
      if (role.task_types) {
        for (var tt = 0; tt < role.task_types.length; tt++) {
          if (role.task_types[tt].toLowerCase().indexOf(q) !== -1) {
            score += weights.task_type;
            break;
          }
        }
      }

      // Module tag match
      if (role.module_tags) {
        for (var mt = 0; mt < role.module_tags.length; mt++) {
          if (role.module_tags[mt].toLowerCase().indexOf(q) !== -1) {
            score += weights.module_tag;
            break;
          }
        }
      }

      // Name match
      if (role.name && role.name.toLowerCase().indexOf(q) !== -1) {
        score += 0.4;
      }

      // ID match
      if (id.toLowerCase().indexOf(q) !== -1) {
        score += 0.3;
      }

      // Boost for alias matches
      if (aliasRoleIds.indexOf(id) !== -1) {
        score += 0.5;
      }

      if (score > 0) {
        scores.set(id, (scores.get(id) || 0) + score);
      }
    });

    // Convert scores to sorted results
    var results = [];
    scores.forEach(function (score, id) {
      var role = self._roles.get(id);
      results.push({
        id: id,
        name: role ? role.name : id,
        score: Math.round(score * 100) / 100,
      });
    });

    results.sort(function (a, b) { return b.score - a.score; });
    return results;
  }

  /**
   * Load and parse the role registry YAML.
   * @param {string} filePath
   */
  _loadRegistry(filePath) {
    try {
      var content = fs.readFileSync(filePath, 'utf-8');
      this._registry = parseSimpleYaml(content);
      this._aliases = this._registry.aliases || {};
    } catch (err) {
      this._registry = { categories: {}, aliases: {}, default_role: 'implementer' };
      this._aliases = {};
    }
  }

  /**
   * Load all role files referenced in the registry.
   */
  _loadRoleFiles() {
    var roleFiles = (this._registry && this._registry.role_files) || [];
    var agentsDir = path.join(this._projectRoot, '.claude', 'agents');

    for (var i = 0; i < roleFiles.length; i++) {
      var entry = roleFiles[i];
      // entry can be a string "path: ..." or an object { path: "..." }
      var relPath = '';
      if (typeof entry === 'string') {
        // parse "path: value"
        var match = entry.match(/path:\s*(.+)/);
        relPath = match ? match[1].trim() : entry;
      } else if (entry && entry.path) {
        relPath = entry.path;
      }
      if (!relPath) continue;

      var fullPath = path.join(agentsDir, relPath);
      try {
        var content = fs.readFileSync(fullPath, 'utf-8');
        var roleData = parseRoleYaml(content);
        if (roleData.id) {
          this._roles.set(roleData.id, roleData);
        }
      } catch (err) {
        // Skip unreadable role files silently
      }
    }
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

module.exports = RoleRegistryProvider;
