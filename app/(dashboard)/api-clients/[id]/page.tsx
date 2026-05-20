import ApiClientDetailPage from "../_components/api-client-detail-page";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  return <ApiClientDetailPage id={id} />;
}
