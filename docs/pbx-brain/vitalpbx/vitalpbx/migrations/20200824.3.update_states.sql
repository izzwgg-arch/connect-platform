use `ombutel`;

select `id` into @usa from `countries` where `iso3` = 'USA';

delete from `states` where `state` in ('Byram', 'Cokato', 'Lowa', 'Medfield', 'New Jersy', 'Ramey', 'Sublimity', 'Trimble') and `country_id` = @usa;

insert into `states` (`country_id`, `state`, `abbreviation`) values
 (@usa, 'Federated States of Micronesia', 'FM'),
 (@usa, 'Puerto Rico', 'PR');
