"""Service name -> coarse group, shared by the importers."""
import collections, re

# Coarse service groups. The first group whose keywords appear wins, in this order, so
# "Consultation + Extraction" counts as Extraction and "RCT + Crown" as Crown & Bridge.
service_other = collections.Counter()
SERVICE_GROUPS = [
    ("Implant", r"implant|alpha ?bio|nobel|straumann|sinus|bone graft"),
    ("Orthodontics", r"invisal|aligner|brace|ortho|damon|retainer"),
    ("Crown & Bridge", r"crown|bridge|fpd|fmr|zirconi|e-?max|veneer|laminate|inlay|onlay|pfm|cementation|recement|prep|impression|prosthes[ie]s|prosthis|prosthises"),
    ("Root Canal (RCT)", r"\brc\b|rct|root canal|obturation|bmp|irrigation|rc open|pulp|apico|post ?& ?core|post and core"),
    ("Denture", r"denture|rpd|\bcd\b|reline"),
    ("Extraction & Surgery", r"extract|extration|extrac|impaction|surgery|suture|frenectomy|gingivectomy|flap|curettage|wisdom"),
    ("Restoration", r"restoration|filling|composite|gic|build ?up"),
    ("Gum care & Scaling", r"scal|prophyl|prophal|prophy|\bo\.?p\b|perio|polish|gum|depigment|laser|lllt|brush"),
    ("Imaging", r"iopa|rvg|opg|cbct|x-?ray|radiograph|digital scan|scan|ceph"),
    ("Whitening & Cosmetic", r"whiten|bleach|smile|zoom"),
    ("Appliances", r"night ?g|guard|splint|tmd|tens|appliance|space maintain|jaw relation"),
    ("Membership", r"member"),
    ("Consultation & Follow-up", r"consu|check ?up|follow|review|emergency|dressing"),
]
def service_group(text):
    g = _service_group(text)
    if g == "Other": service_other[text] += 1
    return g
def _service_group(text):
    t = re.sub(r"\s+", " ", (text or "").lower())
    if not t.strip(): return None
    for name, pat in SERVICE_GROUPS:
        if re.search(pat, t): return name
    return "Other"

