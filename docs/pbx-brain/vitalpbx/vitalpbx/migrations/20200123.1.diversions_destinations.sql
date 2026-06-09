use `ombutel`;

alter table `ombu_extension_diversions`
  add column `destination_id` int unsigned null default null after `destination`,
  add foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null;