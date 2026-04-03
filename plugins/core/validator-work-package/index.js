/**
 * validator-work-package - 工作包文档验证器
 *
 * 检测 WP 文档结构缺陷和依赖有效性：
 *   - 验证必要章节（目标、验收标准、关键文件）
 *   - 验证依赖关系引用的 WP 是否存在
 *   - validate(wpPath) 验证单个 WP 文档
 *   - validateAll() 验证所有 WP 文档
 *
 * 使用方式：
 *   var Validator = require('./index.js');
 *   var v = new Validator({ projectRoot: '/path/to/project' });
 *   var result = v.validate('/path/to/WP-001.md');
 *   var allResult = v.validateAll();
 */

'use strict';

var fs = require('fs');
var path = require('path');
var { ValidatorPlugin } = require('../../contracts/plugin-interface');

/**
 * WP 文档必要章节定义
 * 每个 WP 文档应包含这些章节标题（二级标题 ## 或更高级别）
 */
var REQUIRED_SECTIONS = [
  { id: 'goal', patterns: [/^#{1,6}\s*目标/m, /^#{1,6}\s*Goal/im] },
  { id: 'acceptance', patterns: [/^#{1,6}\s*验收标准/m, /^#{1,6}\s*Acceptance/im] },
  { id: 'keyfiles', patterns: [/^#{1,6}\s*关键文件/m, /^#{1,6}\s*Key\s*Files/im] },
];

/**
 * 依赖关系提取正则
 * 匹配 "依赖: WP-001, WP-002" 或 "依赖: 无" 或 "Dependencies: ..."
 */
var DEPS_LINE_RE = /^>\s*依赖[：:]\s*(.+)$/m;
var DEPS_LINE_ALT_RE = /^\*?\*?依赖\*?\*?[：:]\s*(.+)$/m;

/**
 * WP ID 提取正则
 */
var WP_ID_RE = /WP-\d+/gi;

/**
 * WorkPackageValidator
 */
class WorkPackageValidator extends ValidatorPlugin {
  /**
   * @param {object} [options]
   * @param {string} [options.projectRoot] - 项目根目录，默认 process.cwd()
   */
  constructor(options) {
    super();
    options = options || {};

    this.name = 'validator-work-package';
    this.version = '1.0.0';
    this.description = '工作包文档验证器';
    this.blocking = false;

    /** @type {string} */
    this._projectRoot = options.projectRoot || process.cwd();
    /** @type {string} */
    this._docsWpDir = path.join(this._projectRoot, 'docs', 'wp');
    /** @type {string|null} */
    this._taskMdPath = path.join(this._projectRoot, 'task.md');
  }

  /**
   * 获取所有已知 WP ID（从 docs/wp/ 目录和 task.md 收集）
   * @returns {Set<string>}
   */
  _getKnownWpIds() {
    var ids = new Set();

    // 从 docs/wp/ 目录
    var files = this._readdir(this._docsWpDir);
    for (var i = 0; i < files.length; i++) {
      var match = /^(WP-\d+)\.md$/i.exec(files[i]);
      if (match) {
        ids.add(match[1].toUpperCase());
      }
    }

    return ids;
  }

  /**
   * 从 WP 文档内容中提取依赖的 WP ID
   * @param {string} content
   * @returns {string[]}
   */
  _extractDependencies(content) {
    var deps = [];

    // 尝试匹配依赖行
    var match = DEPS_LINE_RE.exec(content) || DEPS_LINE_ALT_RE.exec(content);
    if (match) {
      var depStr = match[1].trim();
      if (depStr === '无' || depStr === '-' || depStr === 'none') {
        return [];
      }

      var ids = depStr.match(WP_ID_RE);
      if (ids) {
        for (var i = 0; i < ids.length; i++) {
          deps.push(ids[i].toUpperCase());
        }
      }
    }

    // 也检查依赖图或表格中的引用（mermaid 语法）
    var mermaidBlock = /```mermaid[\s\S]*?```/g.exec(content);
    if (mermaidBlock) {
      var mermaidDeps = mermaidBlock[0].match(/WP-\d+/gi);
      if (mermaidDeps) {
        for (var j = 0; j < mermaidDeps.length; j++) {
          var id = mermaidDeps[j].toUpperCase();
          if (deps.indexOf(id) === -1) {
            deps.push(id);
          }
        }
      }
    }

    return deps;
  }

  /**
   * 检查文档中是否包含指定章节
   * @param {string} content
   * @param {{ id: string, patterns: RegExp[] }} section
   * @returns {boolean}
   */
  _hasSection(content, section) {
    for (var i = 0; i < section.patterns.length; i++) {
      if (section.patterns[i].test(content)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 验证单个 WP 文档
   * @param {string} wpPath - WP 文档的完整路径，或 WP ID (如 "WP-001")
   * @param {object} [context] - 验证上下文（保留兼容接口）
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  validate(wpPath, context) {
    var errors = [];
    var warnings = [];

    // 支持 WP ID 简写
    var filePath = wpPath;
    if (/^WP-\d+$/i.test(wpPath)) {
      filePath = path.join(this._docsWpDir, wpPath.toUpperCase() + '.md');
    }

    var wpId = path.basename(filePath, '.md').toUpperCase();
    var content = this._readFile(filePath);

    if (content === null) {
      errors.push(wpId + ' 文档文件不存在或无法读取: ' + filePath);
      return { valid: false, errors: errors, warnings: warnings };
    }

    // 1. 检查必要章节
    for (var i = 0; i < REQUIRED_SECTIONS.length; i++) {
      var section = REQUIRED_SECTIONS[i];
      if (!this._hasSection(content, section)) {
        errors.push(wpId + ' 缺少必要章节: ' + section.id);
      }
    }

    // 2. 检查依赖关系有效性
    var deps = this._extractDependencies(content);
    if (deps.length > 0) {
      var knownIds = this._getKnownWpIds();

      for (var j = 0; j < deps.length; j++) {
        // 跳过自引用
        if (deps[j] === wpId) {
          warnings.push(wpId + ' 依赖关系中包含自引用');
          continue;
        }
        if (!knownIds.has(deps[j])) {
          errors.push(wpId + ' 引用了不存在的依赖: ' + deps[j]);
        }
      }
    }

    // 3. 额外结构检查

    // 检查是否有预估时间
    if (!/预估时间|Estimated\s*Time/i.test(content)) {
      warnings.push(wpId + ' 缺少预估时间章节');
    }

    // 检查验收标准是否有复选框条目
    if (/验收标准/.test(content)) {
      var acceptanceSection = content.split(/#{1,6}\s*验收标准/)[1];
      if (acceptanceSection) {
        // 取到下一个章节标题之前
        var nextSection = acceptanceSection.split(/^#{1,6}\s/m)[0];
        if (nextSection && !/^\s*- \[[ x]\]/m.test(nextSection) && !/^\s*\[[ x]\]/m.test(nextSection)) {
          warnings.push(wpId + ' 验收标准中未发现复选框条目，建议使用 - [ ] 格式列出验收项');
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
    };
  }

  /**
   * 验证所有 WP 文档
   * @param {object} [context] - 验证上下文（保留兼容接口）
   * @returns {{ valid: boolean, errors: string[], warnings: string[], results: object }}
   */
  validateAll(context) {
    var allErrors = [];
    var allWarnings = [];
    var perFile = {};

    var files = this._readdir(this._docsWpDir);
    var wpFiles = [];

    for (var i = 0; i < files.length; i++) {
      if (/^WP-\d+\.md$/i.test(files[i])) {
        wpFiles.push(files[i]);
      }
    }

    if (wpFiles.length === 0) {
      allWarnings.push('docs/wp/ 目录下未找到任何 WP 文档');
      return {
        valid: true,
        errors: allErrors,
        warnings: allWarnings,
        results: perFile,
      };
    }

    for (var j = 0; j < wpFiles.length; j++) {
      var filePath = path.join(this._docsWpDir, wpFiles[j]);
      var result = this.validate(filePath);
      var wpId = path.basename(filePath, '.md').toUpperCase();
      perFile[wpId] = result;

      for (var k = 0; k < result.errors.length; k++) {
        allErrors.push(result.errors[k]);
      }
      for (var m = 0; m < result.warnings.length; m++) {
        allWarnings.push(result.warnings[m]);
      }
    }

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings: allWarnings,
      results: perFile,
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

module.exports = WorkPackageValidator;
