/**
 * yaml-parser - Hand-written YAML parser for harness-config.yaml
 *
 * Supports a limited YAML subset: flat key-value pairs, single-level lists,
 * and single-level nested objects. Designed for parsing harness-config.yaml
 * sections — any top-level key is automatically detected as a section.
 *
 * Limitations:
 *   - No multi-line strings
 *   - No anchors/aliases
 *   - No flow-style collections
 *   - Unsupported features are silently ignored
 *
 * @module yaml-parser
 */

'use strict';

var fs = require('fs');

// Security limits
var MAX_YAML_SIZE = 102400;  // 100KB
var MAX_DEPTH = 10;

// ---------------------------------------------------------------------------
// Scalar parsing
// ---------------------------------------------------------------------------

/**
 * Parse a YAML scalar value.
 *
 * @public
 * @param {string} val - raw string value (already trimmed, comments stripped)
 * @returns {boolean|null|number|string} parsed value
 */
function parseValue(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  if ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
      (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")) {
    var content = val.substring(1, val.length - 1);
    // 双引号字符串处理转义字符（YAML 规范）
    if (val.charAt(0) === '"') {
      content = content.replace(/\\(.)/g, function (_, ch) {
        switch (ch) {
          case '\\': return '\\';
          case '"': return '"';
          case 'n': return '\n';
          case 't': return '\t';
          case 'r': return '\r';
          default: return '\\' + ch;
        }
      });
    }
    return content;
  }
  var num = Number(val);
  if (!isNaN(num) && val !== '') return num;
  return val;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/**
 * Parse a nested YAML block from raw string lines.
 * Converts raw lines to {text, indent} objects, then delegates to parseChildLines.
 *
 * @internal
 * @param {string[]} lines - all raw lines
 * @param {number} startIdx - index of the first child line
 * @param {number} parentIndent - indentation of the parent key
 * @returns {{value: object|Array, endIdx: number}}
 */
function parseNestedBlock(lines, startIdx, parentIndent, depth) {
  if (depth === undefined) depth = 0;
  if (depth > MAX_DEPTH) {
    throw new Error('YAML nesting depth exceeds maximum allowed depth (' + MAX_DEPTH + ')');
  }
  var childLines = [];
  var endIdx = startIdx;
  for (var i = startIdx; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim() || line.trim().indexOf('#') === 0) continue;
    var indent = line.search(/\S/);
    if (indent <= parentIndent) break;
    childLines.push({ text: line.trim(), indent: indent });
    endIdx = i;
  }

  if (childLines.length === 0) {
    return { value: {}, endIdx: startIdx - 1 };
  }

  return parseChildLines(childLines, endIdx, depth + 1);
}

/**
 * Parse pre-collected child lines (always {text, indent} objects).
 * Determines list vs object block and dispatches accordingly.
 *
 * @internal
 * @param {object[]} childLines - {text, indent} objects
 * @param {number} rawEndIdx - last index consumed
 * @returns {{value: object|Array, endIdx: number}}
 */
function parseChildLines(childLines, rawEndIdx, depth) {
  if (depth === undefined) depth = 0;
  if (depth > MAX_DEPTH) {
    throw new Error('YAML nesting depth exceeds maximum allowed depth (' + MAX_DEPTH + ')');
  }
  var isList = childLines[0].text.indexOf('- ') === 0;
  if (isList) {
    return { value: parseListItems(childLines, depth), endIdx: rawEndIdx };
  }
  return { value: parseObjectItems(childLines, depth), endIdx: rawEndIdx };
}

/**
 * Parse list items from child lines.
 * Each "- " prefixed line starts a new item; subsequent more-indented lines
 * belong to that item as nested properties.
 *
 * @internal
 * @param {object[]} childLines - {text, indent} objects
 * @returns {Array} parsed list
 */
