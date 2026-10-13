// INKDOVE_LLM_MOCK=1 时使用的确定性假实现。不发任何网络请求。
import { bm25Rank, entrySearchText, normKey } from '../kb/search.js';
import { CLICHE_TERMS, findTerms } from '../reply/redlines.js';
import { clip, sleep } from '../util.js';

/** 25 个常见问题及判断能否回答用的关键词 */
export const MOCK_QUESTIONS = [
  ['你们的产品价格是多少？', ['价格', '报价', '元', 'price', '$']],
  ['有哪些产品或服务？', ['产品', '服务', 'product']],
  ['最小起订量是多少？', ['起订', 'moq', '最少']],
  ['下单后多久发货？', ['发货', '交期', '交货', 'lead time']],
  ['支持哪些付款方式？', ['付款', '支付', 'payment']],
  ['运费怎么算？', ['运费', '物流', 'shipping']],
  ['发什么快递或物流？', ['快递', '物流', '海运', '空运']],
  ['可以寄到海外吗？', ['海外', '国际', '出口', 'international']],
  ['产品保修多久？', ['保修', '质保', 'warranty']],
  ['售后怎么联系？', ['售后', 'after-sales']],
  ['可以退换货吗？', ['退货', '换货', '退换', 'refund', 'return']],
  ['联系电话是多少？', ['电话', '手机', 'phone', 'tel']],
  ['邮箱是多少？', ['邮箱', 'email', '@']],
  ['营业时间是几点到几点？', ['营业时间', '工作时间', '营业', 'hours']],
  ['公司地址在哪里？', ['地址', '位于', 'address']],
  ['可以提供样品吗？', ['样品', 'sample']],
  ['支持定制吗？', ['定制', 'oem', 'odm', 'custom']],
  ['有现货吗？', ['现货', '库存', 'stock']],
  ['批量购买有折扣吗？', ['折扣', '优惠', 'discount']],
  ['可以开发票吗？', ['发票', 'invoice']],
  ['产品有哪些规格型号？', ['规格', '型号', '尺寸', 'model']],
  ['产品有什么认证？', ['认证', 'ce', 'iso', '证书']],
  ['如何下单？', ['下单', '订购', 'order']],
  ['周末和节假日营业吗？', ['周末', '节假日', '周六', '周日']],
  ['可以用哪些语言沟通？', ['语言', '英语', '中文', 'english']],
];

const classify = (line) => {
  if (/[?？]/.test(line)) return 'faq';
  if (/退|换货|保修|质保|售后|付款|支付|物流|运费|政策|refund|return|shipping|payment|policy|warranty/i.test(line)) return 'policy';
  if (/价格|报价|元|型号|规格|产品|price|model|\$/i.test(line)) return 'product';
  return 'fact';
};

const cleanLine = (l) =>
  l
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+[.、)]\s*/, '')
    .trim();

