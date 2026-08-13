-- A customer can withdraw their own still-pending requests to the owner
-- (agent tool cancel_my_requests). Additive enum value only; the dispatcher
-- sweeps QUEUED/FAILED and so never touches a CANCELLED row.
ALTER TYPE "AgentEscalationStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