function parseListItems(childLines, depth) {
  if (depth === undefined) depth = 0;
  var arr = [];
  var currentItem = null;
  var itemStartIndent = -1;

  for (var i = 0; i < childLines.length; i++) {
    var cl = childLines[i];

    if (cl.text.indexOf('- ') === 0) {
      if (currentItem !== null) arr.push(currentItem);
      var itemContent = cl.text.substring(2);
      currentItem = parseLineAsObject(itemContent);
      itemStartIndent = cl.indent;
    } else if (currentItem !== null && cl.indent > itemStartIndent) {
      var colonIdx = cl.text.indexOf(':');
      if (colonIdx >= 0) {
        var key = cl.text.substring(0, colonIdx).trim();
        var val = cl.text.substring(colonIdx + 1).trim();
        var commentIdx = val.indexOf(' #');
        if (commentIdx >= 0) val = val.substring(0, commentIdx).trim();

        if (val === '') {
          // Nested object within list item — collect and parse children inline
          var subChildren = collectChildren(childLines, i + 1, cl.indent);
          var subResult = parseChildLines(subChildren, 0, depth + 1);
          currentItem[key] = subResult.value;
          i = subChildren.length > 0 ? childLines.indexOf(subChildren[subChildren.length - 1]) : i;
        } else {
          currentItem[key] = parseValue(val);
        }
      }
    }
  }
  if (currentItem !== null) arr.push(currentItem);
  return arr;
}

/**
 * Collect consecutive child lines with indent > parentIndent,
 * starting from startIdx in the childLines array.
 *
 * @internal
 * @param {object[]} childLines - {text, indent} objects
 * @param {number} startIdx - start index
 * @param {number} parentIndent - parent indentation level
 * @returns {object[]} collected child lines
 */
function collectChildren(childLines, startIdx, parentIndent) {
  var result = [];
  for (var i = startIdx; i < childLines.length; i++) {
    if (childLines[i].indent <= parentIndent) break;
    result.push(childLines[i]);
  }
  return result;
}

/**
 * Parse a single "- key: value" or "- value" line into an object.
 *
 * @internal
 * @param {string} text - content after "- " prefix
 * @returns {object|*} parsed object or scalar
 */
function parseLineAsObject(text) {
  var colonIdx = text.indexOf(':');
  if (colonIdx >= 0) {
    var key = text.substring(0, colonIdx).trim();
    var val = text.substring(colonIdx + 1).trim();
    var commentIdx = val.indexOf(' #');
    if (commentIdx >= 0) val = val.substring(0, commentIdx).trim();
    var obj = {};
    obj[key] = val === '' ? {} : parseValue(val);
    return obj;
  }
  return parseValue(text);
}

/**
 * Parse object block (key-value pairs from child lines).
 *
 * @internal
 * @param {object[]} childLines - {text, indent} objects
 * @returns {object} parsed object
 */
