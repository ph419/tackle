/**
 * safe-path - Shared path-safety primitives
 *
 * 统一全仓的「安全名称校验」与「路径包含判断」，替代散落各处的
 *   - child.indexOf(parent) === 0  （S6：/foo 误判为 /foobar 父目录）
 *   - 各模块自写的正则/拼接  （S4：loopId/wpId 路径穿越）
 *
 * 设计参考 team-cleanup.js 的 validateTeamName / isPathSafe（审查报告评为
 * "全仓安全模范"），将其抽为可复用的纯函数。所有函数均无副作用、无 I/O，
 * 便于单元测试。
 *
 * @module plugins/runtime/safe-path
 */

'use strict';

var path = require('path');

/**
 * 合法标识符字符集：首字符字母/数字，其余允许 字母/数字/_/-，长度 1-64。
 * 显式拒绝 '.', '..', '' 及任何路径分隔符（/ \ :）。
 * 与 team-cleanup.validateTeamName 一致。
 */
var SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * 校验一个标识符是否只含安全字符（可用于 loopId / wpId / team 等拼进文件路径的输入）。
 *
 * @public
 * @param {string} name 待校验的标识符
 * @returns {{ok:true} | {ok:false, reason:string}}
 *   reason: 'empty' | 'invalid_chars' | 'too_long' | 'not_string'
 */
function validateSafeName(name) {
  if (name === undefined || name === null || name === '') {
    return { ok: false, reason: 'empty' };
  }
  if (typeof name !== 'string') {
    return { ok: false, reason: 'not_string' };
  }
  if (name === '.' || name === '..') {
    return { ok: false, reason: 'invalid_chars' };
  }
  if (name.length > 64) {
    return { ok: false, reason: 'too_long' };
  }
  // 拒绝任何路径分隔符或盘符冒号（防 'a/../../etc' 这类）
  if (/[\/\\:]/.test(name)) {
    return { ok: false, reason: 'invalid_chars' };
  }
  if (!SAFE_NAME_RE.test(name)) {
    return { ok: false, reason: 'invalid_chars' };
  }
  return { ok: true };
}

/**
 * 断言式校验：非法即抛错（携带原因），合法返回原值。
 *
 * 供拼路径前做前置守卫用：
 *   var safeLoopId = assertSafeName(loopId, 'loopId');
 *   path.join(stateDir, safeLoopId, 'directive.json');
 *
 * @public
 * @param {string} name 待校验标识符
 * @param {string} [label] 用于错误信息的字段名（如 'loopId'）
 * @returns {string} 校验通过的 name 原值
 * @throws {Error} 当 name 非法时，message 形如 "Invalid loopId: <reason>"
 */
function assertSafeName(name, label) {
  var r = validateSafeName(name);
  if (!r.ok) {
    throw new Error('Invalid ' + (label || 'name') + ': ' + r.reason);
  }
  return name;
}

/**
 * 判断 child 路径是否严格位于 parent 目录之内（S6 的正确实现）。
 *
 * 修复经典反模式 child.indexOf(parent) === 0：那会把 /foo 当成 /foobar 的父目录。
 * 这里用 path.relative 计算：结果不以 '..' 开头且非空串即视为包含。
 * 会对两端做 path.resolve（绝对化），故传入相对路径也安全。
 *
 * @public
 * @param {string} parent 父目录（绝对或相对）
 * @param {string} child  待判定的子路径
 * @returns {boolean}
 */
function isWithin(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  var rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return false; // 完全相同不算"包含在内"
  return rel !== '..' && rel.indexOf('..' + path.sep) !== 0 && rel.indexOf('..' + '/') !== 0;
}

/**
 * 判断一个路径条目是否为符号链接（用于 cleanup 前 lstat 防护，S5）。
 *
 * @public
 * @param {string} p 路径
 * @returns {boolean} true 表示是 symlink（含 Windows junction）
 */
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (_e) {
    return false;
  }
}

// lstatSync 需要 fs
var fs = require('fs');

module.exports = {
  SAFE_NAME_RE: SAFE_NAME_RE,
  validateSafeName: validateSafeName,
  assertSafeName: assertSafeName,
  isWithin: isWithin,
  isSymlink: isSymlink,
};
