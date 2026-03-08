"use client";
import { useState } from "react";
export default function Login(){const [email,setEmail]=useState("");const [password,setPassword]=useState("");const [msg,setMsg]=useState("");
async function submit(){const api=process.env.NEXT_PUBLIC_API_URL||"http://127.0.0.1:3001";const r=await fetch(`${api}/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});const j=await r.json();if(j.token){localStorage.setItem("token",j.token);setMsg("Logged in")}else setMsg("Login failed")}
return <div className="card"><h1>Login</h1><input placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)}/><input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)}/><button onClick={submit}>Login</button><p>{msg}</p></div>}
