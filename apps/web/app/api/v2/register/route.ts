import { NextRequest, NextResponse } from 'next/server';
import { verifyRegistration } from '@airchat/shared/crypto';
import { getStorageAdapter } from '@/lib/api-v2-auth';
import { checkRateLimit } from '@/lib/rate-limit';

// ── Constants ───────────────────────────────────────────────────────────────

const IP_REG_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };
const MACHINE_RATE_LIMIT = { windowMs: 60_000, maxRequests: 5 };
const MAX_AGENTS_PER_MACHINE = 50;
const TIMESTAMP_WINDOW_MS = 60_000; // 60 seconds
const NONCE_TTL_MS = 60_000;

// ── Nonce tracking (in-memory, resets on process restart) ───────────────────

const seenNonces = new Map<string, number>(); // nonce -> expiry timestamp
let lastNonceCleanup = Date.now();

function isNonceSeen(nonce: string): boolean {
  cleanupNonces();
  return seenNonces.has(nonce);
}

function recordNonce(nonce: string): void {
  seenNonces.set(nonce, Date.now() + NONCE_TTL_MS);
}

function cleanupNonces(): void {
  const now = Date.now();
  if (now - lastNonceCleanup < 30_000) return;
  lastNonceCleanup = now;
  for (const [nonce, expiry] of seenNonces) {
    if (expiry < now) seenNonces.delete(nonce);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generic 403 — identical for machine-not-found and bad-signature to prevent enumeration. */
const FORBIDDEN_RESPONSE = { error: 'Registration failed' };

function getIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

// ── POST /api/v2/register ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const ip = getIp(request);

  // 1. IP rate limit (10 registrations/min)
  const ipResult = checkRateLimit(
    `v2-register-ip:${ip}`,
    IP_REG_RATE_LIMIT.windowMs,
    IP_REG_RATE_LIMIT.maxRequests
  );
  if (!ipResult.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((ipResult.retryAfterMs || 1000) / 1000)) },
      }
    );
  }

  // 2. Parse body
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { machine_name, agent_name, derived_key_hash, timestamp, nonce, signature } = body;

  // 3. Validate all fields present and are strings
  if (
    typeof machine_name !== 'string' ||
    typeof agent_name !== 'string' ||
    typeof derived_key_hash !== 'string' ||
    typeof timestamp !== 'string' ||
    typeof nonce !== 'string' ||
    typeof signature !== 'string'
  ) {
    return NextResponse.json(
      {
        error:
          'Missing or invalid fields: machine_name, agent_name, derived_key_hash, timestamp, nonce, signature must all be strings',
      },
      { status: 400 }
    );
  }

  // Per-machine rate limit (5 registrations/min) — checked after body parse
  const machineRateResult = checkRateLimit(
    `v2-register-machine:${machine_name}`,
    MACHINE_RATE_LIMIT.windowMs,
    MACHINE_RATE_LIMIT.maxRequests
  );
  if (!machineRateResult.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((machineRateResult.retryAfterMs || 1000) / 1000)),
        },
      }
    );
  }

  // 4. Timestamp within 60 seconds
  const tsMs = new Date(timestamp).getTime();
  if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_WINDOW_MS) {
    return NextResponse.json(FORBIDDEN_RESPONSE, { status: 403 });
  }

  // 5. Nonce replay check
  if (isNonceSeen(nonce)) {
    return NextResponse.json({ error: 'Duplicate nonce' }, { status: 409 });
  }
  recordNonce(nonce);

  // 6. Look up machine by name
  const adapter = getStorageAdapter();
  const machine = await adapter.findMachineByPublicKey(machine_name);
  if (!machine || !machine.public_key) {
    // Generic 403 — don't leak machine existence
    return NextResponse.json(FORBIDDEN_RESPONSE, { status: 403 });
  }

  // 7-8. Verify Ed25519 signature
  const payload = { machine_name, agent_name, derived_key_hash, timestamp, nonce };

  let signatureValid: boolean;
  try {
    signatureValid = verifyRegistration(machine.public_key, payload, signature);
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    // Identical 403 — same as machine not found
    return NextResponse.json(FORBIDDEN_RESPONSE, { status: 403 });
  }

  // 9. Check agent name ownership (hijacking prevention)
  //    Handled inside adapter.registerAgent() — throws 'CONFLICT:...' if
  //    the agent name is owned by a different machine.

  // 10. Check per-machine agent cap (50)
  try {
    const agentCount = await adapter.countAgentsByMachine(machine.id);
    if (agentCount >= MAX_AGENTS_PER_MACHINE) {
      // Allow re-registration of existing agents even at cap
      const existingAgent = await adapter.findAgentByName(agent_name as string);
      if (!existingAgent || (existingAgent as any).machine_id !== machine.id) {
        return NextResponse.json(
          { error: 'Agent limit exceeded for this machine' },
          { status: 429 }
        );
      }
    }
  } catch {
    // If count check fails, continue — registerAgent will enforce constraints
  }

  // 11. Register (upsert) agent
  try {
    const agent = await adapter.registerAgent(agent_name, machine.id, derived_key_hash);
    return NextResponse.json({
      agent_id: agent.id,
      agent_name: agent.name,
    });
  } catch (err: any) {
    const message = err?.message || '';
    if (message.includes('CONFLICT')) {
      return NextResponse.json(
        { error: 'Agent name is owned by a different machine' },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: 'Registration failed' }, { status: 500 });
  }
}
