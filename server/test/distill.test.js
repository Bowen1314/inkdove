import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chunkText } from '../src/distill/runner.js';
import { startApp, waitFor } from './helpers.js';

const SRC_A = `好杯子有限公司
我们专做不锈钢保温杯，工厂在浙江永康。
保温杯 A100 价格 59 元，容量 500ml。
起订量 100 件，下单后 15 天发货。`;

const SRC_B = `售后政策
收货 7 天内可无理由退货，运费由买家承担。
产品保修 12 个月。`;

const SRC_C = `营业时间：周一到周五 9:00-18:00
联系电话：0579-12345678`;

async function waitJob(t, jobId) {
  return waitFor(
    async () => {
      const j = (await t.req('GET', `/api/distill/jobs/${jobId}`)).body;
      return ['done', 'failed', 'cancelled'].includes(j.status) ? j : null;
    },
    { timeout: 8000, message: '蒸馏任务没结束' },
  );
}

describe('蒸馏', () => {
  let t;
  const ids = {};
  before(async () => {
    t = await startApp({ options: { mockDelayMs: 40 } });
    await t.login();
  });
  after(() => t.close());

  it('切块尽量在段落边界', () => {
    const para = 'x'.repeat(4000);
    const chunks = chunkText(`${para}\n\n${para}\n\n${para}`, 6000);
    assert.equal(chunks.length, 3);
    assert.ok(chunks.every((c) => c.length <= 6000));
    assert.equal(chunkText('y'.repeat(13000), 6000).length, 3);
  });

  it('没有资料时 400 nothing_to_distill；mode 非法 400', async () => {
    const r = await t.req('POST', '/api/distill', { body: { mode: 'incremental' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'nothing_to_distill');
    assert.equal((await t.req('POST', '/api/distill', { body: { mode: 'all' } })).status, 400);
  });

  it('增量蒸馏走完整条流水线：phase 推进、条目和缺口落库、资料标记已蒸馏', async () => {
    ids.a = (await t.req('POST', '/api/sources/text', { body: { name: '公司介绍', text: SRC_A } })).body.id;
    ids.b = (await t.req('POST', '/api/sources/text', { body: { name: '售后', text: SRC_B } })).body.id;
    const start = await t.req('POST', '/api/distill', { body: { mode: 'incremental' } });
    assert.equal(start.status, 200);
    const { jobId } = start.body;
    assert.ok(jobId);

    // 运行中再提交返回 409
    const dup = await t.req('POST', '/api/distill', { body: { mode: 'rebuild' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'job_running');

    // 观察 phase 推进
    const seen = new Set();
    const job = await waitFor(
      async () => {
        const j = (await t.req('GET', `/api/distill/jobs/${jobId}`)).body;
        seen.add(j.phase);
        return j.status === 'done' || j.status === 'failed' ? j : null;
      },
      { timeout: 8000, interval: 10 },
    );
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.phase, 'done');
    assert.equal(job.mode, 'incremental');
    assert.ok(seen.has('extract') && seen.has('done'), [...seen].join(','));
    assert.deepEqual(
      Object.keys(job).sort(),
      ['error', 'finishedAt', 'id', 'log', 'mode', 'phase', 'progress', 'startedAt', 'stats', 'status'],
    );
    const order = ['【解析】', '【抽取】', '【合并】', '【画像】', '【缺口】'].map((tag) => job.log.findIndex((l) => l.msg.includes(tag)));
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((x, y) => x - y), order, '各阶段日志按顺序出现');
    assert.ok(job.log.every((l) => l.ts && ['info', 'warn', 'error'].includes(l.level)));

    // extract 每块 2–3 条
    assert.ok(job.stats.entriesAdded >= 4 && job.stats.entriesAdded <= 6, JSON.stringify(job.stats));
    assert.ok(job.stats.gapsFound > 0);
    const entries = (await t.req('GET', '/api/kb/entries')).body;
    assert.equal(entries.length, job.stats.entriesAdded);
    assert.ok(entries.every((e) => e.origin === 'distill' && e.sourceRefs.length >= 1 && e.sourceRefs[0].sourceName));
    const gaps = (await t.req('GET', '/api/kb/gaps?status=open')).body;
    assert.equal(gaps.length, job.stats.gapsFound);
    const profile = (await t.req('GET', '/api/kb/profile')).body;
    assert.equal(profile.companyName, '好杯子有限公司');
    const sources = (await t.req('GET', '/api/sources')).body;
    assert.ok(sources.every((s) => s.distilledAt));
    const stats = (await t.req('GET', '/api/kb/stats')).body;
    assert.equal(stats.lastDistilledAt, job.finishedAt);

    // 列表不含 log
    const list = (await t.req('GET', '/api/distill/jobs')).body;
    assert.equal(list[0].id, jobId);
    assert.equal(list[0].log, undefined);
  });

  it('增量：不传 sourceIds 只处理未蒸馏的；都处理过返回 nothing_to_distill', async () => {
    assert.equal((await t.req('POST', '/api/distill', { body: { mode: 'incremental' } })).body.code, 'nothing_to_distill');
    ids.c = (await t.req('POST', '/api/sources/text', { body: { name: '联系方式', text: SRC_C } })).body.id;
    const before = (await t.req('GET', '/api/kb/entries')).body.length;
    const { jobId } = (await t.req('POST', '/api/distill', { body: { mode: 'incremental' } })).body;
    const job = await waitJob(t, jobId);
    assert.equal(job.status, 'done');
    const parseLogs = job.log.filter((l) => l.msg.startsWith('【解析】'));
    assert.equal(parseLogs.length, 1);
    assert.match(parseLogs[0].msg, /联系方式/);
    const after = (await t.req('GET', '/api/kb/entries')).body.length;
    assert.equal(after, before + job.stats.entriesAdded);
  });

  it('增量：重复蒸馏同一份资料，新条目与已有条目合并去重', async () => {
    const before = (await t.req('GET', '/api/kb/entries')).body.length;
    const { jobId } = (await t.req('POST', '/api/distill', { body: { mode: 'incremental', sourceIds: [ids.a] } })).body;
    const job = await waitJob(t, jobId);
    assert.equal(job.status, 'done');
    assert.ok(job.stats.entriesMerged >= 2, JSON.stringify(job.stats));
    assert.equal(job.stats.entriesAdded, 0);
    const after = (await t.req('GET', '/api/kb/entries')).body;
    assert.equal(after.length, before);
    // 同一来源同一引文的引用合并后不重复
    for (const e of after) {
      const keys = e.sourceRefs.map((r) => `${r.sourceId}|${r.quote}`);
      assert.equal(new Set(keys).size, keys.length);
    }
  });

  it('rebuild：删除 distill 条目和 open 缺口，保留 manual/gap 条目和已忽略缺口', async () => {
    const manual = (await t.req('POST', '/api/kb/entries', { body: { type: 'fact', title: '手动条目', content: '老板姓王' } })).body;
    const openGaps = (await t.req('GET', '/api/kb/gaps?status=open')).body;
    const answered = (await t.req('POST', `/api/kb/gaps/${openGaps[0].id}/answer`, { body: { answer: '可以开票' } })).body.entry;
    const dismissed = openGaps[1];
    await t.req('POST', `/api/kb/gaps/${dismissed.id}/dismiss`);
    const oldDistill = (await t.req('GET', '/api/kb/entries')).body.filter((e) => e.origin === 'distill').map((e) => e.id);

    const { jobId } = (await t.req('POST', '/api/distill', { body: { mode: 'rebuild' } })).body;
    const job = await waitJob(t, jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.mode, 'rebuild');
    assert.equal(job.log.filter((l) => l.msg.startsWith('【解析】')).length, 3, '处理全部 ready 的资料');
    const entries = (await t.req('GET', '/api/kb/entries')).body;
    const idsNow = new Set(entries.map((e) => e.id));
    assert.ok(idsNow.has(manual.id), 'manual 保留');
    assert.ok(idsNow.has(answered.id), 'gap 来源保留');
    assert.ok(oldDistill.every((id) => !idsNow.has(id)), '旧 distill 条目已删除');
    assert.ok(entries.some((e) => e.origin === 'distill'));
    const gaps = (await t.req('GET', '/api/kb/gaps')).body;
    assert.ok(gaps.some((g) => g.id === dismissed.id && g.status === 'dismissed'));
    const reopened = gaps.filter((g) => g.status === 'open');
    assert.ok(!reopened.some((g) => g.question === dismissed.question), '已忽略的缺口不会重新加入');
  });

  it('取消任务', async () => {
    const { jobId } = (await t.req('POST', '/api/distill', { body: { mode: 'rebuild' } })).body;
    const c = await t.req('POST', `/api/distill/jobs/${jobId}/cancel`);
    assert.deepEqual(c.body, { ok: true });
    const job = await waitJob(t, jobId);
    assert.equal(job.status, 'cancelled');
    assert.equal((await t.req('POST', `/api/distill/jobs/${jobId}/cancel`)).status, 409);
    assert.equal((await t.req('GET', '/api/distill/jobs/nope')).status, 404);
  });
});
