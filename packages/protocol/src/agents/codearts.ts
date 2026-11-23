import type { AgentDescriptor } from './agent-descriptor'

const INSTALL = 'sh -c "$(curl -L https://cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com/codearts/cli_tui/install_script/install.sh)"'

// Huawei Cloud's CodeArts Agent (码道), run through Antumi's bridge to its local server. Its modes
// are its primary agents: ask is its own Build, which edits without asking and runs commands in
// its sandbox, asking before those it finds risky; the others are agents Antumi adds at launch,
// held to their rules by a permission plugin Antumi loads with them. Plan and read-only take its
// edit and command tools away, as it cannot be made to ask for them. Outside its TUI it runs only
// with an access key in its environment.
export const codearts: AgentDescriptor = {
  translations: { en: {
    modes: {
      ask: { label: 'Build', description: 'CodeArts’s own Build: edits files without asking, runs commands in its sandbox and asks before risky ones' },
      acceptEdits: { label: 'Automatic', description: 'Edit and run commands in the project; anything outside it, or a command CodeArts finds risky, is refused, not asked' },
      plan: { label: 'Plan', description: 'Read code and propose a plan; edits nothing and runs no commands' },
      readOnly: { label: 'Read only', description: 'Read files and answer; edits nothing and runs no commands' },
      bypass: { label: 'Allow everything', description: 'No approval prompts; commands still run as CodeArts’s run mode says' }
    },
    environment: {
      role: 'Runs its local server (`codearts serve`) through Antumi’s bridge in chat. Other Agents can be used without it.',
      install: INSTALL,
      signIn: 'Create an access key (AK/SK) in Huawei Cloud and set CODEARTS_CLI_AK and CODEARTS_CLI_SK where Antumi sees them (on macOS with launchctl setenv), then restart Antumi'
    },
    usageWhere: 'Check your plan in the CodeArts console on Huawei Cloud'
  } },
  label: 'CodeArts',
  cli: 'codearts',
  setup: 'account',
  modes: {
    ask: { label: 'Build', description: '码道自己的 Build：改文件不问，命令在它的沙箱里运行，有风险的先问你' },
    acceptEdits: { label: '自动', description: '在项目里自由修改、运行命令；项目外的操作和码道认为有风险的命令直接拒绝，不会停下来问' },
    plan: { label: '规划', description: '读代码、给出计划；不修改文件，也不运行命令' },
    readOnly: { label: '只读', description: '只读文件、回答问题；不修改文件，也不运行命令' },
    bypass: { label: '全部放行', description: '什么都不问；命令仍按码道的运行模式执行' }
  },
  startModes: ['ask', 'acceptEdits', 'plan', 'readOnly'],
  defaultStartMode: 'ask',
  discussionMode: 'readOnly',
  readOnlyMode: 'readOnly',
  capabilities: { unattended: true, bypass: true, autoMode: false, pathMentions: false, optionsWhileBusy: false, skills: true, userMcp: true, modelProviders: [], accounts: false },
  environment: {
    role: '聊天界面经 Antumi 的桥运行它的本地服务（`codearts serve`）；没装也可以使用其他 Agent。',
    install: INSTALL,
    signIn: '在华为云创建访问密钥（AK/SK），把 CODEARTS_CLI_AK 和 CODEARTS_CLI_SK 设为 Antumi 能读到的环境变量（macOS 用 launchctl setenv），然后重启 Antumi'
  },
  usageWhere: '在华为云码道控制台查看套餐用量'
}
