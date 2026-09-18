# A2 — Loopcom Works (TrimPro) UI Inventory
Read-only audit. Repo root: `C:\dev\projects\Connect 2\Loopcom works\`. 96 `page.tsx` files under `app/`, 70 files under `components/`.
## Task A — Screen inventory (96 pages)
Columns: Table / Dialog / Dropdown / DatePicker / Switch / Tabs / Form / Upload / Pagination / Search show a **count** of matches for that feature's marker pattern in the file (blank = 0; a count is not the same as a literal number of widgets — e.g. `hasError` counts defensive `catch(`/`Failed to` strings, not literal error banners). `Colors` / `Hex` are the Task D hard-coded-color counts for that same file.
### auth (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/auth/forgot-password` | Request a password-reset email. | none (root layout.tsx only — no sidebar/topbar) | ui/button, ui/card, ui/input, ui/label |  |  |  |  |  |  | 1 |  |  |  |  |  | 3 | 5 | 0 |
| `/auth/login` | Email/password sign-in. | none (root layout.tsx only — no sidebar/topbar) | ui/button, ui/card, ui/input, ui/label |  |  |  |  |  |  | 1 |  |  |  | 1 |  | 3 | 6 | 0 |
| `/auth/reset-password` | Set a new password from a reset-email token. | none (root layout.tsx only — no sidebar/topbar) | ui/button, ui/card, ui/input, ui/label |  |  |  |  |  |  | 1 |  |  |  |  |  | 3 | 5 | 0 |
| `/auth/set-password` | First-time password creation for an invited user. | none (root layout.tsx only — no sidebar/topbar) | ui/button, ui/card, ui/input, ui/label |  |  |  |  |  |  | 1 |  |  |  |  |  | 3 | 4 | 0 |

### dashboard (home) (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard` | Main dashboard home: KPI tiles, charts (jobs, revenue, pipeline) and recent activity. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card |  |  |  |  |  |  |  |  |  |  |  |  | 7 | 19 | 0 |

### clients (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/clients/[id]/edit` | Edit an existing client. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/checkbox, ui/input, ui/label, ui/searchable-client-select, ui/select |  |  | 2 |  |  |  | 1 |  |  |  |  | 1 | 21 | 24 | 0 |
| `/dashboard/clients/[id]` | View/manage a single client record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label |  | 14 | 1 | 1 | 9 |  |  |  |  |  |  | 2 | 32 | 133 | 5 |
| `/dashboard/clients/new` | Create a new client. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/searchable-client-select |  |  | 1 |  |  |  | 1 |  |  |  |  |  | 5 | 6 | 0 |
| `/dashboard/clients` | List/search/filter all client records; bulk actions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | lists/RowCompactItem, lists/RowDetailedItem, lists/TableView, ui/ViewModeSelector, ui/button, ui/card, ui/input, ui/select | 3 |  | 1 |  | 5 |  |  |  | 6 | 1 |  |  | 11 | 52 | 0 |

### leads (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/leads/[id]/edit` | Redirect shim — leads were merged into Requests. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | — |  |  |  |  |  |  |  |  |  |  |  |  |  | 0 | 0 |
| `/dashboard/leads/[id]` | Redirect shim — leads were merged into Requests. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | — |  |  |  |  |  |  |  |  |  |  |  |  |  | 0 | 0 |
| `/dashboard/leads/new` | Redirect shim — leads were merged into Requests. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | — |  |  |  |  |  |  |  |  |  |  |  |  |  | 0 | 0 |
| `/dashboard/leads` | Redirect shim — leads were merged into Requests. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | — |  |  |  |  |  |  |  |  |  |  |  |  |  | 0 | 0 |

### estimates (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/estimates/[id]/edit` | Edit an existing estimate. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/checkbox, ui/input, ui/label, ui/searchable-client-select, ui/select, ui/tabs |  |  | 2 | 1 | 28 | 1 | 1 |  |  |  |  | 1 | 14 | 102 | 0 |
| `/dashboard/estimates/[id]` | View/manage a single estimate record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) + inline `ResponsivePage` wrapper in the page | common/document-attachments, ui/button, ui/card, ui/checkbox, ui/dialog, ui/input, ui/label | 2 | 75 |  |  |  |  |  |  |  |  |  |  | 37 | 87 | 0 |
| `/dashboard/estimates/new` | Create a new estimate. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) + inline `ResponsivePage` wrapper in the page | ui/button, ui/card, ui/checkbox, ui/input, ui/label, ui/searchable-client-select, ui/select, ui/tabs |  |  | 1 | 1 | 34 | 1 | 1 |  |  |  |  | 1 | 12 | 118 | 0 |
| `/dashboard/estimates` | List/search/filter all estimate records; bulk actions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | lists/RowCompactItem, lists/RowDetailedItem, lists/TableView, ui/PaginationControls, ui/ViewModeSelector, ui/button, ui/card, ui/input, ui/select | 3 |  | 1 | 1 | 4 |  |  |  | 8 | 1 |  |  | 13 | 42 | 8 |

### invoices (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/invoices/[id]/edit` | Edit an existing invoice. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/checkbox, ui/input, ui/label, ui/searchable-client-select, ui/select, ui/tabs |  |  | 3 | 2 | 28 | 1 | 1 |  |  |  |  | 1 | 15 | 105 | 0 |
| `/dashboard/invoices/[id]` | View/manage a single invoice record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) + inline `ResponsivePage` wrapper in the page | common/document-attachments, ui/button, ui/card, ui/checkbox, ui/dialog, ui/input, ui/label | 1 | 113 |  | 2 |  |  |  |  |  |  |  |  | 50 | 89 | 0 |
| `/dashboard/invoices/new` | Create a new invoice. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) + inline `ResponsivePage` wrapper in the page | ui/button, ui/card, ui/checkbox, ui/input, ui/label, ui/searchable-client-select, ui/select, ui/tabs |  | 1 | 3 | 2 | 28 | 1 | 1 |  |  |  |  |  | 12 | 117 | 0 |
| `/dashboard/invoices` | List/search/filter all invoice records; bulk actions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | lists/RowCompactItem, lists/RowDetailedItem, lists/TableView, ui/PaginationControls, ui/ViewModeSelector, ui/button, ui/card, ui/dialog, ui/input, ui/label, ui/select | 3 | 21 | 1 | 1 | 4 |  |  |  | 8 | 1 |  |  | 13 | 83 | 0 |

### credit memos (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/credit-memos/[id]/edit` | Edit an existing credit memo. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 1 |  |  |  | 1 |  |  |  | 1 |  | 5 | 2 | 0 |
| `/dashboard/credit-memos/[id]` | View/manage a single credit memo record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/dialog, ui/input, ui/label | 1 | 46 |  |  | 2 |  |  |  |  |  | 1 |  | 13 | 31 | 0 |
| `/dashboard/credit-memos/new` | Create a new credit memo. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/searchable-client-select, ui/select |  |  | 2 |  |  |  | 1 |  |  |  |  |  | 5 | 2 | 0 |
| `/dashboard/credit-memos` | List/search/filter all credit memo records; bulk actions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/select | 1 |  | 1 |  |  |  |  |  |  | 1 | 1 | 1 | 3 | 19 | 0 |

### jobs (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/jobs/[id]/edit` | Edit an existing job. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/searchable-client-select, ui/select |  |  | 2 |  |  |  | 1 |  |  |  |  |  | 12 | 13 | 0 |
| `/dashboard/jobs/[id]` | View/manage a single job record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | common/document-attachments, ui/button, ui/card, ui/dialog, ui/select | 1 | 24 | 2 | 1 | 1 |  |  |  |  |  |  | 2 | 62 | 66 | 0 |
| `/dashboard/jobs/new` | Create a new job. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/searchable-client-select, ui/select |  |  | 2 |  |  |  | 1 |  |  |  |  |  | 4 | 9 | 0 |
| `/dashboard/jobs` | List/search/filter all job records; bulk actions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | lists/RowCompactItem, lists/RowDetailedItem, lists/TableView, ui/PaginationControls, ui/ViewModeSelector, ui/button, ui/card, ui/input, ui/select | 3 |  | 2 | 4 | 5 |  |  |  | 8 | 1 |  |  | 8 | 46 | 8 |

