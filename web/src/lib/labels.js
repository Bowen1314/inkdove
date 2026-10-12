// 枚举值 → 界面文案和状态点颜色。枚举值本身与 SPEC 一字不差。

export const ENTRY_TYPES = [
  { value: 'faq', label: '常见问答' },
  { value: 'product', label: '产品服务' },
  { value: 'policy', label: '政策条款' },
  { value: 'fact', label: '基本信息' },
];
export const entryTypeLabel = (t) => ENTRY_TYPES.find((x) => x.value === t)?.label || t;

export const ENTRY_STATUS = {
  active: { label: '启用中', tone: 'green' },
  disabled: { label: '已停用', tone: 'gray' },
};

export const ENTRY_ORIGIN = {
  distill: '自动整理',
  manual: '手动添加',
  gap: '补充回答',
  conversation: '来自会话',
};

export const SOURCE_KIND = {
  file: '文件',
  url: '网页',
  text: '文本',
};

export const SOURCE_STATUS = {
  ready: { label: '可用', tone: 'green' },
  error: { label: '读取失败', tone: 'red' },
};

export const JOB_STATUS = {
  queued: { label: '排队中', tone: 'amber' },
  running: { label: '进行中', tone: 'teal', pulse: true },
  done: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  cancelled: { label: '已取消', tone: 'gray' },
};

export const JOB_MODE = {
  incremental: '整理新资料',
  rebuild: '全部重建',
};

export const PHASES = [
  { value: 'parse', label: '读取资料' },
  { value: 'extract', label: '提取知识' },
  { value: 'consolidate', label: '合并去重' },
  { value: 'profile', label: '企业画像' },
  { value: 'gaps', label: '查找缺口' },
  { value: 'done', label: '完成' },
];

export const WA_STATE = {
  not_configured: { label: '未连接', tone: 'gray' },
  stopped: { label: '已停止', tone: 'gray' },
  starting: { label: '正在启动', tone: 'amber', pulse: true },
  scan_qr: { label: '等待扫码', tone: 'amber', pulse: true },
  working: { label: '已连接', tone: 'green' },
  failed: { label: '连接失败', tone: 'red' },
  configured: { label: '已配置', tone: 'green' },
};
export const waState = (s) => WA_STATE[s] || { label: s || '未知', tone: 'gray' };

export const CHANNEL_LABEL = {
  waha: '扫码连接',
  meta: 'Meta 官方接口',
};

// 消息作者（author）。owner = 机主在手机上直接回复（F12）
export const AUTHOR_LABEL = {
  customer: '客户',
  bot: '机器人',
  operator: '人工',
  owner: '手机回复',
};

// 自动回复范围（reply.scope）
export const REPLY_SCOPES = [
  { value: 'all', label: '所有私聊（黑名单除外）', desc: '任何人发来私聊都会自动回复，黑名单里的号码除外。' },
  { value: 'allowlist', label: '只回白名单里的号码', desc: '只回复白名单里的号码，其他人的消息不回复、也不保存到后台。' },
];

// 测试对话 /api/kb/ask 的 decision
export const ASK_DECISION = {
  replied: { label: '已回复', tone: 'green' },
  handoff: { label: '转人工', tone: 'amber' },
  blocked: { label: '已拦截', tone: 'red' },
  offtopic: { label: '离题', tone: 'gray' },
};

// 客户消息上的 botDecision（replied 不标）
export const BOT_DECISION_NOTE = {
  offtopic: '离题·未回复',
  handoff: '转人工',
  blocked: '已拦截·转人工',
  skipped: '未处理',
  declined: '客户拒绝·已停止',
};

// F8 角色和成员状态
export const ROLES = [
  { value: 'admin', label: '管理员', desc: '能管理所有号码、知识库、成员和设置。' },
  { value: 'agent', label: '业务员', desc: '只能处理分配给自己的号码和会话，知识库只读。' },
];
export const roleLabel = (r) => ROLES.find((x) => x.value === r)?.label || r || '—';

/** User → {label, tone}：已邀请未激活 / 正常 / 已停用 */
export function userStatus(u) {
  if (u?.disabled) return { label: '已停用', tone: 'gray' };
  if (u?.pending) return { label: '已邀请未激活', tone: 'amber' };
  return { label: '正常', tone: 'green' };
}

// F10 发信方式（provider：null | smtp | resend）
export const EMAIL_PROVIDERS = [
  { value: '', label: '不发邮件' },
  { value: 'smtp', label: 'SMTP' },
  { value: 'resend', label: 'Resend' },
];

// F4 媒体类型
export const MEDIA_LABEL = {
  voice: '语音',
  image: '图片',
};

// F6 客户阶段。前四个是漏斗顺序
export const LEAD_STAGES = [
  { value: 'inquiry', label: '询价' },
  { value: 'sample', label: '要样品' },
  { value: 'negotiation', label: '议价' },
  { value: 'order_intent', label: '有下单意向' },
  { value: 'after_sales', label: '售后' },
  { value: 'other', label: '其他' },
];
export const leadStageLabel = (s) => LEAD_STAGES.find((x) => x.value === s)?.label || s || '—';
