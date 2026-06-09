use `ombutel`;

alter table ombu_sessions
 add column `csfr_token` binary(20) null default null after `user_id`;

/* Logout Users */
delete from ombu_sessions where user_id is not null;