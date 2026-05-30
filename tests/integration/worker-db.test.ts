// @vitest-environment node
//
// 连库集成测试：覆盖此前无任何连库测试、导致 snake_case 列名致命 bug 长期未被
// 发现的盲区。仅在显式提供 DATABASE_URL 时运行（普通 `pnpm test` 不加载 .env，
// 故默认跳过）。运行方式（务必指向独立测试库，勿用 dev 库）：
//   DATABASE_URL=postgresql://user@localhost:5432/email_marketing_test \
//     pnpm exec vitest run tests/integration/worker-db.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

const RUN = !!process.env.DATABASE_URL;
const MARK = `itest_${Date.now()}`;
const DOMAIN = `${MARK}.test`;
const WORKER_ID = `worker-itest`;

const MIN_SNAPSHOT = {
  defaultLocale: "zh",
  locales: { zh: {} },
} as const;

describe.skipIf(!RUN)("worker DB integration", () => {
  let prisma: PrismaClient;
  let jobs: typeof import("@/lib/modules/campaign/worker-jobs");
  let snapshotMod: typeof import("@/lib/modules/campaign/snapshot");

  // created ids for teardown
  let templateId: string;
  let campaignId: string; // SENDING campaign for raw-sql tests
  let snapCampaignId: string; // DRAFT campaign for snapshot tests
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("@/lib/prisma")).prisma;
    jobs = await import("@/lib/modules/campaign/worker-jobs");
    snapshotMod = await import("@/lib/modules/campaign/snapshot");

    const template = await prisma.emailTemplate.create({
      data: { name: `${MARK}-tpl`, variables: [] },
    });
    templateId = template.id;

    const mkCampaign = (status: "SENDING" | "DRAFT") =>
      prisma.campaign.create({
        data: {
          name: `${MARK}-${status}`,
          fromEmail: "from@test.local",
          templateId,
          templateSnapshot: MIN_SNAPSHOT,
          tagFilter: [],
          status,
        },
      });
    campaignId = (await mkCampaign("SENDING")).id;
    snapCampaignId = (await mkCampaign("DRAFT")).id;

    const mkUser = (suffix: string, extra: Record<string, unknown> = {}) =>
      prisma.user.create({ data: { email: `${MARK}-${suffix}@${DOMAIN}`, ...extra } });

    // 生日用户（今天）
    const today = new Date();
    const bday = new Date(Date.UTC(1990, today.getMonth(), today.getDate()));
    const uBirthday = await mkUser("bday", { birthDate: bday });
    const uBirthdayUnsub = await mkUser("bday-unsub", { birthDate: bday, unsubscribed: true });
    const uBirthdayBounced = await mkUser("bday-bounced", { birthDate: bday, totalBounceCount: 3 });

    // domainStat / sendTimePref / claim 用户
    const uDelivered = await mkUser("delivered");
    const uBounced = await mkUser("bounced");
    const uOpened = await mkUser("opened");
    const uPending1 = await mkUser("pending1");
    const uPending2 = await mkUser("pending2");
    const uSnap1 = await mkUser("snap1");
    const uSnap2 = await mkUser("snap2");

    userIds.push(
      uBirthday.id, uBirthdayUnsub.id, uBirthdayBounced.id,
      uDelivered.id, uBounced.id, uOpened.id,
      uPending1.id, uPending2.id, uSnap1.id, uSnap2.id,
    );

    // recipients for the SENDING campaign
    const rDelivered = await prisma.campaignRecipient.create({
      data: { campaignId, userId: uDelivered.id, resolvedLocale: "zh", status: "DELIVERED" },
    });
    await prisma.campaignRecipient.create({
      data: { campaignId, userId: uBounced.id, resolvedLocale: "zh", status: "BOUNCED" },
    });
    const rOpened = await prisma.campaignRecipient.create({
      data: { campaignId, userId: uOpened.id, resolvedLocale: "zh", status: "OPENED" },
    });
    await prisma.campaignRecipient.create({
      data: { campaignId, userId: uPending1.id, resolvedLocale: "zh", status: "PENDING" },
    });
    await prisma.campaignRecipient.create({
      data: { campaignId, userId: uPending2.id, resolvedLocale: "zh", status: "PENDING" },
    });

    // email events for sendTimePref（须落在 90 天窗口内）
    const openedAt = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await prisma.emailEvent.create({
      data: {
        campaignId,
        campaignRecipientId: rOpened.id,
        type: "opened",
        payload: {},
        processedAt: openedAt,
        idempotencyKey: `${MARK}-ev-opened`,
      },
    });
    // a clicked event for the delivered recipient too (exercises type IN filter)
    await prisma.emailEvent.create({
      data: {
        campaignId,
        campaignRecipientId: rDelivered.id,
        type: "clicked",
        payload: {},
        processedAt: openedAt,
        idempotencyKey: `${MARK}-ev-clicked`,
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try { await prisma.sendTimePreference.deleteMany({ where: { userId: { in: userIds } } }); } catch { /* ignore */ }
    try { await prisma.domainStat.deleteMany({ where: { domain: DOMAIN } }); } catch { /* ignore */ }
    try { await prisma.campaign.deleteMany({ where: { id: { in: [campaignId, snapCampaignId] } } }); } catch { /* ignore */ }
    try { await prisma.emailTemplate.deleteMany({ where: { id: templateId } }); } catch { /* ignore */ }
    try { await prisma.user.deleteMany({ where: { id: { in: userIds } } }); } catch { /* ignore */ }
    await prisma.$disconnect();
  });

  it("birthday raw SQL uses camelCase columns and selects only eligible users", async () => {
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();
    // 复制 birthdayChecker 的修复后查询，作为列名回归守卫（birthdayChecker 在
    // 无 BIRTHDAY automation 时会提前返回，无法直接驱动该 SQL）。
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users
      WHERE "birthDate" IS NOT NULL
        AND EXTRACT(MONTH FROM "birthDate") = ${month}
        AND EXTRACT(DAY FROM "birthDate") = ${day}
        AND unsubscribed = false
        AND "totalBounceCount" < 3
        AND email LIKE ${`${MARK}-%`}
    `;
    expect(rows.map((r) => r.id)).toEqual([userIds[0]]); // 只有 uBirthday
  });

  it("domainStatAggregator runs real SQL without column errors and upserts stats", async () => {
    await jobs.domainStatAggregator();
    const stat = await prisma.domainStat.findUnique({ where: { domain: DOMAIN } });
    expect(stat).not.toBeNull();
    // DELIVERED + OPENED 计入 sent；BOUNCED 计入 bounced
    expect(stat!.totalSent).toBe(2);
    expect(stat!.totalBounced).toBe(1);
  });

  it("sendTimePreferenceCalculator runs real SQL without column errors and upserts preference", async () => {
    await jobs.sendTimePreferenceCalculator();
    const pref = await prisma.sendTimePreference.findUnique({ where: { userId: userIds[5] } }); // uOpened
    expect(pref).not.toBeNull();
    // 小时值受会话时区影响，断言为合法整数即可（核心是 SQL 不报列不存在并落库）。
    expect(Number.isInteger(pref!.bestSendHour)).toBe(true);
    expect(pref!.bestSendHour!).toBeGreaterThanOrEqual(0);
    expect(pref!.bestSendHour!).toBeLessThanOrEqual(23);
  });

  it("claim raw SQL dequeues PENDING -> SENDING and writes lockedBy", async () => {
    // 复制 processSendQueue 的认领查询（修复后列名 + lockedBy），列名回归守卫。
    const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE campaign_recipients
      SET status = 'SENDING', "lockedAt" = NOW(), "lockedBy" = ${WORKER_ID}
      WHERE id IN (
        SELECT id FROM campaign_recipients
        WHERE "campaignId" = ${campaignId} AND status = 'PENDING' AND "lockedBy" IS NULL
        ORDER BY id
        LIMIT 100
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;
    expect(claimed.length).toBe(2);
    const stillPending = await prisma.campaignRecipient.count({
      where: { campaignId, status: "PENDING" },
    });
    expect(stillPending).toBe(0);
    const locked = await prisma.campaignRecipient.findMany({
      where: { campaignId, status: "SENDING" },
      select: { lockedBy: true },
    });
    expect(locked.every((r) => r.lockedBy === WORKER_ID)).toBe(true);
  });

  it("snapshotRecipients is idempotent and the unique (campaignId,userId) constraint blocks duplicates", async () => {
    const campaignObj = {
      id: snapCampaignId,
      tagFilter: [] as string[],
      tagFilterMode: "ANY",
      segmentId: null,
      subscriptionCategory: null,
      topicId: null,
      isAbTest: false,
      localeStrategy: "AUTO" as const,
      forcedLocale: null,
      templateSnapshot: MIN_SNAPSHOT as unknown as import("@prisma/client").Prisma.JsonValue,
      segment: null,
      variants: [] as Array<{ id: string; samplePercentage: number }>,
    };

    const first = await prisma.$transaction((tx) => snapshotMod.snapshotRecipients(campaignObj, tx));
    const second = await prisma.$transaction((tx) => snapshotMod.snapshotRecipients(campaignObj, tx));
    expect(second.totalRecipients).toBe(first.totalRecipients);

    const count = await prisma.campaignRecipient.count({ where: { campaignId: snapCampaignId } });
    expect(count).toBe(first.totalRecipients);

    // 直接插入重复 (campaignId,userId) 应被唯一约束拒绝（P2002）。
    const anyRecipient = await prisma.campaignRecipient.findFirst({
      where: { campaignId: snapCampaignId },
      select: { userId: true },
    });
    await expect(
      prisma.campaignRecipient.create({
        data: { campaignId: snapCampaignId, userId: anyRecipient!.userId, resolvedLocale: "zh" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
