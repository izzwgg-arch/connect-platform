use `ombutel`;

alter table ombu_users
  add column `dark_mode` enum('yes','no') not null default 'no' after `theme`;