### purchase orders (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/purchase-orders/[id]/edit` | Edit an existing purchase order. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/searchable-job-select, ui/select |  |  | 3 | 2 | 7 |  | 1 |  |  | 1 |  |  | 14 | 51 | 0 |
| `/dashboard/purchase-orders/[id]` | View/manage a single purchase order record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | common/document-attachments, ui/button, ui/card, ui/dialog, ui/input, ui/label | 1 | 26 |  | 1 |  |  |  |  |  |  |  |  | 23 | 46 | 0 |
| `/dashboard/purchase-orders/new` | Create a new purchase order. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/searchable-job-select, ui/select |  |  | 3 | 2 | 7 |  | 1 |  |  | 1 |  |  | 9 | 51 | 0 |
| `/dashboard/purchase-orders` | List/search/filter all purchase order records; bulk actions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | lists/RowCompactItem, lists/RowDetailedItem, lists/TableView, ui/PaginationControls, ui/ViewModeSelector, ui/button, ui/card, ui/input, ui/select | 3 |  | 1 |  | 4 |  |  |  | 8 | 1 |  |  | 5 | 32 | 0 |

### vendors (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/vendors/[id]/edit` | Edit an existing vendor. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 2 |  |  |  | 1 |  |  |  |  | 1 | 6 | 6 | 0 |
| `/dashboard/vendors/[id]` | View/manage a single vendor record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card | 2 |  |  |  |  |  |  |  |  |  |  | 3 | 6 | 71 | 0 |
| `/dashboard/vendors/new` | Create a new vendor. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 2 |  |  |  | 1 |  |  |  |  | 1 | 3 | 5 | 0 |
| `/dashboard/vendors` | Vendor list with QuickBooks import/export. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | lists/RowCompactItem, lists/RowDetailedItem, ui/PaginationControls, ui/ViewModeSelector, ui/button, ui/card, ui/dialog, ui/input, ui/select | 1 | 26 | 2 |  |  |  |  | 1 | 8 | 1 |  | 1 | 12 | 29 | 0 |

### items (6 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/items/[id]/edit` | Edit an existing item. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 5 |  |  |  | 1 |  |  |  |  |  | 14 | 10 | 0 |
| `/dashboard/items/[id]` | View/manage a single item record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card |  |  |  |  | 3 |  |  |  |  |  |  |  | 9 | 51 | 0 |
| `/dashboard/items/bundles/[id]/edit` | Edit an existing item bundle. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 5 |  |  |  | 1 |  |  |  |  | 1 | 10 | 10 | 0 |
| `/dashboard/items/bundles/new` | (New Bundle) | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 5 |  |  |  | 1 |  |  |  |  | 1 | 7 | 9 | 0 |
| `/dashboard/items/new` | Create a new item. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 5 |  |  |  | 1 |  |  |  |  |  | 8 | 9 | 0 |
| `/dashboard/items` | List/search/filter all item records; bulk actions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/dialog, ui/input, ui/select | 1 | 28 | 4 |  | 2 |  |  | 1 | 6 | 1 |  |  | 22 | 52 | 0 |

### schedule (3 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/schedule/[id]` | View/edit a single schedule entry. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card |  |  |  | 1 |  |  |  |  |  |  |  |  | 4 | 8 | 0 |
| `/dashboard/schedule/new` | Create a new schedule entry. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 3 |  |  |  | 1 |  |  |  |  |  | 5 | 7 | 0 |
| `/dashboard/schedule` | Scheduling calendar/board with unscheduled-jobs list. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/select |  |  | 4 |  |  |  |  |  | 2 | 1 |  | 1 | 19 | 79 | 0 |

### dispatch (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/dispatch` | Live dispatch board: crew map/list, job assignment, live event feed, media uploads. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/dialog, ui/input, ui/label, ui/select, ui/tabs, ui/textarea | 1 | 16 | 4 | 2 |  | 2 |  |  |  | 1 |  | 2 | 3 | 68 | 0 |

### tasks (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/tasks/[id]/edit` | Edit an existing task. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 3 |  |  |  | 1 |  |  |  |  |  | 13 | 11 | 0 |
| `/dashboard/tasks/[id]` | View/manage a single task record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card |  |  |  | 2 |  |  |  |  |  |  |  | 1 | 26 | 35 | 0 |
| `/dashboard/tasks/new` | Create a new task. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/searchable-client-select, ui/select |  |  | 5 |  |  |  | 1 |  |  |  | 2 |  | 7 | 7 | 0 |
| `/dashboard/tasks` | List/search/filter all task records; bulk actions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | lists/RowCompactItem, lists/RowDetailedItem, lists/TableView, ui/PaginationControls, ui/ViewModeSelector, ui/button, ui/card, ui/input, ui/select | 3 |  | 2 | 3 |  |  |  |  | 8 | 1 |  |  | 2 | 36 | 0 |

### issues (3 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/issues/[id]` | View/manage a single issue record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card |  |  |  | 1 |  |  |  |  |  |  |  | 1 | 24 | 37 | 0 |
| `/dashboard/issues/new` | Create a new issue. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/searchable-client-select, ui/select |  |  | 6 |  |  |  | 1 |  |  |  | 2 |  | 7 | 7 | 0 |
| `/dashboard/issues` | List/search/filter all issue records; bulk actions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | lists/RowCompactItem, lists/RowDetailedItem, lists/TableView, ui/PaginationControls, ui/ViewModeSelector, ui/button, ui/card, ui/input, ui/select | 3 |  | 3 |  |  |  |  |  | 8 | 1 |  |  | 2 | 63 | 0 |

### requests (4 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/requests/[id]/edit` | Edit an existing request. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | common/document-attachments, ui/button, ui/card, ui/input, ui/label, ui/searchable-client-select, ui/select |  |  | 5 |  |  |  | 1 |  |  |  |  |  | 15 | 11 | 0 |
| `/dashboard/requests/[id]` | View/manage a single request record (detail page). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | common/document-attachments, ui/button, ui/card, ui/dialog, ui/input, ui/select, ui/textarea |  | 25 | 2 |  | 2 |  |  |  |  | 1 |  | 1 | 25 | 104 | 0 |
| `/dashboard/requests/new` | Create a new request. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | common/attachment-gallery-dialog, ui/button, ui/card, ui/input, ui/label, ui/searchable-client-select, ui/select |  | 3 | 5 |  |  |  | 1 | 1 |  |  | 1 | 1 | 10 | 13 | 0 |
| `/dashboard/requests` | List/search/filter all request records; bulk actions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | lists/RowCompactItem, lists/RowDetailedItem, lists/TableView, ui/PaginationControls, ui/ViewModeSelector, ui/button, ui/card, ui/input, ui/select | 3 |  | 3 | 1 | 8 |  |  |  | 8 | 1 |  |  | 18 | 82 | 16 |

### measuring requests (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/measuring-requests` | Admin queue of customer measuring-request submissions. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/PaginationControls, ui/button, ui/card, ui/input, ui/select | 1 |  | 2 |  |  |  |  |  | 8 | 1 |  | 1 | 12 | 21 | 0 |

### messages (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/messages` | Full-bleed internal team chat (conversation list + thread pane). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | — |  | 2 |  |  | 3 |  |  |  |  | 2 |  | 3 | 5 | 89 | 19 |

### calls (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/calls` | VitalPBX call history list (softphone-integrated). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/PaginationControls, ui/button, ui/card, ui/input, ui/select |  |  | 2 |  |  |  |  |  | 8 | 1 |  |  | 2 | 25 | 0 |

