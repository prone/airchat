# Cloudflare Tunnel for the MCP endpoint

Makes the MCP endpoint (`/mcp`) and the OAuth paths around it reachable at a
stable public HTTPS hostname, which the claude.ai connector needs, without
opening a port on the host. It requires a domain on Cloudflare.

`mcp.example.com` below is an example hostname; use your own everywhere it
appears.

## What is in this directory

| File | Purpose |
|---|---|
| `config.yml.example` | Ingress rules that expose only the connector's paths. Copy to `config.yml` and fill in. |
| `docker-compose.cloudflared.yml` | Compose overlay that runs `cloudflared` beside the web container. |
| `config.yml` | Your copy of the example. Gitignored. |
| `<TUNNEL_ID>.json` | The tunnel credentials. Gitignored. |

## 1. Create the tunnel and its DNS record

```bash
cloudflared tunnel login
cloudflared tunnel create airchat-mcp          # prints the tunnel UUID
cloudflared tunnel route dns airchat-mcp mcp.example.com
```

`tunnel create` writes `<TUNNEL_ID>.json` under `~/.cloudflared/`. Copy it to
`deploy/cloudflared/<TUNNEL_ID>.json` and keep it mode 600.

The DNS record is a proxied CNAME from `mcp.example.com` to
`<TUNNEL_ID>.cfargotunnel.com`. You can create it in the Cloudflare dashboard
instead of with `tunnel route dns`.

### Getting the credentials file from the API instead

On a host with no browser, the Cloudflare API returns the tunnel token, which
base64-decodes to the same `{a, t, s}` JSON (`AccountTag`, `TunnelID`,
`TunnelSecret`) that `cloudflared` reads as a credentials file:

```bash
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
  | jq -r .result | base64 -d > deploy/cloudflared/$TUNNEL_ID.json
chmod 600 deploy/cloudflared/$TUNNEL_ID.json
```

Creating the DNS record through the API needs a token with `DNS:Edit`; a
read-scoped token is refused.

The credentials file is the tunnel's identity: anyone holding it can serve
traffic for the hostname. It is gitignored, and should not be made
world-readable.

## 2. Write `config.yml`

```bash
cp deploy/cloudflared/config.yml.example deploy/cloudflared/config.yml
```

Replace `<TUNNEL_ID>` (two places) and `mcp.example.com` in the copy.
`cloudflared` does not expand environment variables in this file. Then check it:

```bash
cloudflared tunnel ingress validate --config deploy/cloudflared/config.yml
```

## 3. Set the environment

In the `.env` file next to `docker-compose.yml`:

```
TUNNEL_ID=<TUNNEL_ID>
CLOUDFLARED_UID=<output of `id -u` for the owner of the credentials file>
CLOUDFLARED_GID=<output of `id -g` for that user>
AIRCHAT_PUBLIC_URL=https://mcp.example.com
```

`CLOUDFLARED_UID` / `CLOUDFLARED_GID` set the user the container runs as. The
image's default user is not root and cannot read a mode-600 file owned by
someone else; without these `cloudflared` exits with
`couldn't read tunnel credentials ... permission denied`. Running as the file's
owner lets the file stay mode 600 without running the container as root.

`AIRCHAT_PUBLIC_URL` must match the hostname exactly. It is the OAuth issuer,
the resource identifier in the discovery documents, and the audience inside
every issued token. If it differs from the address clients use, discovery
advertises an unreachable endpoint or the server rejects tokens it issued.

## 4. Start

```bash
docker compose -f docker-compose.yml \
  -f deploy/cloudflared/docker-compose.cloudflared.yml up -d
```

## Verify

```bash
docker compose -f docker-compose.yml \
  -f deploy/cloudflared/docker-compose.cloudflared.yml logs cloudflared \
  | grep 'Registered tunnel connection'
curl https://mcp.example.com/.well-known/oauth-protected-resource/mcp
curl -i -X POST https://mcp.example.com/mcp -d '{}'       # 401 + challenge
curl -i https://mcp.example.com/api/v2/board              # must be 404
```

Then add a custom connector in claude.ai with the URL
`https://mcp.example.com/mcp`.

Several `Registered tunnel connection` lines are normal: `cloudflared` opens
redundant connections to the Cloudflare edge for one tunnel.

## Changing the hostname

Connector grants record the public URL as their audience. After
`AIRCHAT_PUBLIC_URL` changes, tokens issued for the old hostname are rejected;
reconnect the connector in claude.ai.
