const { Client, GatewayIntentBits, ActivityType } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
// Delay between each yap message in milliseconds (default: 30 seconds)
let yapDelay = parseInt(process.env.YAP_DELAY || "30000", 10);

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or CHANNEL_ID env vars");
  process.exit(1);
}

const { ALL_MESSAGES } = require("./messages.js");

// ─── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Auto-reactor state ───────────────────────────────────────────────────────
const handled = new Set();

// ─── Yap feature state ────────────────────────────────────────────────────────
let yapActive = false;    // whether the yap loop is running
let yapIndex = 0;         // current position in ALL_MESSAGES (0-based)
let yapChannel = null;    // discord.js TextChannel where !on was issued
let yapTimeout = null;    // handle for the scheduled next message

// Schedule the next yap message; wraps back to 0 after all messages are sent
function scheduleNextYap() {
  if (!yapActive) return;
  yapTimeout = setTimeout(async () => {
    if (!yapActive) return;
    const msgNumber = yapIndex + 1; // 1-based for logging
    const content = ALL_MESSAGES[yapIndex];
    console.log(`💬 Yap #${msgNumber} → channel ${yapChannel.id}`);
    try {
      await yapChannel.send(content);
    } catch (err) {
      console.error("❌ Yap send failed:", err.message);
    }
    yapIndex = (yapIndex + 1) % ALL_MESSAGES.length; // cycle back after all messages
    scheduleNextYap();
  }, yapDelay);
}

// Start the yap loop in the given channel
function startYap(channel) {
  if (yapActive) return; // already running
  yapActive = true;
  yapChannel = channel;
  console.log(`🟢 Yap started in channel ${channel.id} from message ${yapIndex + 1}`);
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

// ─── Ready event ──────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`🚀 Logged in as ${client.user.tag}`);
  console.log(`👀 Watching channel ${CHANNEL_ID}`);
  console.log(`💬 Yap feature ready — send !on to start, !off to stop (delay: ${yapDelay}ms)`);

  client.user.setPresence({
    status: "online",
    activities: [
      {
        name: "the chat 👀",
        type: ActivityType.Watching,
      },
    ],
  });
});

// ─── Message event — commands ─────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  // Ignore messages from bots (including ourselves)
  if (message.author.bot) return;

  const text = (message.content || "").trim().toLowerCase();

  if (text === "!on") {
    console.log(`📥 !on received from ${message.author.username}`);
    startYap(message.channel);
  } else if (text === "!off") {
    console.log(`📥 !off received from ${message.author.username}`);
    stopYap();
  } else if (text.startsWith("!cooldown ")) {
    const arg = text.slice("!cooldown ".length).trim();
    const seconds = parseInt(arg, 10);
    if (!Number.isInteger(seconds) || seconds <= 0 || String(seconds) !== arg) {
      console.log(`⚠️ Invalid !cooldown value from ${message.author.username}: "${arg}"`);
      await message.channel.send(
        `❌ Invalid cooldown. Usage: \`!cooldown <positive integer>\` (seconds)`
      );
    } else {
      yapDelay = seconds * 1000;
      console.log(`⏱️ Cooldown updated to ${seconds}s (${yapDelay}ms) by ${message.author.username}`);
      await message.channel.send(
        `✅ Cooldown set to **${seconds} seconds**. Applies to the next scheduled message.`
      );
    }
  }
});

// ─── Reaction event — auto-reactor ───────────────────────────────────────────
client.on("messageReactionAdd", async (reaction, user) => {
  // Only mirror reactions in the watched channel
  if (reaction.message.channelId !== CHANNEL_ID) return;
  // Don't react to our own reactions
  if (user.id === client.user.id) return;

  // Fetch partial reaction/message if needed
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch (err) {
    console.error("❌ Failed to fetch reaction/message:", err.message);
    return;
  }

  const emoji = reaction.emoji;
  const emojiKey = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
  const comboKey = `${reaction.message.id}:${emojiKey}`;

  if (handled.has(comboKey)) return;
  handled.add(comboKey);

  try {
    await reaction.message.react(emoji.id ? emoji : emoji.name);
    console.log(`✅ Reacted ${emoji.name} on msg from ${reaction.message.author?.username ?? "unknown"}`);
  } catch (err) {
    console.error(`❌ Failed to react ${emoji.name}:`, err.message);
    handled.delete(comboKey); // allow retry next time
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
