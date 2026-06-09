use `ombutel`;

/**
  Additional fields for dialer compatibility
 */
alter table `ombu_queues`
 add column if not exists `direction` varchar(255) not null default 'inbound' comment 'Allow defining the queues call direction' after `prefix`,
 add column if not exists `dial_mode` varchar(255) null default null comment 'For outbound queues' after `direction`;