/**
 * dsh-tokens-ci browser half.
 *
 * Registers one page into the settings panel's `settings.section` list slot —
 * the same seat the official General / Models / Plugins pages occupy — and
 * renders the tokens.ci usage report this plugin's host half serves over the
 * shared `/api` transport.
 *
 * Presentation rules the page is built around:
 *
 * - **The daily chart is the page.** "How much did I use today, and how does
 *   that compare with the rest of the window" is the question a usage page
 *   answers, so the chart gets the widest element on the page and everything
 *   else supports it. Inspection is a readout strip above the chart rather
 *   than a floating tooltip: the panel column is ~560px wide inside its own
 *   scroll container, where a positioned tooltip clips, and a strip reserves
 *   its own height so inspecting a day never moves the bars.
 * - **Keyboard parity.** The bars are buttons in one roving-tabindex group, so
 *   arrow keys walk the window and Home/End jump to its edges, with the readout
 *   following focus exactly as it follows the pointer. The public page offers
 *   the same, and a chart nobody can read without a mouse is not finished.
 * - **Two windows, never conflated.** The public leaderboard's `month` is the
 *   calendar month to date; this profile's `month` is the last 30 days. When
 *   the two disagree the page says so instead of printing a rank beside numbers
 *   from another window.
 * - **Cached numbers look cached.** A report answered from the on-disk snapshot
 *   renders dimmed with its age, because fresh-looking stale numbers are the
 *   one failure mode a usage page must not have.
 * - **Theme tokens only.** Every colour, border and radius comes from `--dsw-*`;
 *   the chart's series palette uses the design system's own static palette
 *   rather than literals, so light and dark both work.
 *
 * Hand-authored bundle: no build step, so components use `React.createElement`
 * rather than JSX, and styling is one injected stylesheet keyed on `.tci-`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-tokens-ci',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    /** Channel and endpoint the host half registers. */
    const CHANNEL = '/api'
    const ENDPOINT = 'tokens-ci/report'
    /** Locale namespace this plugin owns. */
    const NS = 'dsh.tokensCi'
    /** The injected stylesheet's id, so a reload cannot stack copies. */
    const STYLE_ID = 'dsh-tokens-ci-style'

    /** Periods, in the order the switch offers them. */
    const PERIODS = ['week', 'month', 'all']

    /**
     * How long to wait before looking again.
     *
     * A snapshot answer means the host is already re-reading upstream behind it,
     * so the page re-asks almost at once and the numbers go live while the
     * reader is still on the first line. A live answer is good for longer: the
     * upstream only moves when the submitting CLI runs.
     */
    const REVALIDATE_MS = 2_500
    const POLL_MS = 120_000
    /** Cadence after a failure, so a transient outage heals without a reload. */
    const RETRY_MS = 30_000

    /** Series palette: design-system static colours, distinct in both themes. */
    const SERIES = [
      { key: 'cacheRead', color: 'var(--dsw-static-green-500)' },
      { key: 'input', color: 'var(--dsw-static-deepseek-500)' },
      { key: 'output', color: 'var(--dsw-static-amber-500)' },
      { key: 'reasoning', color: 'var(--dsw-static-red-400)' },
      { key: 'cacheWrite', color: 'var(--dsw-static-blue-400)' },
    ]

    const CSS = `
.tci-root{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:18px;font-variant-numeric:tabular-nums;
  container-type:inline-size}

/* The settings panel is 800px wide at full size, but it caps at 100vw minus
   48px, so a narrow browser window narrows this column instead of the panel.
   A media query would test the viewport rather than the column, so the page
   queries its own width and drops to one column before the figures inside
   those columns start to elide. */
@container (max-width:460px){
  .tci-stats,.tci-legend,.tci-standing{grid-template-columns:minmax(0,1fr)}
  .tci-tools{flex-wrap:wrap;justify-content:flex-end}
  .tci-model{grid-template-columns:minmax(0,1fr) 48px}
  .tci-model-figures{display:none}
}

/* ---- header ---- */
.tci-head{display:flex;align-items:flex-start;gap:12px}
.tci-avatar{flex:none;width:40px;height:40px;border-radius:50%;object-fit:cover;
  background:var(--dsw-alias-interactive-bg-hover)}
.tci-avatar-fallback{flex:none;width:40px;height:40px;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-size:14px;font-weight:500;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.tci-id{flex:1;min-width:0}
.tci-name{display:flex;align-items:center;gap:6px;font-size:15px;line-height:20px;font-weight:500;
  min-width:0}
.tci-name a{color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.tci-name a:hover{text-decoration:underline}
.tci-badge{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:14px;height:14px;border-radius:50%;color:var(--dsw-alias-label-primary-inverted);
  background:var(--dsw-static-deepseek-500);font-size:9px;line-height:1}
.tci-meta{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:3px;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-caption)}
.tci-today{color:var(--dsw-alias-label-secondary)}
.tci-today b{font-weight:500;color:var(--dsw-alias-label-primary)}
.tci-tools{flex:none;display:flex;align-items:center;gap:8px}

.tci-seg{display:flex;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-interactive-bg-hover)}
.tci-seg button{appearance:none;border:0;background:transparent;cursor:pointer;
  font:inherit;font-size:12px;line-height:16px;padding:4px 10px;border-radius:var(--dsw-radius-xs,4px);
  color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tci-seg button:hover{color:var(--dsw-alias-label-primary)}
.tci-seg button[aria-pressed="true"]{background:var(--dsw-alias-button-elevated-fill);
  color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft)}
.tci-seg button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:1px}
.tci-icon-btn{width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;
  background:transparent;color:var(--dsw-alias-label-secondary)}
.tci-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tci-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:1px}
.tci-icon-btn[disabled]{cursor:default;opacity:.5}
.tci-spin{animation:tci-spin 900ms linear infinite}
@keyframes tci-spin{to{transform:rotate(360deg)}}

/* ---- cards ---- */
.tci-card{display:flex;flex-direction:column;min-width:0;padding:12px 16px;
  border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));
  border-radius:var(--dsw-radius-xl,20px);
  background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2))}
.tci-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.tci-card-title{font-size:13px;line-height:18px;font-weight:500}
.tci-card-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);
  text-align:right;min-width:0}

/* ---- chart ---- */
.tci-readout{display:flex;flex-direction:column;justify-content:center;gap:1px;
  min-height:36px;margin-top:8px;font-size:12px;line-height:16px}
.tci-readout-main{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 10px}
.tci-readout-day{font-weight:500;color:var(--dsw-alias-label-primary)}
.tci-readout-sub{display:flex;flex-wrap:wrap;gap:2px 12px;color:var(--dsw-alias-label-caption);
  font-size:11px;line-height:14px}
.tci-readout-idle{color:var(--dsw-alias-label-caption)}
.tci-readout-idle b{font-weight:500;color:var(--dsw-alias-label-primary)}
.tci-chart{display:flex;align-items:flex-end;gap:2px;height:124px;margin-top:2px}
.tci-bar{flex:1 1 0;min-width:0;height:100%;display:flex;align-items:flex-end;
  padding:0;border:0;background:transparent;border-radius:3px;cursor:default}
.tci-bar>i{display:block;width:100%;border-radius:3px 3px 1px 1px;
  background:color-mix(in srgb, var(--dsw-static-deepseek-500) 44%, transparent);
  transition:background 120ms ease}
.tci-bar:hover>i,.tci-bar[data-active="true"]>i,.tci-bar[data-today="true"]>i{
  background:var(--dsw-static-deepseek-500)}
.tci-bar[data-zero="true"]>i{background:var(--dsw-alias-interactive-bg-hover)}
.tci-bar:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:1px}
.tci-axis{display:flex;justify-content:space-between;gap:8px;margin-top:7px;
  font-size:11px;line-height:14px;color:var(--dsw-alias-label-caption)}

/* ---- stat grid ---- */
.tci-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;
  border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,12px);
  overflow:hidden;background:var(--dsw-alias-border-l1)}
.tci-stat{padding:11px 14px;background:var(--dsw-alias-bg-layer-2);min-width:0}
.tci-stat-label{font-size:11px;line-height:14px;color:var(--dsw-alias-label-caption)}
.tci-stat-value{margin-top:3px;font-size:17px;line-height:22px;font-weight:500;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tci-stat-sub{margin-top:2px;font-size:11px;line-height:14px;
  color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ---- token mix ---- */
.tci-mix{display:flex;gap:1px;height:10px;margin-top:12px;border-radius:5px;overflow:hidden;
  background:var(--dsw-alias-interactive-bg-hover)}
.tci-mix i{display:block;height:100%;min-width:0}
.tci-legend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 18px;margin-top:12px}
.tci-legend-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto auto;
  align-items:center;gap:8px;font-size:12px;line-height:16px;min-width:0}
.tci-dot{width:8px;height:8px;border-radius:2px}
.tci-legend-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-secondary)}
.tci-legend-value{color:var(--dsw-alias-label-caption);font-size:11px}
.tci-legend-share{font-weight:500;min-width:44px;text-align:right}

/* ---- standing ---- */
.tci-standing{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;
  margin-top:12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,12px);
  overflow:hidden;background:var(--dsw-alias-border-l1)}
.tci-standing>div{padding:10px 12px;background:var(--dsw-alias-bg-layer-2);min-width:0}
.tci-note{margin-top:9px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-caption)}

/* ---- model rows ---- */
.tci-models{display:flex;flex-direction:column;gap:2px;margin-top:10px}
.tci-model{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto 52px;
  align-items:center;gap:10px;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px);isolation:isolate}
.tci-model:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tci-model-fill{position:absolute;left:0;top:1px;bottom:1px;z-index:-1;border-radius:var(--dsw-radius-sm,8px);
  background:color-mix(in srgb, var(--dsw-static-deepseek-500) 15%, transparent)}
.tci-model-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tci-model-figures{display:flex;gap:12px;font-size:11px;
  color:var(--dsw-alias-label-caption);white-space:nowrap}
.tci-model-share{text-align:right;font-weight:500;font-size:12px}

/* ---- clients ---- */
.tci-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.tci-chip{display:inline-flex;align-items:baseline;gap:6px;padding:4px 10px;border-radius:999px;
  font-size:12px;line-height:16px;background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-secondary);max-width:100%}
.tci-chip b{font-weight:500;color:var(--dsw-alias-label-primary)}
.tci-chip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---- states ---- */
.tci-state{display:flex;flex-direction:column;gap:10px;padding:18px 2px;
  align-items:flex-start;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:19px}
.tci-state-title{font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.tci-button{appearance:none;cursor:pointer;font:inherit;font-size:12px;line-height:16px;
  padding:5px 12px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary)}
.tci-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tci-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:1px}
.tci-skeleton{border-radius:5px;background:var(--dsw-alias-bg-skeleton)}
.tci-field{display:flex;gap:8px;margin-top:12px;width:100%;max-width:420px}
.tci-input{flex:1;min-width:0;box-sizing:border-box;height:30px;padding:0 10px;
  font:inherit;font-size:13px;line-height:18px;border-radius:var(--dsw-radius-sm,8px);
  border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary)}
.tci-input::placeholder{color:var(--dsw-alias-label-caption)}
.tci-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.tci-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:1px}
.tci-button-primary{background:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-inverted);border-color:transparent}
.tci-button[disabled]{cursor:default;opacity:.5}
.tci-text-button{appearance:none;border:0;background:transparent;padding:0;cursor:pointer;
  font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-link)}
.tci-text-button:hover{text-decoration:underline}
.tci-text-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:2px}
.tci-left{text-align:left}
.tci-dim{opacity:.64}
.tci-foot{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;
  font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}
.tci-foot a{color:var(--dsw-alias-link);text-decoration:none}
.tci-foot a:hover{text-decoration:underline}
.tci-warn{color:var(--dsw-alias-state-warn-label)}
`

    /** Every string this page renders, in both shipped UI languages. */
    const DICT = {
      en: {
        nav: 'Tokens.ci',
        scopeWeek: 'Week',
        scopeMonth: 'Month',
        scopeAll: 'All time',
        refresh: 'Refresh',
        refreshing: 'Refreshing',
        daily: 'Daily usage',
        metricTokens: 'Tokens',
        metricCost: 'Cost',
        hoverHint: 'Point at a bar, or press ← → to walk the window',
        dayCount: '{count} days',
        totalLabel: 'total',
        peak: 'peak {value} on {date}',
        activeDays: '{count} active days',
        statTokens: 'Tokens',
        statCost: 'Cost',
        statActiveDays: 'Active days',
        statMessages: 'Messages',
        statRank: 'Rank',
        statAhead: 'Ahead of',
        statShare: 'Field share',
        streakDays: '{count}-day streak',
        ratePerMillion: '{value} per million tokens',
        avgPerActiveDay: '{value} per active day',
        cacheHit: '{value} of prompts cached',
        ofDevelopers: 'of {count} developers',
        developersBehind: '{count} developers behind',
        ofFieldTokens: 'of {value} tokens',
        mixTitle: 'Token mix',
        mixNote: 'Where the tokens went',
        cacheRead: 'Cache read',
        input: 'Input',
        output: 'Output',
        reasoning: 'Reasoning',
        cacheWrite: 'Cache write',
        mixHint: 'Cache read is prompt context the model reused — {value} of every prompt token.',
        standing: 'Standing',
        standingWeek: 'This week',
        standingMonth: 'Calendar month to date',
        standingAll: 'All time',
        standingMismatch:
          'The public table counts the calendar month to date, while the usage above covers the last 30 days. The rank belongs to the table, not to these numbers.',
        models: 'Models',
        modelByCost: 'By cost',
        modelByTokens: 'By tokens',
        modelsNoteCost: 'Share of the window’s cost',
        modelsNoteTokens: 'Share of the window’s tokens',
        modelsMore: '{count} more not shown',
        clients: 'Clients',
        clientsNote: 'Tools that reported this usage',
        clientsMore: '+{count} more',
        today: 'Today',
        joined: 'Joined {date}',
        updated: 'Updated {age}',
        justNow: 'just now',
        minutesAgo: '{count}m ago',
        hoursAgo: '{count}h ago',
        daysAgo: '{count}d ago',
        cliVersion: 'CLI {version}',
        sessions: '{count} sessions',
        openProfile: 'Open on tokens.ci',
        openLeaderboard: 'Leaderboard',
        staleWarning: 'Showing the last saved reading, {age}. {message}',
        loading: 'Reading your tokens.ci usage…',
        accountTitle: 'Which tokens.ci account?',
        accountBody:
          'This page reports the usage the Tokens CLI submits for one GitHub account. It is kept on this machine and the row’s own config.username still wins over it.',
        accountLabel: 'GitHub handle',
        accountPlaceholder: 'your-github-handle',
        accountInvalid: 'A GitHub handle is letters, digits, dot, dash and underscore.',
        accountProbed: 'Looked in: {list}',
        save: 'Save',
        saving: 'Saving…',
        cancel: 'Cancel',
        changeAccount: 'Change account',
        accountSource: 'Account @{name} — {origin}',
        unknownTitle: 'No usage for @{username}',
        unknownBody:
          'tokens.ci has no submissions for that handle. Either it is not the GitHub account whose usage the Tokens CLI submits, or nothing has been submitted yet — install the CLI, sign in and submit once.',
        errorTitle: 'Could not read tokens.ci',
        genericError: 'The report could not be read.',
        errorUnloaded:
          'The host half of this plugin is not answering. It loads with the profile — restart dsh, then reopen this page.',
        emptyTitle: 'No activity in this window',
        emptyBody: 'Nothing was submitted for these dates. Another period may have data.',
        retry: 'Try again',
      },
      zh: {
        nav: 'Tokens.ci',
        scopeWeek: '本周',
        scopeMonth: '本月',
        scopeAll: '全部',
        refresh: '刷新',
        refreshing: '刷新中',
        daily: '每日用量',
        metricTokens: 'Token',
        metricCost: '费用',
        hoverHint: '指向柱形，或按 ← → 逐日查看',
        dayCount: '{count} 天',
        totalLabel: '合计',
        peak: '最高 {value}（{date}）',
        activeDays: '{count} 个活跃日',
        statTokens: 'Token',
        statCost: '费用',
        statActiveDays: '活跃天数',
        statMessages: '消息数',
        statRank: '排名',
        statAhead: '领先',
        statShare: '占全站',
        streakDays: '连续 {count} 天',
        ratePerMillion: '每百万 token {value}',
        avgPerActiveDay: '活跃日均 {value}',
        cacheHit: '提示缓存命中 {value}',
        ofDevelopers: '共 {count} 位开发者',
        developersBehind: '领先 {count} 位',
        ofFieldTokens: '全站 {value} token',
        mixTitle: 'Token 构成',
        mixNote: '看的是量去了哪里',
        cacheRead: '缓存读取',
        input: '输入',
        output: '输出',
        reasoning: '推理',
        cacheWrite: '缓存写入',
        mixHint: '缓存读取是模型复用的上下文，占全部提示 token 的 {value}。',
        standing: '榜单排名',
        standingWeek: '本周',
        standingMonth: '本自然月至今',
        standingAll: '全部时间',
        standingMismatch:
          '公开榜单按自然月统计，而上方用量是最近 30 天。这里显示的是榜单排名，不是这些数字的排名。',
        models: '模型',
        modelByCost: '按费用',
        modelByTokens: '按 Token',
        modelsNoteCost: '占本窗口费用比例',
        modelsNoteTokens: '占本窗口 Token 比例',
        modelsMore: '另有 {count} 个未显示',
        clients: '客户端',
        clientsNote: '上报这些用量的工具',
        clientsMore: '另有 {count} 个',
        today: '今天',
        joined: '{date} 加入',
        updated: '更新于{age}',
        justNow: '刚刚',
        minutesAgo: '{count} 分钟前',
        hoursAgo: '{count} 小时前',
        daysAgo: '{count} 天前',
        cliVersion: 'CLI {version}',
        sessions: '{count} 个会话',
        openProfile: '在 tokens.ci 打开',
        openLeaderboard: '排行榜',
        staleWarning: '显示上次保存的读数（{age}）。{message}',
        loading: '正在读取 tokens.ci 用量…',
        accountTitle: '用哪个 tokens.ci 账号？',
        accountBody:
          '本页显示 Tokens CLI 为某个 GitHub 账号上报的用量。这个选择保存在本机；插件行里的 config.username 优先级仍然更高。',
        accountLabel: 'GitHub 用户名',
        accountPlaceholder: '你的 GitHub 用户名',
        accountInvalid: 'GitHub 用户名只能包含字母、数字、点、短横线和下划线。',
        accountProbed: '已查找：{list}',
        save: '保存',
        saving: '保存中…',
        cancel: '取消',
        changeAccount: '更换账号',
        accountSource: '账号 @{name}——{origin}',
        unknownTitle: '@{username} 暂无用量',
        unknownBody:
          'tokens.ci 没有该账号的上报记录。要么这不是 Tokens CLI 上报用量所用的 GitHub 账号，要么还没有上报过——安装 CLI、登录并上报一次即可。',
        errorTitle: '无法读取 tokens.ci',
        genericError: '读取报告失败。',
        errorUnloaded: '插件的宿主端还没有响应。它随 profile 启动加载——请重启 dsh，然后重新打开本页。',
        emptyTitle: '该时间段没有活动',
        emptyBody: '这些日期没有任何上报。换一个时间段可能有数据。',
        retry: '重试',
      },
    }

    /**
     * Install the page's stylesheet once per document.
     * @returns a disposer removing the node, for `ctx.effect`.
     */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    /* ------------------------------------------------------------------ *
     * Formatting
     * ------------------------------------------------------------------ */

    /**
     * Group digits the way the reader's locale does.
     * @param value - any count; a non-number answers `—` like the other formatters.
     */
    function group(value) {
      if (!Number.isFinite(value)) return '—'
      return Math.round(value).toLocaleString()
    }

    /**
     * A token count at three or four significant digits with a unit suffix.
     * @param value - token count.
     * @returns `540.5M`, `3.19B`, `3,619`.
     */
    function compact(value) {
      if (!Number.isFinite(value)) return '—'
      if (value === 0) return '0'
      const units = [
        [1e12, 'T'],
        [1e9, 'B'],
        [1e6, 'M'],
        [1e3, 'K'],
      ]
      for (const [scale, suffix] of units) {
        if (Math.abs(value) >= scale) {
          const scaled = value / scale
          return `${scaled.toFixed(Math.abs(scaled) >= 100 ? 1 : 2)}${suffix}`
        }
      }
      return group(value)
    }

    /**
     * A dollar amount with enough precision to stay non-zero.
     * @param value - cost in USD.
     * @returns `$66.34`, `$0.0252`.
     */
    function money(value) {
      if (!Number.isFinite(value)) return '—'
      if (value === 0) return '$0'
      const magnitude = Math.abs(value)
      if (magnitude >= 1000) return `$${Math.round(value).toLocaleString()}`
      // Two decimals down to a dime: "$0.100" is noise on a figure a reader
      // compares against "$93.80". Below that the extra digits carry real
      // information — a day can genuinely cost $0.0139.
      if (magnitude >= 0.1) return `$${value.toFixed(2)}`
      if (magnitude >= 0.001) return `$${value.toFixed(3)}`
      return `$${value.toFixed(4)}`
    }

    /**
     * A ratio as a percentage.
     * @param value - ratio in `[0, 1]`.
     * @param digits - fraction digits; three for shares that would round to 0.0 %.
     * @returns `44.5%`.
     */
    function percent(value, digits = 1) {
      if (!Number.isFinite(value)) return '—'
      return `${(value * 100).toFixed(digits)}%`
    }

    /**
     * A UTC `YYYY-MM-DD` day as a short label.
     *
     * Parsed and rendered in UTC because that is the day the upstream
     * aggregated: shifting it into the reader's zone would relabel a boundary
     * the numbers do not share.
     *
     * @param date - `YYYY-MM-DD`.
     * @param options - `Intl.DateTimeFormat` options.
     * @returns the formatted date, or the raw value when it cannot be parsed.
     */
    function formatDay(date, options) {
      const parsed = new Date(`${date}T00:00:00Z`)
      if (Number.isNaN(parsed.getTime())) return date
      return parsed.toLocaleDateString(undefined, { timeZone: 'UTC', ...options })
    }

    /** A `YYYY-MM-DD` day as a month + year label, or undefined. */
    function formatMonth(iso) {
      const parsed = new Date(iso)
      if (Number.isNaN(parsed.getTime())) return undefined
      return parsed.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    }

    /**
     * A timestamp as a coarse age.
     * @param iso - ISO timestamp, or undefined.
     * @param t - translate function.
     * @returns `2m ago`, or `—`.
     */
    function age(iso, t) {
      if (typeof iso !== 'string') return '—'
      const then = Date.parse(iso)
      if (Number.isNaN(then)) return '—'
      const seconds = Math.max(0, (Date.now() - then) / 1000)
      if (seconds < 90) return t('justNow')
      const minutes = Math.round(seconds / 60)
      if (minutes < 90) return t('minutesAgo', { count: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 36) return t('hoursAgo', { count: hours })
      return t('daysAgo', { count: Math.round(hours / 24) })
    }

    /** The initial shown when an avatar cannot load. */
    function initials(name) {
      return (name ?? '?').replace(/^@/, '').slice(0, 2).toUpperCase()
    }

    /* ------------------------------------------------------------------ *
     * Data
     * ------------------------------------------------------------------ */

    /**
     * Read one report and keep it current while the page is mounted.
     *
     * The refresh action forces exactly one live read; the polls that follow it
     * are cache-respecting, so pressing Refresh does not turn the page into a
     * polling loop that ignores the host's cache. Every read is abortable, so
     * switching period or leaving the section cancels it instead of racing it.
     *
     * @param fetchReport - transport callback injected by this plugin's apply.
     * @param period - requested period, or undefined to take the host's default.
     * @param username - an account the reader just chose, sent until the page
     *   reloads; the host remembers it, so this is a one-time carry.
     * @param nonce - bumped by the Refresh button.
     * @param onResolvePeriod - called once with the host's default period.
     * @returns the read state plus a `retry` action.
     */
    function useReport(fetchReport, period, username, nonce, onResolvePeriod) {
      const [state, setState] = React.useState({ status: 'loading' })
      const [attempt, setAttempt] = React.useState(0)

      React.useEffect(() => {
        const controller = new AbortController()
        let timer
        /** Whether the next read bypasses the host's cache. */
        let force = nonce > 0 || attempt > 0
        setState((previous) =>
          previous.status === 'ready' ? { ...previous, busy: true } : { status: 'loading' },
        )
        const schedule = (delay) => {
          timer = setTimeout(read, delay)
        }
        const read = () => {
          const forced = force
          force = false
          const payload = { refresh: forced }
          if (period !== undefined) payload.period = period
          if (username !== undefined) payload.username = username
          fetchReport(payload, controller.signal)
            .then((result) => {
              if (controller.signal.aborted) return
              if (result === null || typeof result !== 'object' || result.ok !== true) {
                setState({ status: 'error', message: result?.error?.message })
                schedule(RETRY_MS)
                return
              }
              const value = result.value
              if (value.state !== undefined) {
                setState({ status: value.state, report: value })
                if (value.state === 'error') schedule(RETRY_MS)
                return
              }
              setState({ status: 'ready', report: value, busy: false })
              // The row's `config.period` decides which window the page opens
              // on; the page asks without one and adopts the answer.
              if (period === undefined && typeof value.period === 'string') onResolvePeriod(value.period)
              schedule(value.source === 'snapshot' ? REVALIDATE_MS : POLL_MS)
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              setState({
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              })
              schedule(RETRY_MS)
            })
        }
        read()
        return () => {
          controller.abort()
          clearTimeout(timer)
        }
      }, [fetchReport, period, username, nonce, attempt, onResolvePeriod])

      return { ...state, retry: () => setAttempt((value) => value + 1) }
    }

    /* ------------------------------------------------------------------ *
     * Pieces
     * ------------------------------------------------------------------ */

    /** One labelled figure in the stat grid. */
    function Stat(props) {
      return h('div', { className: 'tci-stat' }, [
        h('div', { className: 'tci-stat-label', key: 'l' }, props.label),
        h('div', { className: 'tci-stat-value', key: 'v' }, props.value),
        h('div', { className: 'tci-stat-sub', key: 's', title: props.sub }, props.sub),
      ])
    }

    /**
     * The daily chart, its readout strip and its keyboard navigation.
     *
     * One roving tabindex over every bar: Tab enters and leaves the chart once,
     * arrows walk it, and the readout follows whichever bar is focused or
     * hovered. Each bar fills the full plot height, so the target is the day's
     * column rather than the few pixels of its drawn top.
     */
    function DailyChart(props) {
      const { daily, metric, t } = props
      const [active, setActive] = React.useState(undefined)
      const bars = React.useRef([])

      const values = daily.map((day) => (metric === 'cost' ? day.cost : day.tokens))
      const peak = values.reduce((best, value) => Math.max(best, value), 0)
      const total = values.reduce((sum, value) => sum + value, 0)
      const todayIndex = daily.length - 1

      const move = (index, delta) => {
        const next = Math.min(daily.length - 1, Math.max(0, index + delta))
        setActive(next)
        bars.current[next]?.focus()
      }
      const onKeyDown = (index) => (event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          move(index, 1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(index, -1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          move(index, -daily.length)
        } else if (event.key === 'End') {
          event.preventDefault()
          move(index, daily.length)
        }
      }

      const shown = active === undefined ? undefined : daily[active]
      const shownValue = shown === undefined ? 0 : metric === 'cost' ? shown.cost : shown.tokens

      return h('div', { className: 'tci-card' }, [
        h('div', { className: 'tci-card-head', key: 'head' }, [
          h('div', { className: 'tci-card-title', key: 'title' }, t('daily')),
          h('div', { className: 'tci-seg', key: 'metric', role: 'group', 'aria-label': t('daily') }, [
            h('button', {
              key: 'tokens',
              type: 'button',
              'aria-pressed': metric === 'tokens',
              onClick: () => props.onMetric('tokens'),
            }, t('metricTokens')),
            h('button', {
              key: 'cost',
              type: 'button',
              'aria-pressed': metric === 'cost',
              onClick: () => props.onMetric('cost'),
            }, t('metricCost')),
          ]),
        ]),
        shown === undefined
          ? h('div', { className: 'tci-readout', key: 'idle' }, [
              h('div', { className: 'tci-readout-main tci-readout-idle', key: 'a' }, [
                h('span', { key: 'd' }, t('dayCount', { count: daily.length })),
                h('span', { key: 't' }, [
                  `${t('totalLabel')} `,
                  h('b', { key: 'v' }, metric === 'cost' ? money(total) : compact(total)),
                ]),
                props.peakDay === undefined
                  ? null
                  : h('span', { key: 'p' }, t('peak', {
                      value: metric === 'cost' ? money(props.peakDay.cost) : compact(props.peakDay.tokens),
                      date: formatDay(props.peakDay.date, { month: 'short', day: 'numeric' }),
                    })),
              ]),
              h('div', { className: 'tci-readout-sub', key: 'b' }, t('hoverHint')),
            ])
          : h('div', { className: 'tci-readout', key: 'active' }, [
              h('div', { className: 'tci-readout-main', key: 'a' }, [
                h('span', { className: 'tci-readout-day', key: 'd' }, [
                  formatDay(shown.date, { weekday: 'short', month: 'short', day: 'numeric' }),
                  active === todayIndex ? ` · ${t('today')}` : '',
                ]),
                h('span', { key: 'v' }, metric === 'cost' ? money(shownValue) : compact(shownValue)),
                h('span', { key: 'm' }, `${group(shown.messages)} ${t('statMessages').toLowerCase()}`),
              ]),
              h('div', { className: 'tci-readout-sub', key: 'b' }, SERIES.map((series) =>
                h('span', { key: series.key }, `${t(series.key)} ${compact(shown[series.key])}`))),
            ]),
        h('div', {
          className: 'tci-chart',
          key: 'plot',
          role: 'group',
          'aria-label': t('daily'),
        }, daily.map((day, index) => {
          const value = values[index]
          const height = peak > 0 ? Math.max(1.5, (value / peak) * 100) : 1.5
          return h('button', {
            key: day.date,
            ref: (node) => {
              bars.current[index] = node
            },
            type: 'button',
            className: 'tci-bar',
            'data-active': active === index,
            'data-zero': value === 0,
            'data-today': index === todayIndex,
            tabIndex: (active ?? todayIndex) === index ? 0 : -1,
            'aria-label': `${formatDay(day.date, { weekday: 'long', month: 'short', day: 'numeric' })}: ${compact(day.tokens)} tokens, ${money(day.cost)}, ${group(day.messages)} messages`,
            onMouseEnter: () => setActive(index),
            onMouseLeave: () => setActive(undefined),
            onFocus: () => setActive(index),
            onBlur: () => setActive(undefined),
            onKeyDown: onKeyDown(index),
          }, h('i', { style: { height: `${height}%` } }))
        })),
        h('div', { className: 'tci-axis', key: 'axis' }, [
          h('span', { key: 'from' }, formatDay(daily[0].date, { month: 'short', day: 'numeric' })),
          h('span', { key: 'to' }, formatDay(daily[daily.length - 1].date, { month: 'short', day: 'numeric' })),
        ]),
      ])
    }

    /** The stacked composition bar with its legend. */
    function TokenMix(props) {
      const { totals, t } = props
      const rows = SERIES
        .map((series) => ({ ...series, value: totals[series.key] ?? 0 }))
        .filter((series) => series.value > 0)
      const sum = rows.reduce((total, row) => total + row.value, 0)
      if (sum === 0) return null
      return h('div', { className: 'tci-card' }, [
        h('div', { className: 'tci-card-head', key: 'head' }, [
          h('div', { className: 'tci-card-title', key: 'title' }, t('mixTitle')),
          h('div', { className: 'tci-card-note', key: 'note' }, t('mixNote')),
        ]),
        h('div', {
          className: 'tci-mix',
          key: 'bar',
          role: 'img',
          'aria-label': rows.map((row) => `${t(row.key)} ${percent(row.value / sum)}`).join(', '),
        }, rows.map((row) => h('i', {
          key: row.key,
          style: {
            // Proportional growth with a 2px floor: a share that rounds to a
            // sub-pixel width would otherwise vanish, and the legend beside the
            // bar carries the exact figure either way.
            flex: `${row.value} 0 2px`,
            background: row.color,
          },
          title: `${t(row.key)} · ${compact(row.value)} · ${percent(row.value / sum)}`,
        }))),
        h('div', { className: 'tci-legend', key: 'legend' }, rows.map((row) =>
          h('div', { className: 'tci-legend-row', key: row.key }, [
            h('span', { className: 'tci-dot', key: 'dot', style: { background: row.color } }),
            h('span', { className: 'tci-legend-name', key: 'name' }, t(row.key)),
            h('span', { className: 'tci-legend-value', key: 'value' }, compact(row.value)),
            h('span', { className: 'tci-legend-share', key: 'share' }, percent(row.value / sum)),
          ]))),
        h('div', { className: 'tci-note', key: 'hint' },
          t('mixHint', { value: percent(totals.cacheHitRate) })),
      ])
    }

    /** Where this account sits in the public table for the same period. */
    function Standing(props) {
      const { report, t } = props
      const standing = report.standing
      if (standing === undefined) return null
      const note = report.period === 'week'
        ? t('standingWeek')
        : report.period === 'month'
          ? t('standingMonth')
          : t('standingAll')
      return h('div', { className: 'tci-card' }, [
        h('div', { className: 'tci-card-head', key: 'head' }, [
          h('div', { className: 'tci-card-title', key: 'title' }, t('standing')),
          h('div', { className: 'tci-card-note', key: 'note' }, note),
        ]),
        h('div', { className: 'tci-standing', key: 'grid' }, [
          h('div', { key: 'rank' }, [
            h('div', { className: 'tci-stat-label', key: 'l' }, t('statRank')),
            h('div', { className: 'tci-stat-value', key: 'v' }, `#${group(standing.position)}`),
            h('div', { className: 'tci-stat-sub', key: 's' }, t('ofDevelopers', { count: group(standing.of) })),
          ]),
          h('div', { key: 'ahead' }, [
            h('div', { className: 'tci-stat-label', key: 'l' }, t('statAhead')),
            h('div', { className: 'tci-stat-value', key: 'v' }, percent(standing.aheadOf)),
            h('div', { className: 'tci-stat-sub', key: 's' },
              t('developersBehind', { count: group(Math.max(0, standing.of - standing.position)) })),
          ]),
          h('div', { key: 'share' }, [
            h('div', { className: 'tci-stat-label', key: 'l' }, t('statShare')),
            h('div', { className: 'tci-stat-value', key: 'v' }, percent(standing.share, 3)),
            h('div', { className: 'tci-stat-sub', key: 's' },
              t('ofFieldTokens', { value: compact(standing.networkTokens) })),
          ]),
        ]),
        standing.sameWindow === false
          ? h('div', { className: 'tci-note tci-warn', key: 'mismatch' }, t('standingMismatch'))
          : null,
      ])
    }

    /** How many model rows the card draws. */
    const MODEL_ROWS = 8

    /**
     * Rank the window's models by one share and keep the head.
     *
     * The two orderings genuinely differ — this account's own data has a model
     * with 39 % of the tokens and 19 % of the bill — so the card lets the
     * reader pick rather than deciding for them. Kept pure so the offline
     * checks can assert both orders without rendering a toggle.
     *
     * @param models - the report's model table.
     * @param metric - `cost` or `tokens`.
     * @returns `{ rows, more, key }`, where `key` is the row field being shared.
     */
    function rankModels(models, metric) {
      if (models === undefined || !Array.isArray(models.rows)) return { rows: [], more: 0, key: 'costShare' }
      const key = metric === 'tokens' ? 'tokenShare' : 'costShare'
      const ranked = [...models.rows].sort((left, right) => right[key] - left[key])
      return { rows: ranked.slice(0, MODEL_ROWS), more: Math.max(0, ranked.length - MODEL_ROWS), key }
    }

    /** One row per model, with the chosen share drawn behind it. */
    function Models(props) {
      const { models, t } = props
      const [metric, setMetric] = React.useState('cost')
      if (models === undefined || !Array.isArray(models.rows) || models.rows.length === 0) return null
      const { rows, more, key } = rankModels(models, metric)
      const widest = rows.reduce((best, row) => Math.max(best, row[key]), 0)
      return h('div', { className: 'tci-card' }, [
        h('div', { className: 'tci-card-head', key: 'head' }, [
          h('div', { className: 'tci-card-title', key: 'title' }, t('models')),
          h('div', { className: 'tci-seg', key: 'metric', role: 'group', 'aria-label': t('models') }, [
            h('button', {
              key: 'cost',
              type: 'button',
              'aria-pressed': metric === 'cost',
              onClick: () => setMetric('cost'),
            }, t('modelByCost')),
            h('button', {
              key: 'tokens',
              type: 'button',
              'aria-pressed': metric === 'tokens',
              onClick: () => setMetric('tokens'),
            }, t('modelByTokens')),
          ]),
        ]),
        h('div', { className: 'tci-models', key: 'rows' }, rows.map((row) =>
          h('div', {
            className: 'tci-model',
            key: row.model,
            title: `${row.model}\n${compact(row.tokens)} tokens · ${money(row.cost)}\ncost share ${percent(row.costShare)} · token share ${percent(row.tokenShare)}`,
          }, [
            h('span', {
              className: 'tci-model-fill',
              key: 'fill',
              style: { width: `${widest > 0 ? Math.max(2, (row[key] / widest) * 100) : 0}%` },
            }),
            h('span', { className: 'tci-model-name', key: 'name' }, row.model),
            h('span', { className: 'tci-model-figures', key: 'figures' }, [
              h('span', { key: 'tokens' }, compact(row.tokens)),
              h('span', { key: 'cost' }, money(row.cost)),
            ]),
            h('span', { className: 'tci-model-share', key: 'share' }, percent(row[key])),
          ]))),
        h('div', { className: 'tci-note', key: 'note' }, [
          t(metric === 'tokens' ? 'modelsNoteTokens' : 'modelsNoteCost'),
          more > 0 ? ` · ${t('modelsMore', { count: more })}` : '',
        ]),
      ])
    }

    /** Which clients reported the window's usage. */
    function Clients(props) {
      const { clients, t } = props
      if (!Array.isArray(clients) || clients.length === 0) return null
      const rows = clients.slice(0, 8)
      return h('div', { className: 'tci-card' }, [
        h('div', { className: 'tci-card-head', key: 'head' }, [
          h('div', { className: 'tci-card-title', key: 'title' }, t('clients')),
          h('div', { className: 'tci-card-note', key: 'note' }, t('clientsNote')),
        ]),
        h('div', { className: 'tci-chips', key: 'chips' }, rows.map((row) =>
          h('span', {
            className: 'tci-chip',
            key: row.client,
            title: `${compact(row.tokens)} tokens · ${money(row.cost)} · ${group(row.messages)} messages`,
          }, [
            h('span', { className: 'tci-chip-name', key: 'name' }, row.client),
            h('b', { key: 'tokens' }, compact(row.tokens)),
            h('span', { key: 'share' }, percent(row.share)),
          ]))),
        clients.length > rows.length
          ? h('div', { className: 'tci-note', key: 'more' }, t('clientsMore', { count: clients.length - rows.length }))
          : null,
      ])
    }

    /* ------------------------------------------------------------------ *
     * Page
     * ------------------------------------------------------------------ */

    /** The identity row: who, which window, and how to re-read it. */
    function Identity(props) {
      const { report, period, onPeriod, onRefresh, busy, t } = props
      const [avatarFailed, setAvatarFailed] = React.useState(false)
      const handle = typeof report.username === 'string' && report.username !== '' ? report.username : undefined
      const name = report.displayName ?? handle ?? ''
      const joined = formatMonth(report.joinedAt)
      // The window's last day is today unless the account has not submitted
      // since the server's day rolled over; the date itself decides, not the
      // assumption, so a stale account is never labelled "today".
      const latest = Array.isArray(report.daily) && report.daily.length > 0
        ? report.daily[report.daily.length - 1]
        : undefined
      const today = latest !== undefined && latest.date === new Date().toISOString().slice(0, 10)
        ? latest
        : undefined
      return h('div', { className: 'tci-head' }, [
        report.avatarUrl !== undefined && !avatarFailed
          ? h('img', {
              key: 'avatar',
              className: 'tci-avatar',
              src: report.avatarUrl,
              alt: '',
              loading: 'lazy',
              referrerPolicy: 'no-referrer',
              onError: () => setAvatarFailed(true),
            })
          : h('div', { className: 'tci-avatar-fallback', key: 'avatar' }, initials(name)),
        h('div', { className: 'tci-id', key: 'id' }, [
          h('div', { className: 'tci-name', key: 'name' }, [
            report.profileUrl === undefined
              ? h('span', { key: 'link' }, name)
              : h('a', {
                  key: 'link',
                  href: report.profileUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                  title: report.profileUrl,
                }, name),
            report.verified === true
              ? h('span', {
                  className: 'tci-badge',
                  key: 'badge',
                  title: 'Verified',
                  'aria-label': 'Verified',
                }, '✓')
              : null,
            handle === undefined ? null : h('span', { className: 'tci-card-note', key: 'handle' }, `@${handle}`),
          ]),
          h('div', { className: 'tci-meta', key: 'meta' }, [
            report.window?.start !== undefined && report.window?.end !== undefined
              ? h('span', { key: 'window' }, `${formatDay(report.window.start, { month: 'short', day: 'numeric' })} – ${formatDay(report.window.end, { month: 'short', day: 'numeric', year: 'numeric' })}`)
              : null,
            today === undefined
              ? null
              : h('span', { className: 'tci-today', key: 'today' }, [
                  `${t('today')} `,
                  h('b', { key: 'v' }, compact(today.tokens)),
                  ' · ',
                  money(today.cost),
                ]),
            joined === undefined ? null : h('span', { key: 'joined' }, t('joined', { date: joined })),
          ]),
        ]),
        h('div', { className: 'tci-tools', key: 'tools' }, [
          h('div', { className: 'tci-seg', key: 'period', role: 'group', 'aria-label': t('daily') },
            PERIODS.map((key) => h('button', {
              key,
              type: 'button',
              'aria-pressed': period === key,
              onClick: () => onPeriod(key),
            }, t(key === 'week' ? 'scopeWeek' : key === 'month' ? 'scopeMonth' : 'scopeAll')))),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'tci-icon-btn',
            title: busy ? t('refreshing') : t('refresh'),
            'aria-label': busy ? t('refreshing') : t('refresh'),
            disabled: busy,
            onClick: onRefresh,
          }, h('svg', {
            className: busy ? 'tci-spin' : undefined,
            width: 15,
            height: 15,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': true,
          }, h('path', {
            d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V5H11',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }))),
        ]),
      ])
    }

    /** A centred message for states that carry no report to draw. */
    function StatePanel(props) {
      return h('div', { className: 'tci-card' }, h('div', { className: 'tci-state' }, [
        h('div', { className: 'tci-state-title', key: 'title' }, props.title),
        props.body === undefined ? null : h('div', { key: 'body' }, props.body),
        ...(props.children ?? []),
      ]))
    }

    /** The page while the first report is in flight. */
    function LoadingPanel(props) {
      return h('div', { className: 'tci-root' }, h('div', { className: 'tci-card' }, [
        h('div', { className: 'tci-card-title', key: 'title' }, props.t('loading')),
        h('div', { className: 'tci-skeleton', key: 'a', style: { marginTop: 14, width: '38%', height: 11 } }),
        h('div', { className: 'tci-skeleton', key: 'b', style: { marginTop: 12, height: 124 } }),
      ]))
    }

    /**
     * The page's one form: name the tokens.ci account.
     *
     * It carries both first use — nothing on this machine names an account —
     * and a correction, because the machine's guess is only a guess and a
     * handle that looks valid but belongs to somebody else is the one failure
     * the host cannot detect on its own.
     *
     * A handle is a restricted alphabet, so the field validates against it and
     * says so rather than letting the request come back as a bad-request.
     */
    function AccountForm(props) {
      const { t, initial, probed, busy, error, onSubmit, onCancel } = props
      const [draft, setDraft] = React.useState(initial ?? '')
      const handle = draft.trim().replace(/^@/, '')
      const valid = /^[A-Za-z0-9._-]{1,64}$/.test(handle)
      const submit = (event) => {
        event.preventDefault()
        if (valid && busy !== true) onSubmit(handle)
      }
      return h('form', { className: 'tci-root', onSubmit: submit }, h('div', { className: 'tci-card' }, [
        h('div', { className: 'tci-state-title', key: 'title' }, t('accountTitle')),
        h('div', { className: 'tci-card-note tci-left', key: 'body' }, t('accountBody')),
        h('div', { className: 'tci-field', key: 'field' }, [
          h('input', {
            key: 'input',
            className: 'tci-input',
            type: 'text',
            value: draft,
            autoFocus: true,
            spellCheck: false,
            autoComplete: 'off',
            autoCapitalize: 'none',
            placeholder: t('accountPlaceholder'),
            'aria-label': t('accountLabel'),
            'aria-invalid': draft !== '' && !valid,
            onChange: (event) => setDraft(event.target.value),
          }),
          h('button', {
            key: 'save',
            type: 'submit',
            className: 'tci-button tci-button-primary',
            disabled: !valid || busy === true,
          }, busy === true ? t('saving') : t('save')),
          onCancel === undefined
            ? null
            : h('button', { key: 'cancel', type: 'button', className: 'tci-button', onClick: onCancel }, t('cancel')),
        ]),
        draft !== '' && !valid
          ? h('div', { className: 'tci-note tci-warn', key: 'invalid' }, t('accountInvalid'))
          : null,
        error === undefined ? null : h('div', { className: 'tci-note tci-warn', key: 'error' }, error),
        Array.isArray(probed) && probed.length > 0
          ? h('div', { className: 'tci-note', key: 'probed' }, t('accountProbed', { list: probed.join(' · ') }))
          : null,
      ]))
    }

    /** The handle is not one tokens.ci knows, so the way out is another name. */
    function UnknownAccountPanel(props) {
      const { report, t, onChange } = props
      return h('div', { className: 'tci-root' }, h(StatePanel, {
        title: t('unknownTitle', { username: report?.username ?? '' }),
        body: t('unknownBody'),
        children: [
          h('button', {
            key: 'change',
            type: 'button',
            className: 'tci-button',
            onClick: onChange,
          }, t('accountTitle')),
        ],
      }))
    }

    /** The upstream could not be read and there is no snapshot to fall back on. */
    function ErrorPanel(props) {
      const { message, onRetry, t } = props
      // A missing endpoint means the browser half is loaded and the host half is
      // not — the one failure a page reload cannot fix, so it says what does.
      const unloaded = typeof message === 'string' && /\b404\b|not found/i.test(message)
      return h('div', { className: 'tci-root' }, h(StatePanel, {
        title: t('errorTitle'),
        body: message ?? t('genericError'),
        children: [
          unloaded ? h('div', { className: 'tci-note', key: 'hint' }, t('errorUnloaded')) : null,
          h('button', {
            key: 'retry',
            type: 'button',
            className: 'tci-button',
            onClick: onRetry,
          }, t('retry')),
        ],
      }))
    }

    /** The settings page itself: read one report, then hand it to the view. */
    function TokensCiSection(props) {
      const { t } = props
      // Undefined until the host answers with the period its row configured.
      const [period, setPeriod] = React.useState(undefined)
      const [metric, setMetric] = React.useState('tokens')
      const [nonce, setNonce] = React.useState(0)
      // Set only after the reader names an account; then every read carries it
      // so the host keeps reporting the account the page is showing.
      const [username, setUsername] = React.useState(undefined)
      const [editing, setEditing] = React.useState(false)
      const state = useReport(props.fetchReport, period, username, nonce, setPeriod)

      const choose = (value) => {
        setUsername(value)
        setEditing(false)
        // A different account must not be answered from the previous one's
        // cache, so the read that follows is forced.
        setNonce((current) => current + 1)
      }

      if (editing) {
        return h(AccountForm, {
          t,
          initial: username ?? state.report?.account?.name ?? state.report?.username,
          busy: state.busy === true,
          onCancel: () => setEditing(false),
          onSubmit: choose,
        })
      }
      if (state.status === 'loading') return h(LoadingPanel, { t })
      if (state.status === 'no-account') return h(AccountForm, { t, probed: state.report?.probed, onSubmit: choose })
      if (state.status === 'unknown-account') {
        return h(UnknownAccountPanel, { report: state.report, t, onChange: () => setEditing(true) })
      }
      if (state.status === 'error') return h(ErrorPanel, { message: state.message, onRetry: state.retry, t })

      return h(ReportView, {
        report: state.report,
        period: period ?? state.report.period,
        metric,
        busy: state.busy === true,
        onPeriod: setPeriod,
        onMetric: setMetric,
        onRefresh: () => setNonce((value) => value + 1),
        onChangeAccount: () => setEditing(true),
        t,
      })
    }

    /**
     * The drawn page: one report, already read, laid out.
     *
     * Split from the section so the whole view is a pure function of a report —
     * which is what the offline checks render, state by state, without a
     * browser and without a transport.
     */
    function ReportView(props) {
      const { report, period, metric, busy, t } = props
      // A component that throws renders nothing at all — the slot goes blank
      // with only a console line — so the view tolerates a report from a host
      // half that is older or newer than this one wherever a field is merely
      // absent. `compact`/`money` already answer '—' for a non-number.
      const totals = report.totals ?? {}
      const fromSnapshot = report.source === 'snapshot'

      return h('div', { className: 'tci-root' }, [
        h('div', { className: fromSnapshot ? 'tci-dim' : undefined, key: 'head' },
          h(Identity, {
            report,
            period,
            busy,
            onPeriod: props.onPeriod,
            onRefresh: props.onRefresh,
            t,
          })),
        fromSnapshot
          ? h('div', { className: 'tci-note tci-warn', key: 'stale' },
              t('staleWarning', { age: age(report.fetchedAt, t), message: report.error ?? '' }))
          : null,
        Array.isArray(report.daily) && report.daily.length > 0
          ? h('div', { className: fromSnapshot ? 'tci-dim' : undefined, key: 'body' }, [
              h(DailyChart, {
                key: 'chart',
                daily: report.daily,
                metric,
                peakDay: report.best,
                onMetric: props.onMetric,
                t,
              }),
              h('div', { className: 'tci-stats', key: 'stats' }, [
                h(Stat, {
                  key: 'tokens',
                  label: t('statTokens'),
                  value: compact(totals.tokens),
                  sub: t('avgPerActiveDay', { value: compact(totals.averagePerActiveDay) }),
                }),
                h(Stat, {
                  key: 'cost',
                  label: t('statCost'),
                  value: money(totals.cost),
                  sub: t('ratePerMillion', { value: money(totals.costPerMillion) }),
                }),
                h(Stat, {
                  key: 'days',
                  label: t('statActiveDays'),
                  value: group(totals.activeDays),
                  sub: Number.isFinite(report.streak) && report.streak > 1
                    ? t('streakDays', { count: report.streak })
                    : '',
                }),
                h(Stat, {
                  key: 'messages',
                  label: t('statMessages'),
                  value: group(totals.messages),
                  sub: t('cacheHit', { value: percent(totals.cacheHitRate) }),
                }),
              ]),
              h(Standing, { key: 'standing', report, t }),
              h(TokenMix, { key: 'mix', totals, t }),
              h(Models, { key: 'models', models: report.models, t }),
              h(Clients, { key: 'clients', clients: report.clients, t }),
            ])
          : h('div', { key: 'body' }, h(StatePanel, {
              title: t('emptyTitle'),
              body: t('emptyBody'),
            })),
        h('div', { className: 'tci-foot', key: 'foot' }, [
          h('span', { key: 'updated' },
            t('updated', { age: age(report.freshness?.lastUpdated ?? report.fetchedAt, t) })),
          report.freshness?.cliVersion === undefined
            ? null
            : h('span', { key: 'cli' }, t('cliVersion', { version: report.freshness.cliVersion })),
          totals.sessions === undefined
            ? null
            : h('span', { key: 'sessions' }, t('sessions', { count: group(totals.sessions) })),
          report.profileUrl === undefined
            ? null
            : h('a', { key: 'profile', href: report.profileUrl, target: '_blank', rel: 'noreferrer' },
                t('openProfile')),
          h('a', {
            key: 'board',
            href: report.standing?.url ?? 'https://tokens.ci/leaderboard',
            target: '_blank',
            rel: 'noreferrer',
          }, t('openLeaderboard')),
          report.account === undefined
            ? null
            : h('button', {
                key: 'account',
                type: 'button',
                className: 'tci-text-button',
                title: t('accountSource', { name: report.account.name, origin: report.account.origin }),
                onClick: props.onChangeAccount,
              }, t('changeAccount')),
        ]),
      ])
    }

    /**
     * Register the page. The slot callback owns its registrations: the settings
     * shell's declaration collapsing removes this contribution with it.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ensureStyles(), 'tokens-ci: stylesheet')
      ctx.effect(() => ctx.locale.register(NS, DICT), 'tokens-ci: dictionaries')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'tokens-ci',
        // After the shipped General / Models / Plugins pages: a personal
        // dashboard is somewhere a reader arrives, not where they start.
        order: 40,
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
        inject: () => ({
          fetchReport: (payload, signal) => ctx.connection.rpc.call(CHANNEL, ENDPOINT, payload, signal),
        }),
      }, TokensCiSection))
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection', 'locale']
    /**
     * Rendering seam for the offline checks: the pure view plus the dictionaries
     * it is driven by, so every visual state can be rendered without a browser,
     * a transport or a Harness boot. Nothing in the running page reads it.
     */
    exports.__test = {
      ReportView,
      TokensCiSection,
      LoadingPanel,
      Models,
      rankModels,
      AccountForm,
      UnknownAccountPanel,
      ErrorPanel,
      DICT,
      NS,
      PERIODS,
      // The formatters are pure and decide every figure on the page, so they
      // are worth asserting at their boundaries rather than only through a
      // rendered string.
      format: { group, compact, money, percent, formatDay },
    }
    return module.exports
  },
})
