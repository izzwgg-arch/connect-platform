use `asterisk`;

alter table `cdr`
 add column if not exists `cloud_path` text null default  null after `recfile`;