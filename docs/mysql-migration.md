# SimCare MySQL 数据迁移与维护

项目业务数据库为 MySQL `simcare`。运行时统一读取项目根目录的 `application.yml`，此文件已被 `.gitignore` 忽略。首次安装可复制 `application.example.yml`，然后修改地址与凭据：

```yaml
spring:
  datasource:
    url: jdbc:mysql://数据库地址:3306/simcare?useUnicode=true&characterEncoding=UTF-8&serverTimezone=GMT%2B8&allowPublicKeyRetrieval=true&useSSL=false
    username: 数据库用户
    password: 数据库密码
    driver-class-name: com.mysql.cj.jdbc.Driver
```

数据库 IP 变化时只需修改 `application.yml` 中 JDBC URL 的主机部分，再运行 `Restart-Local.ps1 -NoBrowser`（本地预览）或重启正式服务；运行中的连接不会自动切换。安装环境时需要 `PyMySQL` 和 `PyYAML`（均已写入 `environment.yml`）。启动时若 MySQL 不可访问会报错，不会回退到 SQLite。

`backend/runtime/import_sqlite_to_mysql.py` 从保留的 `data/clinical.db` 按主键导入门户用户、任务、历史练习和语言绑定，重复执行会跳过已有行。七个引擎首次从旧 `runtime/sessions.json` 导入会话后记录在 `engine_imports`，之后只从 MySQL 读写会话。原 SQLite 和 JSON 文件均保留作备份，不再作为业务写入目标。实际建表 SQL 见 [mysql-schema.sql](mysql-schema.sql)。

## 主键与审计时间

`simcare` 的 17 张业务表统一使用 `id` 单列主键，以及非空的 `create_time`、`update_time`。`update_time` 由 MySQL 的 `ON UPDATE CURRENT_TIMESTAMP(6)` 维护。原有 `created_at`、`updated_at` 字段暂时保留，兼容现有接口与历史记录。原来的业务主键（如 `engine_key`、`attempt_id`）改为唯一键。

新增记录的 `id` 由应用层 `backend/runtime/ids.py` 分配，参照 MyBatis-Plus `IdType.ASSIGN_ID` 的 Snowflake 思路，不依赖 MySQL `AUTO_INCREMENT`。为避免前端 JavaScript 丢失整数精度，采用 53 位布局：40 位毫秒时间、10 位工作节点、3 位同毫秒序号。启动脚本按端口给各服务分配不同的 `SIMCARE_WORKER_ID`；其他多进程部署必须给每个写入进程配置不同的 0–1023 工作节点编号。历史 ID 不重写，因此旧账号和练习链接仍可用；`portal_attempts.id`、`knowledge_items.id` 保留字符串列以容纳历史标识，但新 ID 均为十进制数字字符串。

对已有 `simcare` 数据库升级时，先停止本项目写入服务，然后按顺序运行：

```powershell
.\.venv\Scripts\python.exe -m backend.runtime.backup_mysql
.\.venv\Scripts\python.exe -m backend.runtime.normalize_mysql_schema
.\.venv\Scripts\python.exe -m backend.runtime.verify_mysql_schema
```

备份保存在 git 忽略的 `data/simcare-before-id-migration-*.json.gz`，含全部业务数据，请限制访问。迁移脚本可重复运行，会保留原数据和行数；如果迁移中断，先检查备份和表结构，再重跑。修改表结构后可运行 `backend.runtime.export_mysql_schema` 更新本文件旁的建表 SQL。

## 核心表

| 表 | 用途 |
| --- | --- |
| `users`, `cases`, `assignments`, `training_sessions`, `audit_events` | 账户、病例任务与审计 |
| `portal_documents`, `portal_attempts`, `knowledge_items` | 门户目录、练习与学习记录 |
| `language_unification`, `attempt_language` | 多语言练习绑定 |
| `engine_sessions`, `engine_attempt_links`, `engine_imports` | 七个病例引擎的会话、门户关联及一次性导入标记 |
| `case_content` | 各病例的临床事实与报告模板；原始登记 JSON 仅供首次迁移和兼容旧数据 |
| `case_patients` | 患者姓名、性别、年龄、职业、病史陈述者等列化登记资料，按病例内容一对一关联 |
| `case_presentations` | 训练页面标题、阶段名称、图片地址及病例服务映射 |
| `application_settings` | 非敏感的模型选择与角色人设 |

二进制图片和音频模型仍保留为文件。OpenAI、百炼与腾讯云凭据以 Windows DPAPI 加密后存入 `application_settings`，旧加密文件仅在首次读取时导入；解密仍要求原 Windows 服务账号。`case_content.engine_key` 使用 `chest`、`lumbar`、`ascites`、`uyghur` 及 `en-chest`、`en-lumbar`、`en-ascites`。首次启动将既有登记 JSON 导入 `case_patients`；之后以 `case_patients` 为准。更改登记信息后重启对应引擎，新建练习会读取新资料；历史会话保留创建时的登记快照。

例如修改胸痛患者姓名（先备份，再在 MySQL 客户端执行）：

```sql
UPDATE case_patients p
JOIN case_content c ON c.id = p.case_content_id
SET p.name = '新姓名'
WHERE c.engine_key = 'chest';
```

修改其他人口学资料使用 `case_patients` 的 `sex`、`age`、`marital_status`、`occupation`、`ethnicity`、`birthplace`、`address`、`history_source`、`admission_status` 列。患者回答中的身份陈述由登记信息生成；其他病史与报告内容分别位于 `case_content.facts`、`reports` JSON 字段。

## 统一病例页面和图片

门户训练页面由一份 `backend/main/app/training_ui/index.html` 与一份 `style.css` 渲染。`case_presentations` 通过 `case_content_id` 与患者登记和报告内容关联，包含 7 个中英文病例展示配置。`portal_case_id` 与 `locale` 唯一；原有练习 ID 和门户病例 ID 不变。病例服务仍执行各自的专科逻辑，外部统一经 `/training/{attempt_id}/` 路由访问。

`scene_image_path`、`intervention_image_path`、`cover_image_path` 是相对于项目 `backend/` 目录的图片路径，文件本身仍放在项目资源目录。只允许 `png`、`jpg`、`jpeg`、`webp`；不允许绝对路径或 `..` 穿越。门户封面与训练图片从该表实时读取，编辑路径后刷新页面即可看到新图。

例如同时修改胸痛病例的患者场景图与封面（路径对应实际存在的文件）：

```sql
UPDATE case_presentations p
JOIN case_content c ON c.id = p.case_content_id
SET p.scene_image_path = 'engines/chest/public/assets/patient-scenes-expanded-v1.png',
    p.cover_image_path = 'engines/chest/public/assets/patient-scenes-expanded-v1.png'
WHERE c.engine_key = 'chest';
```

页面标题、阶段和场景名称可直接修改 `title`、`subtitle`、`ui_stage_names`、`scene_names`、`note_titles`、`intro_quote`。`case_patients` 的患者资料与 `case_content.facts`、`reports` 由病例引擎启动时载入；`case_presentations.stage_names`、`stage_times` 同样在启动时载入。修改这些临床配置后重启对应引擎，仅影响新建练习；历史练习保留原始快照。更改 `service_url` 前需确认目标确为本机可信病例服务。
