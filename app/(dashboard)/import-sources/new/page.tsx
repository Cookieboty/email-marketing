import { ImportSourceForm } from "../_components/import-source-form";

export default function NewImportSourcePage() {
  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">新增数据源</h1>
        <p className="text-sm text-muted-foreground">
          配置远端 API、认证、分页与字段映射，保存后可在详情页运行测试与触发任务。
        </p>
      </header>
      <ImportSourceForm mode="create" />
    </section>
  );
}
