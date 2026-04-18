# Discord Auto-Reactor

Automatically mirrors reactions and sends yap messages across multiple Discord user accounts simultaneously.

## Deploy to Railway

1. Push this folder to a **new GitHub repo**
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub Repo
3. Select the repo
4. Go to **Variables** tab and add:
   - `DISCORD_TOKENS` — JSON array of Discord user authorization tokens
     ```
     ["token1","token2","token3"]
     ```
   - `CHANNEL_ID` — the channel to watch for reactions and commands
   - `YAP_DELAY` — (optional) delay between yap messages in ms, default `30000`
5. Railway will auto-deploy and keep all accounts running 24/7

## How it works

- Spins up one WebSocket gateway connection per token — all accounts connect simultaneously
- **Auto-reactor:** when any reaction appears in the watched channel, every account adds the same reaction; a shared `handled` set ensures no account reacts twice to the same message+emoji combo
- **Yap (`!on` / `!off`):** starts/stops a message loop; each message is sent by a randomly chosen live account so activity looks natural across accounts
- **`!cooldown <seconds>`:** updates the delay between yap messages at runtime
- All accounts maintain a persistent `online` presence with automatic reconnect and session resume
