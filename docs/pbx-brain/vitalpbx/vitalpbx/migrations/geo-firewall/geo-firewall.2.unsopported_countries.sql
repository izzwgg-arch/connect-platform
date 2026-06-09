use `ombutel`;

delete from `ombu_geo_firewall`
where `iso` not in  ('bd','be','bf','bg','ba','bn','bo','jp','bi','bj','bt','jm','bw','br','bs','by','bz','ru','rw','rs',
                     'tl','tm','tj','ro','gw','gt','gr','gq','gy','ge','gb','ga','gn','gm','gl','gh','om','tn','jo','hr',
                     'ht','hu','hn','pr','ps','pt','py','pa','pg','pe','pk','ph','pl','zm','eh','ee','eg','za','ec','it',
                     'vn','sb','et','so','zw','es','er','me','md','mg','ma','uz','mm','ml','mn','mk','mw','mr','ug','my',
                     'mx','il','fr','xs','fi','fj','fk','ni','nl','no','na','vu','nc','ne','ng','nz','np','xk','ci','ch',
                     'co','cn','cm','cl','xc','ca','cg','cf','cd','cz','cy','cr','cu','sz','sy','kg','ke','ss','sr','kh',
                     'sv','sk','kr','si','kp','kw','sn','sl','kz','sa','se','sd','do','dj','dk','de','ye','dz','us','uy',
                     'lb','la','tw','tt','tr','lk','lv','lt','lu','lr','ls','th','tf','tg','td','ly','ae','ve','af','iq',
                     'is','ir','am','al','ao','ar','au','at','in','tz','az','ie','id','ua','qa','mz');