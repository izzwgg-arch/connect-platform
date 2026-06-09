use `ombutel`;

insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`, `icon`)
select
    'menu.multi_tenant',
    `menu_id`,
    null,
    2,
    'fa-sharp fa-solid fa-buildings'
from `ombu_menu`
where `label` = 'menu.admin' and `parent_id` is null;

set @parent_menu_id = last_insert_id();

update `ombu_menu` set `parent_id` = @parent_menu_id, `sort` = 1 where `label` = 'menu.tenants' and `parent_id` is not null;