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

type SeedSegment = {
  name: string;
  description: string;
  isSystem: boolean;
  conditions: Prisma.InputJsonValue;
};

const systemSegments: SeedSegment[] = [
    {
      name: "全部用户",
      description: "系统内置：所有未退订的活跃用户",
      isSystem: true,
      conditions: {
        logic: "AND",
        conditions: [{ field: "unsubscribed", operator: "eq", value: false }],
      },
    },
    {
      name: "30 天活跃用户",
      description: "系统内置：最近 30 天内有打开或点击行为",
      isSystem: true,
      conditions: {
        logic: "AND",
        conditions: [
          { field: "unsubscribed", operator: "eq", value: false },
          {
            logic: "OR",
            conditions: [
              { field: "lastOpenedWithinDays", operator: "within_days", value: 30 },
              { field: "lastClickedWithinDays", operator: "within_days", value: 30 },
            ],
          },
        ],
      },
    },
    {
      name: "沉睡用户",
      description: "系统内置：低互动用户，待再激活",
      isSystem: true,
      conditions: {
        logic: "AND",
        conditions: [
          { field: "unsubscribed", operator: "eq", value: false },
          { field: "engagementScore", operator: "lte", value: 20 },
        ],
      },
    },
  ];

const audienceSegments: SeedSegment[] = [
  {
    name: "Enterprise User",
    description: "企业客户用户，用于企业版功能、客户成功和续约相关邮件",
    isSystem: false,
    conditions: {
      logic: "AND",
      conditions: [
        { field: "unsubscribed", operator: "eq", value: false },
        { field: "userLevel", operator: "eq", value: "Enterprise User" },
      ],
    },
  },
  {
    name: "VIP User",
    description: "高价值用户，用于 VIP 优惠、专属权益和高优先级活动",
    isSystem: false,
    conditions: {
      logic: "AND",
      conditions: [
        { field: "unsubscribed", operator: "eq", value: false },
        { field: "userLevel", operator: "eq", value: "VIP User" },
      ],
    },
  },
  {
    name: "Default User",
    description: "默认普通用户，用于常规营销、产品更新和基础触达",
    isSystem: false,
    conditions: {
      logic: "AND",
      conditions: [
        { field: "unsubscribed", operator: "eq", value: false },
        { field: "userLevel", operator: "eq", value: "Default User" },
      ],
    },
  },
];

const tags: Array<Pick<Prisma.TagCreateInput, "name" | "color">> = [
  { name: "Enterprise User", color: "#2563eb" },
  { name: "VIP User", color: "#a855f7" },
  { name: "Default User", color: "#64748b" },
  { name: "Trial User", color: "#14b8a6" },
  { name: "Early Access", color: "#f97316" },
  { name: "Product Updates", color: "#0ea5e9" },
  { name: "Newsletter", color: "#22c55e" },
  { name: "Churn Risk", color: "#ef4444" },
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

async function seedAudienceSegments() {
  for (const seg of audienceSegments) {
    const existing = await prisma.segment.findFirst({
      where: { name: seg.name },
    });
    if (existing) {
      await prisma.segment.update({
        where: { id: existing.id },
        data: {
          description: seg.description,
          conditions: seg.conditions,
          isSystem: seg.isSystem,
        },
      });
    } else {
      await prisma.segment.create({
        data: {
          name: seg.name,
          description: seg.description,
          conditions: seg.conditions,
          isSystem: seg.isSystem,
        },
      });
    }
  }
  console.log(`[seed] audience segments upserted: ${audienceSegments.length}`);
}

async function seedTags() {
  for (const tag of tags) {
    await prisma.tag.upsert({
      where: { name: tag.name },
      update: { color: tag.color },
      create: tag,
    });
  }
  console.log(`[seed] tags upserted: ${tags.length}`);
}

async function seedMailProviderSetting() {
  await prisma.mailProviderSetting.upsert({
    where: { id: "singleton" },
    update: {},
    create: {
      id: "singleton",
      activeProvider: "RESEND",
      activeSmtpId: null,
    },
  });
  console.log("[seed] mail provider setting ensured (singleton)");
}

async function main() {
  console.log("[seed] start");
  await seedSubscriptionCategories();
  await seedFrequencyCap();
  await seedSystemSegments();
  await seedAudienceSegments();
  await seedTags();
  await seedMailProviderSetting();
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