### email (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/email` | Company inbox/outbox + email template management, tabbed. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select, ui/tabs, ui/textarea |  |  | 4 |  |  | 1 |  |  |  | 1 |  | 2 | 25 | 40 | 0 |

### notifications (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/notifications` | Full notification history/inbox. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card |  |  |  |  |  |  |  |  |  |  | 1 |  |  | 12 | 0 |

### reports (7 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/reports/aging` | Accounts-receivable aging report. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label | 1 |  |  | 1 |  |  |  |  |  | 3 | 1 |  | 3 | 10 | 0 |
| `/dashboard/reports/customer-statement` | Per-customer statement generator. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/checkbox, ui/input, ui/label, ui/searchable-client-select | 1 |  | 1 | 2 |  |  |  |  |  |  |  |  | 4 | 19 | 0 |
| `/dashboard/reports/job-profitability` | Job cost vs. revenue profitability report. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label | 1 |  |  | 2 |  |  |  |  |  | 3 | 1 |  | 3 | 22 | 0 |
| `/dashboard/reports` | Reports hub — links out to the individual report pages. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/card |  |  |  |  |  |  |  |  |  |  |  |  |  | 6 | 0 |
| `/dashboard/reports/payments` | Payments-received report. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select | 1 | 38 | 2 | 2 |  |  |  |  | 7 |  |  |  | 7 | 20 | 0 |
| `/dashboard/reports/revenue` | Revenue report over time. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label | 1 |  |  | 2 |  |  |  |  |  | 3 | 1 |  | 3 | 12 | 2 |
| `/dashboard/reports/vendor-spend` | Spend-by-vendor report. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label | 1 |  |  | 2 |  |  |  |  |  | 3 | 1 |  | 3 | 7 | 8 |

### analytics (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/analytics` | Cross-entity analytics dashboard (tabbed charts). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/select, ui/tabs |  |  | 1 |  |  | 1 |  |  |  |  |  | 14 | 3 | 23 | 16 |

### maps (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/maps` | Map view of job sites with geocoding controls. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/checkbox, ui/input, ui/label, ui/select |  |  | 3 | 1 |  |  |  |  |  |  | 1 | 1 | 6 | 20 | 0 |

### production (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/production` | Production/shop-floor board (kanban-style) for items in fabrication. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) + inline `ResponsivePage` wrapper in the page | ui/button, ui/card, ui/input, ui/select |  |  | 4 | 1 |  |  |  |  |  | 1 |  |  | 5 | 36 | 0 |

### teams (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/teams` | Team member directory/roster management. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | lists/RowCompactItem, lists/RowDetailedItem, lists/TableView, ui/ViewModeSelector, ui/button, ui/card, ui/input, ui/label, ui/select | 3 | 19 | 4 |  | 3 |  | 2 |  |  | 1 |  | 1 | 15 | 45 | 0 |

### help (2 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/help/new` | Author a new help article. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 2 |  |  |  | 1 |  |  |  |  |  | 3 | 7 | 0 |
| `/dashboard/help` | Browse published help/knowledge-base articles. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/PaginationControls, ui/button, ui/card, ui/input, ui/select |  |  | 1 |  |  |  |  |  | 8 | 1 |  | 1 | 2 | 36 | 0 |

### audit (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/audit-logs` | Searchable/paginated log of who changed what, platform-wide. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/PaginationControls, ui/button, ui/card, ui/input, ui/select |  |  | 1 | 2 |  |  |  |  | 8 |  |  |  | 6 | 31 | 0 |

### settings (8 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard/settings/branding` | Configure logo/colors used by BrandingProvider (the CSS-var reskin surface). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label |  |  |  |  |  |  |  | 4 |  |  | 1 |  | 4 | 27 | 11 |
| `/dashboard/settings/email-integrations` | Connect/manage inbound email integrations. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select |  |  | 1 |  |  |  | 1 |  |  |  |  |  | 6 | 11 | 0 |
| `/dashboard/settings/integrations/[provider]` | Single integration's connect/config screen. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label, ui/select, ui/textarea |  |  | 1 |  |  |  |  |  |  |  | 1 |  | 32 | 61 | 0 |
| `/dashboard/settings/integrations` | List of available third-party integrations (QuickBooks, etc.). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card |  |  |  |  |  |  |  |  |  |  |  | 1 | 5 | 26 | 0 |
| `/dashboard/settings/integrations/quickbooks/import-credit-memo` | One-off QuickBooks credit-memo import flow. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label |  |  |  |  |  |  | 1 |  |  |  | 2 |  | 1 | 19 | 0 |
| `/dashboard/settings/integrations/quickbooks/import-estimate` | One-off QuickBooks estimate import flow. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label |  |  |  |  |  |  | 1 |  |  |  | 2 |  | 1 | 19 | 0 |
| `/dashboard/settings` | Company settings hub (links to sub-settings). | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/input, ui/label |  |  |  |  |  |  |  |  |  |  |  |  | 4 | 29 | 0 |
| `/dashboard/settings/roles` | Custom role / permission-matrix editor. | DashboardLayout (app/dashboard/layout.tsx: sidebar+topbar+footer shell) | ui/button, ui/card, ui/dialog, ui/input, ui/label |  | 43 |  |  | 3 |  |  |  |  | 1 | 1 |  | 11 | 18 | 0 |

### public / portal / pay / approve / uploads (10 pages)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/download` | Public marketing page for downloading the mobile field app. | PublicLayout (app/(public)/layout.tsx: simple header/footer, no sidebar) | ui/card |  |  |  |  |  |  |  |  |  |  |  |  |  | 9 | 7 |
| `/pay/invoice/[publicToken]` | Public unauthenticated invoice payment page reached via emailed pay link. | PublicLayout (app/(public)/layout.tsx: simple header/footer, no sidebar) | — |  |  |  |  |  |  |  |  |  |  |  |  |  | 19 | 2 |
| `/pay/receipt/[token]` | Public unauthenticated payment receipt view. | PublicLayout (app/(public)/layout.tsx: simple header/footer, no sidebar) | — |  |  |  |  |  |  |  |  |  |  |  |  |  | 10 | 0 |
| `/pay/return` | QuickBooks/payment-gateway return landing page after an external checkout redirect. | PublicLayout (app/(public)/layout.tsx: simple header/footer, no sidebar) | — |  |  |  |  |  |  |  |  |  |  |  |  | 1 | 15 | 0 |
| `/privacy` | Static privacy policy text. | PublicLayout (app/(public)/layout.tsx: simple header/footer, no sidebar) | ui/card |  |  |  |  |  |  |  |  |  |  |  |  |  | 10 | 1 |
| `/terms` | Static terms of service / user license text. | PublicLayout (app/(public)/layout.tsx: simple header/footer, no sidebar) | ui/card |  |  |  |  |  |  |  |  |  |  |  |  |  | 14 | 1 |
| `/approve/estimate/[token]` | Public unauthenticated estimate approval page (customer accepts/declines + optional add-ons) reached via emailed link. | ApproveLayout (app/approve/layout.tsx: bare scroll wrapper, no chrome) | ui/button, ui/card, ui/checkbox, ui/input | 2 |  |  |  | 3 |  |  |  |  |  | 1 |  | 3 | 33 | 0 |
| `/portal/estimates/[token]` | Customer-facing portal view of one estimate (token auth, no login). | none (root layout.tsx only — no sidebar/topbar) | — | 2 |  |  |  |  |  |  |  |  |  |  |  |  | 59 | 5 |
| `/portal/pay/[invoiceId]` | Customer-facing portal invoice payment page (card/ACH via QuickBooks). | none (root layout.tsx only — no sidebar/topbar) | ui/button, ui/checkbox | 1 | 1 |  |  |  |  |  |  |  |  | 1 |  | 5 | 136 | 11 |
| `/reports/payments` | Legacy/alternate top-level payments report route (outside /dashboard). | none (root layout.tsx only — no sidebar/topbar) | — |  |  |  |  |  |  |  |  |  |  |  |  |  | 0 | 0 |

