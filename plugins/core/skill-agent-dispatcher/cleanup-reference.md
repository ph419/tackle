# Agent Dispatcher — 清理参考(逻辑销毁 + 历史残留目录清理)

> 本文档由 `skill-agent-dispatcher` 在 Step 7 阶段按需读取，不作为独立 skill 触发。

---

## ⚠️ 权限要求

本 skill 的 Step 7 清理流程需要 Bash 工具权限来：
- 验证目录是否存在 (`test -d`)
- 调用 `team-cleanup` CLI 执行文件系统级删除（**CLI 直接走 fs.rmSync,不调用 TeamDelete**——该工具已从 harness 移除）

> **Step 7f 的文件系统删除由 `node bin/tackle.js team-cleanup <team> --force` 执行**——该 CLI 是 Node 进程，**绕过 harness Bash 权限系统**，无需在 settings.json 添加 `Bash(rm -rf ...)` 权限条目。只需 `Bash(node bin/tackle.js team-cleanup ...)` 一条。

> ⚠️ **implicit session team 模式下的清理范围**: 当前 session 的 implicit team 随 session 自动清理,**本流程主要针对历史残留的显式/UUID 团队目录**(如旧的 `cybershop-wp101`、UUID 命名团队)。若 `team_name` 是当前 session 的批次标签(非真实 harness 团队目录),目录可能不存在,Step 7a 条件 2 会返回 `NOT_FOUND` 并正常跳过。

**建议权限配置**（添加到 settings.json 的 `permissions.allow` 中）：
```json
{
  "allow": [
    "Bash(test -d $HOME/.claude/teams/*)",
    "Bash(test -d $HOME/.claude/tasks/*)",
    "Bash(rm -rf $HOME/.claude/teams/*)",
    "Bash(rm -rf $HOME/.claude/tasks/*)"
  ]
}
```

如果权限被拒绝，清理流程会提示用户手动执行 `清理团队`。

---

## Step 7: 清理团队 (🔴 强制执行 + 验证)

<HARD-GATE>
Teamee 逻辑销毁必须完成 + 残留目录清理必须验证结果！
注意：大部分 Teamee 已在 Step 6.5 监控循环中即时销毁。
此步骤负责：① 确认 teamee_map 已空；② 对历史残留团队目录执行 team-cleanup CLI 并验证。
当前 session 的 implicit team 随 session 自动清理，无需 TeamDelete（工具也已移除）。
不信任 CLI 返回值，必须用 Bash 检查目录是否真的被删除！
以下步骤必须按顺序逐一执行，不可跳过！
</HARD-GATE>

> **设计说明**: 以下使用显式步骤而非循环，确保 AI agent 能忠实执行每一步。
> 路径使用 `$HOME` 变量（Git Bash 兼容 Windows）。

---

### Step 7a: 安全检查（3 个前置条件）

**条件 1** — `team_name` 非空且仅含合法字符 `[a-zA-Z0-9_-]`
- 失败 → 打印 `❌ 错误：team_name 无效` → 提示手动执行 `清理团队` → **停止**

**条件 2** — 历史残留团队目录存在（当前 session team 通常不存在于此路径）
- 用 Bash 检查: `test -d "$HOME/.claude/teams/$team_name" && echo "EXISTS" || echo "NOT_FOUND"`
- 返回 `NOT_FOUND` → 打印 `ℹ️ 团队目录不存在（当前 session implicit team 由 session 自动管理，此路径仅历史残留显式团队占用），跳过` → **停止**

**条件 3** — 路径安全验证
- 用 Bash 检查: `basename "$HOME/.claude/teams/$team_name"` 应返回 `$team_name`
- 不匹配 → 打印 `❌ 安全检查失败：路径异常` → 提示手动执行 `清理团队` → **停止**

全部通过 → 继续 Step 7b

---

### Step 7b: 清空映射表 (逻辑销毁残留 Teamee)

残留 Teamee 已无需发送协议帧——直接清空映射表，in-process Teamee 随 session 终止：
```
# 无协议帧；in-process Teamee 随 session 自然终止
teamee_map.clear()
# ── 状态输出（直接文本输出，禁止使用 SendMessage）──
# 输出: "映射表已清空（残留 Teamee 随 session 终止）"
```

> 不再读取团队配置发 orphan shutdown——映射表不一致的孤儿成员会在后续 team-cleanup CLI 的目录级清理中被一并删除。

---

### Step 7c: (已删除) 无需等待 shutdown 响应

逻辑销毁（Step 7b `teamee_map.clear()`）无协议帧，无需等待响应，直接进入残留目录清理（Step 7d）。

---

### Step 7d: 执行 team-cleanup CLI（第 1 次）

> TeamDelete 工具已从 harness 移除,本步骤直接调用 team-cleanup CLI 执行文件系统删除(CLI 内部走 fs.rmSync,**不调用 TeamDelete**)。

```
Bash(command="node {package_root}/bin/tackle.js team-cleanup {team_name} --force")
```

