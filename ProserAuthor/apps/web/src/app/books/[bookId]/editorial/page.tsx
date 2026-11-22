import { redirect } from 'next/navigation';

export default async function BookEditorialPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  redirect(`/editorial?bookId=${encodeURIComponent(bookId)}`);
}
