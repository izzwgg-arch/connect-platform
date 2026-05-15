# Deploy queue noop (portal subtree)

Deliberately under `apps/portal/` so `deploy_common_needs_rebuild` observes a portal-relevant
path change without altering runtime behaviour. Safe to delete after blue/green proof.
