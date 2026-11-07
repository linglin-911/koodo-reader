# Koodo Reader：项目需求与开发进度

更新：2026-11-08。本文件是当前需求、技术决定和进度的唯一维护依据；实现后在此更新状态与验证结果。历史日志和过时方案见 Git 历史，不重复维护。开发规范见各仓库 `AGENTS.md`。

## 1. 项目范围与环境

| 仓库 | 本地路径 | 分支 |
|---|---|---|
| `linglin-911/koodo-reader` | `D:\07_ProgramFiles\Koodo-innoo\koodo-reader` | `diagnostics/phase1-logging` |
| `linglin-911/kookit` | `D:\07_ProgramFiles\Kookit-innoo\kookit` | `diagnostics/phase1-logging` |

- 本阶段面向 **Windows Electron 桌面版**。只在共享源码或构建确有硬性约束时处理 Web/移动端兼容。
- 目标：流畅阅读约 100MB 以内 TXT，并支持小批注、章节批注和大批注。书库、导入、选文、复制、菜单、原生笔记弹窗等属于 Koodo 既有能力，继续复用。
- 小说保存在 Koodo 原书库；不建立独立小说项目文件夹、原文副本或第二套数据库。
- 开始工作先检查两库分支、HEAD、工作区及本地/远程差异，不擅自切分支或覆盖无关修改。完成独立阶段后测试、更新本文档并提交到当前分支；默认不推送。
- 不强制加载指定 Skill，不因缺少 `karpathy-guidelines` 阻塞开发。
- 开发版与原安装版共享用户数据，测试时避免同时运行。保护书籍、原文、书签和阅读记录。
- **用户已授权直接改造原生 Note；现有 Note/高亮均为可丢弃测试数据。** 不要求历史笔记迁移、影子实体或双写；只在相应阶段处理 Note 相关表，不清空整库。改造后创建的新批注按正式用户数据保护。
- 用户已授权用最新 Kookit 编译产物覆盖原先未提交的引擎文件，后续正常同步桌面构建产物。

Windows 命令使用 `yarn.cmd` / `npm.cmd`。当前已验证 Node v26.13.0、Electron 35.7.5；不无故重装依赖。

```powershell
# Koodo
yarn.cmd dev        # Vite + Electron；start 只开网页开发服务
yarn.cmd typecheck
yarn.cmd test
node --test test/database-diagnostics.test.cjs
yarn.cmd build

# Kookit
node --test test/txt-chapter-index.test.cjs test/chapter-metrics.test.cjs
yarn.cmd build
```

Kookit `rollup.config.js` 默认同时构建桌面与移动目标。当前任务可用 Rollup API 仅执行配置数组第一项；桌面输出为 Koodo `src/assets/lib/kookit.min.js`，保持现有单文件 ES module 配置。不要为验证桌面功能无故写入移动项目。

## 2. 当前进度

| 项目 | 状态 |
|---|---|
| 开发环境、原安装版/开发版数据互通 | 用户已验证，不重复验收 |
| 目录手动滚动不被阅读位置打断、点击章节立即更新标识 | 用户已验证；滚轮回跳已解决，不重新排查 |
| TXT 完整轻量章节索引、单章 HTML 按需生成、停用 delayedTxtRefresh | 已实现；真实大型 TXT 阅读仍待验证 |
| 阶段 1：章节映射/前缀累计优化、进度缓存、数据库/IPC 分段诊断 | 代码及自动验证完成 |
| 阶段 1 引擎接入正常运行路径 | 当前 Kookit 已重新编译覆盖 Koodo 原引擎产物；普通入口使用新产物，实际阅读体验待测 |
| SQLite 持久索引、字节随机读取、Worker、虚拟目录、连续章节窗口 | 待实施，从阶段 2 开始 |
| Note 改造成小批注、三类绑定与文件变化恢复 | 设计方向已确认，尚未改表或实现完整功能 |

阶段 1 源码提交：Kookit `de1ae7d`；Koodo `46fe30fd`。这些是功能基线，不是永远有效的当前 HEAD。

### 阶段 1 实现与验证