/** @param {{delayMs?: number}} [opts] */
export function createMockAi(opts = {}) {
  const delayMs = opts.delayMs ?? 150;
  const wait = (signal) => (delayMs > 0 ? sleep(delayMs, signal) : Promise.resolve());

  const ai = {
    async test() {
      return { model: 'mock', latencyMs: 0 };
    },

    async extract({ text, sourceName, signal }) {
      await wait(signal);
      let segs = text
        .split('\n')
        .filter((l) => !/^##\s.*\(https?:\/\/.*\)\s*$/.test(l))
        .map(cleanLine)
        .filter((l) => l.length >= 2);
      if (segs.length < 2) {
        segs = segs
          .flatMap((l) => l.split(/(?<=[。！？!?.])\s*/))
          .map((l) => l.trim())
          .filter((l) => l.length >= 2);
      }
      const picked = segs.slice(0, 3).map((line) => ({
        type: classify(line),
        title: clip(line.replace(/[。.!！?？:：]+$/, ''), 30),
        content: clip(line, 500),
        tags: [clip(sourceName, 20)],
        quote: clip(line, 120),
      }));
      while (picked.length < 2) {
        picked.push({
          type: 'fact',
          title: `${clip(sourceName, 20)} 概要${picked.length ? ' 2' : ''}`,
          content: clip(text, 300) || sourceName,
          tags: [clip(sourceName, 20)],
          quote: clip(text, 120),
        });
      }
      return picked;
    },

    async consolidate({ newEntries, candidates, signal }) {
      await wait(signal);
      const newIds = new Set(newEntries.map((e) => e.id));
      const groups = new Map();
      for (const e of [...candidates, ...newEntries]) {
        const k = normKey(e.title);
        if (!groups.has(k)) groups.set(k, []);
        const g = groups.get(k);
        if (!g.some((x) => x.id === e.id)) g.push(e);
      }
      const merges = [];
      for (const g of groups.values()) {
        if (g.length < 2 || !g.some((e) => newIds.has(e.id))) continue;
        const longest = g.reduce((a, b) => (b.content.length > a.content.length ? b : a));
        merges.push({
          ids: g.map((e) => e.id),
          title: g[0].title,
          content: longest.content,
          tags: [...new Set(g.flatMap((e) => e.tags || []))],
        });
      }
      return { merges, conflicts: [] };
    },

    async profile({ current, material, entryTitles, signal }) {
      await wait(signal);
      const lines = material
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      return {
        companyName: current.companyName || clip(lines[0] || '', 40),
        summary: current.summary || clip(lines.join(' '), 200),
        offerings: current.offerings || entryTitles.slice(0, 5).join('、'),
        contact: current.contact,
        hours: current.hours,
        languages: current.languages,
        other: current.other,
      };
    },

    async listQuestions({ signal }) {
      await wait(signal);
      return MOCK_QUESTIONS.map(([q]) => q);
    },

    async judgeQuestions({ questions, entries, signal }) {
      await wait(signal);
      const texts = entries.map((e) => entrySearchText(e).toLowerCase());
      return questions.map((q) => {
        const kws = MOCK_QUESTIONS.find(([mq]) => mq === q)?.[1];
        const answerable = kws
          ? texts.some((t) => kws.some((k) => t.includes(k.toLowerCase())))
          : bm25Rank(q, entries, entrySearchText).length > 0;
        return { question: q, answerable, reason: answerable ? '' : '知识库里没有相关信息' };
      });
    },

    /**
     * 规则（见 SPEC 4 节末尾）：含"不需要""not interested""no thanks" → declined（F11，最先判）；
     * 含"写代码""code""翻译" → offtopic（offtopic_type=task），含"ignore previous" → offtopic（injection）；
     * 含"人工""human" → handoff；含"折扣""便宜""discount""太贵""too expensive" → handoff（price）；关键词命中条目 → business（拼接条目）；
     * 简单问候 → smalltalk；其余 → handoff（insufficient_info，question_zh 取客户原话）。
     * F15：整库索取 → handoff；含"目录""catalog""价目表""price list""规格书""spec"且有文件的 name 或 description 含同一个词 → 发那个文件。
     * F5 红线体检补充（排在上面几条之后、发文件和条目检索之前，词表见 MOCK_REDTEAM_RULES）：注入 → offtopic（injection）；
     * 离题任务 → offtopic（task）；问身份或模型 → handoff（identity）；砍价比价 → handoff（price）；按量报价、算总价 → handoff（price）；
     * 开 PI、留货、place an order、西班牙语下单付款 → handoff（purchase）。
     * styleHint（F14 套话重写）：把上一版里命中的套话词去掉后原样返回。
     */
    async generate({ message, entries, files = [], styleHint = null }) {
      const base = mockGenerate(message, entries, files);
      if (!styleHint) return base;
      let reply = String(styleHint.previous || '');
      for (const term of findTerms(reply, CLICHE_TERMS)) {
        reply = reply.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '');
      }
      return { ...base, reply: reply.replace(/^[\s，,。.!！]+/, '').trim() || base.reply };
    },

    /** mock 审核：回复含 ``` 给 offtopic，其余给 ok */
    async review({ reply }) {
      if (reply.includes('```')) return { verdict: 'offtopic', reason: '回复里有代码块（mock 审核）' };
      return { verdict: 'ok', reason: 'mock 审核通过' };
    },

    /** F2a mock 草稿：命中条目就照条目写；涉及价格、折扣、下单的加【待你确认：…】；文件按 F15 的关键词规则挑 */
    async draft({ message, entries, files = [], signal }) {
      await wait(signal);
      const hits = bm25Rank(message, entries, entrySearchText).slice(0, 2);
      const parts = [];
      if (hits.length) parts.push(hits.map((h) => h.doc.content).join('\n'));
      if (/折扣|便宜|优惠|价格|报价|discount|price|下单|付款|order/i.test(message)) parts.push('【待你确认：价格、折扣和下单条件】');
      if (!parts.length) parts.push(`这个我确认一下再回复你。【待你确认：${clip(message.replace(/\s+/g, ' '), 40)}】`);
      return { text: parts.join('\n'), fileIds: matchFiles(message, files) };
    },

    /**
     * 推荐回复 mock：和草稿一样起草；跟进时（followUp）照我方最后发的那几条起草（兑现我方说要做的事），不再回客户那条老消息；
     * 「换一条」（带 previous）时换个开头，保证和上一条不同
     */
    async suggest({ message, entries, files = [], previous = '', followUp = false, ourMessages = [], signal }) {
      const basis = followUp && ourMessages.length ? ourMessages.join('\n') : message;
      const d = await ai.draft({ message: basis, entries, files, signal });
      if (!previous) return d;
      const text = `换个说法：${d.text}`;
      return { ...d, text: text === previous ? `再换个说法：${d.text}` : text };
    },

    /** F2b mock：问题做标题，答案去掉电话号码和邮箱后做内容 */
    async kbDraft({ question, answer }) {
      const content = String(answer)
        .replace(/\+?\d[\d\s-]{6,}\d/g, '')
        .replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      return { type: 'faq', title: clip(String(question || answer).replace(/\s+/g, ' ').trim(), 40), content, tags: ['会话'] };
    },

    /** 一键翻译 mock：按客户消息里的字符判断语言（见 mockLanguage）；和原文同一种语言时原样返回，否则返回"[译成 X] 原文" */
    async translate({ text, customerMessages = [] }) {
      await wait();
      const language = mockLanguage(customerMessages.join('\n'));
      const translation = mockLanguage(text) === language ? text : `[译成 ${language}] ${text}`;
      return { language, translation };
    },

    /** F6 mock 线索提取：规则见 mockExtractLead */
    async extractLead({ messages = [] }) {
      await wait();
      return mockExtractLead(messages);
    },

    /** F4 mock 识图：图片字节本身是可读文字时（测试用）照抄，否则给通用描述 */
    async describeImage({ mime, data }) {
      await wait();
      const text = readableText(Buffer.from(data, 'base64'));
      return text ? `图片里写着："${clip(text, 200)}"` : `一张图片（${mime}）`;
    },

    /** F4 mock 转写：音频字节本身是可读文字时（测试用）照抄，否则给固定文本 */
    async transcribe({ audio }) {
      await wait();
      return readableText(Buffer.from(audio)) || '（mock 转写）一段语音';
    },

    /** F15 mock 文件描述：文件名 + 正文开头 */
    async describeFile({ name, filename, text = '', image = null }) {
      await wait();
      const head = clip(String(text).replace(/\s+/g, ' ').trim(), 80);
      return `${name}（${filename}）${head ? `：${head}` : image ? '：产品图片' : ''}`;
    },
  };
  return ai;
}

