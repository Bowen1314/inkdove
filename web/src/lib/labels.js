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

// 号的回复方式（replyMode）。新建的号默认 off（人工回复）；desc 是号详情里选中时下面那句说明。
// 推荐回复不是一种回复方式：两种方式下都能在会话页点「推荐回复」手动要一条（v0.3.0 的 suggest 模式已取消，后端按 off 返回）
export const REPLY_MODES = [
  {
    value: 'off',
    label: '人工回复',
    desc: '客户来消息不会自动调用 AI，由业务员回复。需要时在会话页点「推荐回复」，AI 按知识库和话术起草一条，改好再发。',
  },
  { value: 'auto', label: '自动回复', desc: '机器人根据知识库直接回复客户，拿不准的问题不回，转给人工并通知。' },
];
/** 号对象 → replyMode；老接口只有 autoReply 时按 true → auto、false → off 换算 */
export const replyModeOf = (a) =>
  REPLY_MODES.some((m) => m.value === a?.replyMode) ? a.replyMode : a?.autoReply === true ? 'auto' : a?.autoReply === false ? 'off' : null;
export const replyModeLabel = (m) => REPLY_MODES.find((x) => x.value === m)?.label || '—';

// 推荐回复接口（POST /api/wa/conversations/:id/suggest）的错误码 → 提示；其他错误用接口自带的说明
export const SUGGEST_ERROR = {
  llm_not_configured: { admin: '还没有配置 AI 模型，请先到「设置 → AI 模型」填写', agent: '还没有配置 AI 模型，请联系管理员' },
  no_customer_message: '客户还没发过消息，暂时没法推荐回复',
  llm_daily_limit: '这个会话今天的 AI 次数用完了，明天再试',
  account_deleted: '这个会话所属的号已删除，不能再推荐回复',
  llm_error: 'AI 生成失败，请稍后再试',
};
export function suggestErrorText(e, isAdmin) {
  const m = SUGGEST_ERROR[e?.code];
  if (m) return typeof m === 'string' ? m : isAdmin ? m.admin : m.agent;
  if (e?.status === 404) return '这个会话不存在或已删除';
  return e?.message || '推荐回复生成失败，请稍后再试';
}

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

