use `ombutel`;

alter table `ombu_phone_books`
  add column `prefix` varchar(255) null default null after `source_type`;