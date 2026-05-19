-- Phase 4B: enforce EmailTemplate.name uniqueness (specs/modules/template-system.md §319)
-- Existing duplicates would block this migration; on dev/seed snapshots there are none.
CREATE UNIQUE INDEX "email_templates_name_key" ON "email_templates"("name");