function parseObjectItems(childLines, depth) {
  if (depth === undefined) depth = 0;
  var obj = {};
  for (var i = 0; i < childLines.length; i++) {
    var cl = childLines[i];
    var colonIdx = cl.text.indexOf(':');
    if (colonIdx === -1) continue;

    var key = cl.text.substring(0, colonIdx).trim();
    var val = cl.text.substring(colonIdx + 1).trim();
    var commentIdx = val.indexOf(' #');
    if (commentIdx >= 0) val = val.substring(0, commentIdx).trim();

    if (val === '') {
      var subChildren = collectChildren(childLines, i + 1, cl.indent);
      if (subChildren.length === 0) {
        obj[key] = {};
      } else {
        var subResult = parseChildLines(subChildren, 0, depth + 1);
        obj[key] = subResult.value;
      }
      i = childLines.indexOf(subChildren[subChildren.length - 1]);
    } else {
      obj[key] = parseValue(val);
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a YAML file into a JavaScript object.
 * Extracts multiple top-level sections (e.g. context_window, agent_dispatcher).
 * Returns an object keyed by section name.
 *
 * @public
 * @param {string} filePath - absolute path to the YAML file
 * @returns {object} parsed configuration object, empty object on error
 */
function parseYamlFile(filePath) {
  try {
    var content = fs.readFileSync(filePath, 'utf-8');
    return parseYamlString(content);
  } catch (err) {
    // Re-throw security limit errors so callers are aware
    if (err.message && (err.message.indexOf('maximum allowed size') !== -1 ||
        err.message.indexOf('maximum allowed depth') !== -1)) {
      throw err;
    }
    return {};
  }
}

/**
 * Parse a YAML string into a JavaScript object.
 * Extracts multiple top-level sections (e.g. context_window, agent_dispatcher).
 * Returns an object keyed by section name.
 *
 * @public
 * @param {string} content - YAML string content
 * @returns {object} parsed configuration object, empty object on error
 */
function parseYamlString(content) {
  if (content && content.length > MAX_YAML_SIZE) {
    throw new Error('YAML input exceeds maximum allowed size (' + MAX_YAML_SIZE + ' bytes)');
  }
  try {
    var result = {};
    var inSection = false;
    var currentSection = null;
    var sectionIndent = -1;
    var lines = content.split('\n');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();

      // Detect section start — any top-level key (indent 0)
      if (trimmed && trimmed.indexOf('#') !== 0 && trimmed !== '---' &&
          line.search(/\S/) === 0 && /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.test(trimmed)) {
        inSection = true;
        currentSection = trimmed.replace(/\s*:$/, '');
        sectionIndent = 0;
        result[currentSection] = {};
        continue;
      }

      if (inSection && currentSection) {
        // Stop at next top-level section (--- separator or same-indent key)
        if (trimmed === '---' || (line.search(/\S/) >= 0 && line.search(/\S/) <= sectionIndent && !/^[\s#]/.test(trimmed) && trimmed.indexOf(currentSection) === -1 && /^[a-z_]/.test(trimmed))) {
          inSection = false;
          currentSection = null;
          continue;
        }

        // Skip empty lines and comments
        if (!trimmed || trimmed.indexOf('#') === 0) {
          continue;
        }

        // Parse simple key-value pairs (flat or one level nested)
        var colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;

        var key = trimmed.substring(0, colonIdx).trim();
        var valuePart = trimmed.substring(colonIdx + 1).trim();

        // Remove inline comments
        var commentIdx = valuePart.indexOf(' #');
        if (commentIdx >= 0) {
          valuePart = valuePart.substring(0, commentIdx).trim();
        }

        // Skip nested keys — delegate to parseNestedBlock
        if (valuePart === '' || valuePart === null) {
          var nestedIndent = lines[i] ? lines[i].search(/\S/) : -1;
          var parsed = parseNestedBlock(lines, i + 1, nestedIndent);
          result[currentSection][key] = parsed.value;
          i = parsed.endIdx;
          continue;
        }

        result[currentSection][key] = parseValue(valuePart);
      }
    }

    return result;
  } catch (err) {
    // Re-throw security limit errors
    if (err.message && (err.message.indexOf('maximum allowed size') !== -1 ||
        err.message.indexOf('maximum allowed depth') !== -1)) {
      throw err;
    }
    return {};
  }
}

/**
 * Serialize a config value for injection into skill.md comment blocks.
 * Arrays and nested objects become compact JSON; scalars stay as-is.
 *
 * @public
 * @param {*} val - value to serialize
 * @returns {string} serialized string
 */
function serializeConfigValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val !== 'object') return String(val);
  if (Array.isArray(val)) {
    return '[' + val.map(function (item) { return serializeConfigValue(item); }).join(', ') + ']';
  }
  var parts = [];
  for (var k in val) {
    if (val.hasOwnProperty(k)) {
      parts.push(k + '=' + serializeConfigValue(val[k]));
    }
  }
  return '{' + parts.join(', ') + '}';
}

module.exports = {
  parseYamlFile: parseYamlFile,
  parseYamlString: parseYamlString,
  parseValue: parseValue,
  serializeConfigValue: serializeConfigValue,
  // Internal helpers exported for testing
  parseNestedBlock: parseNestedBlock,
  parseChildLines: parseChildLines,
  parseListItems: parseListItems,
  collectChildren: collectChildren,
  parseLineAsObject: parseLineAsObject,
  parseObjectItems: parseObjectItems,
};
