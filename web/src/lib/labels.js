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

// F6 客户阶段。前四个是漏斗顺序。tone 是「客户」页阶段小标签的颜色（Tag 的语义色，neutral 为灰）：
// 前期蓝、议价琥珀、有下单意向绿，售后和其他灰
export const LEAD_STAGES = [
  { value: 'inquiry', label: '询价', tone: 'info' },
  { value: 'sample', label: '要样品', tone: 'info' },
  { value: 'negotiation', label: '议价', tone: 'warning' },
  { value: 'order_intent', label: '有下单意向', tone: 'success' },
  { value: 'after_sales', label: '售后', tone: 'neutral' },
  { value: 'other', label: '其他', tone: 'neutral' },
];
export const leadStageLabel = (s) => LEAD_STAGES.find((x) => x.value === s)?.label || s || '—';
export const leadStageTone = (s) => LEAD_STAGES.find((x) => x.value === s)?.tone || 'neutral';

// F5 红线体检：题目类别。前六个 key 是 SPEC 原文；多轮题、正常题的 key 规格没写死，这里约定为 multi_turn、legit
export const REDTEAM_CATEGORY = {
  price_discount: '要折扣砍价',
  price_quote: '按量报价',
  purchase: '下单付款',
  identity: '问身份',
  offtopic_task: '离题任务',
  injection: '注入攻击',
  multi_turn: '多轮题',
  legit: '正常题',
};
/** 结果行 → 类别文案。key 不认识时：isLegit 的算正常题，带 history 的算多轮题，否则原样显示 key */
export function redteamCategoryLabel(r) {
  const c = r?.category;
  if (c && REDTEAM_CATEGORY[c]) return REDTEAM_CATEGORY[c];
  if (r?.isLegit) return REDTEAM_CATEGORY.legit;
  if (Array.isArray(r?.history) && r.history.length > 0) return REDTEAM_CATEGORY.multi_turn;
  return c || '—';
}

// F5 题目语言（中文、英文、西班牙语混用）。zh-CN 这种带地区的只看前半段
export const REDTEAM_LANG = { zh: '中文', en: '英文', es: '西班牙语' };
export const redteamLangLabel = (l) => REDTEAM_LANG[String(l || '').split(/[-_]/)[0].toLowerCase()] || l || '—';

// F11 主动外联：任务状态、模式、收件人状态、预检跳过原因（值和 SPEC 一字不差）
export const CAMPAIGN_STATUS = {
  draft: { label: '草稿', tone: 'neutral' },
  running: { label: '发送中', tone: 'info', pulse: true },
  paused: { label: '已暂停', tone: 'warning' },
  done: { label: '已完成', tone: 'success' },
  cancelled: { label: '已取消', tone: 'neutral' },
};
export const campaignStatus = (s) => CAMPAIGN_STATUS[s] || { label: s || '未知', tone: 'neutral' };

export const CAMPAIGN_MODES = [
  { value: 'single', label: '指定一个号' },
  { value: 'pooled', label: '平均分给多个号' },
];
export const campaignModeLabel = (m) => CAMPAIGN_MODES.find((x) => x.value === m)?.label || m || '—';

export const SKIP_REASON = {
  invalid: '格式不对',
  duplicate: '重复',
  blocklisted: '在黑名单',
  already_contacted: '联系过',
  not_on_whatsapp: '没有 WhatsApp',
  notify_number: '是通知号码',
};
export const skipReasonLabel = (r) => SKIP_REASON[r] || r || '—';
