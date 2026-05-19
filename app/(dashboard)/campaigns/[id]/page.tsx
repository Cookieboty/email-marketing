import CampaignDetailPage from "./_components/campaign-detail-page";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignDetailPage id={id} />;
}
