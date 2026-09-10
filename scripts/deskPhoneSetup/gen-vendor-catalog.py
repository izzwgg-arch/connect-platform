"""Generate packages/shared/src/deskPhoneSetup/vendorCatalog.generated.ts from the PBX's own
provisioning database.

Inputs (./data — read-only dumps of the live VitalPBX taken 2026-09-10):
  pbx-provisioning-truth.txt  the '=== BRAND,MODEL dump' section: brand,model,phone_models.id,
                              plus the per-brand `provisioning_path` template lines
  pbx-brand-macs.csv          brand,id,oui,brand_id  (provisioning.brand_macs)
  pbx-template-provpath.txt   brand_dir|model_dir|writes_provisioning_path|template_bytes

Nothing here is typed by hand except TEMPLATE_KEY, which is transcribed from the
`provisioning_path` lines at the top of pbx-provisioning-truth.txt.

Run:  python scripts/deskPhoneSetup/gen-vendor-catalog.py
"""

import csv
import hashlib
import io
import json
import os
import re
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, "packages", "shared", "src", "deskPhoneSetup", "vendorCatalog.generated.ts")

# brand display name -> (slug, provisioning.brands.id). Read 2026-09-10.
BRANDS = {
    "Yealink": ("yealink", 6),
    "Grandstream": ("grandstream", 1),
    "Polycom": ("polycom", 4),
    "Flying Voice": ("flyingvoice", 8),
    "Fanvil": ("fanvil", 2),
    "Atcom": ("atcom", 11),
    "Snom": ("snom", 5),
    "Aastra-Mitel": ("mitel", 13),
    "Sangoma": ("sangoma", 18),
    "Vtech": ("vtech", 7),
    "Alcatel-Lucent": ("alcatel", 9),
    "Dinstar": ("dinstar", 14),
    "Gigaset": ("gigaset", 20),
    "Htek": ("htek", 3),
    "Cisco": ("cisco", 15),
    "Attimo": ("attimo", 19),
    "ClearlyIP": ("clearlyip", 10),
    "LVSwitches": ("lvswitches", 12),
    "Nurivoice": ("nurivoice", 16),
    "Hanyang Digitech": ("hanyang", 17),
}

# The line each brand's base template.cfg uses to point the phone back at its folder
# (`{{ $settings['provisioning_path'] }}`), transcribed from the dump. null = no template of
# that brand carries the key at all (Aastra-Mitel is pointed by DHCP or at the handset).
TEMPLATE_KEY = {
    "yealink": "static.auto_provision.server.url",
    "grandstream": "P237 (FirmwareUpGrade_ConfigServerPath) / provisioning.config.serverPath",
    "polycom": "device.prov.serverName",
    "flyingvoice": "auto_provision.server.url",
    "fanvil": "ap.FlashServerIP / Flash Server IP",
    "atcom": "auto_provision.server.url",
    "snom": "setting_server",
    "mitel": None,
    "sangoma": "P237 (S-series, Htek dialect) / config_server_url (P-series)",
    "vtech": "provisioning.server_address / provisioning_settings.cfg.URL",
    "alcatel": "DeviceProvisionServerUrl / LocalEnetcfgDmUrl / FlashServerIP",
    "dinstar": "Config.Autoprovision.GENERAL.Url",
    "gigaset": "Provisioning.global.ProvisioningServer / setting_server",
    "htek": "P237 (FirmwareUpGrade_ConfigServerPath)",
    "cisco": "Profile_Rule",
    "attimo": "Flash Server IP (Fanvil dialect)",
    "clearlyip": "P237 (FirmwareUpGrade_ConfigServerPath)",
    "lvswitches": "auto_provision.server_url",
    "nurivoice": "pvserverip",
    "hanyang": "pvserverip",
}

NL = chr(10)


def norm_key(model):
    return re.sub(r"[^A-Z0-9]", "", model.upper())


def read_models():
    path = os.path.join(DATA, "pbx-provisioning-truth.txt")
    text = io.open(path, encoding="utf-8", errors="replace").read()
    section = text.split("=== BRAND,MODEL dump (427 rows) ===", 1)[1].strip().splitlines()
    models = defaultdict(list)
    seen = set()
    for line in section:
        line = line.strip()
        if not line or line.count(",") < 2:
            continue
        brand, model, mid = line.rsplit(",", 2)
        mid = int(mid)
        assert mid not in seen, "duplicate phone_models.id %d" % mid
        seen.add(mid)
        slug = BRANDS[brand][0]
        models[slug].append(
            {
                "model": model,
                "key": norm_key(model),
                "pbxModelId": mid,
                "brandDir": brand.strip().lower(),
            }
        )
    total = sum(len(v) for v in models.values())
    assert total == 427, total
    assert set(models) == set(s for s, _ in BRANDS.values()), "brand set mismatch"
    return models, total


