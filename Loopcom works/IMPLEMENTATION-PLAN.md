# Trim Pro - Implementation Plan
## Roles & Permissions + Analytics + Dispatch System

### A) REPOSITORY ANALYSIS

**Current Stack:**
- ✅ Framework: Next.js 14.0.4 (App Router)
- ✅ Database: PostgreSQL with Prisma ORM
- ✅ Auth: Custom JWT-based (not NextAuth)
- ✅ Multi-tenancy: Tenant model exists
- ✅ Real-time: Socket.io already in dependencies
- ✅ Charts: recharts + chart.js available

**Existing Entities:**
- Users, Teams, Jobs, Clients, Leads, Schedule, Estimates, Invoices, Purchase Orders, Tasks, Issues, Calls, Messages, Settings, AuditLogs

**Current Permissions:**
- Basic RBAC with JSON permissions field on User model
- No database tables for Roles/Permissions yet
- Permission checking exists but is basic

---

### B) ROLES & PERMISSIONS SYSTEM

#### B1) Database Schema (Prisma)
**New Models:**
1. `Role` - Custom roles + system roles
2. `Permission` - Granular permission catalog
3. `RolePermission` - Many-to-many relationship
4. `UserRole` - User-to-role assignments (support multiple roles)
5. `PermissionConstraint` (optional) - Advanced attribute-based rules

#### B2) Permission Catalog
**Comprehensive permissions grouped by module:**
- Dashboard (view)
- Clients (view/create/edit/delete/export)
- Leads (view/create/edit/delete/convert/export)
- Jobs (view/create/edit/delete/assign/reassign/change-status/add-notes/upload-files/export)
- Schedule (view/create/edit/delete/dispatch/reschedule)
- Estimates (view/create/edit/delete/send/approve/convert/export)
- Invoices (view/create/edit/delete/send/refund/export)
- Purchase Orders (view/create/edit/delete/approve/export)
- Tasks (view/create/edit/delete/assign/complete)
- Issues (view/create/edit/delete/assign/close)
- Teams (view/create/edit/delete/add-members/remove-members)
- Calls/Messages (view/send/delete/export)
- Settings (view/edit)
- Users (view/create/edit/deactivate/reset-password)
- Roles (view/create/edit/delete/assign)
- Analytics (view)
- Reports (view/create/edit/delete/run/schedule/export/share)
- Dispatch (view/dispatch/assign/route/notify/override-lock)
- Audit Logs (view/export)
- Billing/Payments (view/manage/refunds)
- System (manage integrations/webhooks/api-keys)

#### B3) Authorization Layer
- Centralized `lib/authorization.ts` with:
  - `hasPermission(user, permission)`
  - `requirePermission(permission)` middleware
  - `canAccessResource(user, resource, action)` for constraints
- Update all API routes to use permission checks
- Client-side permission hooks for UI hiding

#### B4) Roles Management UI
- Page: `/dashboard/settings/roles`
- Features:
  - List roles (system vs custom)
  - Create/Edit role with permission toggles
  - Assign roles to users
  - Effective permissions viewer

#### B5) Audit Logging
- Log role/permission changes
- Log user role assignments
- Use existing AuditLog model

---

### C) ANALYTICS + REPORTS SYSTEM

#### C1) Analytics Pages
**New Routes:**
- `/dashboard/analytics` (main page with tabs)
- `/dashboard/analytics/overview`
- `/dashboard/analytics/jobs`
- `/dashboard/analytics/revenue`
- `/dashboard/analytics/leads`
- `/dashboard/analytics/dispatch`
- `/dashboard/analytics/team`
- `/dashboard/analytics/customers`

**Features per page:**
- Date range picker
- Filters (team, user, status, etc.)
- KPI cards
- Charts (line, bar, pie, waterfall)

