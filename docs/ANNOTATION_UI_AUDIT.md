# UI-0：批注现有实现核对与后续实施方案

日期：2026-11-09。状态：**UI-0 已完成；UI-1～UI-7 未开始**。

本轮只核对源码、运行现有隔离基线测试和更新文档，没有修改应用源码、引擎产物、Schema 或产品规则。依据为 [批注专项需求](ANNOTATION_UI_REQUIREMENTS.md) 全文与 [项目总览](PROJECT_REQUIREMENTS.md) 第 5 节；旧实现不覆盖专项需求。本文中“拟新增”均为后续实现方案，不能当作已有接口或已经确认的交互细节。

## 1. 核对基线与边界

| 仓库 | 分支 | 核对 HEAD | 工作区/远端 |
|---|---|---|---|
| Koodo | diagnostics/phase1-logging | 92024e90 | 开始时干净；原本地 86535052 落后实际远端 10 个文档提交，核对差异后 fetch 并 ff-only 同步 |
| Kookit | diagnostics/phase1-logging | 5c4928d | 干净；GitHub 同名分支 HEAD 与本地一致 |

- 已读两个仓库根 AGENTS.md；源码目录检索未发现嵌套 AGENTS.md。
- Koodo 远端新增差异仅 5 个 docs 文件，无应用源码变化。未切换分支、重写历史或推送。
- 已读专项需求与新总览；技术文档按三类绑定、索引/读取、数据安全、验收相关章节查阅。
- 引擎核对来自 Kookit 源码；未读取 Koodo 的混淆/压缩引擎文件。测试按既有入口正常导入已编译引擎。
- 未打开正式用户数据库，未启动正式阅读器，未操作小说原文、正式绑定、书签或阅读记录。
- 不重新排查用户已确认的跨章连续、滚轮不中断、目录回跳；旧阶段 11 的实书与性能遗留保持未结项。

## 2. 总体结论

可复用三类独立实体与绑定、受控 IPC、CAS、原子创建、按页摘要、可见窗口关系查询、恢复与备份。此次不是重建批注底座，而是调整现有入口、展示和编辑职责，并补齐少量查询及标签身份。

主要差异是：标签没有作用域身份；原有工作区混合书籍且直接进入通用编辑器；通用编辑器含标题和颜色工具；阅读端缺少目标快捷栏、右键创建与三类当前章面板；交叠命中不是传递并集；单章预览尚不存在。

三类批注在数据库中已经是独立实体，不应再引入父子关系或第二套内容表。现有 title 字段和旧纯高亮数据应兼容保留，目标 UI 不显示/编辑标题、不新增纯高亮；不能通过界面改造清空历史字段或删除已有正式记录。

## 3. 源码与需求差异清单

下表的文件均为 Koodo 路径，标记 Kookit 的除外。

