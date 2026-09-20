---
name: xmtools-git-commit
description: xmtools 项目的 git 提交规则——何时可以提交、提交作者、commit message 格式。仅当用户明确要求提交时使用。
---

# Git 提交规则

- **禁止自动提交**：只有用户明确输入提交指令（如"提交"/"commit"）时才能执行 `git commit`。完成编码、审核、修复等任务后，不要自作主张提交，等待用户明确要求。
- 提交作者**固定使用 `rosesmall2010`**（`rosesmall2010@gmail.com`），不要使用其他用户身份。
- 提交前清理运行产物（如 `findequ-result-*.json`），不要提交进仓库。
- commit message **不要**附加 `Co-Authored-By` 之类的归因行。
