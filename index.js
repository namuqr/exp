const WebSocket = require("ws");

// ─── Configuration ────────────────────────────────────────────────────────────
const CHANNEL_ID = process.env.CHANNEL_ID;
// Delay between each yap message in milliseconds (default: 30 seconds)
let yapDelay = parseInt(process.env.YAP_DELAY || "30000", 10);

// Parse DISCORD_TOKENS as a JSON array of token strings
let TOKENS;
try {
  TOKENS = JSON.parse(process.env.DISCORD_TOKENS || "[]");
  if (!Array.isArray(TOKENS) || TOKENS.length === 0) throw new Error("empty");
} catch {
  console.error(
    "Missing or invalid DISCORD_TOKENS env var.\n" +
    'Expected a JSON array, e.g.: ["token1","token2","token3"]'
  );
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error("Missing CHANNEL_ID env var");
  process.exit(1);
}

const { ALL_MESSAGES } = require("./messages.js");

// ─── Shared state (all clients read/write these together) ─────────────────────
const handled = new Set();   // reaction combo keys already processed

let yapActive = false;       // whether the yap loop is running
let yapIndex = 0;            // current position in ALL_MESSAGES (0-based)
let yapChannelId = null;     // channel ID where !on was issued
let yapTimeout = null;       // handle for the scheduled next message

// ─── Yap feature ─────────────────────────────────────────────────────────────
// Each tick, ONE randomly chosen client sends the message so it looks natural.
// All clients are passed in so we can pick one at random.
let allClients = [];

function scheduleNextYap() {
  if (!yapActive) return;
  yapTimeout = setTimeout(async () => {
    if (!yapActive) return;
    const msgNumber = yapIndex + 1; // 1-based for logging
    const content = ALL_MESSAGES[yapIndex];
    console.log(`💬 Yap #${msgNumber} → channel ${yapChannelId}`);

    // Pick a random live client to send the message
    const live = allClients.filter((c) => c.isReady());
    if (live.length > 0) {
      const sender = live[Math.floor(Math.random() * live.length)];
      try {
        await sender.sendMessage(yapChannelId, content);
      } catch (err) {
        console.error("❌ Yap send failed:", err.message);
      }
    } else {
      console.warn("⚠️ No live clients available to send yap message");
    }

    yapIndex = (yapIndex + 1) % ALL_MESSAGES.length;
    scheduleNextYap();
  }, yapDelay);
}

function startYap(channelId) {
  if (yapActive) return;
  yapActive = true;
  yapChannelId = channelId;
  console.log(`🟢 Yap started in channel ${channelId} from message ${yapIndex + 1}`);
  scheduleNextYap();
}

function stopYap() {
  if (!yapActive) return;
  yapActive = false;
  if (yapTimeout) {
    clearTimeout(yapTimeout);
    yapTimeout = null;
  }
  console.log(`🔴 Yap stopped at message ${yapIndex + 1}`);
}

// ─── Gateway constants ────────────────────────────────────────────────────────
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const API_BASE = "https://discord.com/api/v10";

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

// ─── DiscordClient class ──────────────────────────────────────────────────────
class DiscordClient {
  constructor(token, index) {
    this.token = token;
    this.index = index;          // for log prefixes
    this.tag = `[Account ${index + 1}]`;

    // Gateway state
    this.ws = null;
    this.heartbeatInterval = null;
    this.lastSequence = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.heartbeatAcked = true;
    this.currentUserId = null;
    this.ready = false;
  }

