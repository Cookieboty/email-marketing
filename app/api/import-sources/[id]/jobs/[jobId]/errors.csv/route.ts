import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { NotFoundError } from "@/lib/errors";
import { importRepository } from "@/lib/modules/import/repository";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string; jobId: string }>;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const GET = withAuth(async (_session, _request: Request, ctx: Ctx) => {
  const { id, jobId } = await ctx.params;
  const job = await importRepository.getJob(jobId);
  if (!job || job.sourceId !== id) throw new NotFoundError("ImportJob not found");
  const errors = await importRepository.listJobErrors(jobId, 5000);
  const lines: string[] = ["row,field,message,rawData"];
  for (const e of errors) {
    lines.push(
      [csvEscape(e.row), csvEscape(e.field ?? ""), csvEscape(e.message), csvEscape(e.rawData)].join(
        ",",
      ),
    );
  }
  const body = lines.join("\n");
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="import-job-${jobId}-errors.csv"`,
    },
  });
});
