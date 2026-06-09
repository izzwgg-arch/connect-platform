use ombutel;

update `ombu_menu` set icon = 'fa-regular fa-phone-plus' where label = 'menu.provisioning' and parent_id is not null;