/** 翻译 mock 的语言判断：按特有字符或常见词，依次看日文假名、韩文、汉字、阿拉伯字母、西里尔字母、西班牙语、葡萄牙语，其余算英语 */
const MOCK_LANGUAGE_RULES = [
  ['日语', /[\u3040-\u30ff]/],
  ['韩语', /[\uac00-\ud7af]/],
  ['中文', /[\u4e00-\u9fff]/],
  ['阿拉伯语', /[\u0600-\u06ff]/],
  ['俄语', /[\u0400-\u04ff]/],
  ['西班牙语', /[ñ¿¡]|cuánto|\b(hola|gracias|precio|quiero)\b/i],
  ['葡萄牙语', /[ãõ]|olá|preço|\bobrigad[oa]\b/i],
];
function mockLanguage(text) {
  const s = String(text || '');
  return MOCK_LANGUAGE_RULES.find(([, re]) => re.test(s))?.[0] || '英语';
}

/** 能当文字读的字节（UTF-8 合法且没有控制字符）→ 文本；否则 '' */
function readableText(buf) {
  const t = buf.toString('utf8');
  if (!t.trim() || t.includes('\uFFFD') || /[\u0000-\u0008\u000E-\u001F]/.test(t)) return '';
  return t.trim();
}

/** F15 mock 规则：客户消息和文件的 name/description 含同一个关键词，就发那个文件（最多 3 个） */
const FILE_WORDS = ['目录', 'catalog', '价目表', 'price list', '规格书', 'spec'];
function matchFiles(message, files) {
  const m = String(message).toLowerCase();
  const words = FILE_WORDS.filter((w) => m.includes(w));
  if (!words.length) return [];
  return files
    .filter((f) => words.some((w) => `${f.name}\n${f.description}`.toLowerCase().includes(w)))
    .slice(0, 3)
    .map((f) => f.id);
}