def read_ouis():
    # provisioning.brand_macs stores the prefix in MIXED formats: most rows are bare 6-hex
    # (000B82), rows added later carry colons (EC:74:D7), and two ClearlyIP rows are IEEE
    # MA-M / MA-S assignments 7 and 9 hex digits long (200A0D3, 70B3D59B0). Normalise to
    # lowercase hex with no separators; a MAC is matched by PREFIX, so the longer MA-M/MA-S
    # entries work unchanged.
    ouis = defaultdict(set)
    kept = 0
    with io.open(os.path.join(DATA, "pbx-brand-macs.csv"), encoding="utf-8", errors="replace") as f:
        for row in csv.reader(f):
            if len(row) < 4:
                continue  # the header line is space-separated and parses as one field
            prefix = re.sub(r"[^0-9A-Fa-f]", "", row[2] or "").lower()
            assert 6 <= len(prefix) <= 9, "unusable OUI prefix %r" % (row,)
            ouis[BRANDS[row[0]][0]].add(prefix)
            kept += 1
    assert kept == 1143, kept
    return ouis, kept


# provisioning.phone_models rows with no base_templates/<brand>/<model>/ directory on the PBX.
# The PBX cannot render a settings file for these at all. Listed here so a regeneration that
# silently loses more templates fails loudly instead of quietly widening the gap.
KNOWN_TEMPLATE_GAPS = {("gigaset", "p820 ip pro")}

# base_templates directories with no matching phone_models row - unreachable from the database
# side, so no device can ever be pointed at them. Recorded for the same reason.
KNOWN_ORPHAN_TEMPLATES = {("atcom", "a20")}


