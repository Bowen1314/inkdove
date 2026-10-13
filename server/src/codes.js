// 枚举值 → 中文标签（SPEC-phase2 F12）。看板按 code 分组统计，通知和看板共用这里的文案。
// 枚举值本身和规格一字不差；F15 在 F12 的表外新增了 blocked 的 bad_file 和 handoff 的 file_limit（README 偏离规格第 23 条）。

/** 处理结果（decisions.decision）。skipped 不写进 decisions 表，这里只为显示 */
export const DECISION_LABELS = {
  replied: '已回复',
  handoff: '转人工',
  blocked: '已拦截',
  offtopic: '离题',
  declined: '客户拒绝',
  skipped: '未处理',
};

/**
 * 每种处理结果下的 code 及中文标签。同一个 code 在不同结果下含义不同（handoff 和 offtopic 都有 other），
 * 所以按 decision 分开放，取标签用 codeLabel(decision, code)。
 */
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
export const codeLabel = (decision, code) => DECISION_CODES[decision]?.[code] ?? code;

/** 回复引擎模型输出的 offtopic_type（只在 category 为 offtopic 时填），和 offtopic 的 code 同名 */
export const OFFTOPIC_TYPES = ['task', 'chitchat', 'injection', 'other'];

/** 转人工通知的原因类别（flagNeedsHuman 的 reason） */
export const NOTIFY_REASONS = {
  handoff: '机器人没把握，转人工',
  blocked: '机器人的回复被规则拦截，没有发出',
  non_text: '非文字消息',
  rate_limit: '回复次数超限',
};

/**
 * 模型调用的用途（llm_calls.purpose）。规格的列表外新增两个：file_describe 是 F15 给产品资料写描述；
 * translate 是会话输入框的一键翻译（后台人工把要发的文字翻成客户的语言），不计入会话每日模型次数。
 */
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
  test: '测试连接',
};
export const purposeLabel = (p) => LLM_PURPOSES[p] ?? p;

/**
 * F6 客户线索的阶段（leads.stage、lead_stage_history.stage）。CSV 导出和看板共用这里的文案。
 * 前四个按顺序就是 F12 看板漏斗的阶段顺序；after_sales 和 other 不进漏斗。
 */
export const LEAD_STAGES = {
  inquiry: '询价',
  sample: '要样品',
  negotiation: '议价',
  order_intent: '有下单意向',
  after_sales: '售后',
  other: '其他',
};
export const leadStageLabel = (s) => LEAD_STAGES[s] ?? s;

/** 转人工后第一条人工消息是怎么发的（handoffs.firstResponderKind） */
export const RESPONDER_KINDS = {
  admin_ui: '后台发送',
  whatsapp_relay: 'WhatsApp 转发',
  phone: '手机回复',
};

/** F11 外联任务的状态（campaigns.status） */
export const CAMPAIGN_STATUSES = {
  draft: '草稿',
  running: '发送中',
  paused: '已暂停',
  done: '已完成',
  cancelled: '已取消',
};
export const campaignStatusLabel = (s) => CAMPAIGN_STATUSES[s] ?? s;

/** F11 外联收件人的状态（campaign_recipients.status） */
export const RECIPIENT_STATUSES = {
  pending: '待发',
  sent: '已发',
  failed: '失败',
  skipped: '跳过',
};

/** F11 外联收件人跳过的原因（campaign_recipients.skip_reason）。前五个在预检时判断，not_on_whatsapp 在发送时判断 */
export const OUTREACH_SKIP_REASONS = {
  invalid: '格式不对',
  duplicate: '重复',
  blocklisted: '在黑名单',
  notify_number: '是通知号码',
  already_contacted: '联系过',
  not_on_whatsapp: '没有 WhatsApp',
};
export const skipReasonLabel = (r) => OUTREACH_SKIP_REASONS[r] ?? r;
