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
  // B12: require length >= 2 before treating as a quoted string, so a lone
  // quote char (e.g. '"') is not truncated to '' and an unbalanced leading
  // quote (e.g. '"hello') is returned verbatim rather than stripped.
  if (val.length >= 2 &&
      ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
       (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'"))) {
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
  // Inline flow array: [a, b, "c"] (S8 consolidation — adopted from
  // config-validator's parseValue so the shared parser covers the same surface).
  if (val.charAt(0) === '[' && val.charAt(val.length - 1) === ']') {
    return _parseInlineArray(val);
  }
  var num = Number(val);
  if (!isNaN(num) && val !== '') return num;
  return val;
}

/**
 * Parse a YAML inline (flow-style) array `[a, b, "c"]` into a JS array.
 * Respects quoted strings and commas inside quotes. Used by parseValue.
 * @internal
 * @param {string} val - starts with '[' and ends with ']'
 * @returns {Array}
 */
function _parseInlineArray(val) {
  var inner = val.substring(1, val.length - 1).trim();
  if (inner === '') return [];
  var items = [];
  var current = '';
  var inQuotes = false;
  var quoteChar = '';
  for (var i = 0; i < inner.length; i++) {
    var ch = inner.charAt(i);
    if ((ch === '"' || ch === "'") && (i === 0 || inner.charAt(i - 1) !== '\\')) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = ch;
      } else if (ch === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else {
        current += ch;
      }
    } else if (ch === ',' && !inQuotes) {
      items.push(parseValue(current.trim()));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') {
    items.push(parseValue(current.trim()));
  }
  return items;
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

// ---------------------------------------------------------------------------
// parseSimpleYaml — S8/A3 consolidation target
// ---------------------------------------------------------------------------

/**
 * Parse a simple YAML subset into a plain nested JS object (NOT sectioned).
 *
 * This is the shared parser used by ConfigManager, ConfigValidator,
 * hook-skill-gate and provider-role-registry (S8/A3 — previously each had its
 * own divergent copy). Behaviour:
 *   - Flat key-value pairs: `key: value`
 *   - Nested objects via indentation: `key:\n  child: value`
 *   - Lists via `- ` items, including TOP-LEVEL scalar arrays (B4 fix):
 *       `triggers:\n- foo\n- bar` → `{ triggers: ['foo', 'bar'] }`
 *   - List-of-objects: `- key: value`
 *   - Inline `# comments` and full-line comments stripped
 *   - Quoted strings ("..." / '...'), booleans, null (~), numbers
 *
 * Enforces MAX_YAML_SIZE and MAX_DEPTH to bound resource use (S8 DoS surface
 * that the previous 4 copies lacked).
 *
 * @public
 * @param {string} content - YAML string
 * @returns {object} parsed object (empty on error / oversize)
 */
function parseSimpleYaml(content) {
  if (typeof content !== 'string') return {};
  if (content.length > MAX_YAML_SIZE) {
    throw new Error('YAML input exceeds maximum allowed size (' + MAX_YAML_SIZE + ' bytes)');
  }
  var result = {};
  // Each frame: { obj, indent }. obj is either an Array or a plain object.
  var stack = [{ obj: result, indent: -1 }];
  var lines = content.split('\n');
  var depth = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Skip empty lines, comments, and document separators
    var trimmed = line.trim();
    if (!trimmed || trimmed.indexOf('#') === 0 || trimmed === '---') continue;

    var indent = line.search(/\S/);
    if (indent < 0) continue;

    // List item handling — special stack popping: a `- ` item belongs to the
    // nearest array frame that is an ancestor (strictly shallower indent) of
    // this item. Pop frames until we either (a) reach an array frame shallower
    // than this item's indent, or (b) reach the root (orphan item — drop it).
    // Frames at this item's indent or deeper (e.g. a half-step item-object
    // frame from a previous list item) are popped to get back to the array.
    if (trimmed.indexOf('- ') === 0 || trimmed === '-') {
      while (stack.length > 1) {
        var topFrame = stack[stack.length - 1];
        if (Array.isArray(topFrame.obj) && topFrame.indent < indent) {
          // Found the array this item belongs to.
          break;
        }
        // Otherwise pop and keep looking (covers item-object frames, deeper
        // array frames, and same-indent object frames from prior items).
        stack.pop();
        depth--;
      }
      var listParentFrame = stack[stack.length - 1];
      var listParent = listParentFrame.obj;
      // Only append if we actually found an array frame shallower than indent
      if (listParentFrame.indent < indent && Array.isArray(listParent)) {
        var itemContent = trimmed === '-' ? '' : trimmed.substring(2).trim();
        _appendListItem(stack, listParent, itemContent, indent, trimmed);
      }
      // else: orphan `- ` item outside any list — drop
      continue;
    }

    // Key-value handling: pop stack to the parent whose indent is strictly
    // less than ours.
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
      depth--;
    }
    var parent = stack[stack.length - 1].obj;

    var colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    var key = trimmed.substring(0, colonIdx).trim();
    var valuePart = trimmed.substring(colonIdx + 1).trim();
    // Strip inline comments (only outside quotes)
    valuePart = _stripInlineComment(valuePart);

    if (valuePart === '' || valuePart === null) {
      // Could be a nested object OR a list — look ahead at the next non-comment line
      var nextReal = _nextNonCommentLine(lines, i + 1);
      var keyForObj = _safeKey(key);
      if (nextReal && nextReal.trimmed.indexOf('- ') === 0 && nextReal.indent > indent) {
        // List (B4: includes top-level scalar arrays like `triggers:\n- foo`)
        if (depth >= MAX_DEPTH) {
          throw new Error('YAML nesting depth exceeds maximum allowed depth (' + MAX_DEPTH + ')');
        }
        var arr = [];
        if (Array.isArray(parent)) {
          // list-of-lists: wrap as a single-element nested array entry
          parent.push(arr);
        } else {
          parent[keyForObj] = arr;
        }
        // Array frame indent = key indent, so items at indent > key indent land here.
        stack.push({ obj: arr, indent: indent });
        depth++;
      } else {
        // Nested object
        if (depth >= MAX_DEPTH) {
          throw new Error('YAML nesting depth exceeds maximum allowed depth (' + MAX_DEPTH + ')');
        }
        var child = {};
        if (Array.isArray(parent)) {
          // list-of-objects: add a fresh object to the list and descend into it
          parent.push(child);
        } else {
          parent[keyForObj] = child;
        }
        stack.push({ obj: child, indent: indent });
        depth++;
      }
    } else {
      var kvKey = _safeKey(key);
      if (Array.isArray(parent)) {
        // Inline object inside a list item: `- key: value` already handled in
        // _appendListItem; reaching here means a bare `- key: value` form on a
        // list frame — push as a single-key object.
        var inline = {};
        inline[kvKey] = parseValue(valuePart);
        parent.push(inline);
      } else {
        parent[kvKey] = parseValue(valuePart);
      }
    }
  }

  return result;
}

