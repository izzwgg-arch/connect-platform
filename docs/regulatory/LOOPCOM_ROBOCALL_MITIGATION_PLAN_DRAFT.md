# LoopCom, LLC — Robocall Mitigation Plan

**DRAFT for Izzy's review — not yet filed.** To be submitted with LoopCom's Robocall
Mitigation Database (RMD) registration once the USAC 499 Filer ID is issued.

| | |
|---|---|
| Company | LoopCom, LLC (d/b/a Loopcom) |
| FCC Registration Number (FRN) | 0038803722 |
| FCC Form 499 Filer ID | *(pending — USAC registration in review)* |
| Business address | 33 NY-17M, Suite C, Harriman, NY 10926 |
| Robocall mitigation contact | Israel Weinstock, CEO — izzy@loopcom.net — (562) 209-6644 |
| Provider type | Interconnected VoIP provider (voice service provider; no facilities-based PSTN interconnection of its own) |

## 1. Who we are and how calls reach the phone network

LoopCom provides business phone service (interconnected VoIP) to small and
mid-size businesses in the United States. Customers place and receive calls
through LoopCom's hosted platform; calls reach the public switched telephone
network exclusively through LoopCom's underlying wholesale carriers. LoopCom
does not sell wholesale termination, does not serve other carriers or call
centers as traffic aggregators, and does not offer high-volume outbound
dialing, autodialing, or telemarketing campaign services.

## 2. STIR/SHAKEN status

LoopCom does not originate traffic directly onto the PSTN under its own
Operating Company Number. All outbound calls are handed to underlying
wholesale carriers, which apply STIR/SHAKEN attestation to calls they
originate for LoopCom's customers. LoopCom's role under this plan is to
ensure the traffic it hands upstream is lawful, attributable to a known
customer, and carries only caller ID the customer is entitled to use.

## 3. Know-your-customer (KYC) controls

- Every customer is a identified business that completes a sign-up including
  legal/business name, contact identity, service address, and payment by
  verifiable means (payment card). Service is provisioned only after payment.
- Each line/extension is associated with a named user within the customer's
  organization, and each customer's E911 service address is validated and
  registered with the carrier at provisioning time.
- LoopCom does not accept anonymous sign-ups and does not provision service
  to customers whose identity cannot be established.

## 4. Caller ID controls

- Outbound caller ID is provisioned by LoopCom, not chosen freely by the
  customer at call time. Customers present numbers assigned to their account
  or numbers they demonstrably control that LoopCom has provisioned for them.
- Customers have no self-service mechanism to spoof arbitrary caller ID.

## 5. Traffic monitoring and abuse prevention

- Outbound messaging is subject to per-customer daily caps and a campaign
  approval process; anomalous volume requires manual review.
- Platform monitoring watches for toll-fraud patterns and anomalous calling
  behavior (including automated monitoring with alerts to management), and
  every administrative and provisioning action is recorded in audit logs.
- LoopCom's platform can suspend an individual customer's outbound service
  promptly without affecting other customers, and this capability is used
  when abuse is identified.
- LoopCom's customer base is small businesses using ordinary business
  calling; the platform is not marketed to, or suitable for, mass outbound
  calling operations.

## 6. Cooperation with traceback and enforcement

- LoopCom will respond to traceback requests from the Industry Traceback
  Group, the FCC, or law enforcement within 24 hours of receipt, using the
  contact listed above.
- Because every call is attributable to an identified, paying business
  customer, LoopCom can identify the source of any call it carried.

## 7. Enforcement against violators

- Customers agree not to use the service for unlawful calling, including
  illegal robocalls and unlawful spoofing.
- On discovery of illegal robocalling or spoofing, LoopCom will suspend the
  offending customer's outbound service immediately, investigate, and
  terminate service where the violation is confirmed. LoopCom will not
  knowingly serve any customer engaged in illegal calling campaigns.

## 8. Commitment

LoopCom certifies that it is committed to preventing the origination of
illegal robocall traffic on its network, will cooperate fully with the FCC
and traceback efforts, and will maintain and update the practices described
in this plan as its network and the governing rules evolve.

---
*Prepared 2026-08-20. Review before filing: (a) confirm the description of
upstream carrier signing is current; (b) confirm the contact phone/email;
(c) insert the 499 Filer ID when issued.*
