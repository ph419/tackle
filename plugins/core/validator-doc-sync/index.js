/**
 * validator-doc-sync - 文档同步验证器
 *
 * 检测 task.md 与 docs/wp/ 目录之间的不一致：
 *   - task.md 中列出但 docs/wp/ 中缺少的 WP 文档
 *   - docs/wp/ 中存在但 task.md 未列出的 WP 文档
 *   - 状态不一致（task.md 标记完成但 WP 文档内容为空等）
 *
 * 使用方式：
 *   var Validator = require('./index.js');
 *   var v = new Validator({ projectRoot: '/path/to/project' });
 *   var result = v.validate();  // { valid, errors, warnings }
 */

'use strict';

var fs = require('fs');
var path = require('path');
var { ValidatorPlugin } = require('../../contracts/plugin-interface');

/**
 * WP 编号正则：匹配 task.md 表格行中的 WP-NNN
 */
var WP_TABLE_ROW_RE = /^\|\s*(WP-\d+)\s*\|/;

/**
 * 状态标记正则
 */
var STATUS_COMPLETE_RE = /✅\s*完成/;
var STATUS_IN_PROGRESS_RE = /🔄\s*进行中/;
var STATUS_PENDING_RE = /📋\s*待开始/;

/**
 * 从 task.md 提取状态标记
 */
function parseStatus(statusCell) {
  if (STATUS_COMPLETE_RE.test(statusCell)) return 'completed';
  if (STATUS_IN_PROGRESS_RE.test(statusCell)) return 'in-progress';
  if (STATUS_PENDING_RE.test(statusCell)) return 'pending';
  return 'unknown';
}

/**
 * 检查文件内容是否实质为空
 * 除去空白、标题行、YAML front matter 后内容极少视为空
 */