**验证** — 用 Bash 检查目录是否真的被删除:
```bash
test -d "$HOME/.claude/teams/$team_name" && echo "EXISTS" || echo "GONE"
test -d "$HOME/.claude/tasks/$team_name" && echo "EXISTS" || echo "GONE"
```

- 两个都返回 `GONE`（或 Step 7a 已确认 NOT_FOUND 而本次 CLI 返回 "No team artifacts found"）→ 打印 `✅ 清理成功（验证通过）` → **跳到 Step 7g**
- 任一返回 `EXISTS` → 继续 Step 7e

---

### Step 7e: 执行 team-cleanup CLI（第 2 次，等待 2 秒后重试）

```
Bash(command="node {package_root}/bin/tackle.js team-cleanup {team_name} --force")
```

**验证** — 同 Step 7d 的 Bash 检查。

- 两个都返回 `GONE` → 打印 `✅ 清理成功（第 2 次尝试）` → **跳到 Step 7g**
- 任一返回 `EXISTS` → 继续 Step 7f

---

### Step 7f: 再次执行 team-cleanup CLI（Step 7d/7e 失败后的最终重试）

打印 `🔥 team-cleanup CLI 两次未完成清理，执行最终重试...`

**安全确认** — 再次验证路径:
```bash
basename "$HOME/.claude/teams/$team_name"
```
- 返回值不等于 `$team_name` → 打印 `❌ 安全检查失败` → 提示手动执行 `清理团队` → **停止**

**执行删除**（调用确定性 CLI，封装跨平台 `fs.rmSync` + 安全校验，绕过 Bash 权限系统）:
```
Bash(command="node {package_root}/bin/tackle.js team-cleanup {team_name} --force")
```

该 CLI 直接走文件系统删除（fs.rmSync，带 basename / 字符集 / 路径穿越校验，**不调用 TeamDelete**——工具已移除）。如果 CLI 仍失败:
- 打印 `⚠️ team-cleanup CLI 执行失败`
- 提示用户手动执行 `清理团队` 或 `rm -rf "$HOME/.claude/teams/$team_name" "$HOME/.claude/tasks/$team_name"`

---

### Step 7g: 最终验证

用 Bash 确认两个目录都已清除:
```bash
test -d "$HOME/.claude/teams/$team_name" && echo "STILL_EXISTS" || echo "CLEAN"
test -d "$HOME/.claude/tasks/$team_name" && echo "STILL_EXISTS" || echo "CLEAN"
```

- 两个都返回 `CLEAN` → 打印 `✅ 清理流程完成`
- 任一返回 `STILL_EXISTS` → 打印 `❌ 清理失败！请手动执行: 清理团队`

---

### Step 7h: 记录清理日志

记录清理结果到执行报告（成功/失败、尝试次数、使用的方法）。

---

## Error Handling

### 循环依赖
```
❌ 检测到循环依赖: WP-037 → WP-038 → WP-039 → WP-037
请手动解除依赖关系后重试。
```

### Teamee 执行失败
```
⚠️ Task #2 执行失败
Owner: godot-script-expert-t2
状态: in_progress (卡住)
处理: Lead 调 markTeameeDestroyed 逻辑销毁该 Teamee（无协议帧）
      从 teamee_map 移除映射
      创建新 Teamee 重试 或 人工介入
```

### 部分任务超时
```
⚠️ Task #3 等待依赖超时
依赖: Task #2 (状态: in_progress, 超过 30 分钟)
处理: 检查 Task #2 的 Teamee 状态
      必要时发送消息确认进度
```

### 清理超时
```
⚠️ 清理等待超时（30秒）
可能原因：
- Teamee 进程卡死（逻辑销毁已移除映射，但进程未退出）
- team-cleanup CLI 多次失败（文件系统级删除受阻，如目录被占用）

处理：
- 强制执行 team-cleanup CLI（不是 rm -rf！）
- 建议用户检查是否有残留进程
- 检查 Step 5 是否使用了正确的 subagent_type
```

---

## Cleanup Guarantee (清理保障)

```
┌─────────────────────────────────────────────────────────────┐
│                    强制清理检查点                             │
│                                                             │
│  ✅ 正常完成 → Step 6.5 即时逻辑销毁 → Step 7 历史残留 CLI  │
│  ✅ 部分失败 → Step 6.5 即时逻辑销毁 → Step 7 历史残留 CLI  │
│  ✅ 超时     → Step 6.5 超时逻辑销毁 → Step 7 强制 CLI      │
│  ✅ 异常中断 → 捕获中断 → Step 7 强制逻辑销毁残留 + CLI     │
│                                                             │
│  ❌ 无任何情况可以跳过 Teamee 逻辑销毁！                     │
│  （当前 session implicit team 随 session 自动清理；          │
│   team-cleanup CLI 仅清理历史残留显式/UUID 团队目录）        │
└─────────────────────────────────────────────────────────────┘
```
