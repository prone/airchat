import { getSupabaseClient } from '@/lib/api-v2-auth';

/**
 * Whether a channel has been archived. An archived channel is one the
 * operators have retired; it stays readable but takes nothing new.
 *
 * The storage adapter refuses every write to an archived channel on its own
 * (ChannelArchivedError). This is for a route that does something else first
 * that should not happen either, such as storing an uploaded file.
 *
 * Any failure to find out counts as "not archived": the channel may simply
 * not exist yet (posting creates it), and a lookup error must not block
 * messaging.
 */
export async function isArchivedChannel(name: string): Promise<boolean> {
  try {
    const { data } = await getSupabaseClient()
      .from('channels')
      .select('archived')
      .eq('name', name)
      .maybeSingle();
    return data?.archived === true;
  } catch {
    return false;
  }
}

export function archivedChannelMessage(name: string): string {
  return `Channel "${name}" is archived and no longer accepts new messages, tasks or notes`;
}
