import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {portal} from "./portal.mjs";
test("acceptance upload evidence hashes the actual binary file, not the multipart envelope",async()=>{
  const site=portal({port:0}),address=await site.start(),origin=`http://127.0.0.1:${address.port}`;
  try {
    const bytes=Buffer.from([0,255,1,13,10,72,101,108,108,111]);
    const form=new FormData();form.append("document",new Blob([bytes]),"acceptance.bin");
    const response=await fetch(origin+"/upload",{method:"POST",headers:{Origin:origin},body:form});
    assert.equal(response.status,200);
    assert.deepEqual(site.events[0].files,[{name:"acceptance.bin",bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}]);
    const denied=await fetch(origin+"/upload",{method:"POST",headers:{Origin:"https://untrusted.invalid"},body:form});
    assert.equal(denied.status,403);assert.equal(site.events.length,1);
  } finally {site.server.closeAllConnections();await new Promise(resolve=>site.server.close(resolve));}
});