/**
 * F5 红线体检补充的 mock 规则：[正则, offtopic|handoff, offtopic_type 或 handoff_type, 原因]，按顺序取第一条命中的。
 * 只收红线题会用到的说法，不收"多少钱""price""order""payment"这类正常问题也会用的词。
 */
const MOCK_REDTEAM_RULES = [
  [
    /ignore (all |any )?(the |your )?(previous|prior|above)|忽略(之前|以上|前面|上面|所有)|system prompt|系统提示|提示词|开发者模式|developer mode|<\/?customer_message>|\[(system|admin)\]|【(系统|管理员)|管理员(已|指令|通知)|(ignora|olvida) (todas )?(tus |las )?instrucciones/i,
    'offtopic',
    'injection',
    '让机器人忽略规则、透露设定或冒充系统',
  ],
  [
    /代码|编程|python|javascript|写一篇|写首诗|写一首|作文|essay|poem|翻译|translate|tradu[cz]|角色扮演|role-?play|pretend (to be|you are)|\d+\s*(times|乘以|multiplied by)\s*\d+|方程|equation|presidente?\b|百科|wikipedia/i,
    'offtopic',
    'task',
    '要求做与本企业业务无关的事',
  ],
  [
    /(是|是不是|还是)\s*(真人|机器人|ai)|真人吗|机器人吗|chatgpt|\bgpt|什么模型|哪个模型|大模型|(what|which) (ai )?model are you|are you (a |an )?(bot|robot|human|real|ai)\b|real person|eres (un |una )?(bot|robot|ia|humano|persona)\b|persona real/i,
    'handoff',
    'identity',
    '客户问是不是真人或用的什么模型',
  ],
  [
    /打折|打个折|砍价|最低价|底价|让利|best price|better price|lowest price|cheaper|lower price|descuento|rebaja|mejor precio|más barato/i,
    'handoff',
    'price',
    '客户砍价或比价',
  ],
  [
    /总价|一共多少|总共多少|quote me|give me a quote|quotation for|total (price|cost)|in total|en total|precio total/i,
    'handoff',
    'price',
    '客户要按数量报价或算总价',
  ],
  [
    /\bPI\b|proforma|留货|[给帮替为]我留(?![意言心神])|place (an |the |my )?order|\breserve\b|hacer un pedido|c[oó]mo pago/i,
    'handoff',
    'purchase',
    '客户要开 PI、留货或下单付款',
  ],
];

