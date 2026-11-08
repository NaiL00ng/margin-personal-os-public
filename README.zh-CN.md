# 余白 MARGIN · Personal OS

[English](README.md) | 简体中文

> 当今世界，多少时间留给自己？

余白是一个长期演进的网页个人管理与记账项目。目标是帮助用户把有限时间、金钱和注意力放到自己在意的事情上，让计划、执行、支出和复盘可以相互解释。

当前开发版本 **0.3.0-dev.2** 已有四象限便利贴、本机 Python + SQLite 后端、旧记录导入、备份恢复和可选的 macOS 图形启动器；生命月历、日程与记账联动仍处于设计阶段。目前界面及大部分详细文档为中文。

## 从本机数据库入口开始

下载仓库源码，在项目文件夹打开终端。使用**已有的 Python 3.9+** 运行：

```sh
python3 server.py
```

打开 `http://127.0.0.1:4317`。服务仅监听本机，使用 Python 标准库，包括 `http.server` 和 `sqlite3`，无需安装第三方包。新数据库从空看板开始，记录保存在 `.local/margin.sqlite3`，备份在 `.local/backups/`。按 Ctrl+C 停止服务；下次启动仍可读取已经确认保存的记录。

「数据与备份」可预览旧 JSON 后确认导入，也可创建和恢复备份。**JSON 导入合并记录；恢复数据库备份替换当前记录**，并先自动保留一份安全备份。详见 [后端使用说明](docs/backend-guide.md)。

### 可选的 macOS 图形启动器

**源码下载不包含 `Margin.app`。** 请先使用上面的 Python 命令启动。若 Mac 已有 Swift 编译工具，先阅读 [build_launcher.py](build_launcher.py)，再在本机构建启动器：

```sh
python3 build_launcher.py
```

脚本不会安装任何工具。它在项目文件夹生成 `Margin.app`，构建文件放在 `.local/launcher-build/`。构建后双击应用，自动启动本机服务并在默认浏览器打开看板。应用本体留在项目文件夹，可拖到 Dock，或在访达制作替身作为快捷入口。

