"use client";
import { useState } from "react";
export default function Signup(){const [tenantName,setTenantName]=useState("Demo Tenant");const [email,setEmail]=useState("owner@example.com");const [password,setPassword]=useState("Passw0rd123");const [msg,setMsg]=useState("");
async function submit(){const api=process.env.NEXT_PUBLIC_API_URL||"http://127.0.0.1:3001";const r=await fetch(`${api}/auth/signup`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({tenantName,email,password})});const j=await r.json();if(j.token){localStorage.setItem("token",j.token);setMsg("Account created")}else setMsg("Signup failed")}
return <div className="card"><h1>Sign Up</h1><input value={tenantName} onChange={e=>setTenantName(e.target.value)}/><input value={email} onChange={e=>setEmail(e.target.value)}/><input type="password" value={password} onChange={e=>setPassword(e.target.value)}/><button onClick={submit}>Create account</button><p>{msg}</p></div>}
