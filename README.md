# Discord Auto-Reactor

Automatically clicks existing reactions in a Discord channel.

## Deploy to Railway

1. Push this folder to a **new GitHub repo**
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub Repo
3. Select the repo
4. Go to **Variables** tab and add:
   - `DISCORD_TOKEN` — your Discord authorization token
   - `CHANNEL_ID` — the channel to watch
   - `POLL_INTERVAL` — (optional) poll interval in ms, default 4000
5. Railway will auto-deploy and keep it running 24/7

## How it works

- Polls the channel every 4 seconds for messages with reactions
- If it finds a reaction you haven't added yet, it adds it as you
- Processes one reaction per poll cycle to stay within Discord rate limits
- Tracks handled reactions in memory (resets on restart)
