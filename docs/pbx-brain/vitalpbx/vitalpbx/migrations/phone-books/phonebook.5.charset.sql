use `ombutel`;

alter table ombu_phone_books
 convert to character set utf8 collate utf8_unicode_ci;

alter table ombu_phone_book_contacts
    convert to character set utf8 collate utf8_unicode_ci;

alter table ombu_phone_book_external_contacts
    convert to character set utf8 collate utf8_unicode_ci;