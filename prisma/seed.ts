import { PrismaClient, type Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const subscriptionCategories: Array<
  Pick<
    Prisma.SubscriptionCategoryCreateInput,
    "name" | "description" | "slug" | "isDefault" | "isTransactional" | "isPreset" | "sortOrder"
  >
> = [
    {
      slug: "marketing",
      name: "营销活动",
      description: "促销、新品、节日活动等营销邮件",
      isDefault: true,
      isTransactional: false,
      isPreset: true,
      sortOrder: 0,
    },
    {
      slug: "newsletter",
      name: "周报与资讯",
      description: "产品周报、行业资讯、内容订阅",
      isDefault: false,
      isTransactional: false,
      isPreset: true,
      sortOrder: 1,
    },
    {
      slug: "product-updates",
      name: "产品更新",
      description: "版本发布、新功能上线通知",
      isDefault: false,
      isTransactional: false,
      isPreset: true,
      sortOrder: 2,
    },
    {
      slug: "transactional",
      name: "交易类邮件",
      description: "订单、密码重置、安全通知等不可退订邮件",
      isDefault: false,
      isTransactional: true,
      isPreset: true,
      sortOrder: 3,
    },
  ];

const systemSegments: Array<
  Pick<Prisma.SegmentCreateInput, "name" | "description" | "conditions" | "isSystem">
> = [
    {
      name: "全部用户",
      description: "系统内置：所有未退订的活跃用户",
      isSystem: true,
      conditions: {
        operator: "AND",
        rules: [{ field: "unsubscribedAt", op: "isNull" }],
      },
    },
    {
      name: "30 天活跃用户",
      description: "系统内置：最近 30 天内有打开或点击行为",
      isSystem: true,
      conditions: {
        operator: "AND",
        rules: [
          { field: "lastEngagedAt", op: "gte", value: "now-30d" },
          { field: "unsubscribedAt", op: "isNull" },
        ],
      },
    },
    {
      name: "沉睡用户",
      description: "系统内置：90 天未互动，待再激活",
      isSystem: true,
      conditions: {
        operator: "AND",
        rules: [
          { field: "lastEngagedAt", op: "lt", value: "now-90d" },
          { field: "unsubscribedAt", op: "isNull" },
        ],
      },
    },
  ];

async function seedSubscriptionCategories() {
  for (const cat of subscriptionCategories) {
    await prisma.subscriptionCategory.upsert({
      where: { slug: cat.slug },
      update: {
        name: cat.name,
        description: cat.description,
        isDefault: cat.isDefault,
        isTransactional: cat.isTransactional,
        isPreset: cat.isPreset,
        sortOrder: cat.sortOrder,
      },
      create: cat,
    });
  }
  console.log(`[seed] subscription_categories upserted: ${subscriptionCategories.length}`);
}

async function seedFrequencyCap() {
  const existing = await prisma.frequencyCap.findFirst({ where: { isActive: true } });
  if (existing) {
    console.log("[seed] frequency_cap active row already exists, skip");
    return;
  }
  await prisma.frequencyCap.create({
    data: { maxEmails: 5, periodDays: 7, isActive: true },
  });
  console.log("[seed] frequency_cap default created (5 emails / 7 days)");
}

async function seedSystemSegments() {
  for (const seg of systemSegments) {
    const existing = await prisma.segment.findFirst({
      where: { name: seg.name, isSystem: true },
    });
    if (existing) {
      await prisma.segment.update({
        where: { id: existing.id },
        data: {
          description: seg.description,
          conditions: seg.conditions as Prisma.InputJsonValue,
        },
      });
    } else {
      await prisma.segment.create({
        data: {
          ...seg,
          conditions: seg.conditions as Prisma.InputJsonValue,
        },
      });
    }
  }
  console.log(`[seed] system segments upserted: ${systemSegments.length}`);
}

async function main() {
  console.log("[seed] start");
  await seedSubscriptionCategories();
  await seedFrequencyCap();
  await seedSystemSegments();
  console.log("[seed] done");
}

main()
  .catch((err) => {
    console.error("[seed] failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
