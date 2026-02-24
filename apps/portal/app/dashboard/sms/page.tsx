"use client";
import { useState } from "react";

export default function Sms(){
  const [name,setName]=useState("Campaign 1");
  const [message,setMessage]=useState("Hello customers");
  const [audience,setAudience]=useState("all");
  const [resp,setResp]=useState("");
  async function submit(){
    const token=localStorage.getItem("token") || "";
    const api=process.env.NEXT_PUBLIC_API_URL||"http://127.0.0.1:3001";
    const r=await fetch(`${api}/sms/campaigns`,{method:"POST",headers:{"content-type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({name,message,audience})});
    setResp(JSON.stringify(await r.json(),null,2));
  }
  return <div className="card"><h1>SMS</h1><input value={name} onChange={e=>setName(e.target.value)} /><textarea value={message} onChange={e=>setMessage(e.target.value)} /><input value={audience} onChange={e=>setAudience(e.target.value)} /><button onClick={submit}>Create Campaign</button><pre>{resp}</pre></div>;
}