图形入口与终端命令共用数据库，无需重新导入。启动器退出时只停止它自己启动的服务；若复用同项目、同数据库的已有服务，不会停止原服务。关闭浏览器不删除便利贴。生成的应用包含本机定位路径，不是独立分发安装包，不应随源码上传；它未签署开发者分发证书。详见 [图形启动说明](docs/backend-guide.md#图形启动器macos)。

## 体验静态版本

直接打开 [prototype.html](prototype.html)，或保持源文件同目录后打开 [index.html](index.html)。也可使用已有 Node.js 运行 `node preview.mjs`。此模式使用按浏览器与来源隔离的 `localStorage`，首次生成四张示例卡片，不会自动读写 SQLite。Node 预览与 Python 服务默认占用相同端口，不能同时使用该端口运行。

两种入口均不连接银行或真实账单。静态单文件不包含 Python 后端；具体操作及浏览器存储限制见 [原型操作说明](docs/prototype-guide.md)。

目前可以：

- 生成小型便利贴，纸面只显示标题与驻留数字；分类和描述在详情中查看。
- 象限内自由摆放并记忆位置，可一键整理；左列不紧急、右列紧急，上排重要、下排不重要。
- 独立累计各象限驻留时间。调整暂停计时并保留历史；保存或关闭编辑窗后回准备区，取消只放弃尚未保存的文字修改。
- 将完成与 **Void** 取消分别归档，查看时间占比、恢复或导出记录。恢复及后续修改不会覆盖此前的完成／取消快照。
- 伪 3D 悬停、调整暂留后归位、完成抖动缩小、Void 边缘燃烧；自定义象限颜色，切换灵动、轻柔、关闭动效，并尊重系统减少动态偏好。动效不决定业务结果。

**象限驻留记录经过的墙钟时间，不等于专注或实际工时。** 多张卡片可以同时累计。关闭网页或服务不暂停；编辑及准备区暂停，完成或取消后冻结。数据库模式以服务端动作时间为准。产品是否能提升习惯持续性或个人福祉，尚待验证。

## 文档导航

以下文档目前主要为中文。

| 要了解的问题 | 文档 |
| --- | --- |
| 为什么做、核心理念和边界 | [产品愿景](docs/product/vision.md) |
| 整体页面、典型流程、规划与记账联动 | [产品需求](docs/product/requirements.md) |
| 现在做到了哪里、后续如何分阶段 | [产品路线图](docs/product/roadmap.md) |
| 每个机制有哪些依据、哪些仍是假设 | [研究证据登记](docs/research/evidence-register.md) |
| 同类产品、已存在能力和差异化空间 | [产品比较](docs/research/landscape.md) |
| 卡片、计时、完成／取消／调整和动效语义 | [交互规范](docs/design/interaction-spec.md) |
| 本机运行、旧数据导入、备份与恢复 | [后端使用说明](docs/backend-guide.md) |
| 当前结构与后续领域扩展 | [架构概览](docs/architecture/overview.md)、[ADR 0002](docs/architecture/decisions/0002-local-sqlite-backend.md)、[早期 ADR 0001](docs/architecture/decisions/0001-prototype-and-future-backend.md) |
| 已测内容与未测边界 | [验证记录](docs/quality/validation.md) |
| 如何保留版本、开发、审查与发布 | [贡献与发布流程](CONTRIBUTING.md) |
| 开发沿革与阶段说明 | [CHANGELOG](CHANGELOG.md)、[0.3.0 开发版](docs/releases/v0.3.0.md)、[早期 0.2.0 阶段](docs/releases/v0.2.0.md)、[早期 0.1.0 阶段](docs/releases/v0.1.0.md) |
| 私人数据与凭证的处理边界 | [SECURITY](SECURITY.md) |

文档中的哲学概念是价值立场，心理学／管理学论文是有适用边界的证据，具体产品机制是待验证的设计。不会把“查到相关论文”写成“本产品效果已被证明”，也不会把尚未穷尽的市场调研写成“别人从未做过”。

## 仓库结构

```text
.
├── index.html / style.css        # 原型页面和样式
├── model.js / model.test.cjs     # 状态、位置与驻留模型及测试
├── effects.js / app.js           # 装饰动效、界面与交互
├── storage.js / storage.test.cjs # 后端请求、待确认重试与测试
├── server.py / backend/          # Python HTTP、SQLite 领域存储及测试
├── launcher.py / launcher/       # 服务生命周期辅助程序、macOS 原生窗口源码
├── build_launcher.py             # 使用已有 Swift 构建本机应用
├── build.mjs / preview.mjs       # 单文件打包、本机静态预览
├── prototype.html / preview.jpg  # 可运行单文件、合成数据预览
├── .local/                       # 运行时资料与备份，不纳入源码
├── docs/
│   ├── product/                  # 愿景、需求、阶段范围
│   ├── research/                 # 证据登记与产品比较
│   ├── design/                   # 交互规范
│   ├── architecture/decisions/   # 架构与 ADR
│   ├── quality/                  # 验证记录
│   └── releases/                 # 每个里程碑的说明
├── .github/                      # CI、PR／Issue 模板、代码所有者
├── VERSION / CHANGELOG.md
└── CONTRIBUTING.md / SECURITY.md
```

前端保留原路径；Python HTTP 适配与领域存储放在 `backend/`。静态构建只内联六个前端源文件，不打包 Python 或个人数据。`.local/`、生成的 `Margin.app`、数据库、备份及个人导出均为本机资料，不纳入源码上传。

## 本地检查与当前限制

后端检查使用 Python 3.9+；前端检查需要支持内置 `node:test` 的 Node.js，建议 22 或更高版本。无需 npm 包或 Python 第三方包。先阅读脚本，再在项目根目录运行：

```sh
python3 -m unittest discover -s backend -p 'test_*.py' -v
python3 -m unittest launcher_test -v
node --test model.test.cjs storage.test.cjs
node build.mjs
```

构建会更新生成文件 `prototype.html`。实际测试、浏览器检查及未测范围集中在 [验证记录](docs/quality/validation.md)。CI 结果只对应具体提交；本地检查不替代公开仓库对应提交的 CI 运行。

当前仅支持数据库 schema 1，遇到未知版本会拒绝打开；没有未来版本迁移引擎。尚无离线写入队列、跨设备同步、持久表单草稿、定时备份、数据加密或公网账户。服务面向本机使用，不用于公网托管。

## 项目历史与许可证

公开仓库：[NaiL00ng/margin-personal-os-public](https://github.com/NaiL00ng/margin-personal-os-public)。它从审查后的 **0.3.0-dev.2 源码快照**开始，建立新的 Git 历史。早期开发历史保留在独立私有仓库，不导入这里。源码公开不等于公开托管应用或公开个人记录。

保留的版本记录与早期阶段说明用于解释开发沿革，不表示公开仓库已有旧提交、标签、PR 或 Release。今后的公开变更正常保留提交历史，实际发布时再创建相应标签与 Release。源码版本记录与用户数据备份分开管理：GitHub 不自动备份浏览器或 SQLite 中的个人记录。

当前没有选择开源许可证。未来许可或复用授权由项目所有者另行决定。
