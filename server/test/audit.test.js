// 操作日志：各类改动都记下来（谁、什么时候、改了什么、成功失败、IP）；给客户发消息和页面自动发的请求不记；
// 登录成功失败都记（不记密码）；密钥只记「已修改」绝不落明文；agent 越权的 403 记为失败；只有 admin 能查，没有改和删的接口；
// 撤回消息不记内容；AI 助手不记问的内容和对话标题；全局代理的订阅地址、粘贴的配置和节点的凭证不落库；筛选和游标分页；过期清理。模型都用 mock。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ASSISTANT_DAILY_QUESTIONS } from '../src/assistant/store.js';
import { loadConfig } from '../src/config.js';
import { localDay } from '../src/wa/service.js';
import { ADMIN_EMAIL, convIdOf, convPath, PASSWORD, startApp, startFakeWaha, waitFor, wahaSend } from './helpers.js';

describe('操作日志', () => {
  let t;
  let fake;
  let acc;
  let agent;
  let ipSeq = 0;
  const rows = () => t.ctx.db.prepare('SELECT * FROM audit_logs ORDER BY seq').all();
  const total = () => t.ctx.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n;
  const last = (action) => t.ctx.db.prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY seq DESC LIMIT 1').get(action);
  const changesOf = (row) => JSON.parse(row.changes);
  /** 整张表（所有列）拼成一个字符串，查有没有明文 */
  const dump = () => JSON.stringify(rows());
  /** 登录请求，每次换一个来源 IP（不触发同一 IP 的失败次数限制） */
  const login = (email, password) =>
    t.req('POST', '/api/auth/login', { body: { email, password }, auth: false, headers: { 'x-forwarded-for': `203.0.113.${++ipSeq}` } });

  before(async () => {
    fake = await startFakeWaha();
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url } });
    await t.login();
    acc = await t.createAccount({ name: '销售 1 号' });
    agent = await t.addMember({ email: 'audit-agent@example.com', name: '张三', accountIds: [acc.id] });
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  describe('登录和账号', () => {
    it('登录成功记操作人、IP；登录失败记成失败，操作人是这个邮箱对应的成员，不记密码', async () => {
      const ok = last('auth.login');
      assert.equal(ok.ok, 1);
      assert.equal(ok.actor_email, ADMIN_EMAIL);
      assert.equal(ok.actor_role, 'admin');
      assert.equal(ok.summary, '登录');
      assert.ok(ok.ip, '记了 IP');
      assert.equal(ok.category, 'auth');

      const r = await login(ADMIN_EMAIL, 'wrong-password-for-audit');
      assert.equal(r.status, 401);
      const bad = last('auth.login');
      assert.equal(bad.ok, 0);
      assert.equal(bad.status, 401);
      assert.equal(bad.summary, '登录失败');
      assert.equal(bad.error, '邮箱或密码错误');
      assert.equal(bad.actor_email, ADMIN_EMAIL);
      assert.ok(bad.actor_id, '是现有成员时带上他的 id');
      assert.equal(bad.ip, `203.0.113.${ipSeq}`);
      assert.ok(!dump().includes('wrong-password-for-audit'), '密码不落库');
      assert.ok(!dump().includes(PASSWORD), '正确的密码也不落库');
    });

    it('不是成员的邮箱只记邮箱；邮箱栏里填的不像邮箱（可能是密码）时不记原文；被限流的（429）不再记', async () => {
      await login('nobody@example.com', 'whatever-password-1');
      let row = last('auth.login');
      assert.equal(row.ok, 0);
      assert.equal(row.actor_id, null);
      assert.equal(row.actor_email, 'nobody@example.com');

      await login('looks-like-a-password-777', 'x');
      row = last('auth.login');
      assert.equal(row.actor_email, '（不是邮箱格式）');
      assert.ok(!dump().includes('looks-like-a-password-777'));

      // 同一个邮箱失败 5 次后限流：第 6 次 429，不记
      const email = 'flood@example.com';
      for (let i = 0; i < 5; i++) await login(email, 'bad-password-flood');
      const before429 = total();
      const r = await login(email, 'bad-password-flood');
      assert.equal(r.status, 429);
      assert.equal(total(), before429, '429 不记');
    });

    it('退出登录、改密码（失败也记，新旧密码都不记）、我的资料、个人话术', async () => {
      const cookie = await t.loginAs(ADMIN_EMAIL, PASSWORD);
      const out = await t.req('POST', '/api/auth/logout', { cookie });
      assert.equal(out.status, 200);
      assert.equal(last('auth.logout').summary, '退出了登录');

      let r = await t.req('POST', '/api/auth/password', { cookie: agent.cookie, body: { currentPassword: 'not-the-password', newPassword: 'agent-new-password-1' } });
      assert.equal(r.status, 400);
      let row = last('auth.password');
      assert.equal(row.ok, 0);
      assert.equal(row.summary, '修改自己的登录密码');
      assert.equal(row.actor_id, agent.user.id);
      r = await t.req('POST', '/api/auth/password', { cookie: agent.cookie, body: { currentPassword: agent.password, newPassword: 'agent-new-password-1' } });
      assert.equal(r.status, 200);
      row = last('auth.password');
      assert.equal(row.ok, 1);
      assert.equal(row.summary, '修改了自己的登录密码');
      assert.deepEqual(changesOf(row), [{ field: 'password', label: '登录密码', secret: true, note: '已修改' }]);
      agent.password = 'agent-new-password-1';
      assert.ok(!dump().includes('agent-new-password-1') && !dump().includes('not-the-password'));

      r = await t.req('PUT', '/api/auth/me/profile', { cookie: agent.cookie, body: { jobTitle: '销售经理', bio: '十年外贸经验' } });
      assert.equal(r.status, 200);
      row = last('auth.profile');
      assert.equal(row.actor_id, agent.user.id);
      assert.match(row.summary, /^修改了自己的「我的资料」：职位 （空） → 销售经理；补充介绍已填写（6 字）$/);
      assert.ok(!row.changes.includes('十年外贸经验'), '长文本只记字数');

      r = await t.req('PUT', '/api/auth/me/style-prompt', { cookie: agent.cookie, body: { stylePrompt: '说话简洁' } });
      assert.equal(r.status, 200);
      assert.equal(last('auth.style_prompt').summary, '修改了自己的个人话术：个人话术已填写（4 字）');
    });

    it('接受邀请、重置密码链接：记是谁，链接里的 token 不记', async () => {
      const inv = last('auth.invite_accept');
      assert.equal(inv.ok, 1);
      assert.equal(inv.actor_id, agent.user.id);
      assert.equal(inv.summary, '接受了邀请，设置登录密码');

      const r = await t.req('POST', `/api/users/${agent.user.id}/reset-link`);
      assert.equal(r.status, 200);
      assert.equal(last('member.reset_link').summary, '生成了成员「张三」的重置密码链接');
      const token = r.body.resetUrl.split('/invite/')[1];
      const a = await t.req('POST', `/api/invites/${token}/accept`, { body: { password: 'agent-reset-password-2' }, auth: false });
      assert.equal(a.status, 200);
      const row = last('auth.invite_accept');
      assert.equal(row.summary, '用重置链接重设了登录密码');
      assert.equal(row.actor_id, agent.user.id);
      agent.password = 'agent-reset-password-2';
      agent.cookie = a.headers.get('set-cookie').split(';')[0];
      const all = dump();
      assert.ok(!all.includes(token) && !all.includes(r.body.resetUrl) && !all.includes('agent-reset-password-2'));

      // 乱填的链接不记（找不到是谁）
      const n = total();
      const bad = await t.req('POST', `/api/invites/${'x'.repeat(43)}/accept`, { body: { password: 'whatever-password-3' }, auth: false });
      assert.equal(bad.status, 404);
      assert.equal(total(), n);
    });
  });

  describe('各类操作', () => {
    it('成员：邀请、修改（前后对比）、停用和启用', async () => {
      assert.equal(last('member.invite').summary, '邀请了成员「张三」（业务员）');
      const r = await t.req('PUT', `/api/users/${agent.user.id}`, { body: { name: '张三丰' } });
      assert.equal(r.status, 200);
      let row = last('member.update');
      assert.equal(row.summary, '修改了成员「张三丰」：名字 张三 → 张三丰');
      assert.equal(row.target_type, 'user');
      assert.equal(row.target_id, agent.user.id);
      assert.equal(row.target_name, '张三丰');
      assert.deepEqual(changesOf(row), [{ field: 'name', label: '名字', from: '张三', to: '张三丰' }]);

      const other = await t.addMember({ email: 'audit-other@example.com', name: '李四' });
      await t.req('PUT', `/api/users/${other.user.id}`, { body: { disabled: true } });
      row = last('member.update');
      assert.equal(row.summary, '停用了成员「李四」');
      assert.deepEqual(changesOf(row), [{ field: 'disabled', label: '状态', from: '启用中', to: '已停用' }]);
      await t.req('DELETE', `/api/users/${other.user.id}`);
      assert.equal(last('member.delete').summary, '删除了成员「李四」');
    });

    it('号码：改设置时一句话写清改了什么；导出号码配置也记', async () => {
      const r = await t.req('PUT', `/api/accounts/${acc.id}`, { body: { replyMode: 'auto' } });
      assert.equal(r.status, 200);
      const row = last('account.update');
      assert.equal(row.summary, '修改了号「销售 1 号」的设置：回复方式 人工回复 → 自动回复');
      assert.equal(row.category, 'account');
      assert.equal(row.target_type, 'account');
      assert.equal(row.target_name, '销售 1 号');

      const ex = await t.req('GET', '/api/accounts/export');
      assert.equal(ex.status, 200);
      assert.match(last('account.export').summary, /^导出了号码配置（\d+ 个号，文件里有密钥明文）$/);
    });

    it('会话：分给谁、暂停机器人；知识库：新建、修改、删除；客户线索导出；在线更新；不认识的接口按兜底记', async () => {
      const chat = '8613800000001@c.us';
      await wahaSend(t, acc, chat, 'hello');
      const convId = convIdOf(acc, chat);
      await waitFor(() => t.ctx.wa.getConversation(convId));
      let r = await t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId: agent.user.id } });
      assert.equal(r.status, 200);
      let row = last('conversation.assign');
      assert.match(row.summary, /^把会话「.+」分给了「张三丰」$/);
      assert.equal(row.target_id, convId);
      assert.deepEqual(changesOf(row), [{ field: 'assignee', label: '负责人', from: '未分配', to: '张三丰' }]);
      r = await t.req('POST', `${convPath(convId)}/bot`, { body: { paused: true } });
      assert.equal(r.status, 200);
      assert.match(last('conversation.bot').summary, /^暂停了会话「.+」的机器人/);

      r = await t.req('POST', '/api/kb/entries', { body: { type: 'faq', title: 'P600 价格', content: 'P600 每台 120 美元。' } });
      assert.equal(r.status, 200);
      const entryId = r.body.id;
      assert.equal(last('kb.entry_create').summary, '新建了知识条目「P600 价格」');
      r = await t.req('PUT', `/api/kb/entries/${entryId}`, { body: { status: 'disabled', content: 'P600 每台 110 美元。' } });
      assert.equal(r.status, 200);
      row = last('kb.entry_update');
      assert.equal(row.summary, '修改了知识条目「P600 价格」：内容已修改（15 字 → 15 字）；状态 启用中 → 已停用');
      assert.ok(!row.changes.includes('110 美元'), '长文本不记内容');
      r = await t.req('DELETE', `/api/kb/entries/${entryId}`);
      assert.equal(r.status, 200);
      row = last('kb.entry_delete');
      assert.equal(row.summary, '删除了知识条目「P600 价格」');
      assert.equal(row.category, 'kb');

      r = await t.req('GET', '/api/leads/export.csv?stage=inquiry');
      assert.equal(r.status, 200);
      row = last('lead.export');
      assert.equal(row.summary, '导出了 0 条客户线索（CSV）');
      assert.deepEqual(changesOf(row), [{ field: 'filters', label: '筛选条件', to: '阶段：询价' }]);

      // 测试实例关了检查更新（INKDOVE_UPDATE_CHECK=0）：400，记成失败，带上原因
      r = await t.req('POST', '/api/update/check');
      assert.equal(r.status, 400);
      row = last('system.update_check');
      assert.equal(row.summary, '检查新版本');
      assert.equal(row.ok, 0);
      assert.match(row.error, /INKDOVE_UPDATE_CHECK=0/);

      // 失败的也记：删不存在的外联任务 404
      r = await t.req('DELETE', '/api/campaigns/no-such-campaign');
      assert.equal(r.status, 404);
      row = last('campaign.delete');
      assert.equal(row.ok, 0);
      assert.equal(row.status, 404);
      assert.equal(row.summary, '删除外联任务「no-such-campaign」');

      // 没列出来的改动类接口：只记方法和去掉 id 的路径，不记请求体
      r = await t.req('POST', '/api/not-a-real-endpoint/abc123', { body: { secretThing: 'body-should-not-be-stored' } });
      assert.equal(r.status, 404);
      row = last('other.unknown');
      assert.equal(row.summary, '调用接口 POST /api/not-a-real-endpoint/:id');
      assert.equal(row.ok, 0);
      assert.ok(!dump().includes('body-should-not-be-stored'));
    });

    it('撤回消息：记哪个会话，不记消息内容；再撤回（409）记成失败', async () => {
      const revAcc = await t.createAccount({ name: '撤回号' });
      assert.equal((await t.req('POST', `/api/accounts/${revAcc.id}/waha/start`)).status, 200);
      const chat = '8613800000003@c.us';
      await wahaSend(t, revAcc, chat, 'how much');
      const convId = convIdOf(revAcc, chat);
      await waitFor(() => t.ctx.wa.getConversation(convId));
      const text = 'revoke-body-should-not-be-stored 99 USD';
      const sent = await t.req('POST', `${convPath(convId)}/send`, { body: { text } });
      assert.equal(sent.body.status, 'sent', JSON.stringify(sent.body));

      let r = await t.req('POST', `${convPath(convId)}/messages/${sent.body.id}/revoke`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      let row = last('conversation.message_revoke');
      assert.match(row.summary, /^撤回了会话「.+」里的一条消息$/);
      assert.equal(row.ok, 1);
      assert.equal(row.category, 'conversation');
      assert.equal(row.target_type, 'conversation');
      assert.equal(row.target_id, convId);
      assert.equal(row.changes, '[]');

      r = await t.req('POST', `${convPath(convId)}/messages/${sent.body.id}/revoke`);
      assert.equal(r.status, 409);
      row = last('conversation.message_revoke');
      assert.equal(row.ok, 0);
      assert.equal(row.status, 409);
      assert.match(row.summary, /^撤回会话「.+」里的一条消息$/);
      assert.equal(row.error, '这条消息已经撤回了');
      assert.ok(!dump().includes('revoke-body-should-not-be-stored'), '消息内容不落库');
    });

    it('AI 助手：提问、重试、删除对话都记，问的内容和对话标题（问题的前 40 字）不记；次数用完（429）记成失败', async () => {
      const question = 'assistant-question-not-stored 张三上周的报价是多少';
      let r = await t.req('POST', '/api/assistant/ask', { body: { question } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const chatId = r.body.chat.id;
      const msgId = r.body.message.id;
      let row = last('assistant.ask');
      assert.equal(row.summary, '向 AI 助手提问了');
      assert.equal(row.ok, 1);
      assert.equal(row.category, 'assistant');
      assert.equal(row.target_type, null);
      assert.equal(row.changes, '[]');

      // 等它答完（答没答成都行），改成失败再重试
      const status = () => t.ctx.db.prepare('SELECT status FROM assistant_messages WHERE id = ?').get(msgId).status;
      await waitFor(() => status() !== 'running');
      t.ctx.db.prepare("UPDATE assistant_messages SET status = 'failed', answer = NULL WHERE id = ?").run(msgId);
      r = await t.req('POST', `/api/assistant/chats/${chatId}/retry`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      row = last('assistant.retry');
      assert.equal(row.summary, '重新问了 AI 助手');
      assert.equal(row.category, 'assistant');
      await waitFor(() => status() !== 'running');

      r = await t.req('DELETE', `/api/assistant/chats/${chatId}`);
      assert.equal(r.status, 200);
      row = last('assistant.chat_delete');
      assert.equal(row.summary, '删除了一个 AI 助手对话');
      assert.equal(row.target_name, null);

      // 今天的次数用完：429 记成失败，错误信息里也没有问的内容
      const adminId = t.ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL).id;
      t.ctx.db
        .prepare('INSERT INTO assistant_usage(user_id, day, questions) VALUES(?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET questions = excluded.questions')
        .run(adminId, localDay(), ASSISTANT_DAILY_QUESTIONS);
      r = await t.req('POST', '/api/assistant/ask', { body: { question } });
      assert.equal(r.status, 429);
      row = last('assistant.ask');
      assert.equal(row.ok, 0);
      assert.equal(row.status, 429);
      assert.equal(row.summary, '向 AI 助手提问');
      assert.match(row.error, /今天的提问次数用完了/);
      t.ctx.db.prepare('DELETE FROM assistant_usage WHERE user_id = ?').run(adminId);

      const all = dump();
      assert.ok(!all.includes('assistant-question-not-stored') && !all.includes('张三上周的报价'), '问的内容、对话标题都不落库');
    });

    it('号的代理改成「用全局代理」：记成 关 → 开', async () => {
      const g = await t.createAccount({ name: '全局代理号' });
      const r = await t.req('PUT', `/api/accounts/${g.id}`, { body: { waha: { proxy: { enabled: false, useGlobal: true } } } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = last('account.update');
      assert.deepEqual(changesOf(row), [{ field: 'waha.proxy.useGlobal', label: '用全局代理', from: '关', to: '开' }]);
      assert.equal(row.summary, '修改了号「全局代理号」的设置：用全局代理 关 → 开');
    });

    it('只读的 GET 不记（导出除外）', async () => {
      const n = total();
      for (const p of ['/api/kb/entries', '/api/accounts', '/api/users', '/api/settings', '/api/health', '/api/auth/me', '/api/leads']) {
        const r = await t.req('GET', p);
        assert.equal(r.status, 200, p);
      }
      assert.equal(total(), n);
    });
  });

  describe('不记的', () => {
    it('给客户发消息、发文件不记；页面自动请求的推荐回复中文意思不记；webhook 不记', async () => {
      const chat = '8613800000002@c.us';
      const n0 = total();
      await wahaSend(t, acc, chat, 'need price');
      const convId = convIdOf(acc, chat);
      await waitFor(() => t.ctx.wa.getConversation(convId));
      assert.equal(total(), n0, 'webhook 不记');

      const n = total();
      await t.req('POST', `${convPath(convId)}/send`, { body: { text: 'Hi, the price is 120 USD' } });
      await t.req('POST', `${convPath(convId)}/send-file`, { body: { fileId: 'no-such-file' } });
      await t.req('POST', `${convPath(convId)}/draft/translation`, { body: { createdAt: new Date().toISOString(), text: 'Hello' } });
      assert.equal(total(), n, '发消息、发文件、草稿中文意思都不记');
      assert.ok(!dump().includes('the price is 120 USD'));
    });
  });

  describe('密钥', () => {
    it('设置里的密钥（包括 appId、accessKeyId、带令牌的服务地址这些名字不像密钥的）只记已设置，绝不落明文', async () => {
      const plain = [
        'llm-key-plain-AAAA1111',
        'baidu-appid-plain-2222',
        'baidu-appkey-plain-3333',
        'volc-akid-plain-4444',
        'volc-sak-plain-5555',
        'plain-token-path-6666',
        'q7777plainquery',
      ];
      const r = await t.req('PUT', '/api/settings', {
        body: {
          llm: { apiKey: plain[0] },
          translation: {
            providers: {
              baidu: { appId: plain[1], appKey: plain[2] },
              volcengine: { accessKeyId: plain[3], secretAccessKey: plain[4] },
              deeplx: { url: `https://deeplx.example.com/${plain[5]}/translate?key=${plain[6]}` },
            },
          },
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = last('settings.update');
      const changes = changesOf(row);
      const byField = Object.fromEntries(changes.map((c) => [c.field, c]));
      for (const f of [
        'llm.apiKey',
        'translation.providers.baidu.appId',
        'translation.providers.baidu.appKey',
        'translation.providers.volcengine.accessKeyId',
        'translation.providers.volcengine.secretAccessKey',
        'translation.providers.deeplx.url',
      ]) {
        assert.equal(byField[f]?.secret, true, f);
        assert.equal(byField[f]?.note, '已设置', f);
        assert.equal(byField[f].from, undefined);
        assert.equal(byField[f].to, undefined);
      }
      assert.equal(byField['translation.providers.baidu.appId'].label, '百度翻译 · APP ID');
      const all = dump();
      for (const p of plain) assert.ok(!all.includes(p), `明文 ${p} 不落库`);

      // 再改一次：已修改
      await t.req('PUT', '/api/settings', { body: { llm: { apiKey: 'llm-key-plain-BBBB2222' } } });
      const again = changesOf(last('settings.update'));
      assert.deepEqual(again, [{ field: 'llm.apiKey', label: '回复模型 · API 密钥', secret: true, note: '已修改' }]);
      assert.ok(!dump().includes('llm-key-plain-BBBB2222'));
    });

    it('号的 Meta 凭证、代理密码只记已设置；代理地址照常记', async () => {
      const meta = await t.createAccount({ name: 'Meta 号', channel: 'meta' });
      let r = await t.req('PUT', `/api/accounts/${meta.id}`, {
        body: { meta: { phoneNumberId: '1234567890', accessToken: 'meta-access-plain-7777', appSecret: 'meta-secret-plain-8888', verifyToken: 'verify-plain-9999' } },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      let row = last('account.update');
      let byField = Object.fromEntries(changesOf(row).map((c) => [c.field, c]));
      assert.equal(byField['meta.accessToken'].note, '已设置');
      assert.equal(byField['meta.appSecret'].secret, true);
      assert.equal(byField['meta.verifyToken'].secret, true);
      assert.equal(byField['meta.phoneNumberId'].to, '1234567890');

      r = await t.req('PUT', `/api/accounts/${acc.id}`, {
        body: { waha: { proxy: { enabled: true, protocol: 'socks5', host: '192.0.2.10', port: 1080, username: 'proxyuser', password: 'proxy-pass-plain-0000' } } },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      row = last('account.update');
      byField = Object.fromEntries(changesOf(row).map((c) => [c.field, c]));
      assert.deepEqual(byField['waha.proxy.password'], { field: 'waha.proxy.password', label: '代理密码', secret: true, note: '已设置' });
      assert.equal(byField['waha.proxy.host'].to, '192.0.2.10');
      assert.match(row.summary, /代理密码已设置|等 \d+ 项/);
      const all = dump();
      for (const p of ['meta-access-plain-7777', 'meta-secret-plain-8888', 'verify-plain-9999', 'proxy-pass-plain-0000']) {
        assert.ok(!all.includes(p), `明文 ${p} 不落库`);
      }
    });
  });

  describe('权限', () => {
    it('agent 越权的 403 记为失败（操作人是他）；agent 看操作日志 403；日志没有改和删的接口', async () => {
      const r = await t.req('PUT', '/api/settings', { cookie: agent.cookie, body: { reply: { humanize: false } } });
      assert.equal(r.status, 403);
      const row = last('settings.update');
      assert.equal(row.ok, 0);
      assert.equal(row.status, 403);
      assert.equal(row.actor_id, agent.user.id);
      assert.equal(row.actor_role, 'agent');
      assert.equal(row.error, '没有权限');
      assert.equal(row.summary, '修改设置');
      assert.equal(row.changes, '[]');

      const g = await t.req('GET', '/api/audit-logs', { cookie: agent.cookie });
      assert.equal(g.status, 403);
      const ty = await t.req('GET', '/api/audit-logs/types', { cookie: agent.cookie });
      assert.equal(ty.status, 403);

      const n = total();
      const id = rows()[0].seq;
      for (const m of ['DELETE', 'PUT', 'PATCH', 'POST']) {
        const x = await t.req(m, `/api/audit-logs/${id}`, { body: m === 'DELETE' ? undefined : { summary: 'x' } });
        assert.equal(x.status, 404, m);
      }
      const d = await t.req('DELETE', '/api/audit-logs');
      assert.equal(d.status, 404);
      assert.ok(t.ctx.db.prepare('SELECT 1 FROM audit_logs WHERE seq = ?').get(id), '日志还在');
      // 这些尝试本身也记下来了（兜底规则，失败）
      assert.equal(total(), n + 5);
    });

    it('没登录的请求不记', async () => {
      const n = total();
      const r = await t.req('PUT', '/api/settings', { auth: false, body: { reply: { humanize: false } } });
      assert.equal(r.status, 401);
      assert.equal(total(), n);
    });
  });

  describe('查询', () => {
    const FROM = '2020-01-01T00:00:00.000Z';
    const TO = '2020-01-02T00:00:00.000Z';
    before(() => {
      for (let i = 0; i < 120; i++) {
        t.ctx.audit.record({
          at: new Date(Date.parse(FROM) + i * 60_000).toISOString(),
          actor: i % 2 ? { id: agent.user.id, name: '张三丰', email: 'audit-agent@example.com', role: 'agent' } : { id: 'admin-x', name: '', email: ADMIN_EMAIL, role: 'admin' },
          action: i % 2 ? 'account.update' : 'kb.entry_update',
          summary: `测试第 ${i} 条`,
          target: { type: 'entry', id: `e${i}`, name: `条目 ${i}` },
          changes: [],
          ok: true,
          status: 200,
          ip: '198.51.100.7',
        });
      }
    });
    const list = (qs) => t.req('GET', `/api/audit-logs?${new URLSearchParams({ from: FROM, to: TO, ...qs })}`);

    it('按时间倒序、游标分页，一页一页翻完不重不漏', async () => {
      const seen = [];
      let cursor = '';
      let pages = 0;
      for (;;) {
        const r = await list({ limit: '50', ...(cursor ? { cursor } : {}) });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        pages++;
        seen.push(...r.body.items);
        if (!r.body.nextCursor) break;
        cursor = r.body.nextCursor;
      }
      assert.equal(pages, 3);
      assert.equal(seen.length, 120);
      assert.equal(new Set(seen.map((x) => x.id)).size, 120);
      for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1].at > seen[i].at, '时间倒序');
      const first = seen[0];
      assert.equal(first.summary, '测试第 119 条');
      assert.equal(first.categoryLabel, '号码');
      assert.deepEqual(first.target, { type: 'entry', typeLabel: '知识条目', id: 'e119', name: '条目 119' });
      assert.equal(first.actor.role, 'agent');
      assert.equal(first.ok, true);
    });

    it('按成员、操作类型（大类或具体操作）、关键字筛选；参数不对 400', async () => {
      let r = await list({ actorId: agent.user.id, limit: '200' });
      assert.equal(r.body.items.length, 60);
      r = await list({ type: 'kb', limit: '200' });
      assert.equal(r.body.items.length, 60);
      assert.ok(r.body.items.every((x) => x.category === 'kb'));
      r = await list({ type: 'account.update', limit: '200' });
      assert.equal(r.body.items.length, 60);
      r = await list({ q: '第 7 条' });
      assert.deepEqual(r.body.items.map((x) => x.summary), ['测试第 7 条']);
      r = await list({ q: '%' });
      assert.equal(r.body.items.length, 0, '% 不当通配符');
      r = await list({ q: '198.51.100.7', limit: '200' });
      assert.equal(r.body.items.length, 120, '能按 IP 找');

      // 不带时间范围：真实的操作（2026 年）排在最前面
      r = await t.req('GET', '/api/audit-logs?limit=5');
      assert.equal(r.body.items.length, 5);
      assert.ok(r.body.items[0].at > TO);

      r = await t.req('GET', '/api/audit-logs/types');
      assert.ok(r.body.some((x) => x.value === 'kb' && x.label === '知识库'));

      for (const qs of ['cursor=bad', 'from=not-a-date', 'limit=500', 'limit=0', 'type=DROP TABLE', `q=${'x'.repeat(201)}`]) {
        const x = await t.req('GET', `/api/audit-logs?${qs}`);
        assert.equal(x.status, 400, qs);
      }
    });
  });
});

describe('操作日志：全局代理', () => {
  /** 订阅地址里的 token（假的）：操作日志里不能出现 */
  const TOKEN = `subtoken${crypto.randomBytes(6).toString('hex')}`;
  const SUB_YAML = `
proxies:
  - name: 香港 01
    type: ss
    server: hk1.audit-node.example.test
    port: 8388
    cipher: aes-128-gcm
    password: "audit-ss-password-1"
  - name: SG 02
    type: hysteria2
    server: sg2.audit-node.example.test
    port: 8443
    password: audit-hy2-password-2
`;
  const CONFIG_YAML = `${SUB_YAML}  - name: US 03
    type: trojan
    server: us3.audit-node.example.test
    port: 443
    password: audit-trojan-password-3
`;
  const SECRETS = ['audit-ss-password-1', 'audit-hy2-password-2', 'audit-trojan-password-3', 'hk1.audit-node.example.test', 'us3.audit-node.example.test'];
  let t;
  let sub;
  const last = (action) => t.ctx.db.prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY seq DESC LIMIT 1').get(action);
  const changesOf = (row) => JSON.parse(row.changes);
  const dump = () => JSON.stringify(t.ctx.db.prepare('SELECT * FROM audit_logs ORDER BY seq').all());
  /** 订阅地址、机场节点的地址和密码都不在操作日志里 */
  const assertNoSecrets = () => {
    const all = dump();
    for (const s of [TOKEN, `127.0.0.1:${sub.port}`, ...SECRETS]) assert.ok(!all.includes(s), `${s} 不落库`);
  };

  before(async () => {
    const server = http.createServer((req, res) => {
      if (req.url.split('?')[0] === `/sub/${TOKEN}`) return res.end(SUB_YAML);
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    sub = {
      port: server.address().port,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => {
        server.closeAllConnections?.();
        return new Promise((r) => server.close(r));
      },
    };
    // 没有 mihomo：粘贴的配置和订阅不用 mihomo -t 查，开关打不开（这里只测关着时的设置）
    t = await startApp({
      env: { INKDOVE_MIHOMO_PATH: path.join(os.tmpdir(), `no-mihomo-audit-${process.pid}`) },
      options: { globalProxy: { refreshCheckMs: 0, subscriptionTimeoutMs: 2000 } },
    });
    await t.login();
  });
  after(async () => {
    await t.close();
    await sub.close();
  });

  it('订阅地址只记已设置 / 已修改 / 已清空，下载失败的错误信息里也没有地址；订阅的节点记个数', async () => {
    let r = await t.req('PUT', '/api/settings', { body: { proxy: { subscriptionUrl: `${sub.url}/missing/${TOKEN}` } } });
    assert.equal(r.status, 400);
    let row = last('settings.update');
    assert.equal(row.ok, 0);
    assert.match(row.error, /^proxy\.subscriptionUrl 下载订阅失败：机场返回 HTTP 404/);
    assert.equal(row.changes, '[]');

    r = await t.req('PUT', '/api/settings', { body: { proxy: { subscriptionUrl: `${sub.url}/sub/${TOKEN}`, bypass: ['*.corp.example.test'] } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    row = last('settings.update');
    assert.equal(row.ok, 1);
    assert.deepEqual(changesOf(row), [
      { field: 'proxy.subscriptionUrl', label: '全局代理 · 订阅地址', secret: true, note: '已设置' },
      { field: 'proxy.bypass', label: '全局代理 · 不走代理的地址', from: '（空）', to: '*.corp.example.test', note: '新增 1 个' },
      { field: 'proxy.subscriptionNodes', label: '全局代理 · 订阅的节点', note: '已设置（2 个节点）' },
    ]);
    assert.equal(
      row.summary,
      '修改了设置：全局代理 · 订阅地址已设置；全局代理 · 不走代理的地址 （空） → *.corp.example.test；全局代理 · 订阅的节点已设置（2 个节点）',
    );

    // 同一个订阅换个写法（多一个查询参数）：地址已修改，节点重新下载
    r = await t.req('PUT', '/api/settings', { body: { proxy: { subscriptionUrl: `${sub.url}/sub/${TOKEN}?flag=clash` } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(changesOf(last('settings.update')), [
      { field: 'proxy.subscriptionUrl', label: '全局代理 · 订阅地址', secret: true, note: '已修改' },
      { field: 'proxy.subscriptionNodes', label: '全局代理 · 订阅的节点', note: '已更新（2 个节点）' },
    ]);
    assertNoSecrets();
  });

  it('粘贴的 Clash 配置：原文和节点的地址、密码都不记，只记节点个数；清除记已清空', async () => {
    let r = await t.req('PUT', '/api/settings', { body: { proxy: { source: 'config', config: CONFIG_YAML } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let row = last('settings.update');
    assert.deepEqual(changesOf(row), [
      { field: 'proxy.source', label: '全局代理 · 节点来源', from: '订阅地址', to: '粘贴 Clash 配置' },
      { field: 'proxy.configNodes', label: '全局代理 · 粘贴的 Clash 配置', note: '已设置（3 个节点）' },
    ]);

    r = await t.req('PUT', '/api/settings', { body: { proxy: { config: SUB_YAML } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    row = last('settings.update');
    assert.equal(row.summary, '修改了设置：全局代理 · 粘贴的 Clash 配置已更新（2 个节点）');

    r = await t.req('PUT', '/api/settings', { body: { proxy: { config: null } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(changesOf(last('settings.update')), [{ field: 'proxy.configNodes', label: '全局代理 · 粘贴的 Clash 配置', note: '已清空' }]);
    assertNoSecrets();
  });

  it('测试、更新订阅、测速：记结果（不记错误信息）；更新订阅记节点个数', async () => {
    let r = await t.req('POST', '/api/settings/proxy/test');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    let row = last('settings.proxy_test');
    assert.equal(row.summary, '测试了全局代理（结果：没通过）');
    assert.equal(row.category, 'settings');
    assert.equal(row.ok, 1);
    assert.equal(row.error, null);

    r = await t.req('POST', '/api/settings/proxy/delay');
    assert.equal(r.body.ok, false);
    assert.equal(last('settings.proxy_delay').summary, '给全局代理的节点测了速（结果：没通过）');

    r = await t.req('POST', '/api/settings/proxy/refresh');
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    row = last('settings.proxy_refresh');
    assert.equal(row.summary, '更新了全局代理的订阅（结果：通过）：全局代理 · 订阅的节点已更新（2 个节点）');

    // 清掉订阅地址：地址和订阅的节点都已清空；再更新订阅就没通过
    r = await t.req('PUT', '/api/settings', { body: { proxy: { subscriptionUrl: null } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(changesOf(last('settings.update')), [
      { field: 'proxy.subscriptionUrl', label: '全局代理 · 订阅地址', secret: true, note: '已清空' },
      { field: 'proxy.subscriptionNodes', label: '全局代理 · 订阅的节点', note: '已清空' },
    ]);
    r = await t.req('POST', '/api/settings/proxy/refresh');
    assert.equal(r.body.ok, false);
    assert.equal(last('settings.proxy_refresh').summary, '更新了全局代理的订阅（结果：没通过）');
    assertNoSecrets();
  });
});

describe('操作日志过期清理', () => {
  it('超过 INKDOVE_AUDIT_RETENTION_DAYS 天的每天清掉；没到期的保留', async () => {
    let now = Date.parse('2026-06-01T00:00:00.000Z');
    const t = await startApp({ env: { INKDOVE_AUDIT_RETENTION_DAYS: '30' }, options: { auditNow: () => now } });
    try {
      const rec = (daysAgo, summary) =>
        t.ctx.audit.record({ at: new Date(now - daysAgo * 86400_000).toISOString(), actor: { id: 'u1', name: 'x' }, action: 'kb.ask', summary, ok: true, status: 200 });
      rec(40, '四十天前');
      rec(31, '三十一天前');
      rec(29, '二十九天前');
      rec(1, '昨天');
      const summaries = () => t.ctx.db.prepare("SELECT summary FROM audit_logs WHERE action = 'kb.ask' ORDER BY at").all().map((r) => r.summary);
      assert.equal(t.ctx.audit.cleanup(), 2);
      assert.deepEqual(summaries(), ['二十九天前', '昨天']);
      now += 2 * 86400_000;
      t.ctx.audit.cleanup();
      assert.deepEqual(summaries(), ['昨天']);
    } finally {
      await t.close();
    }
  });

  it('保留天数默认 365；不是 1–36500 的整数时启动报错', () => {
    const base = {
      INKDOVE_ADMIN_EMAIL: ADMIN_EMAIL,
      INKDOVE_ADMIN_PASSWORD: PASSWORD,
      INKDOVE_SESSION_SECRET: 's',
      INKDOVE_WAHA_WEBHOOK_SECRET: 'w',
    };
    assert.equal(loadConfig(base).auditRetentionDays, 365);
    assert.equal(loadConfig({ ...base, INKDOVE_AUDIT_RETENTION_DAYS: '90' }).auditRetentionDays, 90);
    for (const v of ['0', '-1', '1.5', '40000']) {
      assert.throws(() => loadConfig({ ...base, INKDOVE_AUDIT_RETENTION_DAYS: v }), /INKDOVE_AUDIT_RETENTION_DAYS/, v);
    }
  });
});
