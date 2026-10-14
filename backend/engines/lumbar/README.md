# 腰椎间盘突出症独立演练

试用地址：http://127.0.0.1:8770/ 。原胸痛演练的 8765 端口保持独立。

病例来源为 `output/lumbar-case/case-data.json`（SIM-LDH-20260903，v1.1）。沿用既有病史、检查与围手术期病程；目前仍待临床和影像专家审核。

## 体验流程

从骨科普通诊室进入接诊，左侧与患者交流，右侧填写病历；可请教上级医师、查体、安排检查和填写医嘱。随后进入术前决策、手术回报、术后查房、出院指导和复盘。

影像包含腰椎 X 线、CT、MRI。申请后等待结果（也可使用等待下一份结果按钮推进模拟时间），打开报告，点击“打开 PACS 阅片”。PACS 仅展示该次已返回检查，支持原查看器的序列切换和多窗阅片；未返回的检查不能提前打开。图片为既有教学模拟影像，不是诊断用 DICOM。

## 维护

在项目根目录使用已安装依赖的 Python 启动：

```powershell
python lumbar-training/server.py --port 8770
```

模型调用使用本机已登录的 Codex 环境；会话和语音临时资料保存在忽略提交的 `runtime/` 中。

本目录由共享胸痛工作流生成。维护入口是 `rehearsal/lumbar_case.py`、`rehearsal/build_lumbar_training.py` 和 `rehearsal/pacs_gateway.py`，修改这些源文件后重新生成，避免只修改生成文件：

```powershell
python rehearsal/build_lumbar_training.py --pacs-source <原腰椎PACS的dist目录>
python rehearsal/test_lumbar_profile.py
```

PACS 静态资源复制自既有 `lumbar-pacs/dist`，原文件不被修改。场景来自生成的 `rehearsal/lumbar-scenes-v1.png`，包含门诊、手术室、病房及出院四个场景。

已验证：患者和上级医师真实文字回复；影像申请、结果返回、报告打开 PACS；四窗影像加载；未返回检查和跨检查影像访问限制。完整临床教学验收仍需教师试用。
