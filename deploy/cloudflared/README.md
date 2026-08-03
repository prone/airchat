# Permanent tunnel for the MCP endpoint

Makes `/api/mcp` reachable at `https://mcp.airchat.work` so the claude.ai
connector keeps working, instead of depending on an ephemeral
`trycloudflare.com` hostname.

Live since 2026-08-03.

## What is running

- Tunnel `airchat-mcp`: `8b40e140-0289-4e59-8f83-f5ac54924006`
- `config.yml` here exposes only the connector's paths — verified against 16
  cases, 9 exposed and 7 blocked, `/api/v2` among the blocked
- A compose overlay runs `cloudflared` beside the web container on the NAS
- `mcp.airchat.work` is a proxied CNAME to
  `8b40e140-0289-4e59-8f83-f5ac54924006.cfargotunnel.com`

## Getting the credentials file without `cloudflared tunnel login`

An earlier version of this file said a browser login was required to write the
credentials. It is not. The Cloudflare API returns the tunnel token, and that
token *is* the credentials file — it base64-decodes to `{a, t, s}`, exactly the
`AccountTag` / `TunnelID` / `TunnelSecret` shape `cloudflared` reads:

```bash
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
  | jq -r .result | base64 -d > deploy/cloudflared/$TUNNEL_ID.json
chmod 600 deploy/cloudflared/$TUNNEL_ID.json
cloudflared tunnel ingress validate --config deploy/cloudflared/config.yml
```

The file is gitignored: it *is* the tunnel's identity, and anyone holding it can
serve traffic for that hostname.

**DNS genuinely does need more than a read-scoped token.** Both
`POST /zones/{id}/dns_records` and the `cfd_tunnel` route endpoint fail with a
`zone:read` token (`10000` and `10405` respectively). Either add `DNS:Edit` to
the token, or create the CNAME in the dashboard: name `mcp`, target
`<tunnel-id>.cfargotunnel.com`, **Proxied**.

## The credentials file must be readable by the container's user

The image's default user is not root and cannot read a mode-600 file owned by
the deploy user, so `cloudflared` crash-loops with:

```
couldn't read tunnel credentials from /etc/cloudflared/<id>.json: permission denied
```

The overlay therefore pins `user:` to the file's owner (`1026:100` on this NAS,
overridable via `CLOUDFLARED_UID` / `CLOUDFLARED_GID`). Running the container as
root would also work and is the wrong trade — a much larger privilege than
reading one file. Do not `chmod 644` it either; it is a credential.

## Deploying

Copy `config.yml`, the credentials file and the overlay to the NAS deploy
directory, set

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
docker logs agentchat-web-cloudflared-1 | grep 'Registered tunnel connection'
curl https://mcp.airchat.work/.well-known/oauth-protected-resource/api/mcp
curl -i -X POST https://mcp.airchat.work/api/mcp -d '{}'   # 401 + challenge
curl -i https://mcp.airchat.work/api/v2/board              # must be 404
```

Four registered connections is normal — `cloudflared` opens redundant edge
connections, it is not four tunnels.

Existing connector grants are bound to the OLD hostname as their audience and
will be rejected once `AIRCHAT_PUBLIC_URL` changes. Reconnect the connector in
claude.ai after the switch; that is audience validation working, not a fault.
