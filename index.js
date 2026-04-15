const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "4000", 10);

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or CHANNEL_ID env vars");
  process.exit(1);
}

const handled = new Set();

async function poll() {
  try {
    const res = await fetch(
      `https://discord.com/api/v9/channels/${CHANNEL_ID}/messages?limit=50`,
      { headers: { Authorization: TOKEN } }
    );

    if (!res.ok) {
      console.error(`Fetch messages failed: ${res.status}`);
      return;
    }

    const messages = await res.json();

    for (const msg of messages) {
      if (!msg.reactions) continue;
      for (const r of msg.reactions) {
        if (r.me) continue;

        const emojiKey = r.emoji.id
          ? `${r.emoji.name}:${r.emoji.id}`
          : r.emoji.name;
        const comboKey = `${msg.id}:${emojiKey}`;

        if (handled.has(comboKey)) continue;

        const encoded = r.emoji.id
          ? `${encodeURIComponent(r.emoji.name)}:${r.emoji.id}`
          : encodeURIComponent(r.emoji.name);

        const reactRes = await fetch(
          `https://discord.com/api/v9/channels/${CHANNEL_ID}/messages/${msg.id}/reactions/${encoded}/@me`,
          { method: "PUT", headers: { Authorization: TOKEN } }
        );

        if (reactRes.ok || reactRes.status === 204) {
          console.log(`✅ Reacted ${r.emoji.name} on msg from ${msg.author.username}`);
          handled.add(comboKey);
        } else {
          console.log(`❌ Failed ${r.emoji.name}: ${reactRes.status}`);
        }

        // One reaction per poll cycle to respect rate limits
        return;
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }
}

console.log(`🚀 Auto-reactor started — watching channel ${CHANNEL_ID}`);
setInterval(poll, POLL_INTERVAL);
poll();