| 能力/需求 | 实际实现与证据 | 处理 |
|---|---|---|
| 三类独立实体 | src/utils/main/annotation-store.js：notes.kind=small/chapter/range；分别使用 note_bindings/chapter_bindings/range_bindings | 直接复用；range 是“大批注”的技术类型，不改业务含义 |
| 零绑定保留与多位置 | save 可创建无绑定实体；小批注可多个位置，章/范围表以部分唯一索引限制一个非解绑关系；解绑保留快照 | 复用；保留 active/pending/invalid/unbound 与实体正文的区别 |
| 原子创建/CAS | create 验证原文后同事务写实体+绑定；save/delete/解绑及换绑检查版本；范围校验同书同代、顺序和连续性 | 复用；编辑 UI 不先乐观覆盖正式状态；保存失败保留输入 |
| 仅正文和可选标签 | src/components/annotations/editor.tsx 显示 Title、Content、Tags；workspace.tsx 识别优先使用 title | 修改目标界面；隐藏标题且保存时保留已有 title，不顺便擦除历史内容；没有另设内部分类表的必要 |
| 标签身份 | AnnotationEntity.tag:string[]；notes.tag JSON；noteTag/component.tsx 使用全局 ConfigService.noteTags 名称及数组下标 | UI-1 新增稳定身份/作用域/关系；不能按显示名或数组下标管理新标签 |
| 标签管理 | deleteIcon → ConfigUtil.deleteTagFromNotes → remove-tag；默认只处理 small 且跨书按名称扫描，没有局部身份、三类统计、重命名/合并 | 不能把旧删除入口当成局部标签管理；UI-1 提供受控事务能力，UI-6 接管理 UI |
| 快捷栏/宽度 | pages/reader/component.tsx 为边缘悬浮入口；右面板是 SettingPanel，左面板是 NavigationPanel；utils/common.ts:getPageWidth 和 background/viewer 共同参与宽度计算 | UI-2 新增最右常驻窄栏和统一工作区布局；复用目录、设置内容与现有尺寸更新，避免三处各算一套 |
| 横向选文菜单 | popupMenu + popupOption 已有新建、追加到小批注、复制等动作；popupOption.css 仍是六列两行网格，并含多种原有工具 | 复用动作/复制链路及选区快照，改为已确认的横向主要入口；独立颜色/仅高亮入口退出新批注流程 |
| 纯高亮 | utils/reader/noteUtil.ts:createHighlight 在 Electron 下创建 notes="" 的 small；NativeTextPopup 也没有阻止空小批注保存 | UI-2 收口新建/追加入口及受控写入校验，禁止通过新流程创建无正文小批注；旧正式纯高亮不清理；章节/大批注空正文规则仍未定 |
| 右键创建 | viewer/component.tsx:handleBindGesture 已有一次绑定的 contextmenu，但依赖选区，仅更新选区弹窗位置；未提供章/大新建动作 | 扩展原监听器，无选文也解析右键坐标所属章节；不能用 currentChapterIndex 替代点击章 |
| 章/大新建 | 通用 editor 支持先保存、再 Load chapters/Set binding；未从右键自动绑定，也没有 2/3+1/3 或三栏创建布局 | UI-2 复用 create 事务直接创建带初始绑定的实体；大批注初始 start=end=右键章 |
| 追加已有小批注 | editor 的 append 按同书 small 分页搜索，再 bind 原实体 | 复用分页服务与 captureAnnotation；目标选择器只做追加，避免顺带修改原实体正文；具体选择器交互未定 |
| 章节选择规模 | editor.loadChapters 读取索引并把所有章节 map 为原生 option | 替换为有界虚拟选择器；复用 contentList/txtVirtual.ts 的范围计算、TXT 元数据目录读取；不复制目录回跳逻辑 |
| 正常绑定标识 | NativeTextPopup/通用 editor 使用 ColorOption；Kookit utils/txtWindowHighlights.ts 根据每条 style/priority 绘制 Custom Highlight；兼容路径使用 noteUtil.ts 的 span | UI-2 统一点线提示，保留旧样式数据和绘图能力；先在实际 Electron 验证点线绘制支持，不假定现有背景色 CSS 改一行即可 |
| 交叠命中 | Kookit TxtWindowHighlights.handleClick 取点击点命中的最短范围，回传一个 entityKey/bindingId；非窗口 span 走 closest 单条目标 | 改为传递交叠并集、实体去重；复用坐标映射/增量绘制，不把“点击点直接命中的条目”误当完整并集 |
| 浮动详情 | annotationUtil.annotationTarget 与 popupNote 路由直接打开编辑；缺少并集摘要、逐条展开及规定关闭行为 | 新增只读浮框；外点/Esc 关闭；打开时点击其他位置只关闭，下一次点击才打开新集合 |
| 当前章三类面板 | NavigationPanel 的旧 Note/Highlight → navList 只请求 kind:small，范围是本书；没有目标右侧当前章面板 | UI-3 新增三类型切换、实体列表和按需详情；不复用旧“笔记/高亮”分类作为三类 |
| 当前章查询 | list 支持 bookKey+kind+chapterIndex+chapterId+sourceTicket，经 active 同代关系 EXISTS 判断，已覆盖大批注范围含当前章 | TXT 复用，不另建覆盖表；保持小批注一实体一项。列表 DTO 暂缺绑定总数/涉及章摘要 |
| 阅读定位/返回 | navList.handleJump、canJumpAnnotation、rendition.goToPosition、store.reader.jumpPosition 与 pageWidget 的 Return 已存在 | UI-3 按用户点击的 binding 构造定位，不能始终用实体 DTO 第一个位置；复用现有单一返回位置机制，不新增返回栈 |
| 阅读二次编辑 | NativeTextPopup 当前能编辑小批注，通用 editor 编辑章/大；没有面板职责隔离 | UI-3 小批注右侧只读；章/大更新原 key/version，复用 UI-2 工作区；大编辑保留范围参考资料 |
| 大批注参考资料 | editor 的 Related annotations 是手动按钮，仅查询 start 章，包含三类；点击后 apply(value) 替换当前编辑对象 | 必须修改：按完整范围自动查 small/chapter，范围变化后刷新；资料详情独立只读状态，不替换大批注编辑对象；管理页不挂参考区 |
| 统一管理页 | noteList 提供 Annotations 切入 workspace；workspace 是多书/全类型过滤+卡片网格+通用编辑模态框 | UI-4 复用入口和服务，重组为一本书、左侧四项导航、中间摘要、右侧默认只读；不沿用 All books/All types 产品结构 |
| 三类详情布局 | 通用 editor 把正文、标签、绑定操作顺序堆叠且整个 section 滚动 | UI-4 分类型只读/编辑；小批注上部内容总高度最多右栏约2/3且短文收缩，下方位置独立滚动；章/大正文使用剩余空间 |
| 单章预览 | txtIndexService 提供独立 open/load/readChapter/readChapterRange/close；没有管理页预览组件 | UI-5 新增隔离预览；小批注按所选绑定定位高亮，章节从章首；大批注无预览/跳转；不调用主 rendition 导航/record |
| 恢复与备份 | annotation-store 的 export/import 与 import-database；backup.ts/restore.ts、main.js/backup-util.js 携带 annotations.v1.json；版本/冲突预检后事务导入 | 复用机制但 UI-1 必须同步扩展所有备份路径；仅改 schema 或 JSON 名字不足以完成兼容 |
| 绘图与云 | annotationDialog、Kookit annotationUtil 是绘图；main.js 保护性禁止旧 notes.db 云路径 | 绘图独立保留；不把“取消高亮工具”解释为删除绘图；不借 UI 改造恢复不安全旧云路径或声称新版云完成 |

