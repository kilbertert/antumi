import type { AgentDescriptor } from './agent-descriptor'

// CodeBuddy Code's own ACP modes. Its sign-in picks the Chinese or the international site and is
// one for the whole machine: every other account is an API key, for the edition it was made in.
export const codebuddy: AgentDescriptor = {
  translations: { en: {
    modes: {
      ask: { label: 'Always Ask', description: 'Ask before each tool’s first use' },
      acceptEdits: { label: 'Accept Edits', description: 'Edit files directly; other actions still ask' },
      plan: { label: 'Plan', description: 'Read code and propose a plan; execute after your approval' },
      auto: { label: 'Auto', description: 'An AI reviewer approves or blocks each action instead of asking' },
      bypass: { label: 'Bypass Permissions', description: 'Run every tool without approval prompts' }
    },
    environment: {
      role: 'Runs with `codebuddy --acp` in chat, on the Chinese or the international site, whichever you signed in to.',
      install: 'npm install -g @tencent-ai/codebuddy-code',
      signIn: 'Run codebuddy in a terminal and choose Chinese Site or International Site to sign in'
    },
    usageWhere: 'Check your plan on codebuddy.cn or codebuddy.ai',
    accountKeys: {
      editions: [{ id: 'international', label: 'International' }, { id: 'china', label: 'China' }, { id: 'ioa', label: 'iOA' }],
      only: true,
      hint: 'Create an API key in the console of the edition it is for. Your own account stays the one you signed in to in a terminal.'
    }
  } },
  label: 'CodeBuddy',
  cli: 'codebuddy',
  setup: 'account',
  modes: {
    ask: { label: '每次询问', description: '每个工具第一次使用前先问你' },
    acceptEdits: { label: '自动接受编辑', description: '改文件不再问，其他操作仍会问' },
    plan: { label: '规划', description: '只读代码、给出计划，你确认后才动手' },
    auto: { label: '自动审查', description: '由 AI 审查每个操作并直接放行或拦下，不再问你' },
    bypass: { label: '全部放行', description: '所有工具直接运行，不再询问' }
  },
  startModes: ['ask', 'acceptEdits', 'plan', 'auto'],
  defaultStartMode: 'ask',
  discussionMode: 'plan',
  readOnlyMode: 'plan',
  // Its reviewer settles what would ask, so nothing waits on a person.
  unattendedModes: ['auto'],
  capabilities: { readOnly: false, unattended: true, bypass: true, autoMode: true, pathMentions: false, optionsWhileBusy: false, skills: false, userMcp: true, modelProviders: [], accounts: true },
  environment: {
    role: '聊天界面以 `codebuddy --acp` 运行它，用的是你登录的中国站或国际站。',
    install: 'npm install -g @tencent-ai/codebuddy-code',
    signIn: '在终端运行 codebuddy，选择 Chinese Site（中国站）或 International Site（国际站）登录'
  },
  usageWhere: '在 codebuddy.cn 或 codebuddy.ai 查看套餐用量',
  accountKeys: {
    editions: [{ id: 'international', label: '国际版' }, { id: 'china', label: '国内版' }, { id: 'ioa', label: 'iOA' }],
    only: true,
    hint: '在对应版本的控制台创建 API Key。本机账号仍是你在终端里登录的那个。'
  }
}