function isContentEmpty(content) {
  if (!content) return true;

  // 去除 YAML front matter
  var body = content.replace(/^---[\s\S]*?---\n*/, '');
  // 去除 markdown 标题和分隔线
  body = body.replace(/^#{1,6}\s+.*$/gm, '');
  body = body.replace(/^---+$/gm, '');
  body = body.replace(/^>.*$/gm, '');
  // 去除纯空白行
  var lines = body.split('\n').filter(function (line) {
    return line.trim().length > 0;
  });

  return lines.length < 3;
}

/**
 * DocSyncValidator
 */
class DocSyncValidator extends ValidatorPlugin {
  /**
   * @param {object} [options]
   * @param {string} [options.projectRoot] - 项目根目录，默认 process.cwd()
   */
  constructor(options) {
    super();
    options = options || {};

    this.name = 'validator-doc-sync';
    this.version = '1.0.0';
    this.description = '文档同步验证器';
    this.blocking = false;

    /** @type {string} */
    this._projectRoot = options.projectRoot || process.cwd();
    /** @type {string} */
    this._taskMdPath = path.join(this._projectRoot, 'task.md');
    /** @type {string} */
    this._docsWpDir = path.join(this._projectRoot, 'docs', 'wp');
  }

  /**
   * 解析 task.md，提取所有 WP 条目及其状态
   * @returns {Array<{id: string, status: string, rawStatus: string}>}
   */
  parseTaskMd() {
    var content = this._readFile(this._taskMdPath);
    if (content === null) return [];

    var entries = [];
    var lines = content.split('\n');

    for (var i = 0; i < lines.length; i++) {
      var match = WP_TABLE_ROW_RE.exec(lines[i]);
      if (match) {
        // 拆分表格单元格
        var cells = lines[i].split('|').filter(function (c) { return c.trim().length > 0; });
        var rawStatus = cells.length >= 2 ? cells[1].trim() : '';
        // cells[0] 是 WP ID, cells[1] 是标题, cells[2] 是状态
        // 实际格式：| WP-NNN | 标题 | 状态 | ...
        rawStatus = cells.length >= 3 ? cells[2].trim() : (cells.length >= 2 ? cells[1].trim() : '');

        entries.push({
          id: match[1],
          status: parseStatus(rawStatus),
          rawStatus: rawStatus,
        });
      }
    }

    return entries;
  }

  /**
   * 扫描 docs/wp/ 目录，返回存在的 WP 文件列表
   * @returns {string[]} WP ID 列表，如 ['WP-001', 'WP-002']
   */
  scanDocsWp() {
    var entries = [];
    var files = this._readdir(this._docsWpDir);

    for (var i = 0; i < files.length; i++) {
      var match = /^(WP-\d+)\.md$/i.exec(files[i]);
      if (match) {
        entries.push(match[1].toUpperCase());
      }
    }

    return entries;
  }

  /**
   * 执行文档同步验证
   * @param {object} [context] - 验证上下文（保留兼容接口）
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  validate(context) {
    var errors = [];
    var warnings = [];

    // 1. 检查 task.md 可读
    var taskEntries = this.parseTaskMd();
    if (taskEntries.length === 0) {
      // 尝试读取原始文件判断是真的空还是读不到
      var rawContent = this._readFile(this._taskMdPath);
      if (rawContent === null) {
        errors.push('task.md 文件不存在或无法读取: ' + this._taskMdPath);
        return { valid: false, errors: errors, warnings: warnings };
      }
      // 文件存在但解析不出 WP 条目
      warnings.push('task.md 中未找到工作包条目');
      return { valid: true, errors: errors, warnings: warnings };
    }

    // 2. 检查 docs/wp/ 目录可读
    var docFiles = this.scanDocsWp();

    // 3. 构建索引集合
    var taskMap = {};
    for (var i = 0; i < taskEntries.length; i++) {
      taskMap[taskEntries[i].id] = taskEntries[i];
    }
    var docSet = {};
    for (var j = 0; j < docFiles.length; j++) {
      docSet[docFiles[j]] = true;
    }

    // 4. task.md 中有但 docs/wp/ 缺少的 WP
    for (var k = 0; k < taskEntries.length; k++) {
      var id = taskEntries[k].id;
      if (!docSet[id]) {
        errors.push(id + ' 在 task.md 中列出但 docs/wp/ 中缺少对应文档');
      }
    }

    // 5. docs/wp/ 中有但 task.md 未列出的 WP
    for (var m = 0; m < docFiles.length; m++) {
      var docId = docFiles[m];
      if (!taskMap[docId]) {
        warnings.push(docId + ' 在 docs/wp/ 中存在但 task.md 未列出');
      }
    }

    // 6. 状态不一致检测：task.md 标记完成但 WP 文档内容为空
    for (var n = 0; n < taskEntries.length; n++) {
      var entry = taskEntries[n];
      if (entry.status === 'completed' && docSet[entry.id]) {
        var wpPath = path.join(this._docsWpDir, entry.id + '.md');
        var wpContent = this._readFile(wpPath);
        if (wpContent !== null && isContentEmpty(wpContent)) {
          errors.push(entry.id + ' 在 task.md 中标记为已完成，但 WP 文档内容实质为空');
        }
      }

      // task.md 标记待开始但 WP 文档内容丰富（可能忘记更新状态）
      if (entry.status === 'pending' && docSet[entry.id]) {
        var wpPendingPath = path.join(this._docsWpDir, entry.id + '.md');
        var wpPendingContent = this._readFile(wpPendingPath);
        if (wpPendingContent !== null && !isContentEmpty(wpPendingContent)) {
          warnings.push(entry.id + ' 在 task.md 中标记为待开始，但 WP 文档已有实质内容，可能需要更新状态');
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
    };
  }

  // --- internal helpers ---

  /**
   * 同步读取文件，失败返回 null
   * @param {string} filePath
   * @returns {string|null}
   */
  _readFile(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      return null;
    }
  }

  /**
   * 同步读取目录，失败返回空数组
   * @param {string} dirPath
   * @returns {string[]}
   */
  _readdir(dirPath) {
    try {
      return fs.readdirSync(dirPath);
    } catch (err) {
      return [];
    }
  }
}

module.exports = DocSyncValidator;