## 4. 查询复用与需要补齐的协议

现有 AnnotationService 经 invokeMeasuredDatabaseCommand → database-command → annotation-store；继续使用这一条通道及诊断。新面板不要走 DatabaseService.getAllRecords("notes") 或 listAnnotationPages(..., true)。

| 接口 | 已有能力 | 需要补齐/限制 |
|---|---|---|
| list | limit 1～200；先分页键再取160字符摘要；book/kind/tags/当前章过滤，返回独立实体 | 增加有界绑定数量/章节摘要；按需设计范围参考查询，不通过全书循环列表模拟 |
| get | 读取完整正文与该实体所有三表绑定（含解绑历史） | 长正文继续按需；大量位置时拆出分页绑定摘要/单条绑定详情，避免一次搬所有 quote。现有服务内部写入返回也需评估，不能只给 UI 加分页 |
| reading-window | 限24块/128Ki字符窗口；小绑定分页且支持 afterId；无批注正文 | 保持原绘制路径与取消预算；related 章/大关系目前各最多200且无独立分页，不可直接作为完整右侧列表 |
| reading | 单章有效小绑定；非连续/非TXT适配 | 当前章完整列表使用实体分页而非此绘制接口；非TXT章/大绑定目前明确不支持，不伪造TXT坐标 |
| create/save/bind/unbind/delete | 原子创建、版本校验、实体与绑定分离、正式数据保护 | 复用；章/大正文和范围“同次保存”若最终需要整体原子提交，须新增组合受控事务，不能把多次IPC宣传为原子编辑 |
| export/import/import-database | v1格式清单、旧库适配、冲突拒绝、重复导入 | UI-1 实施新版本分派、迁移及多入口回归；保留对已有v1正式清单的读取 |

拟补齐三项查询（命名在实现时定，以下不是现有 action）：

1. **范围参考摘要**：验证同书、同代、两个章 ID 后，small 的有效绑定章落在范围内、chapter 的有效章落在范围内；只返回去重实体摘要，分页加载，不混入 range、不扫正文。范围改变用请求版本丢弃过期响应。
2. **交叠连通分量**：同书/同代/同章有效 small，按相交区间传递闭包处理 A∩B、B∩C；仅获取必要坐标/实体键和摘要。不能只在可见 DOM 截断处计算，因为相交链可能延伸到窗口外。先按坐标元数据合并区间，再分页详情；密集热点不逐条发 IPC，不静默截掉集合。
3. **绑定分页摘要**：实体/状态过滤，返回 bindingId、版本、章节快照名及摘录摘要；绑定管理与预览点击时取具体绑定。未绑定实体留在管理页，不出现在当前章面板。

新增查询须参数验证、受控排序与限额；用 EXPLAIN QUERY PLAN 和现有合成压力夹具验证索引。现有 notes_book_kind、notes_book_updated、绑定 chapter/entity/window 索引优先复用，只在测量证明有缺口时加索引。

## 5. UI-1 标签数据方案（待实现的技术建议）

**本轮不改库、不迁移。** 现有 schema/version 只接受 annotation_schema=1，export/import 只接受清单 version=1；不能原地把字符串数组换成对象而继续冒充原契约。

