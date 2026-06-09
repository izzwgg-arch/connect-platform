use astboard;

delete from menu where label = 'menu.pbx';

delete from module_controllers where controller = 'pbx';

drop table pbx;