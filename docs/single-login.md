# 单账号单会话登录

同一账号每次成功登录都会替换 MySQL `user_login_sessions` 中的有效会话。
Cookie 门户登录和 `/auth/login` Bearer 登录共用这套策略；中英文门户、训练、报告和管理接口通过统一认证依赖验证会话。
同一浏览器的标签页共享 Cookie，可以同时使用。另一个浏览器或电脑重新登录会使旧会话失效。

## 部署

更新代码后运行 `Restart-Local.cmd`。启动迁移会自动创建新表，数据库账号需要建表及迁移权限。
也可以在 `simcare` 数据库中预先执行 `docs/sql/20261016-single-login.sql`；完整结构在 `docs/mysql-schema.sql`。
表有应用分配的 BIGINT 主键、用户唯一索引、`create_time`、`update_time`；数据库仅保存随机会话标识的 SHA-256 摘要。
登录并发通过锁定用户行和会话行串行更新。旧设备的退出请求仅撤销匹配的会话，不影响新登录。

首次上线后，旧版不含 sid 的登录凭证失效，所有用户需要重新登录。
已打开且尚未加载新脚本的页面需要刷新一次，之后具备自动跳转能力。

## 页面行为

- 服务器在新登录提交后拒绝旧会话的后续请求；已通过认证的在途请求不强行中断。
- 页面请求返回 `401 SESSION_REPLACED` / `SESSION_EXPIRED` 时自动返回对应语言的登录页。
- 15 秒一次轻量检查，并在窗口恢复焦点、页面恢复显示时检查。后台浏览器可能节流定时器。
- 网络断开和服务器故障不会被当作会话失效，也不会清空训练草稿。
- 登录页会显示“账号已在其他设备登录，请重新登录”或过期提示。

## 验证

在两个不同浏览器中登录同一账号：第二个登录成功后，第一个继续操作会跳转登录页，停留不操作时由定时检查触发。
新浏览器应能继续正常操作。错误密码登录不应挤掉已有会话。

自动测试：

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -p test_login_sessions.py
node tests/test_session_guard.js
```

`verify_case_presentation.py` 的只读路由检查需要通过 `SIMCARE_VERIFY_SESSION_COOKIES` 提供已有有效会话，JSON 格式为用户 ID 到 Cookie 值的映射。
检查工具不会创建登录或挤掉用户；执行完后清除该环境变量。