建议在原 notes.db 追加标签实体和关系表：

- 标签有稳定 ID、name、scope(global/book)、所属 bookKey（仅局部）、版本；关系以 noteKey+tagId 去重。
- 全局同名、同书局部同名分别做唯一约束；同名全局/局部与不同书局部身份保持独立。名称比较/空白规范化需明确，迁移不擅自把历史大小写或Unicode不同名称合并。
- 关系校验局部标签所属书与批注书籍一致；全局/局部均可供三类选择。数量按去重批注实体计数，不按绑定位置计数。
- 局部重命名/合并/删除在单事务中完成；合并去重且取消无写入；删除只移除标签关系与标签实体，绝不删除批注或绑定。相关实体版本须参与并发保护，旧编辑器不能复活已删除/被合并关系。
- 旧 tag 名称数组与 ConfigService.noteTags 都没有书籍作用域证据。建议以“保留原有跨书使用语义”迁为全局兼容标签；包含未在配置出现但已有批注引用的名称，且未使用的已有配置标签不能丢。不得根据人物名猜成局部；该映射是迁移建议，不是本轮已生效的产品决定。
- 新客户端引用 ID；旧 JSON 名称视图只作为兼容投影，名称相同的全局/局部不可在往返后塌缩。迁移、读取适配、旧导出字段之间只保留一个权威身份源，不做两个可独立修改的标签系统。
- 迁移前一致备份；升级按实际版本追加，失败回滚、重跑幂等。新Schema、版本清单、单库导出/导入、ZIP、快照都要更新；v1清单导入时转换引用并预检冲突，v2往返稳定保留ID/作用域/关系，重复恢复不造重复标签。
- 需核对 annotation-store 中位置式 INSERT 和 importData/exportData 硬编码字段，避免追加列后破坏原CRUD或恢复。
- 本期不新增全局标签管理页；UI-1 建数据和服务，UI-2 编辑器提供两类标签选择，UI-6 才接局部管理界面。

历史 title、style、旧空正文小批注和解绑快照都应保留在备份。小批注新建校验与历史数据兼容分开；章/大空正文、全局维护入口等产品待定项不能借迁移自行定稿。

## 6. 按阶段落地顺序与验收

| 阶段 | 具体实施顺序/主要位置 | 退出条件 |
|---|---|---|
| UI-1 标签作用域基础 | annotation-store 的追加迁移/标签事务 → annotationService 类型/适配 → backup/restore/backup-util 全路径 → 消除旧名称删除写入路径对新身份的干扰 | 隔离v1→新版本、失败回滚/重开幂等、跨书隔离、三类计数、同名合并/去重、并发、v1导入与新版往返通过；无全局管理UI |
| UI-2 阅读快速记录 | Reader 布局状态/窄栏 → 原选文与contextmenu监听扩展 → 共享正文/标签编辑核心 → 小底部、章两栏、大三栏 → 虚拟章节选择/范围参考 → 点线/并集浮框 | 无选文右键准确识别多章同屏点击章；小绑定单章限制不影响复制；追加实体数不变；create失败无半成品；参考点击不改原文/编辑对象；浮框关闭符合规则 |
| UI-3 阅读面板查询 | 新当前章三类列表+详情，复用 list 和按需详情 → 按所选binding定位/临时反馈 → 章/大编辑复用UI-2 | 一实体一项、范围覆盖正确、未绑定排除；小只读；跨章定位保留面板/详情并复用Return；类型切换不改阅读位置 |
| UI-4 统一管理 | 重组 workspace 与 noteList 入口 → 左书籍切换/四导航 → 中摘要 → 三类右详情/编辑/绑定弹窗 | 不混多书；未绑定保留；默认只读、保存回查看；小详情双独立滚动且短文收缩；管理大批注无参考/预览 |
| UI-5 单章预览 | 独立源会话/读取服务适配 → 中央大弹窗 → 小绑定坐标映射/高亮，章首预览 → 关闭/取消资源回收 | 只显示单章完整正文、不接邻章；不写主阅读位置/Return；Unicode/换行锚点正确；大批注无入口；巨章有界读取/渲染验证 |
| UI-6 局部标签管理 | 接UI-1服务，中/右合并宽列表，计数/新建/原位命名/确认删除与合并 | 同书三类名称同步；只解除标签关系；合并提示准确、取消零写入；无全局管理入口 |
| UI-7 交互与验收 | 统一视觉和可访问反馈；确定后落实未定稿细节；实书及规模/保存/恢复/受影响原生交互 | 真实样本与隔离规模分开记录；新UI安全/性能门槛通过；人工待测不冒充完成，旧性能遗留不自动结项 |

