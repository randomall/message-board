# Message Board

A small UseMy app: a public, anonymous message board where anyone can post and
reply (threaded), and the owner can reply, edit, and delete any message.

## Architecture

One Node process (zero dependencies, Node built-ins only) runs two HTTP servers,
both bound to `127.0.0.1`:

| Surface | Port (env)     | Path        | Published to lab? |
|---------|----------------|-------------|-------------------|
| Public board | `PORT` (18860)      | `/`         | **Yes** (via UseMy Agent, `--public`) |
| Owner manager | `MANAGE_PORT` (18861) | `/manage`   | **No** — never registered public |

The agent only ever knows about the public port (`usemy-app.json` `url` →
`http://127.0.0.1:18860/`). The manager port is never declared with `--public`,
so it is structurally unreachable from `lab.usemy.assetcommons.com`.

## Public board (`/`)
- Anonymous posting and threaded replies (anyone can reply to anyone).
- Anti-bot: a simple math challenge per post, a hidden honeypot field, a
  per-IP rate limit (6 posts/minute), and a 2000-char cap.
- Cannot edit, delete, or post as owner — those live only on the manager.

## Owner manager (`/manage`, localhost / Workbench only)
- Post or reply **as owner** (shows an "Owner" badge the public side can't fake,
  because owner messages can only be created here).
- Edit any message.
- Delete (soft) / restore any message. Deleted messages show as
  "[message removed]" on the public board if they still have visible replies,
  otherwise they are hidden.

## Storage
`data/messages.json` (atomic write via temp + rename). No database.

## Run locally
```bash
PORT=18860 MANAGE_PORT=18861 node server.mjs
```

## Deploy (on Lenovo)
1. Place this folder at `~/usemy-apps/message-board`.
2. Link/copy `usemy-message-board.service` into `~/.config/systemd/user/`,
   then `systemctl --user daemon-reload && systemctl --user enable --now usemy-message-board`.
3. Register the public board with the agent:
   ```bash
   usemy-agent add-app --public --slug message-board --name "Message Board" \
     --url http://127.0.0.1:18860/ --group "Public demos" \
     --description "Leave an anonymous message; anyone can reply, the owner moderates."
   usemy-agent sync
   ```
4. The manager is **not** registered public; reach it locally at
   `http://127.0.0.1:18861/manage` (or via Workbench).

## If the public app shows "temporarily unavailable"
Restart the agent first (do not change app code):
```bash
systemctl --user restart usemy-agent.service
```
