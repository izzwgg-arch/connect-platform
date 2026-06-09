use `asterisk`;

CREATE INDEX IF NOT EXISTS cdr_linkedid_disposition_uniqueid ON cdr (linkedid, disposition, uniqueid);
CREATE INDEX IF NOT EXISTS cdr_tenant_source_uniqueid ON cdr (tenant, source, uniqueid);
CREATE INDEX IF NOT EXISTS cdr_tenant_destination_uniqueid ON cdr (tenant, destination, uniqueid);
CREATE INDEX IF NOT EXISTS cq_results_query_index ON ombutel.ombu_cdr_query_results (cdr_query_id, `index`, cdr_id);