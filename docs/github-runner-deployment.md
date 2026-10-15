# Windows Runner 自动部署

本仓库使用 GitHub Actions。配置文件是 `.github/workflows/deploy-local.yml`，部署入口是 `scripts/Deploy-Local.ps1`。

## 另一台电脑的一次性配置

1. Runner 必须关联此 GitHub 仓库并在线，具有 `self-hosted`、`Windows`、`X64` 标签。如果仓库注册了多台 Windows Runner，请给部署电脑加 `simcare` 标签，并将工作流的 `runs-on` 改成 `[self-hosted, Windows, X64, simcare]`。
2. 在 Runner 电脑准备一个**固定的、能正常启动的项目目录**，例如 `C:\SimCare`，不能使用 Runner 的 `_work` 检出目录。目录应包含 Nginx、已安装依赖的 `.venv` 或 Conda 环境、本机 `application.yml` 和 `data/server.json`。首次在该目录按原安装流程初始化，先手动执行一次 `Restart-Local.cmd` 确认可运行。
3. 仓库页面进入 **Settings → Secrets and variables → Actions → Variables → New repository variable**，添加：

   | Name | Value |
   | --- | --- |
   | `SIMCARE_DEPLOY_DIR` | Runner 电脑上的固定项目绝对路径，例如 `C:\SimCare` |

4. Runner 应使用拥有该部署目录权限的 Windows 账号运行。Conda 环境按 Windows 用户和项目路径定位，DPAPI 凭据也绑定用户；因此应使用完成项目安装和凭据配置的同一账号运行 Runner。若 Runner 安装为服务，请检查服务的登录账号及其 PATH（Git、Conda）。
5. 提交并推送工作流及本次相关代码到 `main`。工作流使用 `actions/checkout@v6`，Runner 需支持 Node 24（至少 v2.327.1，建议更新到当前版）。

## 自动执行

- 直接 push 到 `main`，或将其他分支合并到 `main`，都会触发部署。合并最终也会更新 `main`，无需另外注册 PR 关闭事件。
- 其他分支的 push 和未合并的 PR 不部署。可在 **Actions → Deploy SimCare on Windows → Run workflow** 手动执行，分支须选择 `main`。
- 每个任务在 Runner 工作区检出当时最新的 `main`，然后同步到固定部署目录。同一时间只执行一个部署，不会在重启过程中被后续 push 取消。
- 同步仅覆盖 Git 跟踪的应用文件，保留 `application.yml`、`data/`、`logs/`、`certs/`、Python 环境、`.env`、`.secrets`、引擎运行数据及本地生成的缓存。不会执行 `git clean` 或对部署目录执行镜像删除。
- 从第二次部署开始，只删除此前由部署清单管理、现在已从源码删除的文件。本地自行添加的文件不在删除范围内。首次部署前已遗留的旧文件不会自动删除。
- 随后执行 `Restart-Local.cmd --non-interactive`。该参数关闭暂停和自动打开浏览器，并向流水线返回真实退出码；双击 CMD 时仍保留原交互方式。
- 服务启动时不继承 Runner 的进程清理标识，任务结束后继续运行。`Restart-Local.ps1` 会检查病例服务端口、API 健康状态和门户 HTTP 状态，失败则部署标红。
- Nginx 的门户目录使用相对路径 `../frontend`，可适应不同电脑的部署路径。本地入口仍为 `http://127.0.0.1:8080/portal.html`。

成功部署的提交和 UTC 时间保存在部署目录的 `data/deployment.json`，管理的文件路径记录在 `data/deployment-manifest.json`。错误请查看 Actions 日志及部署电脑项目的 `logs/*.err`。同步失败或重启失败时不会写入新的成功记录，也不会自动回滚代码。

本流程更新应用代码和仓库内资源。Python 依赖变化时应先在部署电脑更新环境；不要在无人值守流水线中执行会交互创建管理员的 `Install.ps1`。电脑重启后恢复 Runner 服务可以继续接收部署，应用的开机自启动需另行配置。

## 手动调用

```powershell
# 两个目录应分别为源码检出目录和已初始化的固定部署目录。
.\scripts\Deploy-Local.ps1 -SourceDir 'C:\actions-runner\_work\simcare_vcoding\simcare_vcoding' -DeployDir 'C:\SimCare'

# 只重启现有固定安装：
& 'C:\SimCare\Restart-Local.cmd' --non-interactive
```

该部署脚本会覆盖目标目录内同名的受管理代码文件，请不要在部署目录直接修改应用代码。

参考：[GitHub 自托管 Runner 标签](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow)、[checkout 运行环境要求](https://github.com/actions/checkout#whats-new)、[Runner 子进程清理实现](https://github.com/actions/runner/blob/main/src/Runner.Worker/JobExtension.cs)。