- Kookit `generalParser.getChapterDoc` 用 Map 将目录映射降至 O(C)，保留同 section 首条目录和无标题段。目录展平改为迭代遍历并复用快照。
- `chapterMetrics.ts` 缓存章节权重、总量和 exclusive prefix；`handleRecord`/`handleRenderChapter` 的进度数值计算改为查表，保留旧进度/页码的不同 fallback 规则。整个 record 仍有 DOM 扫描，不能称整体 O(1)。
- 页码缓存随章节权重快照、每页估算大小和阅读模式失效。重解析替换数组；原地改权重须调用 `invalidateChapterWeights`，改树形目录须替换根数组。
- `database-command` 抽出 `src/utils/main/database-diagnostics.js`。诊断调用返回 `{records,diagnostics}`，旧调用保持原结果；Renderer 通过 `databaseDiagnostics.ts` 解包，并以 requestId/traceId 关联恢复高亮请求。
- 主进程分段计时包括 registry、连接/迁移、prepare、输入转换、SQL 执行与行物化、结果转换；Renderer 记录 IPC 往返。`transportAndSchedulingDurationMs` 是排队、传输、日志及调度残差，不能当精确序列化时间。日志不含 SQL 参数、路径、摘录或批注正文。
- 已通过：Kookit 16 项、主进程诊断 5 项、Koodo Vitest 4 项、类型检查、无窗口 Electron + 实际 SqlStatement + 内存 SQLite 冒烟测试。脚本为 `test/database-command.electron.cjs`，可指定 JSON 结果路径。
- 已通过桌面引擎及 Koodo 生产构建；产物替换后普通 `yarn.cmd build` 与 `yarn.cmd typecheck` 再次通过，不依赖临时 alias。未执行真实小说/选区菜单手动回归；现有外部脚本、eval、locale 混合导入及大包构建警告仍在。
- Node 合成 7,700 章微基准：目录映射约 53.5→0.60ms、前缀累计约 32.4→0.06ms，不能代替 Electron 实测。阶段 1 没有修改 Schema 或删除测试笔记。

## 3. 当前架构与关键约束

| 层 | 关键文件/职责 |
|---|---|
| Koodo 主进程 | `main.js`：文件桥、`database-command`、better-sqlite3/WAL |
| Koodo 渲染进程 | viewer、`DatabaseService`、Zustand `useAppStore`、原生菜单/弹窗 |
| Kookit 源码 | `TxtRender.ts`、`libs/textProcessor.ts`、`libs/html.ts`、`generalParser.ts`、`navigationUtil.ts`、`layoutUtil.ts` |
| Kookit-extra | 现有 SqlStatement/配置/同步工具；本地可读源码未找到，不读取压缩产物理解实现 |

现有 TXT 链路：`viewer → BookUtil.fetchBook → 整书同步文件读取/ArrayBuffer → TxtRender 整书解码 → buildTxtChapterIndex → sections/toc → 按章生成 HTML/Blob → iframe`。

尚待处理的架构事实：

- 索引目前只在内存，章节 start/end 是当前解码字符串坐标，未持久化、未计字节、也未统一 LF。按需 HTML 不等于按需读原文；整书 buffer/字符串仍常驻。
- 文件选择优先书库内文件，其次外部引用路径；有效性校验须检查实际读取的文件。
- viewer 的 CACHE ZIP 命中和导入时 `isPrecacheBook` 可能绕过 TXT 新路径，后续须处理；不能只改 TxtRender 就宣称全入口已优化。
- `handleHighlight` 当前读取全书完整 notes 再过滤。旧 Rangy body 字符区间不能直接当原文 UTF-16 坐标，新绑定必须建立原文↔DOM 映射。
- 章节切换仍清空 iframe body 再异步加载；HTML section 的 unload 为空，关书/Blob 释放仍需完善。
- 现有五库为 `books.db`、`notes.db`、`bookmarks.db`、`words.db`、`plugins.db`。核查的默认目录仅有各旧表主键索引，user_version=0；没有持久章节/独立绑定表。自定义存储目录须另行核查。
- 新数据库操作统一走受控 `database-command`，不能直接在 Renderer 操作 SQLite。现有 `custom-database-command` 和旧 registry 只认识旧表，不照搬任意 SQL 或结果转换假设。
- 旧迁移逐项执行并吞异常，连接缓存只按 dbName 区分。新实现须采用版本化事务迁移，并按实际数据库路径识别连接。
- 当前备份可能含整个 .db，但恢复只解析已知旧表。新增正式批注表必须同时支持备份与恢复，不能误以为入包就等于能恢复。旧云同步序列化不能直接承载新多绑定。

## 4. 目标：持久索引与按需正文

正常开书目标：**实际文件身份/轻量校验 → SQLite 目录 → 目标章/块随机读取 → 有界正文窗口**。文件未变化不得重扫全文、整书解码或无条件计算完整 SHA-256。

