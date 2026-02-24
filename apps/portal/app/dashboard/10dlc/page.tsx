"use client";
import { useState } from "react";

export default function TenDlc(){
  const [legalName,setLegalName]=useState("Connect Communications LLC");
  const [resp,setResp]=useState("");
  async function submit(){
    const token=localStorage.getItem("token") || "";
    const api=process.env.NEXT_PUBLIC_API_URL||"http://127.0.0.1:3001";
    const r=await fetch(`${api}/ten-dlc/submit`,{method:"POST",headers:{"content-type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({legalName})});
    setResp(JSON.stringify(await r.json(),null,2));
  }
  return <div className="card"><h1>Business Texting Registration (10DLC)</h1><p>10DLC registration supports compliant A2P messaging and improves delivery trust. Submit accurate business identity and messaging intent.</p><input value={legalName} onChange={e=>setLegalName(e.target.value)} /><button onClick={submit}>Submit</button><pre>{resp}</pre></div>;
}
EOF
