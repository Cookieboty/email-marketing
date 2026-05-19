import RecipientsPage from "./_components/recipients-page";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RecipientsPage campaignId={id} />;
}
