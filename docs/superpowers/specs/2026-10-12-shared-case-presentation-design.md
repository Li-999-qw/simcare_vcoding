# SimCare 统一病例呈现设计

## 目标

所有已接入的病例使用同一训练页面外壳和样式。患者登记资料、医学事实与报告继续由 MySQL `case_content` 管理；页面标题、阶段名称、图片路径及病例服务映射从新的 MySQL `case_presentations` 表读取。病例特有的介入、骨科手术、逐日腹水查房逻辑保持独立的引擎适配器，门户统一网关仍是唯一对外训练接口。

## 数据模型

`case_presentations`：`id BIGINT` 应用分配主键，`case_content_id BIGINT` 唯一外键，`portal_case_id INT`、`locale VARCHAR(8)` 联合唯一，`service_url`、`ui_variant`、`title`、`subtitle`、`stage_names JSON`、`ui_stage_names JSON`、`scene_names JSON`、`note_titles JSON`、`stage_times JSON`、`intro_quote`、`scene_image_path`、`intervention_image_path`、`cover_image_path`、`options JSON`，以及 `create_time`、`update_time`。图片路径只允许位于项目 `backend/` 目录下的相对路径，数据库仅保存地址，图片文件仍保留在磁盘。

现有 7 个病例首次启动时从当前病例文件和资源路径按 `engine_key` 插入初始记录；以后以数据库值为准，不用启动时的默认值覆盖编辑结果。旧练习在 `engine_sessions` 中保存的登记快照继续保持，后续新练习读取新配置。

## 页面与接口

网关 `/training/{attempt_id}/` 返回一份共享 HTML；`style.css` 返回一份共享 CSS。HTML 注入经过 JSON 编码的病例展示配置。现有病例脚本读取配置中的标题、阶段、场景图片与导语。网关集中提供 `/case-asset/{scene|intervention}`，病例卡片封面由 `/portal/case-cover/{case_id}` 从同一表读取。所有访问均沿用现有用户和练习所有权校验。

胸痛与维吾尔语胸痛使用同一心血管页面脚本，并以 `rtl_patient` 和导语配置区分；腰腿痛和腹水的专有流程仍通过各自的脚本模块运行。它们共用页面外壳、样式和网关接口。引擎继续独立进程运行，用作隔离专科流程的适配器；前端不直接访问这些进程。

## 兼容与验证

保留既有门户地址、会话 ID、病例 ID 和报告接口。先备份 MySQL，再加表并种入 7 个病例配置。验证表约束、原有数据行数、全部病例页面和封面、图片路径越界拒绝、英语与维吾尔语显示，以及现有引擎流程测试。