#### C2) Metrics to Track
- Overview: Jobs created/completed, Revenue, Invoice aging, Lead conversion, Job cycle time
- Jobs: Status over time, Completion time, Category breakdown, Rework rate
- Revenue: Revenue over time, Payments, Outstanding invoices waterfall, AR aging
- Leads: Created over time, Sources, Funnel (Lead → Estimate → Won/Lost), Time in stage
- Dispatch: Scheduled to en route time, On-time arrival %, Dispatch-to-accept, Reassignments
- Team: Jobs per tech, Revenue per tech, Utilization %, SLA/on-time %
- Customers: New vs returning, Repeat job rate, Top clients, Churn proxy

#### C3) Reports Builder
**New Routes:**
- `/dashboard/reports` (list + builder)
- `/dashboard/reports/new`
- `/dashboard/reports/[id]`

**Features:**
- Pre-built templates
- Custom report builder:
  - Dataset selection
  - Column selection
  - Filters (AND/OR groups)
  - Group by + aggregates
  - Sorting
  - Save/Share
- Export: CSV/XLSX/PDF
- Scheduling: Email reports (daily/weekly/monthly)

#### C4) Data Layer
- API endpoints: `/api/analytics/*`
- Efficient queries (avoid N+1)
- Optional: `DailyStats` materialized view for performance
- Caching strategy

---

### D) DISPATCHING SYSTEM

#### D1) Database Schema
**New Models:**
1. `DispatchEvent` - Timeline of dispatch actions
2. `TechAvailability` - User availability blocks
3. `ServiceZone` (optional) - Geographic zones
4. Enhance `JobAssignment` with dispatch-specific fields

#### D2) Dispatch UI
**New Routes:**
- `/dashboard/dispatch` (main dispatch board)
- `/dashboard/dispatch/board` (calendar view)

**Features:**
- Drag-drop job assignment
- Calendar timeline per tech
- Unassigned jobs queue
- Conflict detection
- Quick actions (assign, reassign, reschedule)

#### D3) Mobile API
**New Routes:**
- `/api/mobile/jobs` (GET - assigned jobs)
- `/api/mobile/jobs/[id]` (GET - job details)
- `/api/mobile/jobs/[id]/status` (POST - update status)
- `/api/mobile/jobs/[id]/note` (POST - add note)
- `/api/mobile/location` (POST - optional location tracking)

#### D4) Real-time Updates
- WebSocket server using Socket.io
- Rooms per tenant
- Events: job assigned, status changed, schedule updated
- Client-side Socket.io integration

#### D5) Notifications
- Email notifications (fallback)
- Push notification hooks (interface ready)
- User notification preferences
- Quiet hours support

#### D6) Dispatch Audit Trail
- DispatchEvent model for all actions
- Timeline view in job detail
- Admin audit view

---

### E) IMPLEMENTATION ORDER

1. **Roles & Permissions** (Foundation)
   - Schema migration
   - Permission catalog
   - Seed data
   - Authorization layer
   - Roles management UI

2. **Analytics** (Data visualization)
   - Analytics pages
   - API endpoints
   - Charts integration
   - Reports builder

3. **Dispatch** (Real-time operations)
   - Dispatch schema
   - Dispatch UI
   - Mobile API
   - WebSocket integration
   - Notifications

---

### F) DELIVERABLES CHECKLIST

- [ ] New Prisma models and migration
- [ ] Permission catalog (100+ permissions)
- [ ] Seed data (7 system roles + permissions)
- [ ] Authorization middleware
- [ ] Roles management UI
- [ ] Analytics pages (7 tabs)
- [ ] Reports builder
- [ ] Dispatch board UI
- [ ] Mobile API endpoints
- [ ] WebSocket server
- [ ] Notification system
- [ ] Documentation files
- [ ] Test instructions

---

### G) CONFIGURATION

**Environment Variables:**
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (already exists)
- `SOCKET_IO_PORT` (optional, default 3001)
- `PUSH_NOTIFICATION_KEY` (optional, for future)

**Safe Defaults:**
- All new features respect existing tenant isolation
- Permissions default to restrictive (deny by default)
- Real-time features gracefully degrade if WebSocket unavailable
