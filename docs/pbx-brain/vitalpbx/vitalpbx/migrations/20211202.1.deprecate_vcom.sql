use `ombutel`;

/* Delete Menu */
delete
from `ombu_menu`
where `label` in
      (  'menu.scom_softkey_profiles',
         'menu.scom_pause_profiles',
         'menu.vcom_call_result_profiles',
         'menu.vcom_campaigns',
         'menu.scom'
      );

/* Delete Module */
delete from `ombu_modules` where `name` in (
    'scom_softkey_profiles',
    'scom_pause_profiles',
    'vcom_call_result_profiles',
    'vcom_campaigns'
);

/* Drop Tables*/
drop table if exists
    `ombu_scom_pause_profiles`,
    `ombu_scom_softkey_profile_items`,
    `ombu_scom_softkey_profiles`,
    `vcom_campaign_contact_params`,
    `vcom_campaign_contacts`,
    `vcom_campaign_list_headers`,
    `vcom_campaigns`,
    `vcom_campaigns_results`,
    `vcom_campaigns_result_profiles`,
    `vcom_campaigns_result_types`;