  // ── Public helpers ──────────────────────────────────────────────────────────
  isReady() {
    return this.ready && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // ── REST helpers ────────────────────────────────────────────────────────────
  async discordRequest(method, path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: this.token,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (custom, 1.0)",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord API ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  sendMessage(channelId, content) {
    return this.discordRequest("POST", `/channels/${channelId}/messages`, { content });
  }

  addReaction(channelId, messageId, emoji) {
    const encoded = encodeURIComponent(emoji);
    return this.discordRequest(
      "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
      null
    );
  }

  // ── Gateway ─────────────────────────────────────────────────────────────────
  sendGateway(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  startHeartbeat(intervalMs) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatAcked = true;
    this.heartbeatInterval = setInterval(() => {
      if (!this.heartbeatAcked) {
        console.warn(`${this.tag} ⚠️ Heartbeat not acknowledged — reconnecting`);
        this.ws.terminate();
        return;
      }
      this.heartbeatAcked = false;
      this.sendGateway({ op: OP.HEARTBEAT, d: this.lastSequence });
    }, intervalMs);
  }

  identify() {
    this.sendGateway({
      op: OP.IDENTIFY,
      d: {
        token: this.token,
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

  resume() {
    this.sendGateway({
      op: OP.RESUME,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.lastSequence,
      },
    });
  }

  connect(url) {
    const target = url || GATEWAY_URL;
    console.log(`${this.tag} 🔌 Connecting to gateway: ${target}`);
    this.ws = new WebSocket(target);

    this.ws.on("open", () => {
      console.log(`${this.tag} 🌐 Gateway connection opened`);
    });

    this.ws.on("message", (data) => {
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }

      const { op, d, s, t } = payload;

      if (s !== null && s !== undefined) this.lastSequence = s;

      switch (op) {
        case OP.HELLO: {
          this.startHeartbeat(d.heartbeat_interval);
          // Jittered first heartbeat
          setTimeout(() => {
            this.sendGateway({ op: OP.HEARTBEAT, d: this.lastSequence });
          }, Math.random() * d.heartbeat_interval);

          if (this.sessionId && this.resumeGatewayUrl) {
            console.log(`${this.tag} 🔄 Resuming session...`);
            this.resume();
          } else {
            this.identify();
          }
          break;
        }

        case OP.HEARTBEAT_ACK: {
          this.heartbeatAcked = true;
          break;
        }

        case OP.HEARTBEAT: {
          this.sendGateway({ op: OP.HEARTBEAT, d: this.lastSequence });
          break;
        }

        case OP.RECONNECT: {
          console.log(`${this.tag} 🔄 Gateway requested reconnect`);
          this.ws.close();
          break;
        }

        case OP.INVALID_SESSION: {
          console.warn(`${this.tag} ⚠️ Invalid session, re-identifying in 5s...`);
          this.sessionId = null;
          this.resumeGatewayUrl = null;
          setTimeout(() => this.identify(), 5000);
          break;
        }

        case OP.DISPATCH: {
          this.handleDispatch(t, d);
          break;
        }
      }
    });

    this.ws.on("close", (code, reason) => {
      this.ready = false;
      console.warn(`${this.tag} 🔌 Gateway closed (${code}): ${reason}`);
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      const reconnectUrl = this.resumeGatewayUrl || GATEWAY_URL;
      setTimeout(() => this.connect(reconnectUrl), 5000);
    });

    this.ws.on("error", (err) => {
      console.error(`${this.tag} ❌ Gateway error:`, err.message);
    });
  }

  // ── Dispatch handler ────────────────────────────────────────────────────────
  handleDispatch(event, data) {
    switch (event) {
      case "READY": {
        this.ready = true;
        this.currentUserId = data.user.id;
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        console.log(`${this.tag} 🚀 Logged in as ${data.user.username}#${data.user.discriminator}`);
        console.log(`${this.tag} 👀 Watching channel ${CHANNEL_ID}`);
        console.log(`${this.tag} 💬 Yap ready — !on to start, !off to stop (delay: ${yapDelay}ms)`);
        break;
      }

      case "RESUMED": {
        this.ready = true;
        console.log(`${this.tag} ✅ Session resumed`);
        break;
      }

      case "MESSAGE_CREATE": {
        this.handleMessageCreate(data);
        break;
      }

      case "MESSAGE_REACTION_ADD": {
        this.handleReactionAdd(data);
        break;
      }
    }
  }

  // ── Message event — commands ────────────────────────────────────────────────
  async handleMessageCreate(message) {
    if (message.author && message.author.bot) return;

    const text = (message.content || "").trim().toLowerCase();

    if (text === "!on") {
      console.log(`${this.tag} 📥 !on received from ${message.author.username}`);
      startYap(message.channel_id);
    } else if (text === "!off") {
      console.log(`${this.tag} 📥 !off received from ${message.author.username}`);
      stopYap();
    } else if (text.startsWith("!cooldown ")) {
      const arg = text.slice("!cooldown ".length).trim();
      const seconds = parseInt(arg, 10);
      if (!Number.isInteger(seconds) || seconds <= 0 || String(seconds) !== arg) {
        console.log(`${this.tag} ⚠️ Invalid !cooldown value from ${message.author.username}: "${arg}"`);
        try {
          await this.sendMessage(
            message.channel_id,
            `❌ Invalid cooldown. Usage: \`!cooldown <positive integer>\` (seconds)`
          );
        } catch (err) {
          console.error(`${this.tag} ❌ Failed to send cooldown error message:`, err.message);
        }
      } else {
        yapDelay = seconds * 1000;
        console.log(`${this.tag} ⏱️ Cooldown updated to ${seconds}s (${yapDelay}ms) by ${message.author.username}`);
        try {
          await this.sendMessage(
            message.channel_id,
            `✅ Cooldown set to **${seconds} seconds**. Applies to the next scheduled message.`
          );
        } catch (err) {
          console.error(`${this.tag} ❌ Failed to send cooldown confirmation:`, err.message);
        }
      }
    }
  }

  // ── Reaction event — auto-reactor ───────────────────────────────────────────
  async handleReactionAdd(data) {
    // Only mirror reactions in the watched channel
    if (data.channel_id !== CHANNEL_ID) return;
    // Don't react to our own reactions
    if (data.user_id === this.currentUserId) return;

    const emoji = data.emoji;
    const emojiKey = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
    const comboKey = `${data.message_id}:${emojiKey}`;

    // Shared handled set prevents any account from double-reacting
    if (handled.has(comboKey)) return;
    handled.add(comboKey);

    const emojiStr = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;

    try {
      await this.addReaction(data.channel_id, data.message_id, emojiStr);
      console.log(`${this.tag} ✅ Reacted ${emoji.name} on message ${data.message_id}`);
    } catch (err) {
      console.error(`${this.tag} ❌ Failed to react ${emoji.name}:`, err.message);
      handled.delete(comboKey); // allow retry next time
    }
  }
}

// ─── Start — spin up one client per token ────────────────────────────────────
console.log(`🚀 Starting ${TOKENS.length} Discord client(s)...`);

allClients = TOKENS.map((token, i) => new DiscordClient(token, i));
allClients.forEach((client) => client.connect());
