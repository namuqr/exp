const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "4000", 10);
// Delay between each yap message in milliseconds (default: 3 seconds)
const YAP_DELAY = parseInt(process.env.YAP_DELAY || "3000", 10);

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or CHANNEL_ID env vars");
  process.exit(1);
}

const { ALL_MESSAGES } = require("./messages.js");

// ─── Auto-reactor state ───────────────────────────────────────────────────────
const handled = new Set();

// ─── Yap feature state ────────────────────────────────────────────────────────
let yapActive = false;       // whether the yap loop is running
let yapIndex = 0;            // current position in ALL_MESSAGES (0-based)
let yapChannelId = null;     // channel where !on was issued
let yapTimeout = null;       // handle for the scheduled next message
let lastCommandMsgId = null; // track the most recent !on / !off we've seen

// Send a single Discord message to a channel via the REST API
async function sendMessage(channelId, content) {
  const res = await fetch(
    `https://discord.com/api/v9/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ sendMessage failed (${res.status}): ${text}`);
  }
  return res;
}

// Schedule the next yap message; wraps back to 0 after all 100 are sent
function scheduleNextYap() {
  if (!yapActive) return;
  yapTimeout = setTimeout(async () => {
    if (!yapActive) return;
    const msgNumber = yapIndex + 1; // 1-based for logging
    const content = `**[${msgNumber}/100]** ${ALL_MESSAGES[yapIndex]}`;
    console.log(`💬 Yap #${msgNumber} → channel ${yapChannelId}`);
    await sendMessage(yapChannelId, content);
    yapIndex = (yapIndex + 1) % ALL_MESSAGES.length; // cycle back after 100
    scheduleNextYap();
  }, YAP_DELAY);
}

// Start the yap loop in the given channel
function startYap(channelId) {
  if (yapActive) return; // already running
  yapActive = true;
  yapChannelId = channelId;
  console.log(`🟢 Yap started in channel ${channelId} from message ${yapIndex + 1}`);
  scheduleNextYap();
}

// Stop the yap loop
function stopYap() {
  if (!yapActive) return;
  yapActive = false;
  if (yapTimeout) {
    clearTimeout(yapTimeout);
    yapTimeout = null;
  }
  console.log(`🔴 Yap stopped at message ${yapIndex + 1}`);
}

// ─── Command polling ──────────────────────────────────────────────────────────
// Watches for !on / !off commands in any channel the bot can read.
// We track the latest message ID we've processed so we only act on new ones.
let lastSeenCommandId = null;

async function pollCommands() {
  try {
    const url = lastSeenCommandId
      ? `https://discord.com/api/v9/channels/${CHANNEL_ID}/messages?limit=10&after=${lastSeenCommandId}`
      : `https://discord.com/api/v9/channels/${CHANNEL_ID}/messages?limit=10`;

    const res = await fetch(url, { headers: { Authorization: TOKEN } });
    if (!res.ok) {
      console.error(`Command poll failed: ${res.status}`);
      return;
    }

    const messages = await res.json();
    if (!Array.isArray(messages) || messages.length === 0) return;

    // Discord returns newest-first; reverse so we process oldest → newest
    const ordered = [...messages].reverse();

    for (const msg of ordered) {
      // Always advance our cursor so we don't re-process
      if (!lastSeenCommandId || BigInt(msg.id) > BigInt(lastSeenCommandId)) {
        lastSeenCommandId = msg.id;
      }

      const text = (msg.content || "").trim().toLowerCase();

      if (text === "!on") {
        console.log(`📥 !on received from ${msg.author.username}`);
        startYap(msg.channel_id);
      } else if (text === "!off") {
        console.log(`📥 !off received from ${msg.author.username}`);
        stopYap();
      }
    }
  } catch (err) {
    console.error("Command poll error:", err.message);
  }
}

// ─── Auto-reactor ─────────────────────────────────────────────────────────────
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

// ─── Bootstrap ────────────────────────────────────────────────────────────────
console.log(`🚀 Auto-reactor started — watching channel ${CHANNEL_ID}`);
console.log(`💬 Yap feature ready — send !on to start, !off to stop (delay: ${YAP_DELAY}ms)`);

// Seed lastSeenCommandId with the latest message so we don't replay history
(async () => {
  try {
    const res = await fetch(
      `https://discord.com/api/v9/channels/${CHANNEL_ID}/messages?limit=1`,
      { headers: { Authorization: TOKEN } }
    );
    if (res.ok) {
      const msgs = await res.json();
      if (msgs.length > 0) lastSeenCommandId = msgs[0].id;
    }
  } catch (_) {}

  // Start both polling loops
  setInterval(poll, POLL_INTERVAL);
  setInterval(pollCommands, POLL_INTERVAL);
  poll();
  pollCommands();
})();