组件拆分以共享“正文+标签字段、只读详情、绑定摘要、章节选择”为单位；阅读工作区与管理页保留不同容器和能力开关。不能用一个不断加按钮的万能 editor 把阅读页变成管理器，也不能把原子数据逻辑复制进各组件。

只改 Koodo 能完成的阶段不构建 Kookit；点线绘制、点击集合与坐标能力确需引擎改动时改 Kookit 源码，正常 build:desktop 同步桌面ES模块与扫描器，并提交对应仓库。本轮 Kookit 无改动无需提交。

每阶段独立提交当前分支，提交前检查限定文件与适用验证，默认不推送。UI-2 涉及版式宽度/iframe适配时做受影响定位/复制回归，不把已解决的目录回跳或跨章滚动重列为待修问题。

## 7. 专项风险与仍未确认的产品细节

- **虚拟窗口并集**：视觉片段只表示当前挂载部分，不能当完整关系。大密度情况下按需检索与分页展示，不增加全书批注正文缓存。
- **点线与临时高亮**：现有引擎有搜索/TTS辅助高亮，但新导航反馈应独立标识、避免清除这些高亮；在实际 Electron 检查点线样式支持及字体/缩放后的几何位置。反馈时长/清除条件尚未定稿。
- **预览巨章**：readChapter 会组装整章字符串，可用于普通章；巨章需复用范围读取和块映射，以单章内部有界渲染满足“完整章可滚动”，不能把100MB单章一次转成DOM。预览不接入主窗口位置写回链路。
- **当前章稳定性**：连续窗口内右键点击章与视口当前章是两个上下文；编辑期间不能让后续滚动改变捕获的创建绑定。
- **格式边界**：现有非TXT适配仅小批注位置，章/范围服务拒绝非TXT绑定。先完成本期大型TXT目标，不把未支持格式标成全格式通过；如扩展必须单独核对格式定位契约。
- **数据保护**：历史title不能因隐藏控件被save默认空串覆盖；旧标签入口和旧导入也必须走新引用校验。v1未知作用域不猜局部、不重跑旧测试清库迁移。
- **待确认，不抢做**：精细搜索/筛选/排序/批量；选择器搜索/键盘/范围预览的具体体验；草稿/自动保存/未保存退出及空正文规则；标签颜色；状态视觉/撤销反馈；浮框边界/高度；拖动分栏、精确尺寸及小窗口降级。已有已确认流程可以继续实现，遇到依赖待定产品决定的环节再细化，不自行增加功能。

## 8. 本轮验证与证据

全部在 Koodo 92024e90 应用源码基线上运行；本轮只有文档改动，因此不重新生产构建引擎或应用产物，也未重跑未受影响的长测/全压力矩阵。

| 检查 | 本轮结果 | 覆盖边界 |
|---|---|---|
| yarn.cmd typecheck | 通过 | 当前渲染端类型基线 |
| node --test test/database-diagnostics.test.cjs test/annotation-diagnostics.test.cjs | 7/7通过 | IPC诊断隔离、SQL/转换分段、错误传递与日志隐私 |
| electron.exe test/annotation-store.electron.cjs | 21/21通过，退出0 | 隔离原生SQLite；实体/多绑定/单章/范围/CAS/解绑/迁移回滚/备份/冲突；userDatabaseOpened=false |
| electron.exe test/annotation-reader.electron.cjs | 18/18通过，退出0，rendererErrors=[] | 隔离StrictMode旧原生选文/弹窗/追加、通用章/大编辑及故障保留；normalCompiledEngine=true；userDatabaseOpened=false |
| 旧UI截图检查 | 已查看脚本生成的 native/editor 截图 | 验证当前仍有颜色条、标题与绑定控件；仅合成夹具，不是目标UI验收或真实应用全窗口验收 |

原始报告位于本机 TEMP：koodo-ui0-annotation-store-20261109.json、koodo-ui0-annotation-reader-20261109.json。可复现入口为上述现有脚本；界面脚本按顺序运行，未修改测试来迎合结果。

首次受限环境运行 Electron store 脚本因 GPU 子进程不可用而退出，未产生成功报告；在正常权限、同样TEMP隔离配置下重跑21项通过。界面测试日志中的 fixture failure 是已有触发器注入的预期失败，最终JSON和退出码均通过，不能误判为正式数据错误。

本轮不宣称目标新UI已完成，不把旧18项界面测试当作UI-2～UI-7验收；未测试真实小说、真实用户输入体验、新标签迁移或新版备份。下一阶段为 UI-1；按本次指令停在 UI-0。