- 复用现有 SQLite。推荐在 `notes.db` 增加本地索引和绑定表，便于同库原子切换；最终 DDL 在阶段 2 固定。不新建独立数据库。
- 索引是可重建本地缓存，不参与笔记云同步；原始 TXT 是唯一正文来源，不存整书 HTML 或正文副本。
- 元数据至少包括 book_id、实际文件身份、大小/mtime、采样指纹及算法、编码/BOM、parser_version、index_version、规范化/特征版本、解析配置摘要、indexed_at、document_revision、active generation。
- 章节至少包括 chapter_id、book_id、generation、chapter_index/name、起止及正文起始的 byte/UTF-16 两套偏移、first_chars、last_chars、行数、大小及识别类型。章 ID 与顺序分离；无批注章不要求跨重建保留 ID。
- 字节区间相对物理文件，文本区间按去文件头 BOM、CRLF/CR→LF 后的 UTF-16 单元计数，均为半开区间；显式处理 UTF-8、GBK、UTF-16LE/BE、块边界、多字节/代理对、空行和尾换行。
- first_chars 取正文首行前两个非空白字符，last_chars 取正文末尾最后两个非空白字符，不含标题，不足两字取实际字符；按完整 Unicode 码点提取，避免拆分代理对。空白首行的具体处理固定并版本化，不能跨实现漂移。
- 文件/编码/解析配置/版本变化或手动强制重建时才扫描。采用 building/ready 代及短事务切换，扫描/正文匹配在事务外完成；失败保留旧索引和全部批注。旧文件已被覆盖时不可用旧字节偏移读取新文件。
- 采样校验不能保证检测到元数据被保留且修改发生在未采样区的情况；提供手动完整校验/重建，不宣称抽样等于完整内容证明。
- 首版不要求整章 BodySha256、章节相似度、段落 diff 或任意拆章/合章自动迁移。

## 5. 三类批注与绑定

三类实体独立，分类/内容各自管理；可按章节互查参考，不建立自动父子关系，也不因其他类型删除而改变正文。大批注后续提供参考资料区 + 正文编辑区。

| 类型 | 数据与入口 |
|---|---|
| 小批注 | 直接改造原生 Note/notes；正文、标签、时间等在实体，一对多 `note_bindings` 保存各位置。选文→原菜单/编辑弹窗流程保持；追加位置为“添加到小批注→选择已有实体” |
| 章节批注 | 零或一个章节绑定，不含文字区间；在自身编辑页通过章节框选择/解绑，不用阅读区“添加到批注”入口 |
| 大批注 | 零或一个连续范围绑定；自身编辑页选择起始/结束章，含所有中间章。允许清空整个范围，禁止离散多选或删除中间成员 |

通用规则：

- 实体与绑定分离，解除一条/全部绑定不删除正文；无绑定仍可检索、编辑和分类。原“删除笔记”保留删除实体的语义，“解绑”是独立操作，提供撤销或等效恢复。
- 小批注单个锚点必须完整位于一个章节，可多位置、跨不同章节；允许不同锚点交叠/嵌套。纯高亮可表示为空正文实体 + 绑定。
- 每条绑定保存独立 ID、当前状态及最新章节快照（章 ID/名称、正文首尾特征、顺序/文档版本）；小绑定另存精确摘录、章内相对 UTF-16 范围、前后文及本处高亮样式。大范围保存两端各自快照和顺序边界。
- 点击高亮传 note_key + binding_id；正文/标签属于实体，位置样式属于当前绑定。列表一实体一项，无绑定不能消失。非 TXT 继续通过格式定位适配，不能伪造 TXT 坐标；现有格式绘图记录不能混作选文小批注。
- 手动换绑先解除要替换的旧关系，再建立新关系并更新快照。增加小绑定不删除其他绑定。不设自动/手动优先级或手动保护标记。
- 正文、摘录和锚点是正式用户数据，需要新版备份/恢复；索引是缓存。新版云同步契约须单独实现，不能把多绑定压成旧单位置 Note 或同步本地章节缓存。

### 文件变化后的恢复

重新索引仍扫描全书，但只对未解绑绑定引用的旧章节做身份恢复，只读取相关候选章正文；无批注书籍直接重建。

1. 小批注：章名匹配 + 原文摘录存在才确认；章名不匹配时要求正文首尾特征同时匹配，并仍须找到摘录。重复原文用上下文/相对位置消歧；无法唯一确认则待处理，找不到原文则失效。
2. 章节批注：唯一章名优先，否则首尾特征同时匹配；重名、空/弱特征不能任意选章。
3. 大批注：分别匹配两端，验证新代中同书、顺序及连续范围；任一端缺失、歧义或反转则整个范围待处理，不部分恢复。
4. 成功后事务化更新到最新有效快照/位置；失败保留旧快照与正文。已解绑关系不参与恢复。后台恢复须用版本比较避免覆盖用户并发换绑。

