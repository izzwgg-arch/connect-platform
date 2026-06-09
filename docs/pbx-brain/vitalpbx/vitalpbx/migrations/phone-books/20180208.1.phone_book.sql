use `ombutel`;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`) values
  ('phone_books', 'no', 'yes', 'no');

set @module_id = last_insert_id();

insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
  select `role_id`,
    @module_id,
    'yes',
    'yes',
    'yes',
    'yes'
  from `ombu_roles`
  where `role` = 'super_administrator';

insert into `ombutel`.`ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
  select
    'menu.phone_books',
    `menu_id`,
    @module_id,
    6
  from `ombutel`.`ombu_menu`
  where `label` = 'menu.tools';

create table `ombu_phone_books` (
  `id` int unsigned not null auto_increment,
  `description` varchar(255) not null,
  primary key (`id`)
);

create table `ombu_phone_book_contacts` (
  `phone_book_id` int unsigned not null,
  `module_id` int unsigned not null,
  `contact_id` int unsigned not null,
  foreign key (`phone_book_id`) references `ombu_phone_books` (`id`) on delete cascade,
  foreign key (`module_id`) references `ombu_modules` (`module_id`) on delete cascade,
  unique (`phone_book_id`, `module_id`, `contact_id`)
);



