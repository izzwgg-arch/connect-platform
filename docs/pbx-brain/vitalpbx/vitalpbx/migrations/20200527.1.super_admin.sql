use `ombutel`;

alter table `ombu_users`
 add column `super_admin` enum('yes', 'no') not null default 'no',
 add column `visible_by_others` enum('yes', 'no') not null default 'yes';

update `ombu_users` as u
inner join `ombu_roles` as r on u.role_id = r.role_id
set u.super_admin = r.superadmin, u.visible_by_others = 'no'
where r.superadmin = 'yes';

update `ombu_users` set `visible_by_others` = 'no' where `tenant_admin` = 'yes';

alter table ombu_roles
 drop column `superadmin`;