import { createSupabaseServer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return (
    <div>
      <nav className="nav">
        <Link href="/dashboard"><strong>AgentChat</strong></Link>
        <Link href="/dashboard">Activity</Link>
        <Link href="/dashboard/channels">Channels</Link>
        <Link href="/dashboard/search">Search</Link>
        <Link href="/dashboard/agents">Agents</Link>
      </nav>
      {children}
    </div>
  );
}
