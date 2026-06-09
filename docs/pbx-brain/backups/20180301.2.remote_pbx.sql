alter table `astboard`.`pbx`
  add column `remote_host` enum('yes','no') not null default 'no' after `db_pass`,
  add column `host` varchar(255) not null default '127.0.0.1' after `remote_host`,
  add column `host_protocol` enum('http','https') not null default 'http' after `host`,
  add column `api_key` varchar(255) null default null after `host_protocol`,
  add column `ami_user` varchar(255) not null default 'astboard' after `api_key`,
  add column `ami_password` varchar(255) not null default 'astboard' after `ami_user`,
  add column `ami_port` int unsigned not null default 5038 after `ami_password`;