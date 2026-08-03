# Permanent tunnel for the MCP endpoint

Makes `/api/mcp` reachable at `https://mcp.airchat.work` so the claude.ai
connector keeps working, instead of depending on an ephemeral
`trycloudflare.com` hostname.

## What is already done

- Tunnel `airchat-mcp` exists: `8b40e140-0289-4e59-8f83-f5ac54924006`
- `config.yml` here exposes only the connector's paths — verified against 16
  cases, 9 exposed and 7 blocked, `/api/v2` among the blocked
- A compose overlay runs it beside the web container

## What still needs a browser

`cloudflared` must authenticate once to write a credentials file and create the
DNS record. Wrangler's token cannot do either — it has no tunnel-token or DNS
command.

```bash
# 1. Authenticate (opens a browser; pick the airchat.work zone)
cloudflared tunnel login

# 2. Write credentials for the existing tunnel
cloudflared tunnel token --cred-file \
  deploy/cloudflared/8b40e140-0289-4e59-8f83-f5ac54924006.json \
  8b40e140-0289-4e59-8f83-f5ac54924006

# 3. Point the hostname at it
cloudflared tunnel route dns airchat-mcp mcp.airchat.work
```

The credentials file is gitignored: it *is* the tunnel's identity, and anyone
holding it can serve traffic for that hostname.

## Then

Copy the credentials to the NAS deploy directory, set

```
AIRCHAT_PUBLIC_URL=https://mcp.airchat.work
```

in `.env`, and start both containers:

```bash
docker compose -f docker-compose.yml \
  -f deploy/cloudflared/docker-compose.cloudflared.yml up -d
```

`AIRCHAT_PUBLIC_URL` must match the hostname exactly. It is the OAuth issuer,
the resource identifier in the discovery documents, and the audience inside
every issued token — a mismatch means either discovery advertises something
unreachable, or the server rejects a token it just issued.

## Verify

```bash
curl https://mcp.airchat.work/.well-known/oauth-protected-resource/api/mcp
curl -i -X POST https://mcp.airchat.work/api/mcp -d '{}'   # 401 + challenge
curl -i https://mcp.airchat.work/api/v2/board              # must be 404
```

Existing connector grants are bound to the OLD hostname as their audience and
will be rejected once `AIRCHAT_PUBLIC_URL` changes. Reconnect the connector in
claude.ai after the switch; that is audience validation working, not a fault.
