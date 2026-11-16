# Claude Code 保留原生技能发现

Claude Code 标准插件采用原生静态技能发现，允许未启用的工作区显示 Personal Bot 技能名称与简介。共用 `.pbot/config.json` 控制上下文注入；PreToolUse 对 Skill 调用、UserPromptExpansion 对用户直接展开的技能拦截未启用工作区的 pbot 工作方法，保留 `personal-bot:pbot` 初始化技能可用。技能发现、正文加载和模型调用遵循宿主机制，不增加动态目录或私有技能加载器。
