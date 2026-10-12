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

  return {
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
     * 规则（见 SPEC 4 节末尾）：含"写代码""code""翻译""ignore previous" → offtopic；
     * 含"人工""human" → handoff；关键词命中条目 → business（拼接条目）；
     * 简单问候 → smalltalk；其余 → handoff（insufficient_info，question_zh 取客户原话）。
     * F15：整库索取 → handoff；含"目录""catalog""价目表""price list""规格书""spec"且有文件的 name 或 description 含同一个词 → 发那个文件。
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

    /** F2b mock：问题做标题，答案去掉电话号码和邮箱后做内容 */
    async kbDraft({ question, answer }) {
      const content = String(answer)
        .replace(/\+?\d[\d\s-]{6,}\d/g, '')
        .replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      return { type: 'faq', title: clip(String(question || answer).replace(/\s+/g, ' ').trim(), 40), content, tags: ['会话'] };
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

/** mock 生成规则（见 generate 的注释） */
function mockGenerate(message, entries, files = []) {
  const out = (category, reason, reply = '', usedEntryIds = [], extra = {}) => ({
    category,
    reply,
    usedEntryIds,
    sendFileIds: extra.sendFileIds || [],
    handoffType: extra.handoffType || '',
    questionZh: extra.questionZh || '',
    reason,
  });
  const handoff = (type, reason, questionZh = '') => out('handoff', reason, '', [], { handoffType: type, questionZh });
  if (/写代码|code|翻译|ignore previous/i.test(message)) return out('offtopic', '要求做与本企业业务无关的事');
  if (/所有的?文件|全部的?文件|all (of )?(your )?files/i.test(message)) return handoff('other', '客户要整库的文件');
  if (/人工|human/i.test(message)) return handoff('human_request', '客户要求人工');
  if (/折扣|便宜|discount/i.test(message)) return handoff('price', '客户要求打折');
  if (/下单|付款/.test(message)) return handoff('purchase', '客户想下单');
  if (/是不是机器人|are you a bot/i.test(message)) return handoff('identity', '客户问是不是机器人');
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
