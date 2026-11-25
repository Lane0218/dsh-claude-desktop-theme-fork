export const STATS_COPY = {
  zh: {
    tabs: ['概览', '用量'], ranges: ['今天', '近7天', '近30天', '全部'],
    tiles: ['会话数', '消息数', 'Token 总量', '活跃天数', '高峰时段', '常用模型'],
    streak: '连续天数',
    view: '统计视图', range: '时间范围', heat: '每日活跃热力图', chart: '各模型每日 Token 用量',
    empty: '此时间范围内暂无模型用量', less: '收起',
    more: (count: number) => `展开其余 ${count} 个模型`,
  },
  en: {
    tabs: ['Overview', 'Usage'], ranges: ['Today', 'Last 7 days', 'Last 30 days', 'All'],
    tiles: ['Sessions', 'Messages', 'Total tokens', 'Active days', 'Peak hour', 'Favorite model'],
    streak: 'Streak',
    view: 'Statistics view', range: 'Time range', heat: 'Daily activity heatmap', chart: 'Daily token usage by model',
    empty: 'No model usage in this time range', less: 'Show less',
    more: (count: number) => `Show ${count} more ${count === 1 ? 'model' : 'models'}`,
  },
} as const;

/** The hero's continue card: its title, its empty state and its time words. */
export const RECENT_COPY = {
  zh: {
    title: '继续上次',
    empty: '还没有会话',
    running: '进行中',
    justNow: '刚刚',
    minutes: (count: number) => `${count} 分钟前`,
    hours: (count: number) => `${count} 小时前`,
    yesterday: '昨天',
    days: (count: number) => `${count} 天前`,
  },
  en: {
    title: 'Continue',
    empty: 'No sessions yet',
    running: 'Running',
    justNow: 'just now',
    minutes: (count: number) => `${count} min ago`,
    hours: (count: number) => `${count} hr ago`,
    yesterday: 'yesterday',
    days: (count: number) => `${count} days ago`,
  },
} as const;
