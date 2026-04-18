const WebSocket = require("ws");

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
// Delay between each yap message in milliseconds (default: 30 seconds)
let yapDelay = parseInt(process.env.YAP_DELAY || "30000", 10);

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or CHANNEL_ID env vars");
  process.exit(1);
}

const { ALL_MESSAGES } = require("./messages.js");

// ─── Discord REST helpers ─────────────────────────────────────────────────────
const API_BASE = "https://discord.com/api/v10";

async function discordRequest(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: TOKEN,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (custom, 1.0)",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${method} ${path} → ${res.status}: ${text}`);
  }
  // 204 No Content has no body
  if (res.status === 204) return null;
  return res.json();
}

function sendMessage(channelId, content) {
  return discordRequest("POST", `/channels/${channelId}/messages`, { content });
}

function addReaction(channelId, messageId, emoji) {
  // emoji must be URL-encoded "name:id" for custom or just "name" for unicode
  const encoded = encodeURIComponent(emoji);
  return discordRequest("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, null);
}

// ─── Auto-reactor state ───────────────────────────────────────────────────────
const handled = new Set();

// ─── Yap feature state ────────────────────────────────────────────────────────
let yapActive = false;    // whether the yap loop is running
let yapIndex = 0;         // current position in ALL_MESSAGES (0-based)
let yapChannelId = null;  // channel ID where !on was issued
let yapTimeout = null;    // handle for the scheduled next message

// Schedule the next yap message; wraps back to 0 after all messages are sent
function scheduleNextYap() {
  if (!yapActive) return;
  yapTimeout = setTimeout(async () => {
    if (!yapActive) return;
    const msgNumber = yapIndex + 1; // 1-based for logging
    const content = ALL_MESSAGES[yapIndex];
    console.log(`💬 Yap #${msgNumber} → channel ${yapChannelId}`);
    try {
      await sendMessage(yapChannelId, content);
    } catch (err) {
      console.error("❌ Yap send failed:", err.message);
    }
    yapIndex = (yapIndex + 1) % ALL_MESSAGES.length; // cycle back after all messages
    scheduleNextYap();
  }, yapDelay);
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

// ─── Discord Gateway (WebSocket) ──────────────────────────────────────────────
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

// Op codes
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

let ws = null;
let heartbeatInterval = null;
let lastSequence = null;
let sessionId = null;
let resumeGatewayUrl = null;
let heartbeatAcked = true;
let currentUserId = null;

function sendGateway(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function startHeartbeat(intervalMs) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatAcked = true;
  heartbeatInterval = setInterval(() => {
    if (!heartbeatAcked) {
      console.warn("⚠️ Heartbeat not acknowledged — reconnecting");
      ws.terminate();
      return;
    }
    heartbeatAcked = false;
    sendGateway({ op: OP.HEARTBEAT, d: lastSequence });
  }, intervalMs);
}

function identify() {
  sendGateway({
    op: OP.IDENTIFY,
    d: {
      token: TOKEN,
      // User account properties (not bot)
      properties: {
        os: "linux",
        browser: "Chrome",
        device: "",
      },
      intents:
        (1 << 9) |  // GUILD_MESSAGES
        (1 << 10) | // GUILD_MESSAGE_REACTIONS
        (1 << 15),  // MESSAGE_CONTENT
      presence: {
        status: "online",
        activities: [
          {
            name: "the chat 👀",
            type: 3, // Watching
          },
        ],
        since: null,
        afk: false,
      },
    },
  });
}

function resume() {
  sendGateway({
    op: OP.RESUME,
    d: {
      token: TOKEN,
      session_id: sessionId,
      seq: lastSequence,
    },
  });
}

function connect(url) {
  console.log(`🔌 Connecting to gateway: ${url}`);
  ws = new WebSocket(url || GATEWAY_URL);

  ws.on("open", () => {
    console.log("🌐 Gateway connection opened");
  });

  ws.on("message", (data) => {
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    const { op, d, s, t } = payload;

    if (s !== null && s !== undefined) lastSequence = s;

    switch (op) {
      case OP.HELLO: {
        startHeartbeat(d.heartbeat_interval);
        // Send first heartbeat immediately with a jitter
        setTimeout(() => {
          sendGateway({ op: OP.HEARTBEAT, d: lastSequence });
        }, Math.random() * d.heartbeat_interval);

        if (sessionId && resumeGatewayUrl) {
          console.log("🔄 Resuming session...");
          resume();
        } else {
          identify();
        }
        break;
      }

      case OP.HEARTBEAT_ACK: {
        heartbeatAcked = true;
        break;
      }

      case OP.HEARTBEAT: {
        // Server requested a heartbeat
        sendGateway({ op: OP.HEARTBEAT, d: lastSequence });
        break;
      }

      case OP.RECONNECT: {
        console.log("🔄 Gateway requested reconnect");
        ws.close();
        break;
      }

      case OP.INVALID_SESSION: {
        console.warn("⚠️ Invalid session, re-identifying in 5s...");
        sessionId = null;
        resumeGatewayUrl = null;
        setTimeout(() => identify(), 5000);
        break;
      }

      case OP.DISPATCH: {
        handleDispatch(t, d);
        break;
      }
    }
  });

  ws.on("close", (code, reason) => {
    console.warn(`🔌 Gateway closed (${code}): ${reason}`);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    // Reconnect after a short delay
    const reconnectUrl = resumeGatewayUrl || GATEWAY_URL;
    setTimeout(() => connect(reconnectUrl), 5000);
  });

  ws.on("error", (err) => {
    console.error("❌ Gateway error:", err.message);
  });
}

// ─── Dispatch event handler ───────────────────────────────────────────────────
function handleDispatch(event, data) {
  switch (event) {
    case "READY": {
      currentUserId = data.user.id;
      sessionId = data.session_id;
      resumeGatewayUrl = data.resume_gateway_url;
      console.log(`🚀 Logged in as ${data.user.username}#${data.user.discriminator}`);
      console.log(`👀 Watching channel ${CHANNEL_ID}`);
      console.log(`💬 Yap feature ready — send !on to start, !off to stop (delay: ${yapDelay}ms)`);
      break;
    }

    case "RESUMED": {
      console.log("✅ Session resumed");
      break;
    }

    case "MESSAGE_CREATE": {
      handleMessageCreate(data);
      break;
    }

    case "MESSAGE_REACTION_ADD": {
      handleReactionAdd(data);
      break;
    }
  }
}

// ─── Message event — commands ─────────────────────────────────────────────────
async function handleMessageCreate(message) {
  // Ignore messages from bots (including ourselves if we're a bot)
  if (message.author && message.author.bot) return;

  const text = (message.content || "").trim().toLowerCase();

  if (text === "!on") {
    console.log(`📥 !on received from ${message.author.username}`);
    startYap(message.channel_id);
  } else if (text === "!off") {
    console.log(`📥 !off received from ${message.author.username}`);
    stopYap();
  } else if (text.startsWith("!cooldown ")) {
    const arg = text.slice("!cooldown ".length).trim();
    const seconds = parseInt(arg, 10);
    if (!Number.isInteger(seconds) || seconds <= 0 || String(seconds) !== arg) {
      console.log(`⚠️ Invalid !cooldown value from ${message.author.username}: "${arg}"`);
      try {
        await sendMessage(
          message.channel_id,
          `❌ Invalid cooldown. Usage: \`!cooldown <positive integer>\` (seconds)`
        );
      } catch (err) {
        console.error("❌ Failed to send cooldown error message:", err.message);
      }
    } else {
      yapDelay = seconds * 1000;
      console.log(`⏱️ Cooldown updated to ${seconds}s (${yapDelay}ms) by ${message.author.username}`);
      try {
        await sendMessage(
          message.channel_id,
          `✅ Cooldown set to **${seconds} seconds**. Applies to the next scheduled message.`
        );
      } catch (err) {
        console.error("❌ Failed to send cooldown confirmation:", err.message);
      }
    }
  }
}

// ─── Reaction event — auto-reactor ───────────────────────────────────────────
async function handleReactionAdd(data) {
  // Only mirror reactions in the watched channel
  if (data.channel_id !== CHANNEL_ID) return;
  // Don't react to our own reactions
  if (data.user_id === currentUserId) return;

  const emoji = data.emoji;
  const emojiKey = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
  const comboKey = `${data.message_id}:${emojiKey}`;

  if (handled.has(comboKey)) return;
  handled.add(comboKey);

  // Build the emoji string for the API: "name:id" for custom, "name" for unicode
  const emojiStr = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;

  try {
    await addReaction(data.channel_id, data.message_id, emojiStr);
    console.log(`✅ Reacted ${emoji.name} on message ${data.message_id}`);
  } catch (err) {
    console.error(`❌ Failed to react ${emoji.name}:`, err.message);
    handled.delete(comboKey); // allow retry next time
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
connect(GATEWAY_URL);
