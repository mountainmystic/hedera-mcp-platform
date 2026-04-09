// REMOVE THIS FILE — temporary debug script, not needed

const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "account_info",
    arguments: { api_key: XAGENT_KEY },
  },
});

console.log("Calling /mcp with account_info...\n");

const req = https.request({
  hostname: "api.hederatoolbox.com",
  path: "/mcp",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Content-Length": Buffer.byteLength(body),
  },
}, res => {
  console.log("Status:", res.statusCode);
  console.log("Headers:", JSON.stringify(res.headers, null, 2));
  console.log("\n--- RAW BODY START ---");
  let data = "";
  res.on("data", c => { data += c; process.stdout.write(c); });
  res.on("end", () => {
    console.log("\n--- RAW BODY END ---");
    console.log("\nTotal bytes:", data.length);
    console.log("\n--- LINE-BY-LINE PARSE ---");
    const lines = data.split("\n").map(l => l.trim()).filter(Boolean);
    console.log("Lines found:", lines.length);
    for (let i = 0; i < lines.length; i++) {
      console.log(`\nLine ${i}: ${lines[i].slice(0, 120)}`);
      try {
        const parsed = JSON.parse(lines[i]);
        console.log(`  → parsed OK. Keys: ${Object.keys(parsed).join(", ")}`);
        const text = parsed?.result?.content?.[0]?.text;
        if (text) console.log(`  → content found: ${text.slice(0, 100)}`);
        if (parsed?.error) console.log(`  → error: ${JSON.stringify(parsed.error)}`);
      } catch (e) {
        console.log(`  → not valid JSON: ${e.message}`);
      }
    }
  });
});

req.on("error", e => console.error("Request error:", e.message));
req.write(body);
req.end();
