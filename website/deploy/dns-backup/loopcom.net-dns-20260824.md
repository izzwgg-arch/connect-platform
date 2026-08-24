# loopcom.net DNS — full state BEFORE the website cutover
Captured 2026-08-24 from Squarespace DNS Settings (authoritative NS: nsc1-4.squarespacedns.com)

## Squarespace Defaults  (preset group — these are what the cutover replaces)
| TYPE  | NAME | TTL  | DATA |
|-------|------|------|------|
| A     | @    | 4hrs | 198.185.159.144 |
| A     | @    | 4hrs | 198.49.23.145   |
| A     | @    | 4hrs | 198.185.159.145 |
| A     | @    | 4hrs | 198.49.23.144   |
| CNAME | www  | 4hrs | ext-sq.squarespace.com |
| HTTPS | @    | 4hrs | 1 . alpn="h2,http/1.1" ipv4hint="198.185.159.144,198.185.159.145,198.49.23.144,198.49.23.145" |

## Squarespace Domain Connect
| CNAME | _domainconnect | 1hr | _domainconnect.domains.squarespace.com |

## Domain Connect to Google
| TXT | @ | 4hrs | google-site-verification=6m4b8CoTYSlcmArdTtG8_4bx54wYs6TOIg35H92SDnI |

## Google Workspace  — DO NOT TOUCH
| MX | @ | 1  | 4hrs | aspmx.l.google.com      |
| MX | @ | 5  | 4hrs | alt1.aspmx.l.google.com |
| MX | @ | 5  | 4hrs | alt2.aspmx.l.google.com |
| MX | @ | 10 | 4hrs | alt3.aspmx.l.google.com |
| MX | @ | 10 | 4hrs | alt4.aspmx.l.google.com |

## Custom records — DO NOT TOUCH (live production)
| A   | sip               | 4hrs | 45.14.194.179   | Connect SIP over 443 |
| A   | app               | 4hrs | 45.14.194.179   | Connect customer portal |
| A   | turn              | 4hrs | 169.58.213.204  | LiveKit TURN |
| TXT | @                 | 4hrs | v=spf1 include:_spf.google.com ~all |
| TXT | _dmarc            | 4hrs | v=DMARC1; p=none; rua=mailto:support@connectcomunications.com |
| TXT | google._domainkey | 4hrs | v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0U/Sku5PB3oTU2BHOqa2sDgE+SpEi0dKFUN+d/tXMBRWQywZVTx5oXHT85EyL3bRICALV37opIUe8hZCTutdtxKzOyh3m5oA1phCa+MKqhbIJwXAbyt4mOkonPPaLeOL/cpwZt+uXuFgp/Z8w+TNQzoyEg54lM+vXsICx6kask97qiyQ6KqWWxoupryZwek0JAeeDpr1SIw16h4njyPuE8OR9ozTzR3+URQIP9Dc00HQQDGl8fg9gTJDHW3st3qwgp0uDMuZ8itzJV1TKUHG6YuzLTWr45K941xhzq+HhlbNqHhfTeYIWtZ30nVbjZhRUE9j5KNJtqNlB8/YpYlVGwIDAQAB |

## The cutover
CHANGE ONLY:  A @ (x4) and CNAME www  ->  31.220.77.60
REMOVE ALSO:  HTTPS @  (its ipv4hint pins Squarespace IPs; browsers honour it
              and would keep reaching Squarespace even after the A records move)

## Rollback
Re-point the domain at the Squarespace site (Website tab), or recreate:
  A @ -> the four Squarespace IPs above
  CNAME www -> ext-sq.squarespace.com
  HTTPS @ -> as recorded above
