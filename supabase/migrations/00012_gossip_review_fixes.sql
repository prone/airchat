-- Migration 00012: Code review fixes for gossip layer
--
-- Fixes from security code review:
-- #11: UNIQUE constraint on gossip_retractions.retracted_message_id
-- #19: UNIQUE constraint on gossip_peers.fingerprint

-- Fix #11: Prevent duplicate retractions per message
ALTER TABLE gossip_retractions ADD CONSTRAINT gossip_retractions_message_unique
  UNIQUE (retracted_message_id);

-- Fix #19: Fingerprints must be unique across peers
ALTER TABLE gossip_peers ADD CONSTRAINT gossip_peers_fingerprint_unique
  UNIQUE (fingerprint);
