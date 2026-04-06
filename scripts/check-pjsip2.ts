// Check PJSIP auth username for T2_103_1 via raw AMI TCP connection
import net from "net";

const AMI_HOST = process.env.AMI_HOST || "172.17.0.1";
const AMI_PORT = parseInt(process.env.AMI_PORT || "5038");
const AMI_USER = process.env.AMI_USER || "connect";
const AMI_PASS = process.env.AMI_SECRET || "";

function amiQuery(host: string, port: number, user: string, pass: string, action: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host, port });
    let buf = "";
    let loggedIn = false;
    let actionSent = false;

    client.setTimeout(8000);
    client.on("timeout", () => { client.destroy(); reject(new Error("timeout")); });

    client.on("data", (data) => {
      buf += data.toString();
      if (!loggedIn && buf.includes("Asterisk Call Manager")) {
        client.write(`Action: Login\r\nUsername: ${user}\r\nSecret: ${pass}\r\n\r\n`);
      }
      if (!loggedIn && buf.includes("Authentication accepted")) {
        loggedIn = true;
        buf = "";
        client.write(action);
        actionSent = true;
      }
      // Collect until we see the complete event
      if (actionSent && buf.includes("EventList: Complete")) {
        client.write("Action: Logoff\r\n\r\n");
        client.end();
        resolve(buf);
      }
    });
    client.on("error", reject);
    client.on("close", () => resolve(buf));
  });
}

async function main() {
  console.log(`Connecting to AMI at ${AMI_HOST}:${AMI_PORT} as ${AMI_USER}`);
  
  try {
    // Query the PJSIP endpoint details for T2_103_1
    const result = await amiQuery(
      AMI_HOST, AMI_PORT, AMI_USER, AMI_PASS,
      "Action: PJSIPShowEndpoint\r\nEndpoint: T2_103_1\r\n\r\n"
    );
    
    const lines = result.split("\n").map(l => l.trim()).filter(Boolean);
    
    // Print relevant auth lines
    console.log("\n=== PJSIP Endpoint T2_103_1 ===");
    const relevant = lines.filter(l => 
      l.startsWith("Endpoint:") || 
      l.startsWith("Type:") ||
      l.startsWith("AuthUsername:") ||
      l.startsWith("Username:") ||
      l.startsWith("Auth:") ||
      l.includes("auth") ||
      l.includes("Auth") ||
      l.includes("Username") ||
      l.includes("Identify")
    );
    for (const l of relevant.slice(0, 40)) console.log(" ", l);
    
    // Also do PJSIPShowAuths to see all auth objects
    const authResult = await amiQuery(
      AMI_HOST, AMI_PORT, AMI_USER, AMI_PASS,
      "Action: PJSIPShowAuths\r\n\r\n"
    );
    
    console.log("\n=== All PJSIP Auths (filtered for 103) ===");
    const authLines = authResult.split("\n").map(l => l.trim()).filter(l => l.includes("103"));
    for (const l of authLines.slice(0, 20)) console.log(" ", l);
    
  } catch (e: any) {
    console.log("Error:", e.message);
    // Try with 172.18.0.1 (another common docker gateway)
    try {
      const result2 = await amiQuery("172.18.0.1", AMI_PORT, AMI_USER, AMI_PASS, "Action: PJSIPShowEndpoint\r\nEndpoint: T2_103_1\r\n\r\n");
      console.log("172.18.0.1 result:", result2.substring(0, 200));
    } catch (e2: any) {
      console.log("172.18.0.1 also failed:", e2.message);
    }
  }
}
main().catch(console.error);
