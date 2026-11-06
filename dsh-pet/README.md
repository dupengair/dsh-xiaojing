# dsh-xiaojing（小鲸桌宠）

一只住在 [DeepSeek Harness](https://github.com/dupengair/dsh-xiaojing) 里的桌面宠物：一百余个透明动画、可多开、能上桌面，也能和指定的 DSH 会话绑在一起聊天。

- 完整文档、截图与更新说明：**<https://github.com/dupengair/dsh-xiaojing>**
- 基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) v0.4.1 二创，独立仓库在此，不再跟随上游

## 安装

**插件市场（推荐）**：DSH → 侧栏「插件」→「添加插件」→ 填 `dsh-xiaojing` → 安装 → 立即启用 → 重开 DSH。

**命令行**（先关掉 DSH）：

```
dsh plugin --profile <profile> add dsh-xiaojing
```

也可以填精确版本（`dsh-xiaojing@0.4.1`）钉住版本。装完重开 DSH，宠物会出现在桌面上。

## 主要功能

- **桌宠本体**：透明动画、拖拽抛掷、睡觉/动作/配图/碎碎念，多只宠物各自独立
- **DSH 会话打通**：网页端右侧栏面板、宠物右键「对话」弹窗、桌面 Helper 小窗都能绑定到同一个 DSH 会话；消息进入该会话，回复回到气泡里
- **助手能力**：查看余额与待办、按人设说话、可选配图

绑定是全局单值，存在 `$DSH_HOME/dsh-pet/main-config.jsonc` 的 `sessionBinding` 字段；数据目录与路由前缀保留上游原名，升级不需要迁移。

## 环境要求

- DeepSeek Harness 0.2.x（桌面版自带运行时）
- Node.js ≥ 22.12（命令行安装时）

## 许可

代码 MIT。素材禁止商用；二创在公开渠道须署名（见上游仓库的素材条款）。