旧项目仅作设计参考：`linglin-911/FujiyNotepad`，分支 `feature/reader-settings-phase4`。核心文件在 `src/FujiyNotepad.Core/`：`NovelAnnotations.cs`、`NovelChapterIndexBuilder.cs`、`NovelChapterIndexReconciler.cs`、`AnnotationAnchorMetadata.cs`、`AnnotationAnchorQuoteLocator.cs`、`NovelAnnotationStore.cs`。旧 BigAnnotationChapters 用有序关联表并校验连续性；本项目可用起止章模型，不能照搬旧项目文件体系和级联删除关系。

## 6. 后续阶段与当前待办

按已确认方案逐阶段提交，不一次性完成大规模重构：

| 阶段 | 范围 / 完成门槛 |
|---|---|
| 1 | 已实现算法与诊断；真实大文件/原 UI 回归待测 |
| **2（下一步）** | SQLite 持久章节索引：固定双坐标与文件有效性契约，受控 IPC、版本迁移、批量事务和代切换；热打开不再扫描索引。尚在过渡整书读取时须明示 |
| 3 | 按字节随机读正文，移除 TXT 整书常驻；处理预缓存 ZIP/各导入入口及编码边界 |
| 4 | 直接改造 Note + 多绑定、章节/范围绑定，保留原阅读 UI；同步完善新用户数据备份/恢复 |
| 5 | 文件变化恢复、唯一匹配、并发/失败保护及强制重建 |
| 6 | SQLite 目录 + 虚拟列表（搜索结果也有界）；远跳不读中间正文 |
| 7 | Worker 后台扫描、取消/背压/任务合并；缓存命中不启动全文任务 |
| 8 | 仅 TXT 滚动模式：一个 iframe Document 承载相邻章节，有界块窗口、预读、占位/锚点补偿；超大单章也必须分块 |
| 9 | 多章窗口下进度、原文/DOM 映射、高亮、菜单、书签等适配；按章/可见块查绑定，详情正文按需 |
| 10 | Blob、DOM、LRU、句柄/Worker/监听器生命周期与关书释放 |
| 11 | 1,000/10,000 条批注及多绑定压力测试，长期内存与迁移/恢复验收 |

持续待查：历史 6 条笔记读取约 96.7s 的根因、章节加载偶发 1–4s、旧 findCurrentLine 深位置日志是否仍对应当前运行入口。已有分段计时，不能先用全量批注缓存掩盖问题，不能把旧日志或微基准当作已修复证明。

其他阅读要求：目录打开时用户控制滚动；重新打开直接居中当前章、不播放旧位置平滑动画，尽可能显示邻章，保留其他展开分支及独立“返回原处”。后续虚拟化时落实，勿重查已解决回跳。章节标题居中且比正文大，仍待实现/验收。

## 7. 验证与数据安全门槛

- 主样本：76,083,283 bytes（约72.6MiB）、UTF-8、约382,034行、约7,700章；测试第1/1600/6800章及接近100MB样本。计数口径需区分目录章与前言 section。
- 分开记录首次导入/热打开：首屏、扫描/映射、读取/解码/HTML/挂载、SQL/IPC、目录响应、滚轮边界长帧、主/渲染内存。无原文数据不得编造实测结果。
- 热开书零全文扫描/解码；深跳不随目标章号线性增长；目录不读正文；章节边界不清空正文等待；DOM/Blob/缓存数量有明确预算，不随已读章数持续增长。
- 回归选文、复制、菜单、新建/编辑/删除笔记、重叠高亮、目录跳转、阅读位置保存恢复。1,000/10,000实体压力同时记录绑定数，完整批注正文按需读取。
- 迁移使用隔离临时库和一致备份，失败可回滚；新表不能沿用吞异常迁移。禁止错误自动绑定，歧义宁可待处理；绑定失效不能删除批注或大批注正文。
- 不提交小说正文、私有摘录或原始用户日志。长时间阅读、反复开关书后检查资源释放；单次 RSS 高或不立即下降不能直接证明泄漏。
- 每阶段执行适用单测、类型检查、桌面构建及受影响阅读功能回归。结果标明“自动验证通过/用户已验证/待测”，不重复要求验收未受影响且已通过的事项。
- 提交后记录功能、接口/迁移、兼容影响、验证结果和下一步；实现细节保留在源码/提交，不在本文件累积完整日志和重复历史。