### root (1 page)
| Route | Purpose | Layout | Primitives | Tbl | Dlg | Drop | Date | Swch | Tabs | Form | Upl | Pag | Srch | Load | Empty | Err | Colors | Hex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/` | Root route — redirects to /dashboard or /auth/login. | none (root layout.tsx only — no sidebar/topbar) | — |  |  |  |  |  |  |  |  |  |  |  |  |  | 0 | 0 |

**Total pages inventoried: 96**


## Task B — Component inventory (70 files under `components/`)
`exports` = named exports found; `radix` = `@radix-ui/react-*` primitive imported; `brandVar#` = uses of a `--brand-*` CSS var (the branding/reskin hook); `Colors`/`Hex` = Task D hard-coded-color counts for that file.
| File | Purpose | Exports | Radix primitive | Colors | Hex | brandVar# |
|---|---|---|---|---|---|---|
| `components/branding/BrandingProvider.tsx` | Shift each RGB channel by `delta` (positive = lighter, negative = darker). | BrandingProvider, useBranding | — | 0 | 0 | 32 |
| `components/branding/TrimProLogo.tsx` | Compact auth-page badge: lowercase trimpro + column mark on brand slate. | TrimProIcon, TrimProLoginBadge, TrimProLogo, TrimProMark | — | 0 | 3 | 0 |
| `components/branding/TrimProMark.tsx` | — | TrimProMark | — | 0 | 0 | 0 |
| `components/calls/VitalPbxSoftphone.tsx` | — | VitalPbxSoftphone | — | 6 | 0 | 0 |
| `components/charts/EmptyState.tsx` | — | EmptyState | — | 3 | 0 | 0 |
| `components/charts/WaterfallChart.tsx` | — | WaterfallChart | — | 0 | 3 | 0 |
| `components/common/attachment-gallery-dialog.tsx` | — | AttachmentGalleryDialog | — | 19 | 6 | 0 |
| `components/common/document-attachments.tsx` | — | DocumentAttachments | — | 14 | 0 | 0 |
| `components/dashboard/DashboardJobsChart.tsx` | — | DashboardJobsChart | — | 1 | 2 | 0 |
| `components/dashboard/DashboardJobsPipelineChart.tsx` | — | DashboardJobsPipelineChart | — | 2 | 6 | 0 |
| `components/dashboard/DashboardRevenueChart.tsx` | — | DashboardRevenueChart | — | 1 | 1 | 0 |
| `components/documents/document-line-items-column-header.tsx` | * Sticky header above document line-item editors with drag-resizable column widths. | DOCUMENT_LINE_WIDTH_DEFAULTS, DocumentLineItemsColumnHeader | — | 2 | 0 | 0 |
| `components/documents/line-item-drag-handle.tsx` | Must match the key used in onDrop getData (e.g. text/line-index, text/opt-line-index). | LineItemDragHandle | — | 2 | 0 | 0 |
| `components/documents/unified-documents-section.tsx` | Fallback client for payment receipt recipient picker when a row has no clientId. | UnifiedDocumentsSection | — | 97 | 2 | 0 |
| `components/email/contact-recipient-picker.tsx` | When provided, the picker fetches the client's contacts + email(s) on file. | ContactRecipientPicker | — | 10 | 0 | 0 |
| `components/estimates/customer-estimate-panel.tsx` | Used in empty-state copy ("estimate" \| "invoice") | CustomerEstimatePanel | — | 11 | 0 | 0 |
| `components/estimates/estimate-material-list.tsx` | When true, use local example rows only (no API). | EXAMPLE_MATERIAL_LINES, EstimateMaterialList | — | 4 | 0 | 0 |
| `components/integrations/SecretField.tsx` | — | SecretField | — | 4 | 0 | 0 |
| `components/items/FastPicker.tsx` | When true, show a "Tag" column in the dropdown (e.g. for purchase orders) | FastPicker | — | 20 | 0 | 0 |
| `components/items/ItemPicker.tsx` | — | ItemPicker | — | 11 | 0 | 0 |
| `components/items/RapidFireItemPicker.tsx` | — | RapidFireItemPicker | — | 14 | 0 | 0 |
| `components/jobs/JobBillingStatusBadge.tsx` | — | JobBillingStatusBadge | — | 0 | 0 | 0 |
| `components/jobs/JobStatusSelect.tsx` | — | JobStatusBadge, JobStatusSelect | — | 4 | 0 | 0 |
| `components/jobs/JobTypeCreateField.tsx` | * When true, uses invoice-specific copy in the prompt dialog. * Prompting itself always happens whenever the user has more than one type to choose. | JobTypeCreateField | — | 0 | 0 | 0 |
| `components/jobs/JobTypeSelect.tsx` | — | JobTypeBadge, JobTypeSelect | — | 2 | 0 | 0 |
| `components/layout/MobileActionBar.tsx` | * Wraps dense action button groups. On phones/tablets, sticks to the bottom with * safe-area padding so primary actions stay reachable above the Andro | MobileActionBar | — | 1 | 0 | 0 |
| `components/layout/ResponsivePage.tsx` | * Standard page wrapper: prevents accidental horizontal overflow on narrow viewports * while preserving desktop spacing. | ResponsivePage | — | 0 | 0 | 0 |
| `components/layout/ResponsiveTableContainer.tsx` | * Intentional horizontal scroll container for wide tables. * Keeps page layout from overflowing while allowing table pan on mobile. | ResponsiveTableContainer | — | 0 | 0 | 0 |
| `components/layout/dashboard-layout.tsx` | — | DashboardLayout | — | 10 | 0 | 0 |
| `components/layout/sidebar.tsx` | — | Sidebar | — | 8 | 0 | 12 |
| `components/lists/RowCompactItem.tsx` | — | RowCompactItem | — | 2 | 0 | 0 |
| `components/lists/RowDetailedItem.tsx` | — | RowDetailedItem | — | 2 | 0 | 0 |
| `components/lists/TableView.tsx` | Initial / default pixel width when resizing is enabled | TableView | — | 2 | 0 | 0 |
| `components/maps/AddressMap.tsx` | — | AddressMap, loadGoogleMapsScript | — | 3 | 0 | 0 |
| `components/maps/GoogleMapsLoader.tsx` | — | GoogleMapsLoader | — | 7 | 0 | 0 |
| `components/maps/JobSiteMap.tsx` | — | JobSiteMap | — | 1 | 0 | 0 |
| `components/maps/PlaceAutocompleteInput.tsx` | — | PlaceAutocompleteInput | — | 0 | 0 | 0 |
| `components/messages/JobThreadDialog.tsx` | * Full job chat popup: left thread list, right chat pane, sticky recipients. | JobThreadDialog | — | 5 | 19 | 0 |
| `components/messages/chat-ui.tsx` | Relative `/uploads/...` URLs need an origin for `<audio>` / `<video>` in some browsers and dev setups. | Composer, MsgBubble, QUICK_REACTIONS, attachmentPreviewLabel, dateSep, msgTimeStr, normaliseTeamMsg, replyPreviewText, resolveMessageMediaUrl | — | 49 | 33 | 0 |
| `components/navigation/DashboardNavCapture.tsx` | * Captures in-app dashboard link clicks and stamps the current page * so EntityBackButton can return to the real previous context. * Skips /edit and / | DashboardNavCapture | — | 0 | 0 | 0 |
| `components/navigation/EntityBackButton.tsx` | Used when there is no return stack / history (deep link, new tab). | EntityBackButton | — | 0 | 0 | 0 |
| `components/notes/editable-notes-list.tsx` | — | EditableNotesList | — | 15 | 0 | 0 |
| `components/notifications/NotificationBell.tsx` | — | NotificationBell | — | 35 | 3 | 0 |
| `components/permissions/CreateOnlyAccessCard.tsx` | — | CreateOnlyAccessCard | — | 3 | 0 | 0 |
| `components/permissions/PermissionButton.tsx` | * Button that is disabled/hidden based on permissions | PermissionButton | — | 0 | 0 | 0 |
| `components/permissions/PermissionGuard.tsx` | * Component that conditionally renders children based on user permissions | PermissionGuard, withPermission | — | 0 | 0 | 0 |
| `components/permissions/RoutePermissionGuard.tsx` | * Blocks direct URL access to dashboard routes when the user lacks view permission. | RoutePermissionGuard | — | 5 | 0 | 0 |
| `components/qbo/QboSyncFailureNotifier.tsx` | — | QboSyncFailureNotifier | — | 15 | 0 | 0 |
| `components/reports/EmailReportButton.tsx` | Current filter query params for the report (startDate, clientId, etc.) — sent as-is to the server. | EmailReportButton | — | 2 | 0 | 0 |
| `components/reports/ReportFilterBar.tsx` | Fires with the full selected client (email included) whenever it resolves, or null when cleared. | ReportFilterBar | — | 0 | 0 | 0 |
| `components/search/GlobalSearch.tsx` | — | GlobalSearch | — | 49 | 0 | 0 |
| `components/settings/RolePermissionModulePicker.tsx` | — | RolePermissionModulePicker | — | 41 | 0 | 0 |
| `components/tasks/TaskStatusSelect.tsx` | — | TaskStatusBadge, TaskStatusSelect | — | 4 | 0 | 0 |
| `components/ui/PaginationControls.tsx` | — | PaginationControls | — | 1 | 0 | 0 |
| `components/ui/ViewModeSelector.tsx` | — | ViewModeSelector | — | 0 | 1 | 0 |
| `components/ui/button.tsx` | — | — | slot | 0 | 0 | 0 |
| `components/ui/card.tsx` | — | — | — | 0 | 0 | 0 |
| `components/ui/checkbox.tsx` | — | — | checkbox | 0 | 0 | 0 |
| `components/ui/dialog.tsx` | — | — | dialog | 4 | 0 | 0 |
| `components/ui/dropdown-styles.ts` | Centralized dropdown/menu styling so all custom dropdowns feel consistent. | DROPDOWN_EMPTY, DROPDOWN_ITEM, DROPDOWN_LIST, DROPDOWN_PANEL, DROPDOWN_SEARCH_INPUT, DROPDOWN_SEARCH_WRAP, DROPDOWN_TRIGGER | — | 0 | 4 | 0 |
| `components/ui/input.tsx` | * Enable calculator mode: type 100+50 then Enter to commit 150. * Expressions that start with an operator (+10, -5) are left unchanged. * Uses text +  | — | — | 0 | 0 | 0 |
| `components/ui/label.tsx` | — | — | label | 0 | 0 | 0 |
| `components/ui/preserved-text.tsx` | Renders saved text exactly as typed (keeps newlines and spaces). | PreservedText | — | 0 | 0 | 0 |
| `components/ui/searchable-client-select.tsx` | — | SearchableClientSelect | — | 0 | 2 | 0 |
| `components/ui/searchable-job-select.tsx` | Optional remote search — called as the user types (debounced). | SearchableJobSelect | — | 0 | 4 | 0 |
| `components/ui/searchable-select.tsx` | — | SearchableSelect | — | 1 | 1 | 0 |
| `components/ui/select.tsx` | — | — | select | 0 | 4 | 0 |
| `components/ui/tabs.tsx` | — | — | tabs | 5 | 0 | 0 |
| `components/ui/textarea.tsx` | — | — | — | 3 | 0 | 0 |
| `components/voip/softphone.tsx` | — | Softphone | — | 6 | 0 | 0 |

