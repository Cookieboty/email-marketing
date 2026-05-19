import SegmentEditor from "../_components/segment-editor";

export default function NewSegmentPage() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">新建分群</h1>
      <SegmentEditor mode="create" />
    </section>
  );
}
