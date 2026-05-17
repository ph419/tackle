# Task Archive (任务归档)

将 task.md 中已完成和非待执行的工作包归档到独立文档，保持 task.md 精简。

## When to Use

- 用户说 "任务归档" / "归档"
- 用户说 "task archive" / "archive tasks"
- task.md 文件过长需要清理时

---

## 核心流程

### Step 1: 分析 task.md

1. 读取项目根目录的 `task.md`
2. 识别以下内容为**可归档**：
   - 状态为 `✅ 完成` 的工作包行
   - "历史工作包" 及其子节（含所有已完成 WP 的详细表格）
   - "实施阶段" / "依赖图" 等纯历史参考信息
   - "设计文档编写" 等已完成章节
3. 识别以下内容为**必须保留**：
   - 文件头部的 `# Task Overview` 标题和 `📊 快速概览` 节
   - `📝 最近活动` 节（保留最近 5 条）
   - `📋 待办工作包` 表格中状态**不是** `✅ 完成` 的行
   - `综合发展规划文档` 引用链接

### Step 2: 生成归档文档

1. 获取当前日期 `YYYY-MM-DD`
2. 创建归档文件 `docs/archive/task-archive-YYYY-MM-DD.md`
3. 将所有可归档内容写入该文件，格式如下：

```markdown
# Task Archive — YYYY-MM-DD

> 自动归档生成，源文件：task.md

## 已归档工作包

[按原格式保留所有已完成工作包的详细信息]

## 历史阶段

[按原格式保留实施阶段、依赖图等历史参考]
```

### Step 3: 更新 task.md

1. 在 `📊 快速概览` 节之后、`📝 最近活动` 节之前，插入归档索引：

```markdown
## 📦 归档索引

| 日期 | 文件 | 摘要 |
|------|------|------|
| YYYY-MM-DD | [task-archive-YYYY-MM-DD.md](docs/archive/task-archive-YYYY-MM-DD.md) | X 个已完成 WP 归档 |
```

2. 删除已归档的详细内容（历史工作包表格、实施阶段、依赖图等）
3. 删除待办工作包表格中所有 `✅ 完成` 的行
4. 如果待办工作包表格变空，保留表头并标注"无待办工作包"

### Step 4: 验证

```bash
# 确认归档文件存在
ls docs/archive/task-archive-YYYY-MM-DD.md

# 确认 task.md 仍包含关键结构
grep "📋 待办工作包" task.md
grep "📦 归档索引" task.md
```

---

## 注意事项

- 如果 `docs/archive/` 目录不存在，先创建
- 每次归档只追加新索引行，不覆盖已有归档索引
- 待办工作包中非 `✅ 完成` 状态的行（如 `🔄 进行中`、`📋 待执行`）**绝对不归档**
- 归档是累积的：如果已有归档索引表，只追加新行，不重建

## 输出报告格式

```markdown
✅ 归档完成

📦 归档文件: docs/archive/task-archive-YYYY-MM-DD.md
📊 归档条目: X 个已完成工作包 + Y 个历史章节
📋 task.md 剩余: Z 行

🛑 归档完成，等待您的下一步指示
```
