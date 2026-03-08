"use client";

import Link from "next/link";

export default function AdminPbxHomePage() {
  return (
    <div className="card">
      <h1>Admin PBX Control</h1>
      <p>Manage VitalPBX connectivity, tenants, sync operations, and resource-level administration.</p>
      <ul>
        <li><Link href="/dashboard/admin/pbx/instances">PBX Instances</Link></li>
        <li><Link href="/dashboard/admin/pbx/tenants">PBX Tenants</Link></li>
        <li><Link href="/dashboard/admin/pbx/resources">PBX Resources</Link></li>
        <li><Link href="/dashboard/admin/pbx/events">PBX Events</Link></li>
      </ul>
    </div>
  );
}
