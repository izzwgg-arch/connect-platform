use `ombutel`;

alter table `ombu_phone_books`
    add column `source_type` enum('internal', 'external') not null default 'internal' after `description`;

create table `ombu_phone_book_external_contacts`(
  `phone_book_id` int unsigned not null,
  `first_name` varchar(255) not null,
  `last_name` varchar(255) null default null,
  `phone` varchar(255) not null,
  `organization` varchar(255) null default null,
  `job_title` varchar(255) null default null,
  `email` varchar(255) null default null,
  foreign key (`phone_book_id`) references `ombu_phone_books` (`id`) on delete cascade
);