### Visual API of the shadcn-style primitives (`components/ui/*`)

- **`button.tsx`** — CVA-based. Variants: `default` (bg-primary), `destructive`, `outline`
  (border+bg-background), `secondary`, `ghost`, `link`. Sizes: `default` (h-11), `sm` (h-10),
  `lg` (h-12), `icon` (h-11 w-11). All sizes force `min-h-[44px]` for touch targets.
  Colors go through the shadcn `--primary`/`--secondary`/`--destructive` HSL tokens (which
  `tailwind.config.ts` maps to `hsl(var(--...))`), so this one component *is* theme-driven —
  **except** the global CSS override in `app/globals.css` (`button[class*="bg-blue-600"]`)
  that repaints any literally-blue button to `--brand-button-color`, a second, parallel
  theming mechanism layered on top of the first.
- **`card.tsx`** — compound: `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/
  `CardFooter`. Uses `bg-card`/`text-card-foreground`/`border` tokens — theme-driven.
- **`dialog.tsx`** — Radix `Dialog`. Content is hard-coded `bg-white` (not `bg-card`/
  `bg-popover`), close button hard-coded `ring-gray-950`/`bg-gray-100`/`text-gray-500`.
  Mobile: becomes a bottom sheet (`max-sm:top-auto max-sm:bottom-0 ... rounded-b-none`).
  **Will not follow dark mode or brand background color** as written.
- **`select.tsx`** — Radix `Select`. Trigger uses tokens (`bg-background`/`border-input`),
  but `SelectItem` hover/focus/highlighted/checked states are hard-coded
  `hover:bg-[#2E4A59] hover:text-white` etc. — the brand-primary hex is baked directly into
  the primitive, bypassing `--brand-primary-color`.
- **`tabs.tsx`** — Radix `Tabs`. Hard-coded `bg-gray-100`/`text-gray-500` (list) and
  `data-[state=active]:bg-white data-[state=active]:text-gray-950` (trigger) — not
  token-driven at all.
- **`checkbox.tsx`** — Radix `Checkbox`, token-driven (`border-primary`, `bg-primary`).
- **`input.tsx`** — token-driven (`border-input`/`bg-background`/`ring`), plus a custom
  `calculator` prop (inline `100+50` → `150` on Enter) that is TrimPro-specific business
  logic embedded in a primitive.
- **`label.tsx`** — CVA wrapper around Radix `Label`, no color classes at all.
- **`textarea.tsx`** — **not token-driven**: hard-coded `border-gray-300 bg-white
  ring-offset-white focus-visible:ring-gray-950`, inconsistent with `input.tsx` right next
  to it in the same folder.
- **`searchable-select.tsx` / `searchable-client-select.tsx` / `searchable-job-select.tsx`** —
  custom combobox pattern (not Radix), all three built on the shared
  `components/ui/dropdown-styles.ts` class strings, which themselves hard-code
  `focus:ring-[#2E4A59]` and `hover:bg-[#2E4A59]` (again bypassing the brand CSS var).
- **`PaginationControls.tsx`** — thin Prev/Next wrapper around `Button variant="outline"`,
  plain text "Page X of Y". No page-size control, no jump-to-page.
- **`ViewModeSelector.tsx`** — grid/compact/detailed/table switcher, active state hard-coded
  `bg-[#2E4A59]` (third occurrence of the same un-tokenized brand hex, after `select.tsx`
  and `dropdown-styles.ts`).
- **`preserved-text.tsx`** — not visual, just `whitespace-pre-wrap` text wrapper.
### The layout shell (`components/layout/*`) — read in full

**`dashboard-layout.tsx`** (`DashboardLayout`, applied to every `/dashboard/*` route via
`app/dashboard/layout.tsx`):
- Structure: fixed-height flex row — `Sidebar` (own component) + a flex-col content pane.
- Topbar: `h-14` bar, hamburger button (mobile only, `lg:hidden`), then `GlobalSearch` filling
  the remaining width (`max-w-2xl`). **No notification bell, no avatar/user menu, no theme
  toggle in the topbar** — the notification bell lives in the sidebar header/footer instead.
- Main content: `overflow-y-auto`, padded `p-4 sm:p-6`, `bg-gray-100` (hard-coded, not a
  token) — one exception: routes under `/dashboard/messages` opt into a "full-bleed" mode
  (`FULL_BLEED_PREFIXES`) that skips the padding/footer for the chat UI's own internal
  scroll regions.
- Footer (non-full-bleed routes only): `© {year} TrimPro`, Privacy/Terms links,
  `support@trimprony.com` mailto — plain text, small, `text-xs text-muted-foreground`.
- Auth gate: reads `accessToken`/`user` straight out of `localStorage` in a `useEffect`
  and hard-redirects to `/auth/login` if missing — this happens client-side after a
  loading spinner, not via middleware.
- Wraps children in `RoutePermissionGuard` (blocks direct URL access when the user lacks
  the route's view permission).

**`sidebar.tsx`** (`Sidebar`):
- Width: `w-64` expanded, `w-16` collapsed (`transition-all duration-300`). Collapse state
  persists in `localStorage('sidebar-collapsed')`.
- Desktop: always in flow (`hidden lg:flex`). Mobile (`<lg`): full drawer overlay
  (`fixed inset-0 z-50`) with a `bg-black/50` backdrop, width `min(100vw,16rem)` /
  `max-w-[85vw]`, slides from the left, closes on backdrop click, X button, or route change.
- Colors: **entirely CSS-var driven** — `background-color: var(--brand-sidebar-color)`,
  border `var(--brand-sidebar-border-color)`, active/hover link color
  `var(--brand-menu-color)` — this is the one part of the shell that already reskins
  cleanly through `BrandingProvider`.
- Header: logo (`TrimProLogo variant="sidebar"`, swaps in the tenant's uploaded logo via
  `useBranding()`), `NotificationBell`, collapse chevron (desktop) / X (mobile).
  25-item flat nav list (Dashboard → Help), each gated by `PermissionGuard`; a nav item
  can show a red "New" badge with a hover preview populated by polling
  `/api/notifications?status=UNREAD` every 30s.
  Footer: Logout button (clears localStorage tokens, hits `/api/auth/logout`,
  hard-navigates to `/auth/login`).
- No breakpoint for tablet specifically — the only breakpoint used is Tailwind's `lg`
  (1024px): below it, drawer mode; at/above, static column.

**`MobileActionBar.tsx`** — sticky-bottom wrapper for dense action-button rows; on
`<lg` screens it becomes `sticky bottom-0`, full-bleed (`-mx-4`), translucent
(`bg-white/95 backdrop-blur-sm`), with safe-area bottom padding. No-op wrapper on desktop.

**`ResponsivePage.tsx`** — trivial wrapper (`min-w-0 max-w-full overflow-x-hidden
space-y-4 sm:space-y-6`) used inline by only 5 of the 96 pages
(estimates/invoices detail+new). Most pages don't use it and instead manage their own
top-level spacing.

**`ResponsiveTableContainer.tsx`** — horizontal-scroll wrapper (`-mx-4 overflow-x-auto
touch-pan-x`) for wide tables on mobile; used by `TableView` internally plus directly by
some pages.


## Task C — Design tokens as-is

**Files read in full:** `app/globals.css`, `tailwind.config.ts`, `app/layout.tsx`,
`components/branding/BrandingProvider.tsx`, `components/ui/dropdown-styles.ts` (plus
`app/providers.tsx`, `package.json` for `next-themes`).

### CSS variables defined in `app/globals.css`

shadcn/ui HSL triplet tokens (`:root` light value → `.dark` value; format is
`H S% L%`, consumed by Tailwind as `hsl(var(--x))`):

| Token | Light | Dark (`.dark` block exists) |
|---|---|---|
| `--background` | `0 0% 100%` | `222.2 84% 4.9%` |
| `--foreground` | `222.2 84% 4.9%` | `210 40% 98%` |
| `--card` / `--card-foreground` | `0 0% 100%` / `222.2 84% 4.9%` | `222.2 84% 4.9%` / `210 40% 98%` |
| `--popover` / `--popover-foreground` | same as card | `222.2 84% 4.9%` / `210 40% 98%` |
| `--primary` / `--primary-foreground` | `201 32% 27%` / `210 40% 98%` | `201 32% 27%` / `222.2 47.4% 11.2%` |
| `--secondary` / `--secondary-foreground` | `210 40% 96.1%` / `222.2 47.4% 11.2%` | `217.2 32.6% 17.5%` / `210 40% 98%` |
| `--muted` / `--muted-foreground` | `210 40% 96.1%` / `215.4 16.3% 46.9%` | `217.2 32.6% 17.5%` / `215 20.2% 65.1%` |
| `--accent` / `--accent-foreground` | `210 40% 96.1%` / `222.2 47.4% 11.2%` | `217.2 32.6% 17.5%` / `210 40% 98%` |
| `--destructive` / `--destructive-foreground` | `0 84.2% 60.2%` / `210 40% 98%` | `0 62.8% 30.6%` / `210 40% 98%` |
| `--border` / `--input` | `214.3 31.8% 91.4%` (both) | `217.2 32.6% 17.5%` (both) |
| `--ring` | `201 32% 27%` | `201 32% 27%` |
| `--radius` | `0.5rem` | (no dark override) |

Custom **brand tokens** (`:root` only, hex — no `.dark` overrides at all, overwritten at
runtime by `BrandingProvider` from the tenant's saved branding record):
`--brand-primary-color #2e4a59`, `--brand-secondary-color #4a7c94`,
`--brand-background-color #f3f4f6`, `--brand-sidebar-color #2E4A59`,
`--brand-sidebar-border-color #3A5C70`, `--brand-menu-color #E6C98B`,
`--brand-button-color #2e4a59`, `--brand-button-hover-color #243b47`,
`--brand-button-text-color #ffffff`, `--brand-text-primary-color #111827`,
`--brand-text-secondary-color #6b7280`, `--brand-link-color #2e4a59`,
`--brand-border-color #e5e7eb`, `--brand-success-color #16a34a`,
`--brand-warning-color #d97706`, `--brand-danger-color #dc2626`.

### Font
`next/font/google` `Inter`, loaded once in `app/layout.tsx` (`const inter = Inter({subsets:
['latin']})`), applied via `inter.className` on `<body>`. No second display/heading font;
`h1–h4` just get `color: var(--brand-primary-color)` in `globals.css`. One unused reference
to a fancier stack (`'Avenir Next, Montserrat, Poppins, Inter, ...'`) exists only inside
`TrimProLoginBadge` in `TrimProLogo.tsx`, not wired into `layout.tsx`/Tailwind theme.

### Radius / shadow
`--radius: 0.5rem`; Tailwind maps `rounded-lg/md/sm` to `var(--radius)` and
`calc(var(--radius) - 2px/4px)`. No shadow tokens defined — components use Tailwind's
stock `shadow-sm`/`shadow-md`/`shadow-lg`/`shadow-xl` utilities directly (not themed).

### Tailwind theme extension (`tailwind.config.ts`)
`darkMode: ["class"]` is configured. `theme.extend.colors` only defines the 8 shadcn
semantic colors (`border/input/ring/background/foreground/primary/secondary/destructive/
muted/accent/popover/card`), each `hsl(var(--x))` — **no brand-token colors are registered
in Tailwind** (`bg-[var(--brand-primary-color)]` arbitrary-value syntax is used ad hoc in
JSX instead of a named utility). `borderRadius` maps to `--radius`. Only plugin:
`tailwindcss-animate` (accordion keyframes). Container: centered, `2rem` padding, `2xl`
breakpoint at `1400px`.

### Dark mode wiring — ⛔ NOT actually wired up
- `darkMode: ["class"]` in Tailwind + a full `.dark { ... }` HSL block in `globals.css`
  **exist**, so the *scaffolding* from the original shadcn template is present.
- **But:** `next-themes` is a declared dependency (`package.json` `"next-themes": "^0.2.1"`)
  and is **never imported anywhere** — no `ThemeProvider`, no `useTheme`, no `<html
  className={theme}>` logic. `grep -rl "useTheme\|ThemeProvider\|next-themes"
  app components lib` returns **zero files**.
- `app/providers.tsx` only wraps children in `BrandingProvider` — nothing toggles the
  `.dark` class on `<html>` or `<body>` ever.
- `app/layout.tsx` hard-codes `<html className="h-full bg-gray-100">` /
  `<body className="... h-full bg-gray-100">` — a literal light-gray background with `!important`
  duplicated again in `globals.css` on `html`, `body`, and `#__next`.
- Confirmed by Task D: **zero** `dark:`-prefixed Tailwind classes exist anywhere in
  `app/` or `components/` (`rg -o 'dark:[a-zA-Z0-9_\[\]./%-]+'` → 0 matches, 0 files).
- **Conclusion: dark mode is present as unused CSS scaffolding only.** A reskin that must
  ship light **and** dark (per this project's `CLAUDE.md`: *"Look: reskin only, matched to
  the Loop Customer Portal, light AND dark mode"*) will need to (a) actually wire
  `next-themes` or an equivalent class-toggle, (b) replace every hard-coded `bg-gray-100`/
  `bg-white`/`text-gray-900`-style utility (Task D) with a token, and (c) add `.dark`
  overrides for the 16 brand tokens, which currently have none.


## Task D — Hard-coded color hotspots

Method: `rg -o` (ripgrep, occurrence mode, not line-count mode) across every `*.ts`/`*.tsx`
under `app/` and `components/`, for (a) the Tailwind color-utility regex
`\b(bg|text|border|ring|from|to|via|fill|stroke)-(slate|gray|zinc|neutral|stone|red|orange|
amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-
[0-9]{2,3}\b`, (b) raw hex `#[0-9a-fA-F]{3,8}\b`, (c) `dark:`-prefixed classes.

### Totals

| Metric | Count |
|---|---|
| Tailwind color-utility occurrences (`bg-gray-100`, `text-slate-500`, `border-blue-600`, ...) | **3,704** |
| Raw hex-color occurrences (`#2E4A59`, `#fff`, ...) | **286** |
| **Combined hard-coded color occurrences** | **3,990** |
| Files with at least one hit | 153 (of ~430 `.ts`/`.tsx` files under `app/`+`components/`) |
| `dark:`-prefixed Tailwind classes anywhere in `app/` or `components/` | **0** |

### Top 40 files by combined color+hex occurrence count

| # | Total | Color-class | Hex | File |
|---|---|---|---|---|
| 1 | 147 | 136 | 11 | `app/portal/pay/[invoiceId]/page.tsx` |
| 2 | 138 | 133 | 5 | `app/dashboard/clients/[id]/page.tsx` |
| 3 | 118 | 118 | 0 | `app/dashboard/estimates/new/page.tsx` |
| 4 | 117 | 117 | 0 | `app/dashboard/invoices/new/page.tsx` |
| 5 | 108 | 89 | 19 | `app/dashboard/messages/page.tsx` |
| 6 | 105 | 105 | 0 | `app/dashboard/invoices/[id]/edit/page.tsx` |
| 7 | 104 | 104 | 0 | `app/dashboard/requests/[id]/page.tsx` |
| 8 | 102 | 102 | 0 | `app/dashboard/estimates/[id]/edit/page.tsx` |
| 9 | 99 | 97 | 2 | `components/documents/unified-documents-section.tsx` |
| 10 | 98 | 82 | 16 | `app/dashboard/requests/page.tsx` |
| 11 | 89 | 89 | 0 | `app/dashboard/invoices/[id]/page.tsx` |
| 12 | 87 | 87 | 0 | `app/dashboard/estimates/[id]/page.tsx` |
| 13 | 83 | 83 | 0 | `app/dashboard/invoices/page.tsx` |
| 14 | 82 | 49 | 33 | `components/messages/chat-ui.tsx` |
| 15 | 79 | 79 | 0 | `app/dashboard/schedule/page.tsx` |
| 16 | 71 | 71 | 0 | `app/dashboard/vendors/[id]/page.tsx` |
| 17 | 68 | 68 | 0 | `app/dashboard/dispatch/page.tsx` |
| 18 | 66 | 66 | 0 | `app/dashboard/jobs/[id]/page.tsx` |
| 19 | 64 | 59 | 5 | `app/portal/estimates/[token]/page.tsx` |
| 20 | 63 | 63 | 0 | `app/dashboard/issues/page.tsx` |
| 21 | 61 | 61 | 0 | `app/dashboard/settings/integrations/[provider]/page.tsx` |
| 22 | 54 | 46 | 8 | `app/dashboard/jobs/page.tsx` |
| 23 | 52 | 52 | 0 | `app/dashboard/items/page.tsx` |
| 24 | 52 | 52 | 0 | `app/dashboard/clients/page.tsx` |
| 25 | 51 | 51 | 0 | `app/dashboard/purchase-orders/new/page.tsx` |
| 26 | 51 | 51 | 0 | `app/dashboard/purchase-orders/[id]/edit/page.tsx` |
| 27 | 51 | 51 | 0 | `app/dashboard/items/[id]/page.tsx` |
| 28 | 50 | 42 | 8 | `app/dashboard/estimates/page.tsx` |
| 29 | 49 | 49 | 0 | `components/search/GlobalSearch.tsx` |
| 30 | 46 | 46 | 0 | `app/dashboard/purchase-orders/[id]/page.tsx` |
| 31 | 45 | 45 | 0 | `app/dashboard/teams/page.tsx` |
| 32 | 41 | 41 | 0 | `components/settings/RolePermissionModulePicker.tsx` |
| 33 | 40 | 40 | 0 | `app/dashboard/email/page.tsx` |
| 34 | 39 | 23 | 16 | `app/dashboard/analytics/page.tsx` |
| 35 | 38 | 35 | 3 | `components/notifications/NotificationBell.tsx` |
| 36 | 38 | 27 | 11 | `app/dashboard/settings/branding/page.tsx` |
| 37 | 37 | 37 | 0 | `app/dashboard/issues/[id]/page.tsx` |
| 38 | 36 | 36 | 0 | `app/dashboard/tasks/page.tsx` |
| 39 | 36 | 36 | 0 | `app/dashboard/production/page.tsx` |
| 40 | 36 | 36 | 0 | `app/dashboard/help/page.tsx` |

### Reading the hotspot list
- The single biggest offender is a **public, unauthenticated customer-facing page**
  (`app/portal/pay/[invoiceId]/page.tsx`, 147 hits — 136 color classes + 11 raw hex) — this
  is one of the few screens a Loopcom customer's *own customer* will ever see, so it's a
  high-value early reskin target independent of its raw count.
- The `[id]/edit` and `new` pages for **estimates / invoices / purchase orders** cluster at
  the top (100–120 hits each) because they share a near-identical hand-rolled line-item
  editor pattern (28–34 `<Switch>`-style toggle rows in some of them) that was
  copy-pasted per entity rather than extracted into a shared component — a reskin will
  either have to touch 6+ near-duplicate files or take this as a forcing function to
  finally extract the shared editor.
- `components/messages/chat-ui.tsx` (82: 49 color + **33 raw hex**, the highest hex count
  in the repo) and `components/documents/unified-documents-section.tsx` (99, almost all
  color classes) are the two `components/` files most worth tokenizing first, since fixing
  them once fixes every page that imports them.
- `dark:` being exactly **zero** everywhere means none of this is "just missing the dark
  variant" — every one of these ~4,000 occurrences is a decision point for the reskin
  (map to a token, or leave and add a `dark:` sibling).


## Task E — Microcopy samples (not rewritten, collected only)

Collected via targeted greps for `alert(`/`confirm(`, empty-state strings, error text,
and `Loading...` literals across `app/`. Not exhaustive — a representative 40+.

### Native `alert()` / `confirm()` dialogs used as UI (no toast/dialog component)
The app has a Radix `Dialog` component (`components/ui/dialog.tsx`) but dozens of flows
fall back to the browser's own unstyled `alert()`/`confirm()` popups instead — these will
look jarring against any reskinned UI since they cannot be themed at all.

| Path:line | String |
|---|---|
| `app/dashboard/vendors/[id]/page.tsx:157` | `Are you sure you want to delete "${vendor.name}"? This action cannot be undone.` |
| `app/dashboard/vendors/[id]/page.tsx:178` | `Failed to delete vendor` |
| `app/dashboard/jobs/[id]/page.tsx:427` | `Note is required for manual entries` |
| `app/dashboard/jobs/[id]/page.tsx:434` | `Invalid duration` |
| `app/dashboard/jobs/[id]/page.tsx:469` | `Edit reason is required` |
| `app/dashboard/jobs/[id]/page.tsx:507` | `Delete reason is required` |
| `app/dashboard/purchase-orders/[id]/page.tsx:196` | `Please enter at least one email address` |
| `app/dashboard/purchase-orders/[id]/page.tsx:218` | `Purchase order sent successfully` |
| `app/dashboard/purchase-orders/[id]/page.tsx:372` | `Popup blocked. Please allow popups to print.` |
| `app/dashboard/purchase-orders/[id]/edit/page.tsx:219` | `Purchase order not found` |
| `app/dashboard/purchase-orders/[id]/edit/page.tsx:620` | `Please select a vendor` |
| `app/dashboard/jobs/page.tsx:270` | `Duplicate ${selectedIds.length} selected job(s)?` |
| `app/dashboard/vendors/page.tsx:201` | `Import complete: ${data.imported} imported, ${data.skipped} skipped, ${data.errors} errors` |
| `app/dashboard/vendors/page.tsx:214` | `Import all vendors from QuickBooks? Existing vendors matched by QuickBooks ID or name will be updated.` |
| `app/auth/set-password/page.tsx:63` | `Password set successfully! Please log in with your new password.` |
| `app/dashboard/tasks/[id]/page.tsx:171` | `Delete task "${task.title}"? This cannot be undone.` |
| `app/dashboard/messages/page.tsx:291` | `Delete this message for everyone?` |
| `app/dashboard/vendors/new/page.tsx:136` | `Vendor created but invalid response received` |
| `app/dashboard/vendors/[id]/edit/page.tsx:224` | `Failed to update vendor. Check console for details.` |
| `app/dashboard/measuring-requests/page.tsx:116` | `You do not have permission to view measuring requests.` |
| `app/dashboard/jobs/new/page.tsx:148` | `Please select a real job site address from the suggestions.` |
| `app/dashboard/jobs/new/page.tsx:206` | `Job created but unable to redirect. Please refresh the page.` |
| `app/dashboard/maps/page.tsx:354` | `Geocoded ${result.successCount} addresses successfully.` |
| `app/portal/pay/[invoiceId]/page.tsx:409` | `You selected ${achLinks.length} invoice(s) to pay by ACH:\n... Click OK to proceed.` (multi-line `confirm()` on the customer-facing payment page) |

### Empty states (all bare text, no illustration/icon component, wording inconsistent — "found" vs "yet" vs no article)
| Path:line | String |
|---|---|
| `app/dashboard/vendors/page.tsx:339` | `No vendors found` |
| `app/dashboard/jobs/[id]/page.tsx:1266` | `No time entries yet.` |
| `app/dashboard/jobs/[id]/page.tsx:1630` | `No unattached invoices found for this client.` |
| `app/dashboard/messages/page.tsx:563` | `No conversations yet` |
| `app/dashboard/messages/page.tsx:716` | `No messages yet. Say hello!` (only empty state with a friendly tone — rest are terse) |
| `app/dashboard/messages/page.tsx:817` | `No users found` |
| `app/dashboard/schedule/page.tsx:1066` | `No unscheduled jobs found.` |
| `app/dashboard/settings/email-integrations/page.tsx:314` | `No email integrations configured yet.` |
| `app/dashboard/settings/integrations/page.tsx:170` | `No integrations found. Please refresh the page.` (tells the user to refresh instead of the page just refetching) |
| `app/dashboard/email/page.tsx:606` | `No email templates yet` |
| `app/dashboard/email/page.tsx:711` | `No emails found` |
| `app/dashboard/dispatch/page.tsx:664` | `No live events yet.` |
| `app/dashboard/estimates/[id]/edit/page.tsx:1806` | `No optional items yet.` |
| `app/dashboard/clients/[id]/page.tsx:1481` | `No jobs yet` |
| `app/dashboard/help/page.tsx:204` | `No articles found` |
| `app/dashboard/teams/page.tsx:593` | `No team members found` |

### Errors / loading (bare strings, no shared `ErrorState`/`Skeleton` component)
| Path:line | String |
|---|---|
| `app/dashboard/page.tsx:173` | `Failed to load dashboard data` |
| `app/dashboard/error.tsx:22` | `Something went wrong` (the one App-Router `error.tsx` boundary found) |
| `app/dashboard/clients/[id]/page.tsx:570` | `<p style="padding:20px;color:red">Failed to generate statement.</p>` (raw inline-styled HTML string, red text hard-coded, injected via `dangerouslySetInnerHTML`-style path) |
| `app/api/public/clients/[id]/statement/route.ts:192` | `No open invoices found. This account is fully paid.` (server-rendered HTML with `color:#6b7280` inline) |
| 13 distinct files | Bare `Loading...` text node (no spinner/skeleton component) — e.g. `app/dashboard/settings/roles/page.tsx:219`, `app/dashboard/credit-memos/[id]/page.tsx:407`, `app/dashboard/notifications/page.tsx:90`, `app/auth/login/page.tsx:209`, `app/dashboard/maps/page.tsx:518` |

### Observations (collection only, not a rewrite)
- Tone is inconsistent: some empty states end in a period, some don't; "found" vs "yet" vs
  no qualifier are used interchangeably for the same underlying condition (nothing exists
  yet vs. a filter matched nothing).
- Destructive actions are gated by the browser's native `confirm()` (unstyled, cannot be
  reskinned) rather than the app's own `Dialog` component, including on the **customer-facing**
  ACH payment page.
- Several error messages surface implementation detail to the user ("Check console for
  details", "Please refresh the page") instead of the app recovering or retrying itself.
- `Loading...` is a plain text node in 13+ places with no shared skeleton/spinner
  component, so the reskin has no single choke point to swap in a themed loading state.


## Out of scope, noticed

- This repo's own `CLAUDE.md` ("THE GATE") requires reading/updating
  `docs/ai-context/claude-md-sections/` + a handoff + `MEMORY.md` + a HANDOFF INDEX line at
  the start/end of every task, and ends with commit → push → deploy. This audit's own task
  instructions were explicit and narrower — read-only, single report file, no repo edits —
  so none of that gate was performed; flagging the conflict rather than silently resolving
  it either way.
- `app/dashboard/layout.tsx` sets `export const dynamic = 'force-dynamic'` /
  `revalidate = 0` / `fetchCache = 'force-no-store'` on the entire dashboard route group —
  a performance/caching characteristic, not a visual one, noticed while reading the layout
  file for Task B.
- `components/ui/input.tsx` embeds a TrimPro-specific `calculator` prop (arithmetic-on-Enter)
  directly inside a generic form primitive — a coupling/architecture concern, not a color
  one.
- Several `alert()`/`confirm()` calls contain business logic in their copy (e.g. QuickBooks
  import semantics) that a reskin must preserve verbatim if native dialogs are ever replaced
  with the themed `Dialog` — a behavior-preservation risk for a *future* task, not this one.
- `app/globals.css` has a `/* Emergency fix: Remove stuck dialog overlays */` block
  papering over a Radix dialog-overlay bug with `!important` — a functional bug, not a
  design-token issue.
- Two full-file diffs elsewhere in `git status` for this repo were visible in the ambient
  session context but were not opened or touched — out of scope for this read-only visual
  audit.