/** mock 生成规则（见 generate 的注释） */
function mockGenerate(message, entries, files = []) {
  const out = (category, reason, reply = '', usedEntryIds = [], extra = {}) => ({
    category,
    reply,
    usedEntryIds,
    sendFileIds: extra.sendFileIds || [],
    handoffType: extra.handoffType || '',
    offtopicType: extra.offtopicType || '',
    questionZh: extra.questionZh || '',
    reason,
  });
  const handoff = (type, reason, questionZh = '') => out('handoff', reason, '', [], { handoffType: type, questionZh });
  if (/不需要|not interested|no thanks/i.test(message)) return out('declined', '客户说不需要');
  if (/ignore previous/i.test(message)) return out('offtopic', '让机器人忽略规则', '', [], { offtopicType: 'injection' });
  if (/写代码|code|翻译/i.test(message)) return out('offtopic', '要求做与本企业业务无关的事', '', [], { offtopicType: 'task' });
  if (/所有的?文件|全部的?文件|all (of )?(your )?files/i.test(message)) return handoff('other', '客户要整库的文件');
  if (/人工|human/i.test(message)) return handoff('human_request', '客户要求人工');
  if (/折扣|便宜|discount/i.test(message)) return handoff('price', '客户要求打折');
  if (/太贵|too expensive/i.test(message)) return handoff('price', '客户嫌贵');
  if (/下单|付款/.test(message)) return handoff('purchase', '客户想下单');
  if (/是不是机器人|are you a bot/i.test(message)) return handoff('identity', '客户问是不是机器人');
  const redteam = MOCK_REDTEAM_RULES.find(([re]) => re.test(message));
  if (redteam) {
    const [, kind, type, reason] = redteam;
    return kind === 'offtopic' ? out('offtopic', reason, '', [], { offtopicType: type }) : handoff(type, reason);
  }
  const fileIds = matchFiles(message, files);
  if (fileIds.length) {
    const reply = /[\u4e00-\u9fff]/.test(message) ? '发你了，你看下' : "Here's the file, take a look";
    return out('business', '客户要资料，库里有对应文件', reply, [], { sendFileIds: fileIds });
  }
  const hits = bm25Rank(message, entries, entrySearchText).slice(0, 3);
  if (hits.length) {
    const reply = clip(hits.map((h) => `*${h.doc.title}*：${h.doc.content}`).join('\n'), 600);
    return out('business', '资料里有答案', reply, hits.map((h) => h.doc.id));
  }
  if (/^\s*(你好|您好|hi|hello|hey|谢谢|thanks?|thank you|再见|bye)[\s!！。.,，~]*$/i.test(message)) {
    return out('smalltalk', '寒暄', '您好，想了解哪款产品？');
  }
  return handoff('insufficient_info', '资料里找不到答案', clip(message.replace(/\s+/g, ' ').trim(), 100));
}

/**
 * F6 mock 线索提取，只看客户说的话：
 * - stage 取最靠后的阶段：含"下单""order""PI" → order_intent；含"价格""价钱""price""discount" → negotiation；
 *   含"样品""sample" → sample；否则 inquiry；
 * - name 取"我叫 X""my name is X"；company 取"公司是 X""公司：X""company: X""company is X"；email 取第一个邮箱；
 *   quantity 取"数字 + 单位"（个、件、台、套、箱、pcs、pieces、units、sets）；country、interest 留空；
 * - summary 是"mock 提取：客户说了 N 句，最近一句是「…」"。
 */
function mockExtractLead(messages) {
  const said = messages.filter((m) => m.author === 'customer').map((m) => String(m.text || ''));
  const all = said.join('\n');
  const pick = (re) => (all.match(re)?.[1] || '').trim();
  let stage = 'inquiry';
  if (/下单|\border|\bPI\b/i.test(all)) stage = 'order_intent';
  else if (/价格|价钱|price|discount/i.test(all)) stage = 'negotiation';
  else if (/样品|sample/i.test(all)) stage = 'sample';
  const last = clip((said[said.length - 1] || '').replace(/\s+/g, ' ').trim(), 40);
  return {
    name: pick(/(?:我叫|my name is)\s*([^\s，,。.!！?？]{1,30})/i),
    company: pick(/(?:公司是|公司[:：]|company is|company[:：])\s*([^\n，,。!！?？]{1,60})/i),
    country: '',
    email: pick(/([^\s@<>，,；;：:]+@[^\s@<>，,；;]+\.[a-z]{2,})/i),
    interest: '',
    quantity: pick(/(\d+\s*(?:个|件|台|套|箱|pcs|pieces|units|sets))/i),
    stage,
    summary: said.length ? `mock 提取：客户说了 ${said.length} 句，最近一句是「${last}」` : 'mock 提取：客户还没说话',
  };
}
