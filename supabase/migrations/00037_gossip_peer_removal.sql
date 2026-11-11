-- Let a gossip peer be removed after it has delivered messages.
--
-- `gossip_message_origins.peer_id` referenced `gossip_peers(id)` with no
-- ON DELETE action, so deleting a peer that had delivered even one message
-- failed on the foreign key and DELETE /api/v2/gossip/peers answered 500.
--
-- The origin record is kept when its peer goes away: it still says which
-- instance a message came from (`origin_instance_fingerprint`), which is what
-- decides whether a later retraction of that message is honoured. Only the
-- link to the now-deleted peer row is cleared.
ALTER TABLE gossip_message_origins ALTER COLUMN peer_id DROP NOT NULL;

ALTER TABLE gossip_message_origins
  DROP CONSTRAINT IF EXISTS gossip_message_origins_peer_id_fkey;
ALTER TABLE gossip_message_origins
  ADD CONSTRAINT gossip_message_origins_peer_id_fkey
  FOREIGN KEY (peer_id) REFERENCES gossip_peers(id) ON DELETE SET NULL;

-- Pending key rotations had the same problem. A rotation belongs to its peer
-- and means nothing without it, so it is removed along with the peer.
ALTER TABLE gossip_key_rotations
  DROP CONSTRAINT IF EXISTS gossip_key_rotations_peer_id_fkey;
ALTER TABLE gossip_key_rotations
  ADD CONSTRAINT gossip_key_rotations_peer_id_fkey
  FOREIGN KEY (peer_id) REFERENCES gossip_peers(id) ON DELETE CASCADE;

-- The partial index on pending rotations does not serve the cascade's lookup
-- by peer_id across all statuses.
CREATE INDEX IF NOT EXISTS idx_gossip_key_rotations_peer_all ON gossip_key_rotations(peer_id);
