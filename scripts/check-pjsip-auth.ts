// Check what Asterisk PJSIP auth username is configured for device T2_103_1
import { db } from "@connect/db";
import net from "net";

async function main() {
  const amiBridge = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
  if (!amiBridge) return;

  // Use the telephony service to query AMI
  // Connect to AMI via telephony container
  console.log("Checking via AMI: PJSIP auth for T2_103_1 ...");
  
  // Try the telephony service health endpoint first
  const fetch = (await import("node-fetch")).default;
  
  try {
    // AMI action to get PJSIP auth details
    const amiHost = process.env.AMI_HOST || "host.docker.internal";
    const amiPort = parseInt(process.env.AMI_PORT || "5038");
    const amiUser = process.env.AMI_USER || "connect";
    const amiPass = process.env.AMI_SECRET || "";
    
    console.log("Connecting to AMI at", amiHost, amiPort);
    
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection({ host: amiHost, port: amiPort });
      let buf = "";
      let loggedIn = false;
      
      client.setTimeout(8000);
      client.on("timeout", () => { client.destroy(); reject(new Error("AMI timeout")); });
      
      client.on("data", (data) => {
        buf += data.toString();
        
        if (!loggedIn && buf.includes("Asterisk Call Manager")) {
          client.write(`Action: Login\r\nUsername: ${amiUser}\r\nSecret: ${amiPass}\r\n\r\n`);
          return;
        }
        
        if (!loggedIn && buf.includes("Authentication accepted")) {
          loggedIn = true;
          buf = "";
          // Query PJSIP show endpoint T2_103_1
          client.write("Action: PJSIPShowEndpoint\r\nEndpoint: T2_103_1\r\n\r\n");
          return;
        }
        
        if (loggedIn && (buf.includes("EndpointDetailComplete") || buf.includes("AuthDetail"))) {
          const lines = buf.split("\n");
          const authLines = lines.filter(l => l.includes("AuthUsername") || l.includes("Endpoint:") || l.includes("Username:") || l.includes("Type: auth") || l.includes("Auth:"));
          console.log("PJSIP auth details:");
          for (const l of authLines) console.log(" ", l.trim());
          
          if (buf.includes("EndpointDetailComplete")) {
            client.write("Action: Logoff\r\n\r\n");
            client.end();
            resolve();
          }
        }
      });
      
      client.on("error", (e) => reject(e));
      client.on("close", () => resolve());
    });
  } catch (e: any) {
    console.log("AMI check error:", e.message);
  }
}
main().catch(console.error).finally(() => db.$disconnect());
