import UserDetailPage from "../_components/user-detail-page";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  return <UserDetailPage id={id} />;
}
