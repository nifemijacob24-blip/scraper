// src/utils/notifier.js
require('dotenv').config();

async function notifyFailure({ endpoint, params, statusCode, errorMsg }) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    
    if (!webhookUrl) {
        console.warn("⚠️ Discord webhook URL not set in .env");
        return;
    }

    const payload = {
        username: "API Monitor",
        embeds: [{
            title: `🚨 Endpoint Failure: ${endpoint}`,
            color: 16711680, // Red color
            fields: [
                { name: "Status Code", value: statusCode.toString(), inline: true },
                { name: "Error", value: errorMsg, inline: false },
                { name: "Params", value: `\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``, inline: false }
            ],
            timestamp: new Date().toISOString()
        }]
    };

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        console.error("Failed to send Discord notification:", err);
    }
}

module.exports = { notifyFailure };