/**
 * Append a `- ` list item to the current parent array. If the parent is not
 * yet an array (defensive — should not happen because we look-ahead before
 * pushing an array frame), no-op.
 *
 * Multi-line object items: `- id: planning` followed by more-indented
 * `name: p1` lines — the deeper lines are merged into the same object via a
 * list-item-object frame pushed onto the stack.
 * @internal
 */
function _appendListItem(stack, parent, itemContent, indent, trimmed) {
  if (!Array.isArray(parent)) {
    // The list frame should already be on the stack via look-ahead. If we
    // somehow land here, drop the item rather than corrupting the parent.
    return;
  }
  if (itemContent === '') {
    // `- ` with nothing after → null placeholder
    parent.push(null);
    return;
  }
  // Object item: `- key: value` or `- key:` (start of multi-line object item)
  var colonIdx = itemContent.indexOf(':');
  if (colonIdx !== -1 && /^\S/.test(itemContent)) {
    var candidateKey = itemContent.substring(0, colonIdx).trim();
    // Only treat as object-item if the part before the colon looks like a bare
    // key (no spaces inside). Avoids misclassifying `http://...` style scalars.
    if (candidateKey && candidateKey.indexOf(' ') === -1) {
      var itemVal = _stripInlineComment(itemContent.substring(colonIdx + 1).trim());
      var obj = {};
      parent.push(obj);
      if (itemVal === '') {
        // `- key:` → start of a nested block under this list item; descend into
        // the object so subsequent deeper lines populate it.
        obj[_safeKey(candidateKey)] = {};
        // Push a frame for the inline value object at the item's indent so that
        // deeper child lines attach to it, then a frame for the item object
        // itself at the same indent.
        stack.push({ obj: obj[_safeKey(candidateKey)], indent: indent });
        stack.push({ obj: obj, indent: indent - 0.5 });
      } else {
        obj[_safeKey(candidateKey)] = parseValue(itemVal);
        // Push a frame for the item object at a half-step deeper indent so
        // subsequent deeper lines (e.g. `name: p1`) merge into THIS object
        // rather than being treated as new list items.
        stack.push({ obj: obj, indent: indent - 0.5 });
      }
      return;
    }
  }
  // Plain scalar item (including quoted strings, URLs, etc.)
  parent.push(parseValue(_stripInlineComment(itemContent)));
}

/**
 * Strip an inline ` # comment` from a value, respecting quoted strings.
 * @internal
 * @param {string} val
 * @returns {string}
 */
function _stripInlineComment(val) {
  if (!val) return val;
  var inSingle = false, inDouble = false;
  for (var i = 0; i < val.length; i++) {
    var ch = val.charAt(i);
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '#' && !inSingle && !inDouble) {
      // Must be preceded by whitespace or start-of-string to count as a comment
      if (i === 0 || val.charAt(i - 1) === ' ' || val.charAt(i - 1) === '\t') {
        return val.substring(0, i).trim();
      }
    }
  }
  return val.trim();
}

/**
 * Find the next non-empty, non-comment line. Returns null at EOF.
 * @internal
 * @param {string[]} lines
 * @param {number} startIdx
 * @returns {{trimmed: string, indent: number}|null}
 */
function _nextNonCommentLine(lines, startIdx) {
  for (var i = startIdx; i < lines.length; i++) {
    var l = lines[i];
    var t = l.trim();
    if (!t || t.indexOf('#') === 0 || t === '---') continue;
    return { trimmed: t, indent: l.search(/\S/) };
  }
  return null;
}

/**
 * Reject prototype-pollution keys (S7-style guard for parsed YAML).
 * @internal
 * @param {string} k
 * @returns {string}
 */
function _safeKey(k) {
  if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
    return '_';
  }
  return k;
}

module.exports = {
  parseYamlFile: parseYamlFile,
  parseYamlString: parseYamlString,
  parseSimpleYaml: parseSimpleYaml,
  parseValue: parseValue,
  serializeConfigValue: serializeConfigValue,
  // Internal helpers exported for testing
  parseNestedBlock: parseNestedBlock,
  parseChildLines: parseChildLines,
  parseListItems: parseListItems,
  collectChildren: collectChildren,
  parseLineAsObject: parseLineAsObject,
  parseObjectItems: parseObjectItems,
  // Constants exposed for tests / callers that want to surface limits
  MAX_YAML_SIZE: MAX_YAML_SIZE,
  MAX_DEPTH: MAX_DEPTH,
};