def read_templates():
    # Every model directory was stat'd and grepped on the PBX the same day. Three separate facts,
    # and they must not be conflated:
    #   * the template EXISTS -> the PBX can render a settings file for that model at all
    #   * the template is NON-EMPTY
    #   * the template WRITES provisioning_path -> the rendered file also tells the phone to keep
    #     coming back to the tenant folder. 67 of the 426 that exist do not; those are pointed
    #     once by another mechanism and remember it.
    provpath = {}
    with io.open(os.path.join(DATA, "pbx-template-provpath.txt"), encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            bdir, mdir, flag, size = line.split("|")
            key = (bdir.strip().lower(), mdir.strip().lower())
            assert int(size) > 0, "empty template.cfg for %r" % (key,)
            provpath[key] = flag == "1"
    assert len(provpath) == 427, len(provpath)
    return provpath


def main():
    models, total = read_models()
    ouis, oui_count = read_ouis()
    provpath = read_templates()

    # Reconcile the database against the disk in BOTH directions before writing anything.
    db_keys = set()
    for slug in models:
        for m in models[slug]:
            db_keys.add((m["brandDir"], m["model"].strip().lower()))
    gaps = db_keys - set(provpath)
    orphans = set(provpath) - db_keys
    assert gaps == KNOWN_TEMPLATE_GAPS, "template gaps changed: %r" % (sorted(gaps),)
    assert orphans == KNOWN_ORPHAN_TEMPLATES, "orphan templates changed: %r" % (sorted(orphans),)

    slugs = sorted(s for s, _ in BRANDS.values())
    name_by_slug = dict((s, n) for n, (s, _) in BRANDS.items())
    id_by_slug = dict((s, i) for _, (s, i) in BRANDS.items())

    out = []
    w = out.append
    w("/**")
    w(" * GENERATED - DO NOT EDIT BY HAND. Regenerate with scripts/deskPhoneSetup/gen-vendor-catalog.py.")
    w(" *")
    w(" * The PBX's own provisioning catalog, read off the live VitalPBX (provisioning.brands,")
    w(" * provisioning.phone_models, provisioning.brand_macs and the base_templates tree) on")
    w(" * 2026-09-10: every brand the PBX can render a settings file for, every model under it with")
    w(" * its phone_models.id, the IEEE OUI blocks the PBX itself uses to recognise each brand, and")
    w(" * the exact key each brand's base template writes to point the phone at its folder.")
    w(" *")
    w(" * A model that is not in here has NO template on the PBX and cannot be provisioned by")
    w(" * anything. A model that IS in here has a template.cfg under")
    w(" * /var/lib/vitalpbx/provisioning/base_templates/<brand>/<model>/ which")
    w(" * Device::generateProvisioningFile() renders on demand for any device row - 427 of 427")
    w(" * verified present and non-empty. `pbxModelId` is what a device row must carry.")
    w(" */")
    w("")
    w("export const VENDOR_SLUGS = [" + ", ".join('"%s"' % s for s in slugs) + "] as const;")
    w("export type VendorSlug = (typeof VENDOR_SLUGS)[number];")
    w("")
    w("export type CatalogModel = {")
    w("  /** The model name exactly as provisioning.phone_models.model spells it. */")
    w("  model: string;")
    w("  /** `model` with every non-alphanumeric stripped and upper-cased - what a discovered model string is matched on. */")
    w("  key: string;")
    w("  /** provisioning.phone_models.id. A provisioning.devices row must carry this or the PBX cannot render a config. */")
    w("  pbxModelId: number;")
    w("  /**")
    w("   * True when base_templates/<brand>/<model>/template.cfg exists and is non-empty, i.e. the")
    w("   * PBX can render a settings file for this model at all. 426 of 427 are true; the one")
    w("   * exception is Gigaset P820 IP PRO, which has a catalogue row and no template on disk.")
    w("   */")
    w("  hasBaseTemplate: boolean;")
    w("  /**")
    w("   * True when this model's base template also writes `provisioning_path` into the rendered")
    w("   * config, i.e. the phone is told to keep fetching from the tenant folder. 360 of 427 do.")
    w("   * False (67 models) means the template renders perfectly well but carries no")
    w("   * self-reference, so the phone must be pointed at the folder ONCE by PnP / DHCP / its own")
    w("   * web page, and remembers it from then on.")
    w("   */")
    w("  templateWritesProvisioningPath: boolean;")
    w("};")
    w("")
    w("export type CatalogBrand = {")
    w("  slug: VendorSlug;")
    w("  /** The brand name exactly as provisioning.brands spells it. */")
    w("  displayName: string;")
    w("  pbxBrandId: number;")
    w("  /** The line this brand's base templates use to carry provisioning_path; null = none of them do. */")
    w("  templateProvisioningKey: string | null;")
    w("  /** Lowercase hex MAC prefixes, no separators. Match a MAC by PREFIX - some are MA-M/MA-S and longer than 6. */")
    w("  ouis: string[];")
    w("  models: CatalogModel[];")
    w("};")
    w("")
    w("export const VENDOR_CATALOG: Record<VendorSlug, CatalogBrand> = {")
    for s in slugs:
        w("  %s: {" % s)
        w('    slug: "%s",' % s)
        w("    displayName: %s," % json.dumps(name_by_slug[s]))
        w("    pbxBrandId: %d," % id_by_slug[s])
        w("    templateProvisioningKey: %s," % json.dumps(TEMPLATE_KEY[s]))
        w("    ouis: [" + ", ".join('"%s"' % o for o in sorted(ouis[s])) + "],")
        w("    models: [")
        for m in sorted(models[s], key=lambda m: (m["key"], m["pbxModelId"])):
            tkey = (m["brandDir"], m["model"].strip().lower())
            has = tkey in provpath
            wp = provpath.get(tkey, False)
            w(
                "      { model: %s, key: %s, pbxModelId: %d, hasBaseTemplate: %s, templateWritesProvisioningPath: %s },"
                % (
                    json.dumps(m["model"]),
                    json.dumps(m["key"]),
                    m["pbxModelId"],
                    "true" if has else "false",
                    "true" if wp else "false",
                )
            )
        w("    ],")
        w("  },")
    w("};")
    w("")
    w("export const VENDOR_CATALOG_MODEL_COUNT = %d;" % total)
    w("export const VENDOR_CATALOG_OUI_COUNT = %d;" % oui_count)
    w("/** Models the PBX can render a settings file for at all. */")
    w("export const VENDOR_CATALOG_TEMPLATED_MODEL_COUNT = %d;" % (total - len(gaps)))
    w("/** Models whose base template also writes the provisioning URL back into the phone. */")
    # Count MODELS, not template directories: base_templates also holds the atcom/a20 orphan,
    # which writes provisioning_path but belongs to no catalogue row.
    self_pointing = sum(
        1
        for slug in models
        for m in models[slug]
        if provpath.get((m["brandDir"], m["model"].strip().lower()), False)
    )
    w("export const VENDOR_CATALOG_SELF_POINTING_MODEL_COUNT = %d;" % self_pointing)
    w('export const VENDOR_CATALOG_SOURCE = "vitalpbx provisioning.{brands,phone_models,brand_macs} + base_templates, read 2026-09-10";')

    body = NL.join(out) + NL
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
    body += 'export const VENDOR_CATALOG_DIGEST = "%s";%s' % (digest, NL)

    with io.open(OUT, "w", encoding="utf-8", newline=NL) as f:
        f.write(body)

    per = dict((s, len(models[s])) for s in slugs)
    print("wrote %s" % OUT)
    print("models=%d templated=%d ouis=%d selfPointing=%d digest=%s" % (total, total - len(gaps), oui_count, self_pointing, digest))
    print(per)


if __name__ == "__main__":
    main()
