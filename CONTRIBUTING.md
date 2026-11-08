# 开发与版本保留约定

本项目当前由 NaiL00ng 管理，采用轻量的 main + 短期分支流程。此文件是工作约定，不能将其表述为 GitHub 已经强制开启的分支保护规则。

公开仓库为 [NaiL00ng/margin-personal-os-public](https://github.com/NaiL00ng/margin-personal-os-public)，从审查后的 `0.3.0-dev.2` 源码快照建立新的 Git 历史。早期开发历史保留在独立私有仓库，不随快照导入；本仓库内的早期阶段文档不是旧公开提交、标签、PR 或 Release 的证明。后续公开变更正常保留历史。

## 开发入口

当前版本为 `0.3.0-dev.2`，属于开发版本。源码发布与个人数据分开管理，静态源文件保持原位置，避免破坏已有本地打开路径。

- 数据库入口：使用 Python 3.9+ 运行 `python3 server.py`，默认监听 `127.0.0.1:4317`。仅使用 `sqlite3`、`http.server`、`unittest` 等标准库，不需要安装 FastAPI、SQLAlchemy 或其他包。
- macOS 图形入口：源码下载不含 `Margin.app`，新用户先用 Python 命令启动。有现成 Swift 工具时，审查 `build_launcher.py` 后运行 `python3 build_launcher.py` 在本机生成应用，再双击使用。源码为 `launcher/MarginLauncher.swift` 和 `launcher.py`；构建不会安装工具，生成应用包含本机路径，不纳入源码上传。
- 静态入口：直接打开 `index.html`／`prototype.html`，或运行 `node preview.mjs`。仍使用浏览器存储和初次示例；Node 预览与 Python 默认使用相同端口，不能同时启动。
- 数据库、备份与合成测试临时数据放在 `.local/`，不提交到 Git。测试仅清理自己创建的临时数据。
- 发布使用明确的源码文件清单，并核对提交树；不因 `.gitignore` 存在就假定个人数据一定没有被追踪。检查新提交、分支、标签及 Release 附件；提交作者姓名和邮箱也会成为公开元数据，提交前自行确认。不要合并或推送独立私有仓库的历史来替代源码快照更新。

先阅读相关脚本，再在项目根目录运行本地检查：

```sh
python3 -m unittest discover -s backend -p 'test_*.py' -v
python3 -m unittest launcher_test -v
node --test model.test.cjs storage.test.cjs
node build.mjs
```

Node 使用内置测试和文件 API，不需要 `npm install`。构建读取六个前端源文件并更新 `prototype.html`，不会把 Python、数据库或备份打进静态单文件。运行说明见 [后端指南](docs/backend-guide.md)，实际结果和未测范围见 [验证记录](docs/quality/validation.md)。

已有 Git 时，可在独立目录读取公开源码并创建开发分支。向本仓库推送、合并或发布仍须具备相应权限并遵循所有者授权：

```sh
git clone https://github.com/NaiL00ng/margin-personal-os-public.git
cd margin-personal-os-public
git switch -c feat/short-description
python3 -m unittest discover -s backend -p 'test_*.py' -v
python3 -m unittest launcher_test -v
node --test model.test.cjs storage.test.cjs
node build.mjs
```

这些命令不安装工具、不配置全局 Git 身份，也不授予上传权限。不要自动添加 SSH 密钥、CLI 令牌或第三方依赖。尚未选择开源许可证，许可与复用授权由所有者另行决定。

## 一次变更的流程

1. 明确问题、预期行为、验收方式；涉及新行为干预时，先补充 [证据登记](docs/research/evidence-register.md)。哲学概念、研究结果、产品假设分开写。
2. 从 `main` 创建 `feat/`、`fix/` 或 `docs/` 短期分支。一个提交表达一个完整意图，消息建议 `feat:`、`fix:`、`docs:`、`test:`、`chore:`。
3. 运行相关检查。修改前端源文件后重建单文件；UI 改动补浏览器验证，业务变化运行相关模型／存储／HTTP 测试。当前数据库只有 schema 1，未知版本拒绝打开；未来结构变化必须新增受测迁移与回退方案，不能删库重建或仅修改版本号。
4. PR 说明问题、最终行为、证据/假设、测试和未测范围。独立开发也做自审；CI 通过后合入。
5. 默认使用 merge commit 保留分支内各个提交。不要对已发布分支 force-push，不重写已经共享的历史；修复通过新提交完成。删除已合并的短期分支不删除已合入历史。

产品路线图用于能力规划，Issue／PR 用于采用该流程后的公开协作。个人工作区的任务台账、日记和背景资料不属于公开源码，不因参与项目而获得上传授权。

## 如何尽可能保留版本

- 每次可解释的变更提交一次；未提交、未上传的中间编辑不会自动成为 GitHub 版本。
- 可体验里程碑使用 `vMAJOR.MINOR.PATCH` 标签并创建 Release；探索版可以使用 `-alpha.1` 等后缀。
- 项目开发沿革早于本公开仓库；本仓库起点是 `0.3.0-dev.2` 快照，不补造早期提交或旧版本标签。后续修复或文档改进增加 patch；新增一组用户能力增加 minor；不兼容的数据结构必须明确迁移说明，不能仅靠版本数字代替。
- 已发布标签不移动、不复用；Release 附带版本说明、校验过的单文件及 SHA-256。撤回实验时新增说明和后续版本，不抹掉旧版本。
- `main` 保存最新公开源码；实际创建 Release 后，可由相应标签重新下载源码。不要复制 `v1-final-final` 目录作为主要版本机制。
- GitHub 保存源码历史，不备份用户的浏览器记录、SQLite 数据库或账单。个人数据导出另行保存在私有位置，不提交到 Git。
- 原私有仓库独立保留早期历史；公开仓库后续提交、分支、标签与 Release 在这里正常留存，不能将私有历史重写为已经公开存在的记录。

## 发布步骤

更新 `VERSION`、[CHANGELOG](CHANGELOG.md) 和 `docs/releases/`；完成测试、构建并确认生成文件与源一致；检查待上传文件范围；合入后给精确提交打标签。创建 Release 时说明原型状态和已知限制，附上该标签构建出的 `prototype.html`。禁止把未执行的检查标成通过。

GitHub 官方说明：[Releases 与标签的关系](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。