// 客户消息上的 botDecision（replied 不标）。suggested 只在 v0.3.0 推荐回复模式的历史消息上有
export const BOT_DECISION_NOTE = {
  offtopic: '离题·未回复',
  handoff: '转人工',
  blocked: '已拦截·转人工',
  skipped: '未处理',
  declined: '客户拒绝·已停止',
  suggested: '已生成推荐回复',
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

// 一键翻译（设置 → 翻译）：翻译方式和翻译服务。腾讯云在最后：已停止接受新用户
export const TRANSLATION_MODES = [
  { value: 'ai', label: 'AI 翻译（用回复模型）' },
  { value: 'api', label: '翻译 API' },
];
export const TRANSLATION_PROVIDERS = [
  { value: 'deepl', label: 'DeepL' },
  { value: 'deeplx', label: 'DeepLX（自己部署）' },
  { value: 'azure', label: 'Azure 翻译' },
  { value: 'google', label: '谷歌翻译' },
  { value: 'baidu', label: '百度翻译' },
  { value: 'volcengine', label: '火山翻译' },
  { value: 'libretranslate', label: 'LibreTranslate（自己部署）' },
  { value: 'tencent', label: '腾讯云翻译', desc: '已停止接受新用户，2027-10-01 起全部停用' },
];
/** 翻译服务的名字（会话里翻译后的提示用，不带括号里的说明） */
export const translationProviderLabel = (v) =>
  (TRANSLATION_PROVIDERS.find((x) => x.value === v)?.label || v || '').replace(/（.*）$/, '');

// F4 媒体类型
export const MEDIA_LABEL = {
  voice: '语音',
  image: '图片',
  video: '视频',
  document: '文件',
  sticker: '贴纸',
};

/** 人工回复的号收到客户消息时后端记的跳过原因（和 server/src/wa/service.js 一致）。人工回复的号会话页不显示这句 */
export const SKIP_NO_AUTO_REPLY = '这个号没开自动回复';
/** 客户撤回了还没处理的消息时记的跳过原因（同 service.js 的 REVOKED_SKIP_REASON）。消息上已经标了「客户已撤回」，不再重复显示 */
export const SKIP_REVOKED = '客户撤回了这条消息';
/** 号的回复方式不是自动回复（人工回复）。不知道（号已删除、还没拿到号列表）时返回 false，按自动回复的样子显示 */
export const isManualMode = (mode) => mode != null && mode !== 'auto';

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

// F5 红线体检：题目类别，key 和后端题库一致（catalog 是正常题，要回复并带文件才算通过）
export const REDTEAM_CATEGORY = {
  price_discount: '要折扣砍价',
  price_quote: '按量报价',
  purchase: '下单付款',
  identity: '问身份',
  offtopic_task: '离题任务',
  injection: '注入攻击',
  file_dump: '整库索取文件',
  catalog: '要产品目录',
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

// F12 看板：处理结果（decisions.decision）和各结果下的 code。和 server/src/codes.js 一致，接口返回里一般自带 label，这里只做兜底。
// 同一个 code 在不同结果下含义不同（handoff 和 offtopic 都有 other），所以按 decision 分开放
export const DECISION_LABELS = {
  replied: '已回复',
  handoff: '转人工',
  blocked: '已拦截',
  offtopic: '离题',
  declined: '客户拒绝',
  suggested: '已生成推荐回复',
  skipped: '未处理',
};

export const DECISION_CODES = {
  replied: {
    business: '业务回复',
    smalltalk: '寒暄',
  },
  handoff: {
    insufficient_info: '资料里没有答案',
    price: '议价或要报价',
    purchase: '想下单或谈付款',
    identity: '问是不是机器人',
    human_request: '客户要求人工',
    other: '其他原因',
    no_citation: '回复没有引用依据',
    review_ungrounded: '审核：内容找不到依据',
    review_commitment: '审核：有议价、成交承诺或身份问题',
    review_failed: '审核失败',
    media_unsupported: '语音图片超出识别范围',
    media_failed: '语音图片识别失败',
    rate_limit: '回复次数超限',
    file_limit: '发文件超过每日上限',
  },
  blocked: {
    price_mismatch: '价格数字对不上资料',
    discount_word: '有资料没写的优惠措辞',
    commitment_phrase: '有成交或承诺措辞',
    identity_leak: '暴露是机器人',
    too_long: '回复过长',
    code_block: '回复里有代码块',
    canary: '疑似提示词泄露',
    bad_file: '要发的文件不存在或超量',
  },
  offtopic: {
    task: '让机器人干别的活',
    chitchat: '闲聊',
    injection: '提示词注入',
    other: '其他离题',
    review_offtopic: '审核判定离题',
    muted: '反复离题，静默中',
  },
  declined: {
    declined: '客户拒绝',
  },
};
/** code 的中文标签；不认识的原样返回 */
export const codeLabel = (decision, code) => DECISION_CODES[decision]?.[code] ?? code ?? '—';

// F12 模型调用用途（llm_calls.purpose）
export const LLM_PURPOSES = {
  reply: '生成回复',
  review: '审核回复',
  draft: '起草人工回复',
  kb_draft: '人工回复存进知识库',
  distill: '整理知识库',
  media: '语音图片识别',
  file_describe: '产品资料描述',
  leads: '客户线索',
  redteam: '红线体检',
  translate: '翻译',
  suggest: '推荐回复',
  kb_search: '知识库检索改写',
  embedding: '向量检索',
  assistant: '助手',
  test: '测试连接',
};
export const purposeLabel = (p) => LLM_PURPOSES[p] ?? p ?? '—';

// F12 看板成员表：kind=user 是具体成员；phone、relay 两行不对应具体的人
export const MEMBER_KIND = {
  user: '成员',
  phone: '手机回复',
  relay: 'WhatsApp 转发',
};

// 按客户分配：分配记录的原因（conversation_assignments.reason）
export const ASSIGN_REASON = {
  manual: '手动分配',
  bulk: '批量分配',
  transfer: '转交客户',
  migration: '升级时自动分配',
  campaign: '外联回复',
  access_removed: '失去号码权限',
  user_deleted: '成员被删除',
};
export const assignReasonLabel = (r) => ASSIGN_REASON[r] || r || '—';

// 分配接口的错误码；其他错误用接口自带的提示
export const ASSIGN_ERROR = {
  assignee_invalid: '这个成员不存在或已停用，请换一个',
  assignee_no_account_access: '对方没有这个号的权限，先在成员页给他加上这个号',
};
export const assignErrorText = (e) => ASSIGN_ERROR[e?.code] || e?.message || '操作失败，请重试';

// 批量分配返回的 skipped[].code
export const ASSIGN_SKIP = {
  not_found: '会话已不存在',
  assignee_no_account_access: '对方没有号的权限',
  unchanged: '负责人没变',
};
