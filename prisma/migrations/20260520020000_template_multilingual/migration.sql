-- Template multilingual structural migration.
-- Creates the new locale-owned template model, backfills from the existing
-- single-language columns, then removes the old single-language contract.

-- 1) Enums
CREATE TYPE "Locale" AS ENUM ('zh', 'en');
CREATE TYPE "LocaleStrategy" AS ENUM ('AUTO', 'FORCE');

-- 2) Template locale table and shared metadata
ALTER TABLE "email_templates"
  ADD COLUMN "defaultLocale" "Locale" NOT NULL DEFAULT 'zh';

CREATE TABLE "email_template_locales" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "locale" "Locale" NOT NULL,
  "subject" TEXT NOT NULL,
  "htmlContent" TEXT NOT NULL,
  "textContent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "email_template_locales_pkey" PRIMARY KEY ("id")
);

INSERT INTO "email_template_locales" (
  "id",
  "templateId",
  "locale",
  "subject",
  "htmlContent",
  "textContent",
  "createdAt",
  "updatedAt"
)
SELECT
  'tmploc_' || md5("id" || ':zh'),
  "id",
  'zh'::"Locale",
  "subject",
  "htmlContent",
  "textContent",
  "createdAt",
  "updatedAt"
FROM "email_templates"
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX "email_template_locales_templateId_locale_key"
  ON "email_template_locales"("templateId", "locale");
CREATE INDEX "email_template_locales_locale_idx"
  ON "email_template_locales"("locale");

ALTER TABLE "email_template_locales"
  ADD CONSTRAINT "email_template_locales_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "email_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) User locale
ALTER TABLE "users"
  ADD COLUMN "locale" "Locale";

-- 4) Campaign multilingual snapshot and subject overrides
ALTER TABLE "campaigns"
  ADD COLUMN "subjects" JSONB,
  ADD COLUMN "localeStrategy" "LocaleStrategy" NOT NULL DEFAULT 'AUTO',
  ADD COLUMN "forcedLocale" "Locale";

UPDATE "campaigns" AS c
SET
  "subjects" = jsonb_build_object('zh', c."subject"),
  "templateSnapshot" = jsonb_build_object(
    'version', COALESCE(c."templateSnapshot"->'version', to_jsonb(t."version")),
    'defaultLocale', 'zh',
    'locales', jsonb_build_object(
      'zh', jsonb_build_object(
        'subject', COALESCE(c."templateSnapshot"->>'subject', t."subject"),
        'htmlContent', COALESCE(c."templateSnapshot"->>'htmlContent', t."htmlContent"),
        'textContent',
          CASE
            WHEN c."templateSnapshot" ? 'textContent'
              THEN c."templateSnapshot"->'textContent'
            ELSE to_jsonb(t."textContent")
          END
      )
    ),
    'variables', to_jsonb(t."variables")
  )
FROM "email_templates" AS t
WHERE c."templateId" = t."id";

-- 5) Campaign A/B variants
ALTER TABLE "campaign_variants"
  ADD COLUMN "subjects" JSONB,
  ADD COLUMN "htmlContents" JSONB,
  ADD COLUMN "textContents" JSONB;

UPDATE "campaign_variants"
SET
  "subjects" = jsonb_build_object('zh', "subject"),
  "htmlContents" = jsonb_build_object('zh', "htmlContent"),
  "textContents" = jsonb_build_object('zh', NULL);

ALTER TABLE "campaign_variants"
  ALTER COLUMN "subjects" SET NOT NULL,
  ALTER COLUMN "htmlContents" SET NOT NULL;

-- 6) Campaign recipient resolved locale
ALTER TABLE "campaign_recipients"
  ADD COLUMN "resolvedLocale" "Locale";

UPDATE "campaign_recipients"
SET "resolvedLocale" = 'zh';

ALTER TABLE "campaign_recipients"
  ALTER COLUMN "resolvedLocale" SET NOT NULL;

-- 7) Automation multilingual subject overrides
ALTER TABLE "automations"
  ADD COLUMN "subjects" JSONB,
  ADD COLUMN "localeStrategy" "LocaleStrategy" NOT NULL DEFAULT 'AUTO',
  ADD COLUMN "forcedLocale" "Locale";

UPDATE "automations"
SET "subjects" = jsonb_build_object('zh', "subject");

-- 8) Automation run resolved locale and content snapshot
ALTER TABLE "automation_runs"
  ADD COLUMN "resolvedLocale" "Locale",
  ADD COLUMN "templateSnapshot" JSONB;

UPDATE "automation_runs" AS r
SET
  "resolvedLocale" = 'zh',
  "templateSnapshot" = jsonb_build_object(
    'version', COALESCE(t."version", 1),
    'defaultLocale', 'zh',
    'locales', jsonb_build_object(
      'zh', jsonb_build_object(
        'subject', COALESCE(t."subject", a."subject"),
        'htmlContent', COALESCE(t."htmlContent", '<p>' || a."subject" || '</p>'),
        'textContent', to_jsonb(t."textContent")
      )
    ),
    'variables', COALESCE(to_jsonb(t."variables"), '[]'::jsonb)
  )
FROM "automations" AS a
LEFT JOIN "email_templates" AS t ON a."templateId" = t."id"
WHERE r."automationId" = a."id";

ALTER TABLE "automation_runs"
  ALTER COLUMN "resolvedLocale" SET NOT NULL,
  ALTER COLUMN "templateSnapshot" SET NOT NULL;

-- 9) Template blocks by locale
ALTER TABLE "template_blocks"
  ADD COLUMN "locale" "Locale" NOT NULL DEFAULT 'zh';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "template_blocks"
    GROUP BY "name", "locale"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'template_multilingual migration requires unique template_blocks.name per locale before adding the constraint';
  END IF;
END $$;

CREATE UNIQUE INDEX "template_blocks_name_locale_key"
  ON "template_blocks"("name", "locale");

-- 10) Remove old single-language contract columns
ALTER TABLE "email_templates"
  DROP COLUMN "subject",
  DROP COLUMN "htmlContent",
  DROP COLUMN "textContent";

ALTER TABLE "campaigns"
  DROP COLUMN "subject";

ALTER TABLE "campaign_variants"
  DROP COLUMN "subject",
  DROP COLUMN "htmlContent";

ALTER TABLE "automations"
  DROP COLUMN "subject";
